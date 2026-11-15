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

interface PeerInfo {
  peerId: string;
  name: string;
}

let chatIdCounter = 0;

export default function Room() {
  const { code } = useParams<{ code: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LocationState | null;
  const myName = state?.name ?? 'Guest';

  // Connection
  const [status, setStatus] = useState<'connecting' | 'connected' | 'full' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [peerName, setPeerName] = useState('');
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);

  // Camera / mic
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteCamHidden, setRemoteCamHidden] = useState(false);

  // Movie — streamer
  const [isStreaming, setIsStreaming] = useState(false);
  const [movieSrc, setMovieSrc] = useState<string>('');
  const [movieError, setMovieError] = useState('');
  const [movieHelp, setMovieHelp] = useState('');
  const [quality, setQuality] = useState<Quality>('720p');

  // Movie — viewer
  const [viewerMovieStream, setViewerMovieStream] = useState<MediaStream | null>(null);
  const [movieStreamId, setMovieStreamId] = useState<string>('');
  const [peerIsStreaming, setPeerIsStreaming] = useState(false);

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);

  const movieSupported = isCaptureStreamSupported();

  // Refs
  const sigRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<PeerManager | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const camSenderRef = useRef<RTCRtpSender | null>(null);
  const micSenderRef = useRef<RTCRtpSender | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamerVideoRef = useRef<HTMLVideoElement | null>(null);
  const viewerVideoRef = useRef<HTMLVideoElement | null>(null);
  const movieSendersRef = useRef<RTCRtpSender[]>([]);
  const movieStreamIdRef = useRef(movieStreamId);
  const peerNameRef = useRef(peerName);
  const myNameRef = useRef(myName);

  useEffect(() => { movieStreamIdRef.current = movieStreamId; }, [movieStreamId]);
  useEffect(() => { peerNameRef.current = peerName; }, [peerName]);

  // ── Control message handler ────────────────────────────────────

  const handleControlMessage = useCallback((msg: ControlMessage) => {
    if (msg.t === 'cmd') {
      // We received a command — we must be the streamer
      const el = streamerVideoRef.current;
      if (!el) return;
      if (msg.action === 'play') {
        void el.play();
      } else if (msg.action === 'pause') {
        el.pause();
        el.currentTime = msg.time;
      } else if (msg.action === 'seek') {
        el.currentTime = msg.time;
      }
    } else if (msg.t === 'state') {
      // We received state — we must be the viewer
      const el = viewerVideoRef.current;
      if (!el) return;
      // Sync time (allow small drift)
      if (Math.abs(el.currentTime - msg.time) > 1) {
        el.currentTime = msg.time;
      }
      if (msg.playing && el.paused) void el.play();
      if (!msg.playing && !el.paused) el.pause();
    } else if (msg.t === 'chat') {
      setChatMessages((prev) => [
        ...prev,
        { id: ++chatIdCounter, name: msg.name, text: msg.text, mine: false },
      ]);
    }
  }, []);

  // ── Peer setup ─────────────────────────────────────────────────

  useEffect(() => {
    if (!code || !state?.name) {
      navigate('/', { replace: true });
      return;
    }

    const sig = new SignalingClient();
    sigRef.current = sig;

    const off = sig.on(async (event) => {
      if (event.type === 'joined') {
        setStatus('connected');
        setPeers(event.peers);

        let iceConfig: IceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
        try {
          const res = await fetch('/api/ice-config');
          if (res.ok) iceConfig = await res.json() as IceConfig;
        } catch { /* fall back */ }

        const pm = new PeerManager(iceConfig, {
          polite: event.polite,
          signaling: sig,

          onTrack: (trackEvent) => {
            const incomingStream = trackEvent.streams[0];
            if (!incomingStream) return;
            if (incomingStream.id === movieStreamIdRef.current) {
              setViewerMovieStream(incomingStream);
            } else {
              setRemoteStream(incomingStream);
            }
          },

          onDataChannel: (channel) => {
            if (channel.label === 'control') {
              channelRef.current = channel;
              channel.onopen = () => {
                onControl(channel, handleControlMessage);
              };
              // Channel might already be open
              if (channel.readyState === 'open') {
                onControl(channel, handleControlMessage);
              }
            }
          },

          onConnectionStateChange: (_s) => {
            // Connection state tracked by ConnectionBadge via pc.getStats()
          },

          onIceConnectionStateChange: (s) => {
            if (s === 'failed') pm.restartIce();
          },
        });

        // Impolite peer owns the data channel
        if (!event.polite && pm.controlChannel) {
          channelRef.current = pm.controlChannel;
          const ch = pm.controlChannel;
          ch.onopen = () => { onControl(ch, handleControlMessage); };
          if (ch.readyState === 'open') onControl(ch, handleControlMessage);
        }

        setPc(pm.pc);
        peerRef.current = pm;

      } else if (event.type === 'peer-joined') {
        setPeers((prev) => [...prev, { peerId: event.peerId, name: event.name }]);
        setPeerName(event.name);

      } else if (event.type === 'peer-left') {
        setPeers((prev) => prev.filter((p) => p.peerId !== event.peerId));
        setPeerName('');
        setRemoteStream(null);
        setPeerIsStreaming(false);
        setViewerMovieStream(null);

      } else if (event.type === 'room-full') {
        setStatus('full');

      } else if (event.type === 'signal') {
        const data = event.data;
        // Intercept stream-meta messages (not WebRTC SDP/ICE)
        if (data['type'] === 'stream-meta') {
          const kind = data['kind'] as string;
          if (kind === 'movie') {
            const streamId = data['streamId'] as string;
            setMovieStreamId(streamId);
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
      if (localStreamRef.current) stopStream(localStreamRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // ── Camera toggle ────────────────────────────────────────────

  const handleToggleCamera = useCallback(async () => {
    const pm = peerRef.current;
    if (!pm) return;
    if (!cameraOn) {
      try {
        const { videoTrack } = await getLocalMedia(true, false);
        if (!videoTrack) return;
        if (!localStreamRef.current) {
          localStreamRef.current = new MediaStream();
        }
        localStreamRef.current.addTrack(videoTrack);
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        const sender = pm.addTrack(videoTrack, localStreamRef.current);
        camSenderRef.current = sender;
        setCameraOn(true);
        sendControl(channelRef.current, { t: 'track-toggle', kind: 'video', enabled: true });
      } catch (err) { console.error('[media] camera', err); }
    } else {
      if (camSenderRef.current) {
        pm.removeTrack(camSenderRef.current);
        camSenderRef.current = null;
      }
      setCameraOn(false);
      setLocalStream((prev) => prev ? new MediaStream(prev.getAudioTracks()) : null);
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'video', enabled: false });
    }
  }, [cameraOn]);

  // ── Mic toggle ────────────────────────────────────────────────

  const handleToggleMic = useCallback(async () => {
    const pm = peerRef.current;
    if (!pm) return;
    if (!micOn) {
      try {
        const { audioTrack } = await getLocalMedia(false, true);
        if (!audioTrack) return;
        if (!localStreamRef.current) localStreamRef.current = new MediaStream();
        const sender = pm.addTrack(audioTrack, localStreamRef.current);
        micSenderRef.current = sender;
        setMicOn(true);
        sendControl(channelRef.current, { t: 'track-toggle', kind: 'audio', enabled: true });
      } catch (err) { console.error('[media] mic', err); }
    } else {
      if (micSenderRef.current) {
        pm.removeTrack(micSenderRef.current);
        micSenderRef.current = null;
      }
      setMicOn(false);
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'audio', enabled: false });
    }
  }, [micOn]);

  // ── Movie sharing ─────────────────────────────────────────────

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
    setTimeout(() => { void startMovieStream(); }, 300);
  }

  async function startMovieStream() {
    const pm = peerRef.current;
    const sig = sigRef.current;
    const videoEl = streamerVideoRef.current;
    if (!pm || !sig || !videoEl) return;

    const stream = captureVideoStream(videoEl);
    const sourceHeight = videoEl.videoHeight || 720;

    // Send stream-meta BEFORE adding tracks
    sig.sendSignal({ type: 'stream-meta', streamId: stream.id, kind: 'movie' });

    async function addMovieTrack(track: MediaStreamTrack) {
      if (track.kind === 'video') {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion';
      }
      const sender = pm!.addTrack(track, stream);
      movieSendersRef.current.push(sender);
      if (track.kind === 'video') {
        setTimeout(() => { void applyQualityToSender(sender, quality, sourceHeight); }, 500);
      }
    }

    for (const track of stream.getTracks()) {
      await addMovieTrack(track);
    }

    // Chrome: tracks appear after play() starts
    stream.onaddtrack = (event) => { void addMovieTrack(event.track); };
  }

  async function handleStopSharing() {
    const pm = peerRef.current;
    const sig = sigRef.current;
    if (pm) {
      for (const sender of movieSendersRef.current) pm.removeTrack(sender);
      movieSendersRef.current = [];
    }
    sig?.sendSignal({ type: 'stream-meta', streamId: '', kind: 'movie-ended' });
    setIsStreaming(false);
    if (movieSrc) { URL.revokeObjectURL(movieSrc); setMovieSrc(''); }
  }

  async function handleQualityChange(newQuality: Quality) {
    setQuality(newQuality);
    const videoEl = streamerVideoRef.current;
    const sourceHeight = videoEl?.videoHeight ?? 720;
    for (const sender of movieSendersRef.current) {
      if (sender.track?.kind === 'video') {
        await applyQualityToSender(sender, newQuality, sourceHeight);
      }
    }
  }

  // Viewer playback commands → sent to streamer
  function sendPlayCmd(action: 'play' | 'pause' | 'seek', time: number) {
    sendControl(channelRef.current, { t: 'cmd', action, time });
  }

  // Streamer broadcasts state after local events
  function broadcastState(playing: boolean, time: number) {
    sendControl(channelRef.current, { t: 'state', playing, time });
  }

  // ── Chat ──────────────────────────────────────────────────────

  function handleSendChat(text: string) {
    sendControl(channelRef.current, { t: 'chat', text, name: myNameRef.current });
    setChatMessages((prev) => [
      ...prev,
      { id: ++chatIdCounter, name: myNameRef.current, text, mine: true },
    ]);
  }

  // ── Render ────────────────────────────────────────────────────

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

  const hasPeer = peers.length >= 2 || !!peerName;

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
        {status === 'connecting' ? (
          <div className="text-center space-y-4">
            <div className="text-4xl animate-pulse">⏳</div>
            <p className="text-gray-400">Joining room {code}…</p>
          </div>
        ) : !hasPeer ? (
          <div className="text-center space-y-4 max-w-sm">
            <p className="text-xl font-semibold">Room {code}</p>
            <div className="rounded-xl bg-gray-900 p-6 space-y-3">
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
          </div>
        ) : (
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

            {/* Waiting for peer to stream */}
            {peerIsStreaming && !viewerMovieStream && (
              <p className="text-gray-500 text-sm animate-pulse">🎬 Loading stream…</p>
            )}

            {/* Idle state */}
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
            <CameraTile
              stream={remoteStream}
              label={peerName || 'Peer'}
              onHide={() => setRemoteCamHidden(true)}
            />
          )}
          {hasPeer && remoteCamHidden && (
            <button
              onClick={() => setRemoteCamHidden(false)}
              className="rounded-xl bg-gray-800 px-3 py-2 text-xs text-gray-400 hover:bg-gray-700"
            >Show camera</button>
          )}
        </div>
      </main>

      {/* Controls bar */}
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
        {/* Chat button (positioned here so it's in the control bar) */}
        {hasPeer && (
          <Chat
            myName={myName}
            messages={chatMessages}
            onSend={handleSendChat}
          />
        )}
      </div>

      {/* Hidden file input */}
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
