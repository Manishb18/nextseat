import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { SignalingClient } from '../lib/signaling';
import { PeerManager, type IceConfig } from '../lib/peer';
import { getLocalMedia, stopStream } from '../lib/media';
import { onControl, sendControl, type ControlMessage } from '../lib/controls';
import {
  validateMovieFile,
  isCaptureStreamSupported,
  captureVideoStream,
  applyQualityToSender,
  type Quality,
} from '../lib/movie';
import CameraTile from '../components/CameraTile';
import Controls from '../components/Controls';
import MoviePlayer from '../components/MoviePlayer';
import ConnectionBadge from '../components/ConnectionBadge';
import Chat, { type ChatEntry } from '../components/Chat';

interface LocationState {
  name?: string;
}

let chatIdCounter = 0;

async function fetchIceConfig(): Promise<IceConfig> {
  try {
    const res = await fetch('/api/ice-config');
    if (res.ok) return await res.json() as IceConfig;
  } catch { /* fall back */ }
  return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
}

export default function Room() {
  const { code } = useParams<{ code: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LocationState | null;
  const myName = state?.name ?? 'Guest';

  // Connection
  const [status, setStatus] = useState<'connecting' | 'waiting' | 'connected' | 'full' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [peerName, setPeerName] = useState('');
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [mediaError, setMediaError] = useState('');

  // Camera / mic — LOCAL
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  // Camera — REMOTE (separate from movie stream)
  const [remoteCamStream, setRemoteCamStream] = useState<MediaStream | null>(null);
  const [remoteCamHidden, setRemoteCamHidden] = useState(false);

  // Movie — streamer
  const [isStreaming, setIsStreaming] = useState(false);
  const [movieSrc, setMovieSrc] = useState<string>('');
  const [movieError, setMovieError] = useState('');
  const [movieHelp, setMovieHelp] = useState('');
  const [quality, setQuality] = useState<Quality>('720p');

  // Movie — viewer
  const [viewerMovieStream, setViewerMovieStream] = useState<MediaStream | null>(null);
  const [peerIsStreaming, setPeerIsStreaming] = useState(false);

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);

  const movieSupported = isCaptureStreamSupported();

  // Refs (mutable values that must NOT trigger re-renders)
  const sigRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<PeerManager | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const camSenderRef = useRef<RTCRtpSender | null>(null);
  const micSenderRef = useRef<RTCRtpSender | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamerVideoRef = useRef<HTMLVideoElement | null>(null);
  const viewerVideoRef = useRef<HTMLVideoElement | null>(null);
  // Movie senders are kept alive between stop/start to allow replaceTrack()
  const movieVideoSenderRef = useRef<RTCRtpSender | null>(null);
  const movieAudioSenderRef = useRef<RTCRtpSender | null>(null);
  const movieStreamIdRef = useRef('');
  const myNameRef = useRef(myName);

  // Pre-connection state (stored for deferred PM creation)
  const politeRef = useRef<boolean | null>(null);
  const iceConfigRef = useRef<IceConfig | null>(null);
  const pmCreatedRef = useRef(false);  // guard against double creation

  // ── Control message handler ────────────────────────────────────────

  const handleControlMessage = useCallback((msg: ControlMessage) => {
    if (msg.t === 'cmd') {
      // We are the streamer — apply the viewer's command
      const el = streamerVideoRef.current;
      if (!el) return;
      if (msg.action === 'play')       void el.play();
      else if (msg.action === 'pause') { el.pause(); el.currentTime = msg.time; }
      else if (msg.action === 'seek')    el.currentTime = msg.time;
    } else if (msg.t === 'state') {
      // We are the viewer — sync to streamer's state
      const el = viewerVideoRef.current;
      if (!el) return;
      if (Math.abs(el.currentTime - msg.time) > 1) el.currentTime = msg.time;
      if (msg.playing && el.paused)   void el.play();
      if (!msg.playing && !el.paused) el.pause();
    } else if (msg.t === 'chat') {
      setChatMessages((prev) => [
        ...prev,
        { id: ++chatIdCounter, name: msg.name, text: msg.text, mine: false },
      ]);
    }
  }, []);

  // ── Create PeerManager (called only when BOTH peers are present) ───
  //
  // KEY FIX: The impolite peer (first joiner) must NOT create the PM until
  // the second peer joins. Otherwise, onnegotiationneeded fires immediately
  // and sends an offer to an empty room — which the backend drops.
  // The polite peer creates PM on 'joined' (the other peer is already there).

  const createPeerManager = useCallback(async (polite: boolean) => {
    if (pmCreatedRef.current) return;   // guard: only one PM per mount
    pmCreatedRef.current = true;

    const iceConfig = iceConfigRef.current ?? await fetchIceConfig();
    const sig = sigRef.current;
    if (!sig) return;

    const pm = new PeerManager(iceConfig, {
      polite,
      signaling: sig,

      onTrack: (trackEvent) => {
        const incoming = trackEvent.streams[0];
        if (!incoming) return;
        // Distinguish movie stream vs camera stream by stream ID.
        // movieStreamIdRef is set synchronously when stream-meta arrives,
        // which always comes BEFORE addTrack on the streamer side.
        if (incoming.id === movieStreamIdRef.current) {
          // This is the movie stream — show it in the viewer player
          setViewerMovieStream(incoming);
        } else {
          // This is a camera/mic stream — show it in the camera tile
          setRemoteCamStream(incoming);
        }
      },

      onDataChannel: (channel) => {
        if (channel.label !== 'control') return;
        channelRef.current = channel;
        const attach = () => onControl(channel, handleControlMessage);
        if (channel.readyState === 'open') attach();
        else channel.onopen = attach;
      },

      onConnectionStateChange: (_s) => { /* ConnectionBadge reads stats directly */ },

      onIceConnectionStateChange: (s) => {
        if (s === 'failed') pm.restartIce();
      },
    });

    // Impolite peer owns the control channel — register it immediately
    if (!polite && pm.controlChannel) {
      channelRef.current = pm.controlChannel;
      const ch = pm.controlChannel;
      const attach = () => onControl(ch, handleControlMessage);
      if (ch.readyState === 'open') attach();
      else ch.onopen = attach;
    }

    peerRef.current = pm;
    setPc(pm.pc);
  }, [handleControlMessage]);

  // ── Signaling + room lifecycle ─────────────────────────────────────

  useEffect(() => {
    if (!code || !state?.name) {
      navigate('/', { replace: true });
      return;
    }

    pmCreatedRef.current = false;
    politeRef.current = null;
    iceConfigRef.current = null;

    const sig = new SignalingClient();
    sigRef.current = sig;

    const off = sig.on(async (event) => {

      if (event.type === 'joined') {
        // Store polite flag and pre-fetch ICE config
        politeRef.current = event.polite;
        setStatus('waiting');
        iceConfigRef.current = await fetchIceConfig();

        if (event.polite) {
          // Second joiner: other peer already in room → create PM now
          await createPeerManager(true);
          setStatus('connected');
        }
        // First joiner: PM creation deferred to 'peer-joined'

      } else if (event.type === 'peer-joined') {
        setPeerName(event.name);
        setStatus('connected');

        if (politeRef.current === false) {
          // First joiner: now that peer joined, create PM and initiate
          await createPeerManager(false);
        }

      } else if (event.type === 'peer-left') {
        setPeerName('');
        setRemoteCamStream(null);
        setPeerIsStreaming(false);
        setViewerMovieStream(null);
        setStatus('waiting');
        // Reset PM so it can be re-created when peer rejoins
        peerRef.current?.close();
        peerRef.current = null;
        setPc(null);
        pmCreatedRef.current = false;
        movieVideoSenderRef.current = null;
        movieAudioSenderRef.current = null;

      } else if (event.type === 'room-full') {
        setStatus('full');

      } else if (event.type === 'signal') {
        const data = event.data;
        if (data['type'] === 'stream-meta') {
          const kind = data['kind'] as string;
          if (kind === 'movie') {
            // Set the ref SYNCHRONOUSLY so ontrack can check it immediately
            const streamId = data['streamId'] as string;
            movieStreamIdRef.current = streamId;
            setPeerIsStreaming(true);
          } else if (kind === 'movie-ended') {
            setPeerIsStreaming(false);
            setViewerMovieStream(null);
            movieStreamIdRef.current = '';
          }
        } else {
          await peerRef.current?.handleSignal(data);
        }

      } else if (event.type === 'error') {
        setStatus('error');
        setErrorMsg(event.message);
      }
    });

    sig.connect(code, myName);

    return () => {
      off();
      sig.disconnect();
      peerRef.current?.close();
      peerRef.current = null;
      setPc(null);
      if (localStreamRef.current) stopStream(localStreamRef.current);
      localStreamRef.current = null;
      channelRef.current = null;
      movieVideoSenderRef.current = null;
      movieAudioSenderRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // ── Camera toggle ─────────────────────────────────────────────────

  const handleToggleCamera = useCallback(async () => {
    const pm = peerRef.current;
    setMediaError('');
    if (!cameraOn) {
      try {
        const { videoTrack } = await getLocalMedia(true, false);
        if (!videoTrack) return;
        if (!localStreamRef.current) localStreamRef.current = new MediaStream();
        localStreamRef.current.addTrack(videoTrack);
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        if (pm) {
          if (camSenderRef.current) {
            // Reuse existing sender — avoids full renegotiation
            await pm.replaceTrack(camSenderRef.current, videoTrack);
          } else {
            const sender = pm.addTrack(videoTrack, localStreamRef.current);
            camSenderRef.current = sender;
          }
          sendControl(channelRef.current, { t: 'track-toggle', kind: 'video', enabled: true });
        }
        setCameraOn(true);
      } catch (err) {
        const e = err as Error;
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          setMediaError('Camera permission denied. Click the 🔒 icon in the address bar to allow it.');
        } else {
          setMediaError(`Camera error: ${e.message}`);
        }
        console.error('[media] camera', err);
      }
    } else {
      if (camSenderRef.current && pm) {
        // Replace with null track — keeps the sender alive for next toggle
        await pm.replaceTrack(camSenderRef.current, null);
      }
      // Stop the actual camera track so the indicator light goes off
      localStreamRef.current?.getVideoTracks().forEach((t) => t.stop());
      setCameraOn(false);
      setLocalStream(new MediaStream(localStreamRef.current?.getAudioTracks() ?? []));
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'video', enabled: false });
    }
  }, [cameraOn]);

  // ── Mic toggle ────────────────────────────────────────────────────

  const handleToggleMic = useCallback(async () => {
    const pm = peerRef.current;
    setMediaError('');
    if (!micOn) {
      try {
        const { audioTrack } = await getLocalMedia(false, true);
        if (!audioTrack) return;
        if (!localStreamRef.current) localStreamRef.current = new MediaStream();
        if (pm) {
          if (micSenderRef.current) {
            await pm.replaceTrack(micSenderRef.current, audioTrack);
          } else {
            const sender = pm.addTrack(audioTrack, localStreamRef.current);
            micSenderRef.current = sender;
          }
          sendControl(channelRef.current, { t: 'track-toggle', kind: 'audio', enabled: true });
        }
        setMicOn(true);
      } catch (err) {
        const e = err as Error;
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          setMediaError('Mic permission denied. Click the 🔒 icon in the address bar to allow it.');
        } else {
          setMediaError(`Mic error: ${e.message}`);
        }
        console.error('[media] mic', err);
      }
    } else {
      if (micSenderRef.current && pm) {
        await pm.replaceTrack(micSenderRef.current, null);
      }
      setMicOn(false);
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'audio', enabled: false });
    }
  }, [micOn]);

  // ── Movie sharing ─────────────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelected(file: File) {
    setMovieError('');
    setMovieHelp('');
    const result = await validateMovieFile(file);
    if (!result.ok) {
      setMovieError(result.error ?? 'Unknown error');
      setMovieHelp(result.helpMessage ?? '');
      return;
    }
    const src = URL.createObjectURL(file);
    setMovieSrc(src);
    setIsStreaming(true);
    // startMovieStream is called by MoviePlayer via onVideoReady
  }

  async function startMovieStream(videoEl: HTMLVideoElement) {
    const pm = peerRef.current;
    const sig = sigRef.current;
    if (!pm || !sig) return;
    // pm is non-null here; capture as non-null for the nested async closure
    const pmSafe = pm;

    // Wait for video metadata before capturing (Chrome needs this)
    if (videoEl.readyState < 1) {
      await new Promise<void>((res) => { videoEl.onloadedmetadata = () => res(); });
    }

    const stream = captureVideoStream(videoEl);
    const sourceHeight = videoEl.videoHeight || 720;

    // Send stream-meta BEFORE adding/replacing tracks.
    // The viewer's ontrack handler reads movieStreamIdRef synchronously,
    // so the ref must be set before ontrack fires. stream-meta sets that ref.
    sig.sendSignal({ type: 'stream-meta', streamId: stream.id, kind: 'movie' });
    // Also set locally so the ref is consistent on the streamer side
    movieStreamIdRef.current = stream.id;

    async function setupTrack(track: MediaStreamTrack) {
      if (track.kind === 'video') {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion';
      }

      if (track.kind === 'video' && movieVideoSenderRef.current) {
        // Reuse existing video sender — no renegotiation needed, viewer ontrack fires for replaceTrack
        await movieVideoSenderRef.current.replaceTrack(track);
        setTimeout(() => {
          void applyQualityToSender(movieVideoSenderRef.current!, quality, sourceHeight);
        }, 500);
      } else if (track.kind === 'audio' && movieAudioSenderRef.current) {
        await movieAudioSenderRef.current.replaceTrack(track);
      } else {
        // First time — addTrack (triggers renegotiation + ontrack on viewer)
        const sender = pmSafe.addTrack(track, stream);
        if (track.kind === 'video') {
          movieVideoSenderRef.current = sender;
          setTimeout(() => { void applyQualityToSender(sender, quality, sourceHeight); }, 500);
        } else {
          movieAudioSenderRef.current = sender;
        }
      }
    }

    // Handle tracks already present on the stream
    for (const track of stream.getTracks()) {
      await setupTrack(track);
    }

    // Chrome: audio/video tracks may appear after play() starts
    stream.onaddtrack = (e) => { void setupTrack(e.track); };
  }

  async function handleStopSharing() {
    const pm = peerRef.current;
    // Mute senders (replace with null) but keep them alive for restart
    if (movieVideoSenderRef.current && pm) {
      try { await movieVideoSenderRef.current.replaceTrack(null); } catch { /* ignore */ }
    }
    if (movieAudioSenderRef.current && pm) {
      try { await movieAudioSenderRef.current.replaceTrack(null); } catch { /* ignore */ }
    }
    sigRef.current?.sendSignal({ type: 'stream-meta', streamId: '', kind: 'movie-ended' });
    setIsStreaming(false);
    if (movieSrc) { URL.revokeObjectURL(movieSrc); setMovieSrc(''); }
  }

  async function handleQualityChange(newQuality: Quality) {
    setQuality(newQuality);
    const sourceHeight = streamerVideoRef.current?.videoHeight ?? 720;
    if (movieVideoSenderRef.current) {
      await applyQualityToSender(movieVideoSenderRef.current, newQuality, sourceHeight);
    }
  }

  // Viewer sends command to streamer
  function sendPlayCmd(action: 'play' | 'pause' | 'seek', time: number) {
    sendControl(channelRef.current, { t: 'cmd', action, time });
  }

  // Streamer broadcasts state to viewer
  function broadcastState(playing: boolean, time: number) {
    sendControl(channelRef.current, { t: 'state', playing, time });
  }

  // Chat
  function handleSendChat(text: string) {
    sendControl(channelRef.current, { t: 'chat', text, name: myNameRef.current });
    setChatMessages((prev) => [
      ...prev,
      { id: ++chatIdCounter, name: myNameRef.current, text, mine: true },
    ]);
  }

  // ── Render ────────────────────────────────────────────────────────

  if (status === 'full') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center space-y-4">
          <p className="text-2xl font-bold">Room is full 🚫</p>
          <p className="text-gray-400">This room already has 2 people.</p>
          <button onClick={() => navigate('/')} className="rounded-lg bg-blue-600 px-6 py-2 font-semibold hover:bg-blue-500">Go Home</button>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center space-y-4">
          <p className="text-2xl font-bold">Connection error</p>
          <p className="text-gray-400">{errorMsg}</p>
          <button onClick={() => navigate('/')} className="rounded-lg bg-blue-600 px-6 py-2 font-semibold hover:bg-blue-500">Go Home</button>
        </div>
      </div>
    );
  }

  const hasPeer = status === 'connected';

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-white overflow-hidden">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold">🎬 Watch Party</span>
          <span className="rounded bg-gray-800 px-2 py-0.5 font-mono text-sm text-gray-400">{code}</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <ConnectionBadge pc={pc} />
          <span className="text-gray-400">👤 {myName}</span>
        </div>
      </header>

      {/* Main area */}
      <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-gray-950 p-4">

        {/* Connecting / waiting */}
        {(status === 'connecting' || status === 'waiting') && (
          <div className="text-center space-y-4 max-w-sm">
            {status === 'connecting' ? (
              <>
                <div className="text-4xl animate-pulse">⏳</div>
                <p className="text-gray-400">Joining room {code}…</p>
              </>
            ) : (
              <div className="rounded-xl bg-gray-900 p-6 space-y-3">
                <p className="text-xl font-semibold">Room {code}</p>
                <p className="text-gray-400">Waiting for someone to join…</p>
                <div className="flex gap-2">
                  <code className="flex-1 truncate rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-300">
                    {window.location.href}
                  </code>
                  <button
                    onClick={() => { void navigator.clipboard.writeText(window.location.href); }}
                    className="rounded bg-gray-700 px-3 py-1.5 text-sm hover:bg-gray-600"
                  >Copy</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Connected */}
        {hasPeer && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4 max-w-4xl mx-auto">

            {/* Streamer: local movie player */}
            {isStreaming && movieSrc && (
              <div className="w-full">
                <MoviePlayer
                  src={movieSrc}
                  isController={true}
                  videoRef={streamerVideoRef}
                  onPlay={(t) => broadcastState(true, t)}
                  onPause={(t) => broadcastState(false, t)}
                  onSeeked={(t) => broadcastState(false, t)}
                  onVideoReady={(el) => { void startMovieStream(el); }}
                />
              </div>
            )}

            {/* Viewer: remote movie stream */}
            {peerIsStreaming && viewerMovieStream && (
              <div className="w-full">
                <MoviePlayer
                  stream={viewerMovieStream}
                  isController={false}
                  videoRef={viewerVideoRef}
                  onPlay={(t) => sendPlayCmd('play', t)}
                  onPause={(t) => sendPlayCmd('pause', t)}
                  onSeeked={(t) => sendPlayCmd('seek', t)}
                />
              </div>
            )}

            {peerIsStreaming && !viewerMovieStream && (
              <p className="text-gray-500 text-sm animate-pulse">🎬 Receiving stream…</p>
            )}

            {!isStreaming && !peerIsStreaming && (
              <div className="text-center text-gray-500">
                <p className="text-lg">🟢 {peerName || 'Both people'} connected</p>
                <p className="text-sm mt-1">Click &ldquo;Share a Movie&rdquo; to start watching</p>
              </div>
            )}

            {/* Movie validation error */}
            {movieError && (
              <div className="w-full max-w-2xl rounded-xl bg-red-950 border border-red-800 p-4">
                <p className="font-semibold text-red-300">⚠️ {movieError}</p>
                {movieHelp && (
                  <pre className="mt-3 overflow-x-auto rounded bg-gray-900 p-3 text-xs text-gray-300 whitespace-pre-wrap">
                    {movieHelp}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* Camera tiles — floating top-right */}
        <div className="absolute right-4 top-4 flex flex-col gap-2">
          <CameraTile stream={localStream} label={`${myName} (you)`} muted mirrored />
          {hasPeer && !remoteCamHidden && (
            <CameraTile stream={remoteCamStream} label={peerName || 'Peer'} onHide={() => setRemoteCamHidden(true)} />
          )}
          {hasPeer && remoteCamHidden && (
            <button onClick={() => setRemoteCamHidden(false)} className="rounded-xl bg-gray-800 px-3 py-2 text-xs text-gray-400 hover:bg-gray-700">
              Show camera
            </button>
          )}
        </div>

        {/* Media error toast */}
        {mediaError && (
          <div className="absolute bottom-20 left-1/2 -translate-x-1/2 max-w-md rounded-lg bg-red-900 border border-red-700 px-4 py-2 text-sm text-red-200 shadow-lg">
            {mediaError}
            <button className="ml-3 text-red-400 hover:text-white" onClick={() => setMediaError('')}>✕</button>
          </div>
        )}
      </main>

      {/* Controls + Chat bar */}
      <div className="flex flex-shrink-0 items-center justify-between border-t border-gray-800 bg-gray-900 px-6 py-2">
        <Controls
          cameraOn={cameraOn}
          micOn={micOn}
          onToggleCamera={() => { void handleToggleCamera(); }}
          onToggleMic={() => { void handleToggleMic(); }}
          canShareMovie={movieSupported}
          isStreaming={isStreaming}
          onShareMovie={() => fileInputRef.current?.click()}
          onStopSharing={() => { void handleStopSharing(); }}
          quality={quality}
          onQualityChange={(q) => { void handleQualityChange(q); }}
          showQuality={isStreaming}
        />
        {hasPeer && (
          <Chat myName={myName} messages={chatMessages} onSend={handleSendChat} />
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".mp4,.webm,.mov,.mkv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFileSelected(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
