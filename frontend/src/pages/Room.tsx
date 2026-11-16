import { useEffect, useRef, useState, useCallback, type CSSProperties, type FormEvent } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { SignalingClient } from '../lib/signaling';
import { PeerManager, type IceConfig } from '../lib/peer';
import { getLocalMedia, stopStream } from '../lib/media';
import {
  onControl,
  sendControl,
  applyStreamerCommand,
  applyViewerState,
  trackToggleEnabled,
  type ControlMessage,
  type ReactionMessage,
} from '../lib/controls';
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
import Icon from '../components/Icon';
import Brand from '../components/Brand';
import CopyButton from '../components/CopyButton';
import { ThemeToggle } from '../App';

interface LocationState {
  name?: string;
  ownerToken?: string;
}

let chatIdCounter = 0;
let reactionIdCounter = 0;
const reactionEmojis: ReactionMessage['emoji'][] = ['❤️', '😂', '👏', '🔥', '🎉'];

async function fetchIceConfig(): Promise<IceConfig> {
  try {
    const res = await fetch('/api/ice-config', { signal: AbortSignal.timeout(5_000) });
    if (res.ok) return await res.json() as IceConfig;
  } catch { /* fall back */ }
  return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
}

// ── Name gate: shown when user arrives via direct URL with no name ──

function NameGate({ code, onJoin }: { code: string; onJoin: (name: string) => void }) {
  const [name, setName] = useState('');
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) onJoin(trimmed);
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
      <div className="w-full max-w-sm space-y-6 px-6">
        <div className="text-center">
          <h1 className="flex justify-center"><Brand /></h1>
          <p className="mt-2 text-gray-400">You're joining room <span className="font-mono text-white">{code}</span></p>
        </div>
        <form onSubmit={handleSubmit} className="rounded-xl bg-gray-900 p-6 space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-300">Your name</label>
            <input
              id="name"
              type="text"
              maxLength={30}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              autoFocus
              className="mt-1 w-full rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={!name.trim()}
            className="w-full rounded-lg bg-green-600 px-4 py-3 font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Join Room
          </button>
        </form>
      </div>
    </div>
  );
}

export default function Room() {
  const { code } = useParams<{ code: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LocationState | null;

  // Allow joining via direct URL — show name prompt if no name in router state
  const [resolvedName, setResolvedName] = useState<string | null>(state?.name ?? null);

  if (!code) {
    navigate('/', { replace: true });
    return null;
  }

  // Show name gate until we have a name
  if (!resolvedName) {
    return <NameGate code={code} onJoin={(n) => setResolvedName(n)} />;
  }

  const ownerToken = state?.ownerToken ?? (() => {
    try { return sessionStorage.getItem(`watch-party-owner:${code}`) ?? ''; }
    catch { return ''; }
  })();

  return <RoomInner key={code} code={code} myName={resolvedName} ownerToken={ownerToken} />;
}

// ── Stream loader with reconnect button ────────────────────────────

function StreamLoader({ onReconnect }: { onReconnect: () => void }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="text-gray-500 text-sm animate-pulse">🎬 Receiving stream…</p>
      {elapsed >= 5 && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-xs text-gray-600">Stream taking a while?</p>
          <button
            onClick={onReconnect}
            className="rounded-lg bg-gray-700 px-4 py-1.5 text-xs font-semibold text-gray-200 hover:bg-gray-600 transition"
          >
            🔄 Reconnect
          </button>
        </div>
      )}
    </div>
  );
}

function RoomInner({ code, myName, ownerToken }: { code: string; myName: string; ownerToken: string }) {
  const navigate = useNavigate();

  // Connection
  const [status, setStatus] = useState<'connecting' | 'waiting' | 'connected' | 'full' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [peerName, setPeerName] = useState('');
  const [isCreator, setIsCreator] = useState(false);
  const [participantPanelVisible, setParticipantPanelVisible] = useState(true);
  const [endRoomDialogOpen, setEndRoomDialogOpen] = useState(false);
  const [endingRoom, setEndingRoom] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
  const [mediaError, setMediaError] = useState('');

  // Camera / mic — LOCAL
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('user');
  const [micOn, setMicOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  // Camera — REMOTE (separate from movie stream)
  const [remoteCamStream, setRemoteCamStream] = useState<MediaStream | null>(null);
  const [remoteVideoEnabled, setRemoteVideoEnabled] = useState<boolean | null>(null);
  const [remoteCamHidden, setRemoteCamHidden] = useState(false);
  const [controlReady, setControlReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const [syncToast, setSyncToast] = useState<{ success: boolean; message: string } | null>(null);

  // Movie — streamer
  const [isStreaming, setIsStreaming] = useState(false);
  const [movieSrc, setMovieSrc] = useState<string>('');
  const [movieError, setMovieError] = useState('');
  const [movieHelp, setMovieHelp] = useState('');
  const [quality, setQuality] = useState<Quality>('720p');
  const qualityRef = useRef<Quality>(quality);
  qualityRef.current = quality;

  // Movie — viewer
  const [viewerMovieStream, setViewerMovieStream] = useState<MediaStream | null>(null);
  const [peerIsStreaming, setPeerIsStreaming] = useState(false);
  const [playback, setPlayback] = useState({ time: 0, duration: 0, playing: false });
  const lastPlaybackUpdateRef = useRef(0);
  const pendingPlaybackActionRef = useRef<{ action: 'play' | 'pause' | 'seek'; time: number; expiresAt: number } | null>(null);
  const syncRequestIdRef = useRef(0);
  const syncTimeoutRef = useRef<number | null>(null);

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);
  const [reactions, setReactions] = useState<Array<{ id: number; emoji: ReactionMessage['emoji']; drift: number }>>([]);
  const fileValidationGenerationRef = useRef(0);

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
  const outgoingMovieStreamIdRef = useRef('');
  const movieCaptureStreamRef = useRef<MediaStream | null>(null);
  const movieCaptureSourceRef = useRef('');
  const movieCaptureGenerationRef = useRef(0);
  const movieObjectUrlRef = useRef<string | null>(null);
  const myNameRef = useRef(myName);

  // Pre-connection state (stored for deferred PM creation)
  const politeRef = useRef<boolean | null>(null);
  const iceConfigRef = useRef<IceConfig | null>(null);
  const pmCreatedRef = useRef(false);  // guard against double creation
  const signalingReconnectRef = useRef(false);
  const lastIceRestartAtRef = useRef(0);
  const mountedRef = useRef(false);

  function requestIceRestart(manager: PeerManager) {
    const now = Date.now();
    if (now - lastIceRestartAtRef.current < 5_000) return;
    lastIceRestartAtRef.current = now;
    manager.restartIce();
  }

  const addReaction = useCallback((emoji: ReactionMessage['emoji']) => {
    const id = ++reactionIdCounter;
    const drift = Math.round((Math.random() - 0.5) * 56);
    setReactions((current) => [...current, { id, emoji, drift }]);
    window.setTimeout(() => setReactions((current) => current.filter((reaction) => reaction.id !== id)), 2_600);
  }, []);

  // ── Control message handler ────────────────────────────────────────

  const handleControlMessage = useCallback((msg: ControlMessage) => {
    if (msg.t === 'cmd') {
      // We are the streamer — apply the viewer's command
      const el = streamerVideoRef.current;
      if (!el) return;
      if (msg.action === 'play') {
        void el.play().catch(() => setMovieError('Playback was blocked by the browser. Press Play on the shared player to resume.'));
      } else {
        applyStreamerCommand(el, msg);
      }
    } else if (msg.t === 'state') {
      // We are the viewer — sync to streamer's state
      const pending = pendingPlaybackActionRef.current;
      if (pending) {
        if (Date.now() >= pending.expiresAt) {
          pendingPlaybackActionRef.current = null;
        } else {
          const acknowledged = pending.action === 'play'
            ? msg.playing
            : pending.action === 'pause'
              ? !msg.playing
              : Math.abs(msg.time - pending.time) < 2;
          if (!acknowledged) return; // Ignore in-flight state from before the receiver's click.
          pendingPlaybackActionRef.current = null;
        }
      }
      const el = viewerVideoRef.current;
      if (!el) return;
      applyViewerState(el, msg);
      setPlayback({ time: Math.min(msg.time, msg.duration || msg.time), duration: msg.duration, playing: msg.playing });
    } else if (msg.t === 'chat') {
        setChatMessages((prev) => [
        ...prev,
        { id: ++chatIdCounter, name: msg.name, text: msg.text, mine: false },
        ].slice(-200));
    } else if (msg.t === 'track-toggle') {
      setRemoteVideoEnabled((current) => trackToggleEnabled(current, msg));
    } else if (msg.t === 'reaction') {
      addReaction(msg.emoji);
    } else if (msg.t === 'sync-request') {
      const video = streamerVideoRef.current;
      const success = Boolean(video && video.currentSrc && Number.isFinite(video.currentTime));
      if (success && video) broadcastState(!video.paused, video.currentTime);
      sendControl(channelRef.current, { t: 'sync-result', requestId: msg.requestId, success });
    } else if (msg.t === 'sync-result') {
      if (msg.requestId !== syncRequestIdRef.current || !syncingRef.current) return;
      if (syncTimeoutRef.current !== null) window.clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = null;
      syncingRef.current = false;
      setSyncing(false);
      setSyncToast(msg.success
        ? { success: true, message: 'Playback synced with the host.' }
        : { success: false, message: 'Sync failed: the host has no active video to sync.' });
      window.setTimeout(() => setSyncToast(null), 3_500);
    }
  }, [addReaction]);

  useEffect(() => () => {
    if (syncTimeoutRef.current !== null) window.clearTimeout(syncTimeoutRef.current);
  }, []);

  function requestPlaybackSync() {
    if (syncingRef.current) return;
    const requestId = Date.now();
    syncRequestIdRef.current = requestId;
    setSyncToast(null);
    if (!sendControl(channelRef.current, { t: 'sync-request', requestId })) {
      setSyncToast({ success: false, message: 'Sync failed: the room connection is unavailable.' });
      window.setTimeout(() => setSyncToast(null), 3_500);
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    syncTimeoutRef.current = window.setTimeout(() => {
      syncTimeoutRef.current = null;
      syncingRef.current = false;
      setSyncing(false);
      setSyncToast({ success: false, message: 'Sync timed out. Check the room connection and try again.' });
      window.setTimeout(() => setSyncToast(null), 3_500);
    }, 5_000);
  }

  const registerControlChannel = useCallback((channel: RTCDataChannel) => {
    if (channel.label !== 'control') return;
    channelRef.current = channel;
    onControl(channel, handleControlMessage);
    const markOpen = () => {
      if (channelRef.current !== channel) return;
      setControlReady(true);
      const video = streamerVideoRef.current;
      if (video?.currentSrc) {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const time = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        setPlayback({ playing: !video.paused, time, duration });
        sendControl(channel, {
          t: 'state',
          playing: !video.paused,
          time,
          duration,
        });
      }
    };
    channel.addEventListener('open', markOpen);
    channel.addEventListener('close', () => {
      if (channelRef.current === channel) setControlReady(false);
    });
    if (channel.readyState === 'open') markOpen();
  }, [handleControlMessage]);

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
    if (!mountedRef.current) {
      pmCreatedRef.current = false;
      return;
    }
    const sig = sigRef.current;
    if (!sig) {
      pmCreatedRef.current = false;
      return;
    }

    const classifyTrackEvent = (trackEvent: RTCTrackEvent) => {
      const incoming = trackEvent.streams[0];
      if (!incoming) return;
      if (incoming.id === movieStreamIdRef.current) {
        // This is the movie stream — show it in the viewer player
        setViewerMovieStream(incoming);
      } else {
        // This is a camera/mic stream — show it in the camera tile
        setRemoteCamStream(incoming);
      }
    };

    const pm = new PeerManager(iceConfig, {
      polite,
      signaling: sig,

      onTrack: (trackEvent) => {
        // Prefer a short receive buffer for responsive live playback where supported.
        // Browsers clamp this target to what the current network can sustain.
        const receiver = trackEvent.receiver as RTCRtpReceiver & { jitterBufferTarget?: number };
        if ('jitterBufferTarget' in receiver) {
          try { receiver.jitterBufferTarget = 100; }
          catch { /* Keep the browser's default buffer if this implementation rejects tuning. */ }
        }
        const incoming = trackEvent.streams[0];
        if (!incoming) return;
        // Stream metadata is sent on this same ordered WebSocket before movie
        // tracks are added to the peer connection. A nonmatching stream is a
        // camera/microphone stream, so no timeout-based race workaround is needed.
        classifyTrackEvent(trackEvent);
      },

      onDataChannel: (channel) => {
        registerControlChannel(channel);
      },

      onConnectionStateChange: (s) => {
        setConnectionState(s);
        // If connection fails, attempt ICE restart to re-establish
        if (s === 'failed') {
          console.warn('[peer] connection failed — attempting ICE restart');
          requestIceRestart(pm);
        }
        // If connection disconnected (transient), log it
        if (s === 'disconnected') {
          console.warn('[peer] connection disconnected — waiting for recovery...');
        }
      },

      onIceConnectionStateChange: (s) => {
        if (s === 'failed') {
          console.warn('[peer] ICE failed — restarting ICE');
          requestIceRestart(pm);
        }
      },
    });

    // Impolite peer owns the control channel — register it immediately
    if (!polite && pm.controlChannel) registerControlChannel(pm.controlChannel);

    peerRef.current = pm;
    setPc(pm.pc);
    setConnectionState(pm.pc.connectionState);

    // Reattach active local tracks after a peer connection is rebuilt.
    const localMedia = localStreamRef.current;
    for (const track of localMedia?.getTracks() ?? []) {
      if (track.readyState !== 'live' || !localMedia) continue;
      const sender = pm.addTrack(track, localMedia);
      if (track.kind === 'video') camSenderRef.current = sender;
      else if (track.kind === 'audio') micSenderRef.current = sender;
    }

    // Keep an active movie capture alive across signaling reconnections.
    const movieStream = movieCaptureStreamRef.current;
    const movieTracks = movieStream?.getTracks().filter((track) => track.readyState === 'live') ?? [];
    if (movieStream && movieTracks.length > 0) {
      if (!outgoingMovieStreamIdRef.current) outgoingMovieStreamIdRef.current = movieStream.id;
      sig.sendSignal({ type: 'stream-meta', streamId: outgoingMovieStreamIdRef.current, kind: 'movie' });
      for (const track of movieTracks) {
        const sender = pm.addTrack(track, movieStream);
        if (track.kind === 'video') {
          movieVideoSenderRef.current = sender;
          const sourceHeight = streamerVideoRef.current?.videoHeight || 720;
          window.setTimeout(() => { void applyQualityToSender(sender, qualityRef.current, sourceHeight); }, 500);
        }
        else if (track.kind === 'audio') movieAudioSenderRef.current = sender;
      }
    }
  }, [registerControlChannel]);

  useEffect(() => {
    const video = viewerVideoRef.current;
    if (video && viewerMovieStream) {
      applyViewerState(video, {
        t: 'state',
        playing: playback.playing,
        time: playback.time,
        duration: playback.duration,
      });
    }
  }, [viewerMovieStream, peerIsStreaming, playback]);

  // ── Signaling + room lifecycle ─────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    pmCreatedRef.current = false;
    politeRef.current = null;
    iceConfigRef.current = null;

    const sig = new SignalingClient();
    sigRef.current = sig;

    const off = sig.on(async (event) => {

      if (event.type === 'joined') {
        setIsCreator(event.isCreator);
        // Store polite flag and pre-fetch ICE config
        politeRef.current = event.polite;
        const otherPeer = event.peers.find((peer) => peer.peerId !== event.peerId);
        setPeerName(otherPeer?.name ?? '');
        setStatus(otherPeer ? 'connected' : 'waiting');
        setReconnecting(false);
        iceConfigRef.current = await fetchIceConfig();
        if (!mountedRef.current || sigRef.current !== sig) return;

        if (signalingReconnectRef.current) {
          peerRef.current?.close();
          peerRef.current = null;
          setPc(null);
          setConnectionState('new');
          pmCreatedRef.current = false;
          camSenderRef.current = null;
          micSenderRef.current = null;
          movieVideoSenderRef.current = null;
          movieAudioSenderRef.current = null;
          channelRef.current = null;
          movieStreamIdRef.current = '';
          setViewerMovieStream(null);
          setRemoteCamStream(null);
          setPeerIsStreaming(false);
        }
        signalingReconnectRef.current = false;
        if (otherPeer) {
          await createPeerManager(event.polite);
        }
        // First joiner: PM creation deferred to 'peer-joined'

      } else if (event.type === 'peer-joined') {
        setPeerName(event.name);
        setStatus('connected');
        // Both peers need a connection object. The impolite peer initiates
        // through its data channel; the polite peer waits for that offer.
        await createPeerManager(politeRef.current ?? false);

      } else if (event.type === 'peer-reconnected') {
        setPeerName(event.name);
        peerRef.current?.close();
        peerRef.current = null;
        setPc(null);
      setConnectionState('new');
        pmCreatedRef.current = false;
        camSenderRef.current = null;
        micSenderRef.current = null;
        movieVideoSenderRef.current = null;
        movieAudioSenderRef.current = null;
        channelRef.current = null;
        setControlReady(false);
        setRemoteVideoEnabled(null);
        movieStreamIdRef.current = '';
        outgoingMovieStreamIdRef.current = '';
        setViewerMovieStream(null);
        setRemoteCamStream(null);
        setPeerIsStreaming(false);
        await createPeerManager(politeRef.current ?? false);

      } else if (event.type === 'peer-left') {
        setPeerName('');
        setRemoteCamStream(null);
        setRemoteVideoEnabled(null);
        setControlReady(false);
        setPeerIsStreaming(false);
        setViewerMovieStream(null);
        setStatus('waiting');
        // Reset PM so it can be re-created when peer rejoins
        peerRef.current?.close();
        peerRef.current = null;
        setPc(null);
        setConnectionState('new');
        pmCreatedRef.current = false;
        camSenderRef.current = null;
        micSenderRef.current = null;
        movieVideoSenderRef.current = null;
        movieAudioSenderRef.current = null;
        channelRef.current = null;
        movieStreamIdRef.current = '';
        outgoingMovieStreamIdRef.current = '';

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
          }
        } else {
          await peerRef.current?.handleSignal(data);
        }

      } else if (event.type === 'reconnecting') {
        signalingReconnectRef.current = true;
        setReconnecting(true);

      } else if (event.type === 'error') {
        setStatus('error');
        setErrorMsg(event.message);
      } else if (event.type === 'room-deleted') {
        try { sessionStorage.removeItem(`watch-party-owner:${code}`); } catch { /* storage may be disabled */ }
        sig.disconnect();
        navigate('/', { replace: true });

      } else if (event.type === 'delete-denied') {
        setEndingRoom(false);
        setMediaError('Only the room creator can end the room for everyone.');
      }
    });

    sig.connect(code, myName, ownerToken);

    return () => {
      off();
      sig.disconnect();
      if (sigRef.current === sig) sigRef.current = null;
      peerRef.current?.close();
      peerRef.current = null;
      setPc(null);
      mountedRef.current = false;
      setConnectionState('new');
      if (localStreamRef.current) stopStream(localStreamRef.current);
      localStreamRef.current = null;
      channelRef.current = null;
      movieVideoSenderRef.current = null;
      movieAudioSenderRef.current = null;
      movieCaptureGenerationRef.current += 1;
      movieCaptureStreamRef.current?.getTracks().forEach((track) => track.stop());
      movieCaptureStreamRef.current = null;
      if (movieObjectUrlRef.current) URL.revokeObjectURL(movieObjectUrlRef.current);
      movieObjectUrlRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // ── Camera toggle ─────────────────────────────────────────────────

  const handleToggleCamera = useCallback(async () => {
    setMediaError('');
    if (!cameraOn) {
      try {
        const { videoTrack } = await getLocalMedia(true, false, cameraFacing);
        if (!videoTrack) return;
        if (!mountedRef.current) { videoTrack.stop(); return; }
        if (!localStreamRef.current) localStreamRef.current = new MediaStream();
        localStreamRef.current.getVideoTracks().forEach((oldTrack) => {
          localStreamRef.current?.removeTrack(oldTrack);
          if (oldTrack.readyState !== 'ended') oldTrack.stop();
        });
        localStreamRef.current.addTrack(videoTrack);
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        const pm = peerRef.current;
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
      const pm = peerRef.current;
      if (camSenderRef.current && pm) {
        // Replace with null track — keeps the sender alive for next toggle
        await pm.replaceTrack(camSenderRef.current, null);
      }
      // Stop the actual camera track so the indicator light goes off
      localStreamRef.current?.getVideoTracks().forEach((track) => {
        localStreamRef.current?.removeTrack(track);
        track.stop();
      });
      setCameraOn(false);
      setLocalStream(new MediaStream(localStreamRef.current?.getTracks() ?? []));
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'video', enabled: false });
    }
  }, [cameraOn, cameraFacing]);

  const handleSwitchCamera = useCallback(async () => {
    const nextFacing = cameraFacing === 'user' ? 'environment' : 'user';
    setMediaError('');
    let nextTrack: MediaStreamTrack | null = null;
    try {
      ({ videoTrack: nextTrack } = await getLocalMedia(true, false, nextFacing));
      if (!nextTrack) return;
      if (!mountedRef.current) { nextTrack.stop(); return; }
      const oldTrack = localStreamRef.current?.getVideoTracks()[0] ?? null;
      if (!localStreamRef.current) localStreamRef.current = new MediaStream();
      if (oldTrack) localStreamRef.current.removeTrack(oldTrack);
      localStreamRef.current.addTrack(nextTrack);
      if (camSenderRef.current && peerRef.current) await peerRef.current.replaceTrack(camSenderRef.current, nextTrack);
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
      oldTrack?.stop();
      setCameraFacing(nextFacing);
    } catch (err) {
      nextTrack?.stop();
      const error = err as Error;
      setMediaError('Could not switch camera: ' + error.message);
    }
  }, [cameraFacing]);

  // ── Mic toggle ────────────────────────────────────────────────────

  const handleToggleMic = useCallback(async () => {
    setMediaError('');
    if (!micOn) {
      try {
        const { audioTrack } = await getLocalMedia(false, true);
        if (!audioTrack) return;
        if (!mountedRef.current) { audioTrack.stop(); return; }
        if (!localStreamRef.current) localStreamRef.current = new MediaStream();
        localStreamRef.current.getAudioTracks().forEach((oldTrack) => {
          localStreamRef.current?.removeTrack(oldTrack);
          if (oldTrack.readyState !== 'ended') oldTrack.stop();
        });
        localStreamRef.current.addTrack(audioTrack);
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        const pm = peerRef.current;
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
      const pm = peerRef.current;
      if (micSenderRef.current && pm) {
        await pm.replaceTrack(micSenderRef.current, null);
      }
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        localStreamRef.current?.removeTrack(track);
        track.stop();
      });
      setMicOn(false);
      setLocalStream(new MediaStream(localStreamRef.current?.getTracks() ?? []));
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'audio', enabled: false });
    }
  }, [micOn]);

  // ── Movie sharing ─────────────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelected(file: File) {
    const generation = ++fileValidationGenerationRef.current;
    setMovieError('');
    setMovieHelp('');
    const result = await validateMovieFile(file);
    if (!mountedRef.current || generation !== fileValidationGenerationRef.current) return;
    if (!result.ok) {
      setMovieError(result.error ?? 'Unknown error');
      setMovieHelp(result.helpMessage ?? '');
      return;
    }
    if (movieObjectUrlRef.current) URL.revokeObjectURL(movieObjectUrlRef.current);
    const src = URL.createObjectURL(file);
    movieObjectUrlRef.current = src;
    setMovieSrc(src);
    setIsStreaming(true);
    // startMovieStream is called by MoviePlayer via onVideoReady
  }

  async function startMovieStream(videoEl: HTMLVideoElement) {
    const sig = sigRef.current;
    if (!sig) return;

    const source = videoEl.currentSrc || videoEl.src;
    if (movieCaptureSourceRef.current === source && movieCaptureStreamRef.current) return;

    // Wait for video metadata before capturing (Chrome needs this)
    if (videoEl.readyState < 1) {
      await new Promise<void>((res) => { videoEl.onloadedmetadata = () => res(); });
    }
    if (!mountedRef.current) return;

    const stream = captureVideoStream(videoEl);
    const previousCapture = movieCaptureStreamRef.current;
    const generation = ++movieCaptureGenerationRef.current;
    movieCaptureSourceRef.current = source;
    movieCaptureStreamRef.current = stream;
    const sourceHeight = videoEl.videoHeight || 720;

    // replaceTrack keeps the transceiver's original MediaStream association.
    // Keep that ID stable across stop/replay so the viewer routes its existing
    // receiver stream correctly (replaceTrack does not fire another ontrack).
    if (!movieVideoSenderRef.current && !movieAudioSenderRef.current) {
      outgoingMovieStreamIdRef.current = stream.id;
    }
    sig.sendSignal({ type: 'stream-meta', streamId: outgoingMovieStreamIdRef.current, kind: 'movie' });

    async function setupTrack(track: MediaStreamTrack) {
      if (generation !== movieCaptureGenerationRef.current || track.readyState !== 'live') return;
      if (track.kind === 'video') {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion';
      }

      const activePm = peerRef.current;
      if (!activePm) return;
      if (track.kind === 'video' && movieVideoSenderRef.current) {
        // Reuse the sender; the remote receiver track and stream identity remain stable.
        await movieVideoSenderRef.current.replaceTrack(track);
        const sender = movieVideoSenderRef.current;
        setTimeout(() => { void applyQualityToSender(sender, qualityRef.current, sourceHeight); }, 500);
      } else if (track.kind === 'audio' && movieAudioSenderRef.current) {
        await movieAudioSenderRef.current.replaceTrack(track);
      } else {
        // First time — addTrack (triggers renegotiation + ontrack on viewer)
        const sender = activePm.addTrack(track, stream);
        if (track.kind === 'video') {
          movieVideoSenderRef.current = sender;
          setTimeout(() => { void applyQualityToSender(sender, qualityRef.current, sourceHeight); }, 500);
        } else {
          movieAudioSenderRef.current = sender;
        }
      }
      if (previousCapture && previousCapture !== stream) {
        previousCapture.getTracks().forEach((previousTrack) => previousTrack.stop());
      }
    }

    // Handle tracks already present on the stream
    for (const track of stream.getTracks()) {
      await setupTrack(track);
    }

    // Chrome: audio/video tracks may appear after play() starts
    stream.onaddtrack = (e) => { void setupTrack(e.track).catch((err) => console.error('[movie] add track failed', err)); };
  }

  async function handleStopSharing() {
    movieCaptureGenerationRef.current += 1;
    const pm = peerRef.current;
    // Mute senders (replace with null) but keep them alive for restart
    if (movieVideoSenderRef.current && pm) {
      try { await movieVideoSenderRef.current.replaceTrack(null); } catch { /* ignore */ }
    }
    if (movieAudioSenderRef.current && pm) {
      try { await movieAudioSenderRef.current.replaceTrack(null); } catch { /* ignore */ }
    }
    sigRef.current?.sendSignal({ type: 'stream-meta', streamId: '', kind: 'movie-ended' });
    streamerVideoRef.current?.pause();
    setIsStreaming(false);
    movieCaptureStreamRef.current?.getTracks().forEach((track) => track.stop());
    movieCaptureStreamRef.current = null;
    movieCaptureSourceRef.current = '';
    if (movieObjectUrlRef.current) URL.revokeObjectURL(movieObjectUrlRef.current);
    movieObjectUrlRef.current = null;
    setMovieSrc('');
  }

  async function handleQualityChange(newQuality: Quality) {
    setQuality(newQuality);
    const sourceHeight = streamerVideoRef.current?.videoHeight ?? 720;
    if (movieVideoSenderRef.current) {
      await applyQualityToSender(movieVideoSenderRef.current, newQuality, sourceHeight);
    }
  }

  // Viewer sends command to streamer
  function sendPlayCmd(action: 'play' | 'pause' | 'seek', time: number): boolean {
    const sent = sendControl(channelRef.current, { t: 'cmd', action, time });
    if (sent) pendingPlaybackActionRef.current = { action, time, expiresAt: Date.now() + 3_000 };
    return sent;
  }

  // Streamer broadcasts state to viewer
  function broadcastState(playing: boolean, time: number) {
    const duration = streamerVideoRef.current?.duration ?? 0;
    const safeTime = Number.isFinite(time) && time >= 0 ? time : 0;
    setPlayback({ playing, time: safeTime, duration: Number.isFinite(duration) ? duration : 0 });
    sendControl(channelRef.current, { t: 'state', playing, time: safeTime, duration: Number.isFinite(duration) ? duration : 0 });
  }

  // Chat
  function handleSendChat(text: string) {
    if (!sendControl(channelRef.current, { t: 'chat', text: text.slice(0, 500), name: myNameRef.current.slice(0, 30) })) return;
    setChatMessages((prev) => [
      ...prev,
      { id: ++chatIdCounter, name: myNameRef.current, text, mine: true },
    ].slice(-200));
  }

  function handleSendReaction(emoji: ReactionMessage['emoji']) {
    if (!sendControl(channelRef.current, { t: 'reaction', emoji })) return;
    addReaction(emoji);
  }

  function handleLeaveRoom() {
    sigRef.current?.disconnect();
    navigate('/', { replace: true });
  }

  function handleEndRoom() {
    if (!sigRef.current?.deleteRoom()) {
      setMediaError('The room connection is not ready. Try again in a moment.');
      return;
    }
    setEndingRoom(true);
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
    <div className="watch-room flex h-dvh flex-col overflow-hidden bg-gray-950 text-white">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <Brand />
          <span className="rounded bg-gray-800 px-2 py-0.5 font-mono text-sm text-gray-400">{code}</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <ConnectionBadge pc={pc} />
          <ThemeToggle />
          {reconnecting && <span className="text-xs text-yellow-300">Reconnecting signaling…</span>}
          {connectionState === 'failed' && (
            <button onClick={() => sigRef.current?.reconnect()} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-blue-300 hover:bg-blue-950" aria-label="Reconnect to room">
              <Icon name="refresh" size={15} />Reconnect
            </button>
          )}
          <button onClick={handleLeaveRoom} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-xs font-medium text-gray-200 transition hover:bg-gray-800" aria-label="Leave this room" title="Leave this room">
            <Icon name="door" size={16} /><span>Leave</span>
          </button>
          {isCreator && (
            <button onClick={() => setEndRoomDialogOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-900/70 px-3 py-2 text-xs font-medium text-red-300 transition hover:bg-red-950" aria-label="End room for everyone" title="End room for everyone">
              <Icon name="trash" size={16} /><span className="hidden sm:inline">End room</span>
            </button>
          )}
          <span className="text-gray-400">👤 {myName}</span>
        </div>
      </header>

      {/* Main area */}
      <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-gray-950 p-4">
        <div className="reaction-flight-layer" aria-live="polite" aria-label="Room reactions" aria-relevant="additions">
          {reactions.map((reaction) => <span key={reaction.id} className="reaction-flight" style={{ '--reaction-drift': `${reaction.drift}px` } as CSSProperties} aria-hidden="true">{reaction.emoji}</span>)}
        </div>

        {/* Connecting / waiting */}
        {(status === 'connecting' || status === 'waiting') && !isStreaming && (
          <div className="text-center space-y-4 max-w-sm">
            {status === 'connecting' ? (
              <>
                <div className="text-4xl animate-pulse">⏳</div>
                <p className="text-gray-400">Joining room {code}…</p>
              </>
            ) : (
              <div className="rounded-xl bg-gray-900 p-6 space-y-3">
                <p className="text-xl font-semibold">Room {code}</p>
                <p className="text-gray-400">
                  {reconnecting ? 'Reconnecting to the room…' : 'Waiting for someone to join…'}
                </p>
                <div className="flex gap-2">
                  <code className="flex-1 truncate rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-300">
                    {window.location.href}
                  </code>
                  <CopyButton value={window.location.href} className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600" />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Connected */}
        {(hasPeer || isStreaming) && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4 max-w-4xl mx-auto">

            {/* Streamer: local movie player */}
            {isStreaming && movieSrc && (
              <div className="w-full">
                <MoviePlayer
                  src={movieSrc}
                  isController={true}
                  videoRef={streamerVideoRef}
                  onSeeked={(t) => broadcastState(!streamerVideoRef.current?.paused, t)}
                  onPlay={(t) => broadcastState(true, t)}
                  onPause={(t) => broadcastState(false, t)}
                  onVideoReady={(el) => {
                    void startMovieStream(el).catch((err: unknown) => {
                      const message = err instanceof Error ? err.message : 'Could not start movie capture.';
                      setMovieError(message);
                      void handleStopSharing();
                    });
                  }}
                  onVideoError={() => {
                    setMovieError('The browser could not decode this video file. Try a compatible H.264/AAC MP4.');
                    void handleStopSharing();
                  }}
                  onVideoEnded={() => { void handleStopSharing(); }}
                  onTimeUpdate={(t) => {
                    const now = Date.now();
                    if (now - lastPlaybackUpdateRef.current >= 1000) {
                      lastPlaybackUpdateRef.current = now;
                      broadcastState(!streamerVideoRef.current?.paused, t);
                    }
                  }}
                />
              </div>
            )}

            {/* Viewer: remote movie stream */}
            {viewerMovieStream && (
              <div className="w-full">
                <MoviePlayer
                  stream={viewerMovieStream}
                  isController={false}
                  streamActive={peerIsStreaming}
                  controlsEnabled={controlReady}
                  videoRef={viewerVideoRef}
                  onPlay={(t) => sendPlayCmd('play', t)}
                  onPause={(t) => sendPlayCmd('pause', t)}
                  onSeeked={(t) => sendPlayCmd('seek', t)}
                  playbackTime={playback.time}
                  duration={playback.duration}
                  onRemoteSeek={(t) => { sendPlayCmd('seek', t); }}
                  onSync={requestPlaybackSync}
                  syncing={syncing}
                />
              </div>
            )}

            {peerIsStreaming && !viewerMovieStream && (
              <StreamLoader onReconnect={() => sigRef.current?.reconnect()} />
            )}

            {!isStreaming && !peerIsStreaming && (
              <div className="text-center text-gray-500">
                <p className="text-lg">🟢 {peerName || 'Both people'} connected</p>
                <p className="text-sm mt-1">Click &ldquo;Share a Movie&rdquo; to start watching</p>
              </div>
            )}

            {hasPeer && (
              <section className="reaction-dock" aria-label="Room reactions">
                <div className="flex items-center justify-center gap-1.5 sm:gap-2" role="group" aria-label="Send a reaction">
                  {reactionEmojis.map((emoji) => <button key={emoji} type="button" onClick={() => handleSendReaction(emoji)} disabled={!controlReady} className="reaction-button" aria-label={`Send ${emoji} reaction`} title={`Send ${emoji}`}>
                    {emoji}
                  </button>)}
                </div>
              </section>
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
        <div className="absolute right-4 top-4 z-20 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2">
          <button
            onClick={() => setParticipantPanelVisible((visible) => !visible)}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900/90 px-3 py-2 text-xs font-medium text-slate-200 shadow-lg backdrop-blur transition hover:bg-slate-800"
            aria-expanded={participantPanelVisible}
            aria-label={participantPanelVisible ? 'Hide participants panel' : 'Show participants panel'}
          >
            <Icon name={participantPanelVisible ? 'eye-off' : 'users'} size={16} />
            <span>{participantPanelVisible ? 'Hide panel' : 'Participants'}</span>
          </button>
          {participantPanelVisible && (
            <div className="flex flex-col gap-2">
              <CameraTile stream={localStream} label={`${myName} (you)`} muted mirrored />
              {hasPeer && !remoteCamHidden && (
                <CameraTile stream={remoteCamStream} label={peerName || 'Peer'} videoEnabled={remoteVideoEnabled} onHide={() => setRemoteCamHidden(true)} />
              )}
              {hasPeer && remoteCamHidden && (
                <button onClick={() => setRemoteCamHidden(false)} className="inline-flex items-center justify-center gap-2 rounded-lg bg-gray-800 px-3 py-2 text-xs text-gray-300 transition hover:bg-gray-700" aria-label="Show peer camera">
                  <Icon name="eye" size={15} /> Show peer camera
                </button>
              )}
            </div>
          )}
        </div>

        {/* Media error toast */}
        {syncToast && (
          <div role="status" aria-live="polite" className={'absolute bottom-20 left-1/2 -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-lg ' + (syncToast.success ? 'border-green-700 bg-green-900 text-green-100' : 'border-red-700 bg-red-900 text-red-100')}>
            {syncToast.message}
          </div>
        )}
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
          cameraFacing={cameraFacing}
          onSwitchCamera={() => { void handleSwitchCamera(); }}
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
          <Chat myName={myName} messages={chatMessages} onSend={handleSendChat} canSend={controlReady} />
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
      {endRoomDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !endingRoom) setEndRoomDialogOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="end-room-title" className="w-full max-w-sm rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-red-950 text-red-300"><Icon name="trash" size={20} /></div>
            <h2 id="end-room-title" className="text-lg font-semibold">End room for everyone?</h2>
            <p className="mt-2 text-sm leading-6 text-gray-400">This will disconnect you and {peerName || 'the other participant'} and close this room.</p>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setEndRoomDialogOpen(false)} disabled={endingRoom} className="rounded-lg px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800 disabled:opacity-50">Cancel</button>
              <button onClick={handleEndRoom} disabled={endingRoom} className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-600 disabled:opacity-60">
                <Icon name="trash" size={15} />{endingRoom ? 'Ending room…' : 'End for everyone'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
