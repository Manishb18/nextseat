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

interface LocationState {
  name?: string;
}

interface PeerInfo {
  peerId: string;
  name: string;
}

export default function Room() {
  const { code } = useParams<{ code: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LocationState | null;
  const myName = state?.name ?? 'Guest';

  // Connection
  const [status, setStatus] = useState<'connecting' | 'connected' | 'full' | 'error'>('connecting');
  const [connState, setConnState] = useState<RTCPeerConnectionState>('new');
  const [errorMsg, setErrorMsg] = useState('');
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [peerName, setPeerName] = useState('');

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
  const [movieStreamId, setMovieStreamId] = useState<string>('');   // from stream-meta
  const [peerIsStreaming, setPeerIsStreaming] = useState(false);

  const movieSupported = isCaptureStreamSupported();

  // Refs
  const sigRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<PeerManager | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const camSenderRef = useRef<RTCRtpSender | null>(null);
  const micSenderRef = useRef<RTCRtpSender | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamerVideoRef = useRef<HTMLVideoElement | null>(null);    // streamer's local player
  const movieSendersRef = useRef<RTCRtpSender[]>([]);                // senders for movie tracks
  const viewerVideoRef = useRef<HTMLVideoElement | null>(null);      // viewer's player

  // ── Peer setup ──────────────────────────────────────────────────

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

            // Check if this is the movie stream using the stream-meta streamId
            if (incomingStream.id === movieStreamId || movieStreamId === incomingStream.id) {
              setViewerMovieStream(incomingStream);
            } else {
              // Could be camera/mic
              setRemoteStream((prev) => {
                // If we already have a remote stream, add tracks to it
                if (prev && prev.id === incomingStream.id) return prev;
                return incomingStream;
              });
            }
          },

          onDataChannel: (channel) => {
            if (channel.label === 'control') {
              channelRef.current = channel;
              onControl(channel, (msg: ControlMessage) => {
                handleControlMessage(msg);
              });
            }
          },

          onConnectionStateChange: (s) => setConnState(s),
          onIceConnectionStateChange: (s) => {
            if (s === 'failed') pm.restartIce();
          },
        });

        if (!event.polite && pm.controlChannel) {
          channelRef.current = pm.controlChannel;
          pm.controlChannel.onopen = () => {
            onControl(pm.controlChannel!, (msg: ControlMessage) => {
              handleControlMessage(msg);
            });
          };
        }

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
        // Handle stream-meta before routing to peer manager
        const data = event.data;
        if (data['type'] === 'stream-meta') {
          const kind = data['kind'] as string;
          if (kind === 'movie') {
            const streamId = data['streamId'] as string;
            setMovieStreamId(streamId);
            setPeerIsStreaming(true);
          } else if (kind === 'movie-ended') {
            setPeerIsStreaming(false);
            setViewerMovieStream(null);
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

  // Keep movieStreamId ref fresh for onTrack closure
  const movieStreamIdRef = useRef(movieStreamId);
  useEffect(() => { movieStreamIdRef.current = movieStreamId; }, [movieStreamId]);

  // Also handle track events with fresh movieStreamId
  useEffect(() => {
    const pm = peerRef.current;
    if (!pm) return;
    pm.pc.ontrack = (trackEvent) => {
      const incomingStream = trackEvent.streams[0];
      if (!incomingStream) return;
      if (incomingStream.id === movieStreamIdRef.current) {
        setViewerMovieStream(incomingStream);
      } else {
        setRemoteStream(incomingStream);
      }
    };
  }, [movieStreamId]);

  // ── Control message handler ──────────────────────────────────────

  function handleControlMessage(msg: ControlMessage) {
    if (msg.t === 'cmd') {
      // Viewer is sending a playback command — apply to streamer's player
      const el = streamerVideoRef.current;
      if (!el) return;
      if (msg.action === 'play') void el.play();
      else if (msg.action === 'pause') el.pause();
      else if (msg.action === 'seek') el.currentTime = msg.time;
    }
    if (msg.t === 'state') {
      // Streamer broadcasted playback state — apply to viewer's display
      // (The viewer does NOT directly control their video element; state drives it)
    }
  }

  // Broadcast playback state to viewer (streamer side)
  function broadcastState(playing: boolean, time: number) {
    sendControl(channelRef.current, { t: 'state', playing, time });
  }

  // ── Camera toggle ──────────────────────────────────────────────

  const handleToggleCamera = useCallback(async () => {
    const pc = peerRef.current;
    if (!pc) return;
    if (!cameraOn) {
      try {
        const { stream, videoTrack } = await getLocalMedia(true, false);
        if (!videoTrack) return;
        localStreamRef.current = localStreamRef.current ?? stream;
        localStreamRef.current.addTrack(videoTrack);
        setLocalStream(new MediaStream([
          ...localStreamRef.current.getTracks(),
        ]));
        const sender = pc.addTrack(videoTrack, localStreamRef.current);
        camSenderRef.current = sender;
        setCameraOn(true);
        sendControl(channelRef.current, { t: 'track-toggle', kind: 'video', enabled: true });
      } catch (err) { console.error('[media] camera', err); }
    } else {
      if (camSenderRef.current) {
        pc.removeTrack(camSenderRef.current);
        camSenderRef.current = null;
      }
      setCameraOn(false);
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'video', enabled: false });
    }
  }, [cameraOn]);

  // ── Mic toggle ────────────────────────────────────────────────

  const handleToggleMic = useCallback(async () => {
    const pc = peerRef.current;
    if (!pc) return;
    if (!micOn) {
      try {
        const { audioTrack } = await getLocalMedia(false, true);
        if (!audioTrack) return;
        const camStream = localStreamRef.current ?? new MediaStream();
        const sender = pc.addTrack(audioTrack, camStream);
        micSenderRef.current = sender;
        setMicOn(true);
        sendControl(channelRef.current, { t: 'track-toggle', kind: 'audio', enabled: true });
      } catch (err) { console.error('[media] mic', err); }
    } else {
      if (micSenderRef.current) {
        pc.removeTrack(micSenderRef.current);
        micSenderRef.current = null;
      }
      setMicOn(false);
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'audio', enabled: false });
    }
  }, [micOn]);

  // ── Movie sharing ─────────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleShareMovie() {
    fileInputRef.current?.click();
  }

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

    // After the video element renders and can play, start streaming
    // We set a small timeout so the video element has time to mount with the src
    setTimeout(() => { void startMovieStream(); }, 200);
  }

  async function startMovieStream() {
    const pc = peerRef.current;
    const sig = sigRef.current;
    const videoEl = streamerVideoRef.current;
    if (!pc || !sig || !videoEl) return;

    const stream = captureVideoStream(videoEl);
    const sourceHeight = videoEl.videoHeight || 720;

    // Helper to add a track to the peer connection with quality tuning
    async function addMovieTrack(track: MediaStreamTrack) {
      // Set content hint for video
      if (track.kind === 'video') {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion';
      }
      const sender = pc!.addTrack(track, stream);
      movieSendersRef.current.push(sender);

      if (track.kind === 'video') {
        // Apply quality settings after a brief delay (sender needs active track)
        setTimeout(() => {
          void applyQualityToSender(sender, quality, sourceHeight);
        }, 500);
      }
    }

    // Send stream-meta BEFORE adding tracks so viewer can identify this stream
    sig.sendSignal({ type: 'stream-meta', streamId: stream.id, kind: 'movie' });

    // Add any tracks already present
    for (const track of stream.getTracks()) {
      await addMovieTrack(track);
    }

    // Listen for tracks that appear after play() starts (Chrome behaviour)
    stream.onaddtrack = (event) => {
      void addMovieTrack(event.track);
    };
  }

  async function handleStopSharing() {
    const pc = peerRef.current;
    const sig = sigRef.current;
    if (pc) {
      for (const sender of movieSendersRef.current) {
        pc.removeTrack(sender);
      }
      movieSendersRef.current = [];
    }
    sig?.sendSignal({ type: 'stream-meta', streamId: '', kind: 'movie-ended' });
    setIsStreaming(false);
    if (movieSrc) URL.revokeObjectURL(movieSrc);
    setMovieSrc('');
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

  // ── Render ─────────────────────────────────────────────────────

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
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            connState === 'connected' ? 'bg-green-900 text-green-300' :
            connState === 'failed'    ? 'bg-red-900 text-red-300' :
            'bg-yellow-900 text-yellow-300'
          }`}>
            {connState === 'new' || connState === 'connecting' ? '⏳ Connecting' :
             connState === 'connected' ? '🟢 Connected' :
             connState === 'disconnected' ? '🔴 Reconnecting' :
             connState === 'failed' ? '❌ Failed' : connState}
          </span>
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
                />
              </div>
            )}

            {/* Waiting for movie */}
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

      {/* Controls */}
      <Controls
        cameraOn={cameraOn}
        micOn={micOn}
        onToggleCamera={() => { void handleToggleCamera(); }}
        onToggleMic={() => { void handleToggleMic(); }}
        canShareMovie={movieSupported}
        isStreaming={isStreaming}
        onShareMovie={handleShareMovie}
        onStopSharing={() => { void handleStopSharing(); }}
        quality={quality}
        onQualityChange={(q) => { void handleQualityChange(q); }}
        showQuality={isStreaming}
      />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp4,.webm,.mov,.mkv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFileSelected(file);
          e.target.value = '';   // allow re-selecting same file
        }}
      />
    </div>
  );
}
