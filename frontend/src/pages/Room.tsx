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
  inviteToken?: string;
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

  // If someone opens a direct room link, ask for their name first.
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

  // Invite token: from navigation state, sessionStorage, or URL ?t= param
  const inviteToken = state?.inviteToken ?? (() => {
    try { return sessionStorage.getItem(`watch-party-invite:${code}`) ?? new URLSearchParams(window.location.search).get('t') ?? ''; }
    catch { return new URLSearchParams(window.location.search).get('t') ?? ''; }
  })();

  return <RoomInner key={code} code={code} myName={resolvedName} ownerToken={ownerToken} inviteToken={inviteToken} />;
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

function RoomInner({ code, myName, ownerToken, inviteToken: initialInviteToken }: { code: string; myName: string; ownerToken: string; inviteToken: string }) {
  const navigate = useNavigate();

  // Connection
  const [status, setStatus] = useState<'connecting' | 'waiting' | 'connected' | 'full' | 'error'>('connecting');
  const [roomEnded, setRoomEnded] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [peerName, setPeerName] = useState('');
  const [roomParticipants, setRoomParticipants] = useState<Array<{peerId: string; name: string}>>([]);
  const [isCreator, setIsCreator] = useState(false);
  const [participantPanelVisible, setParticipantPanelVisible] = useState(true);
  const [endRoomDialogOpen, setEndRoomDialogOpen] = useState(false);
  const [endingRoom, setEndingRoom] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [pc, setPc] = useState<RTCPeerConnection | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
  const [mediaError, setMediaError] = useState('');
  // invite token tracked in state so rotate-invite can refresh the shareable link
  const [inviteToken, setInviteToken] = useState(initialInviteToken);
  // tab visibility: warn the streamer if they minimise the tab
  const [tabHidden, setTabHidden] = useState(false);

  // Local camera and microphone
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('user');
  const [micOn, setMicOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  // Remote cameras (separate from the movie stream)
  const [remoteCameraStreams, setRemoteCameraStreams] = useState<Record<string, MediaStream>>({});
  const [remoteCameraEnabled, setRemoteCameraEnabled] = useState<Record<string, boolean | null>>({});
  const [controlReady, setControlReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const [syncToast, setSyncToast] = useState<{ success: boolean; message: string } | null>(null);

  // Movie streamer state
  const [isStreaming, setIsStreaming] = useState(false);
  const [movieSrc, setMovieSrc] = useState<string>('');
  const [movieError, setMovieError] = useState('');
  const [movieHelp, setMovieHelp] = useState('');
  const [quality, setQuality] = useState<Quality>('720p');
  const qualityRef = useRef<Quality>(quality);
  qualityRef.current = quality;

  // Movie viewer state
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
  const peersRef = useRef<Map<string, PeerManager>>(new Map());
  const pendingPeerSignalsRef = useRef<Map<string, Array<Record<string, unknown>>>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const camSenderRef = useRef<RTCRtpSender | null>(null);
  const micSenderRef = useRef<RTCRtpSender | null>(null);
  const camSendersRef = useRef<Map<string, RTCRtpSender>>(new Map());
  const micSendersRef = useRef<Map<string, RTCRtpSender>>(new Map());
  const channelRef = useRef<RTCDataChannel | null>(null);
  const channelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const localPeerIdRef = useRef('');
  const streamerPeerIdRef = useRef('');
  const streamerVideoRef = useRef<HTMLVideoElement | null>(null);
  const viewerVideoRef = useRef<HTMLVideoElement | null>(null);
  // Movie senders are kept alive between stop/start to allow replaceTrack()
  const movieVideoSenderRef = useRef<RTCRtpSender | null>(null);
  const movieAudioSenderRef = useRef<RTCRtpSender | null>(null);
  const movieVideoSendersRef = useRef<Map<string, RTCRtpSender>>(new Map());
  const movieAudioSendersRef = useRef<Map<string, RTCRtpSender>>(new Map());
  const movieStreamIdsRef = useRef<Map<string, string>>(new Map());
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
  const lastIceRestartAtRef = useRef<Map<string, number>>(new Map());
  const mountedRef = useRef(false);
  const isCreatorRef = useRef(false);

  function requestIceRestart(manager: PeerManager, remotePeerId: string) {
    const now = Date.now();
    if (now - (lastIceRestartAtRef.current.get(remotePeerId) ?? 0) < 5_000) return;
    lastIceRestartAtRef.current.set(remotePeerId, now);
    manager.restartIce();
  }

  const addReaction = useCallback((emoji: ReactionMessage['emoji']) => {
    const id = ++reactionIdCounter;
    const drift = Math.round((Math.random() - 0.5) * 56);
    setReactions((current) => [...current, { id, emoji, drift }]);
    window.setTimeout(() => setReactions((current) => current.filter((reaction) => reaction.id !== id)), 2_600);
  }, []);

  // ── Control message handler ────────────────────────────────────────

  const handleControlMessage = useCallback((msg: ControlMessage, remotePeerId = '') => {
    if (msg.t === 'cmd') {
      // Apply the viewer's command to the streamer's player.
      const el = streamerVideoRef.current;
      if (!el) return;
      if (msg.action === 'play') {
        void el.play().catch(() => setMovieError('Playback was blocked by the browser. Press Play on the shared player to resume.'));
      } else {
        applyStreamerCommand(el, msg);
      }
    } else if (msg.t === 'state') {
      // Keep the viewer's player in sync with the streamer.
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
      if (remotePeerId) setRemoteCameraEnabled((current) => ({
        ...current,
        [remotePeerId]: trackToggleEnabled(current[remotePeerId] ?? null, msg),
      }));
    } else if (msg.t === 'reaction') {
      addReaction(msg.emoji);
    } else if (msg.t === 'sync-request') {
      const video = streamerVideoRef.current;
      const success = Boolean(video && video.currentSrc && Number.isFinite(video.currentTime));
      if (success && video) broadcastState(!video.paused, video.currentTime);
      sendControl(channelsRef.current.get(remotePeerId) ?? channelRef.current, { t: 'sync-result', requestId: msg.requestId, success });
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
    const syncChannel = streamerPeerIdRef.current
      ? channelsRef.current.get(streamerPeerIdRef.current) ?? null
      : channelRef.current;
    if (!sendControl(syncChannel, { t: 'sync-request', requestId })) {
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

  const registerControlChannel = useCallback((channel: RTCDataChannel, remotePeerId = '') => {
    if (channel.label !== 'control') return;
    if (remotePeerId) channelsRef.current.set(remotePeerId, channel);
    if (!channelRef.current || channelRef.current.readyState !== 'open') channelRef.current = channel;
    onControl(channel, (message) => handleControlMessage(message, remotePeerId));
    const markOpen = () => {
      if (channelRef.current !== channel && channelsRef.current.get(remotePeerId) !== channel) return;
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
      if (channelsRef.current.get(remotePeerId) === channel) channelsRef.current.delete(remotePeerId);
      if (channelRef.current === channel) {
        channelRef.current = channelsRef.current.values().next().value ?? null;
        setControlReady(Boolean(channelRef.current?.readyState === 'open'));
      }
    });
    if (channel.readyState === 'open') markOpen();
  }, [handleControlMessage]);

  const broadcastControl = useCallback((message: ControlMessage) => {
    let sent = false;
    for (const channel of channelsRef.current.values()) sent = sendControl(channel, message) || sent;
    return sent;
  }, []);

  const retuneMovieSenders = useCallback(() => {
    const sourceHeight = streamerVideoRef.current?.videoHeight || 720;
    for (const sender of movieVideoSendersRef.current.values()) {
      void applyQualityToSender(sender, qualityRef.current, sourceHeight, peersRef.current.size);
    }
  }, []);

  // Create one connection for a participant pair only after both are in the room.
  // A new joiner creates connections from the joined roster; existing members
  // create the matching connection when they receive peer-joined.

  const createPeerManager = useCallback(async (polite: boolean, remotePeerId: string) => {
    if (peersRef.current.has(remotePeerId)) return;
    pmCreatedRef.current = true;

    const iceConfig = iceConfigRef.current ?? await fetchIceConfig();
    if (!mountedRef.current) {
      return;
    }
    const sig = sigRef.current;
    if (!sig) {
      return;
    }

    const classifyTrackEvent = (trackEvent: RTCTrackEvent) => {
      const incoming = trackEvent.streams[0];
      if (!incoming) return;
      if (incoming.id === movieStreamIdRef.current) {
        // Show the movie stream in the viewer.
        setViewerMovieStream(incoming);
      } else {
        // Show camera and mic streams in this participant's tile.
        setRemoteCameraStreams((current) => ({ ...current, [remotePeerId]: incoming }));
      }
    };

    const pm = new PeerManager(iceConfig, {
      polite,
      remotePeerId,
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
        registerControlChannel(channel, remotePeerId);
      },

      onConnectionStateChange: (s) => {
        setConnectionState(s);
        // If connection fails, attempt ICE restart to re-establish
        if (s === 'failed') {
          console.warn('[peer] Connection failed. Trying an ICE restart.');
          requestIceRestart(pm, remotePeerId);
        }
        // If connection disconnected (transient), log it
        if (s === 'disconnected') {
          console.warn('[peer] Connection dropped. Waiting for it to recover.');
        }
      },

      onIceConnectionStateChange: (s) => {
        if (s === 'failed') {
          console.warn('[peer] ICE failed. Restarting the connection.');
          requestIceRestart(pm, remotePeerId);
        }
      },
    });

    // Register the control channel as soon as it is created.
    if (!polite && pm.controlChannel) registerControlChannel(pm.controlChannel, remotePeerId);

    peersRef.current.set(remotePeerId, pm);
    const pendingSignals = pendingPeerSignalsRef.current.get(remotePeerId) ?? [];
    pendingPeerSignalsRef.current.delete(remotePeerId);
    for (const pendingSignal of pendingSignals) await pm.handleSignal(pendingSignal);
    if (!peerRef.current) {
      peerRef.current = pm;
      setPc(pm.pc);
    }
    setConnectionState(pm.pc.connectionState);

    // Reattach active local tracks after a peer connection is rebuilt.
    const localMedia = localStreamRef.current;
    for (const track of localMedia?.getTracks() ?? []) {
      if (track.readyState !== 'live' || !localMedia) continue;
      const sender = pm.addTrack(track, localMedia);
      if (track.kind === 'video') { camSendersRef.current.set(remotePeerId, sender); camSenderRef.current ??= sender; }
      else if (track.kind === 'audio') { micSendersRef.current.set(remotePeerId, sender); micSenderRef.current ??= sender; }
    }

    // Keep an active movie capture alive across signaling reconnections.
    const movieStream = movieCaptureStreamRef.current;
    const movieTracks = movieStream?.getTracks().filter((track) => track.readyState === 'live') ?? [];
    if (movieStream && movieTracks.length > 0) {
      if (!outgoingMovieStreamIdRef.current) outgoingMovieStreamIdRef.current = movieStream.id;
      movieStreamIdsRef.current.set(remotePeerId, movieStream.id);
      sig.sendSignal({ type: 'stream-meta', streamId: movieStream.id, kind: 'movie' }, remotePeerId);
      for (const track of movieTracks) {
        const sender = pm.addTrack(track, movieStream);
        if (track.kind === 'video') {
          movieVideoSenderRef.current = sender;
          movieVideoSendersRef.current.set(remotePeerId, sender);
          const sourceHeight = streamerVideoRef.current?.videoHeight || 720;
          window.setTimeout(() => { void applyQualityToSender(sender, qualityRef.current, sourceHeight, peersRef.current.size); }, 500);
        }
        else if (track.kind === 'audio') { movieAudioSenderRef.current = sender; movieAudioSendersRef.current.set(remotePeerId, sender); }
      }
    }
    retuneMovieSenders();
  }, [registerControlChannel, retuneMovieSenders]);

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
        isCreatorRef.current = event.isCreator;
        // Store polite flag and pre-fetch ICE config
        politeRef.current = event.polite;
        localPeerIdRef.current = event.peerId;
        const otherPeers = event.peers.filter((peer) => peer.peerId !== event.peerId);
        setRoomParticipants(otherPeers);
        const otherPeer = otherPeers[0];
        setPeerName(otherPeer?.name ?? '');
        setStatus(otherPeer ? 'connected' : 'waiting');
        setReconnecting(false);
        iceConfigRef.current = await fetchIceConfig();
        if (!mountedRef.current || sigRef.current !== sig) return;

        if (signalingReconnectRef.current) {
          peersRef.current.forEach((pm) => pm.close());
          peersRef.current.clear();
          pendingPeerSignalsRef.current.clear();
          peerRef.current = null;
          setPc(null);
          setConnectionState('new');
          pmCreatedRef.current = false;
          camSenderRef.current = null;
          micSenderRef.current = null;
          camSendersRef.current.clear();
          micSendersRef.current.clear();
          movieVideoSenderRef.current = null;
          movieAudioSenderRef.current = null;
          movieVideoSendersRef.current.clear();
          movieAudioSendersRef.current.clear();
          movieStreamIdsRef.current.clear();
          channelRef.current = null;
          channelsRef.current.clear();
          movieStreamIdRef.current = '';
          setViewerMovieStream(null);
          setRemoteCameraStreams({});
          setRemoteCameraEnabled({});
          setPeerIsStreaming(false);
        }
        signalingReconnectRef.current = false;
        for (const peer of otherPeers) await createPeerManager(event.peerId > peer.peerId, peer.peerId);

      } else if (event.type === 'peer-joined') {
        setPeerName(event.name);
        setRoomParticipants((current) => current.some((p) => p.peerId === event.peerId) ? current : [...current, {peerId: event.peerId, name: event.name}]);
        setStatus('connected');
        await createPeerManager(localPeerIdRef.current > event.peerId, event.peerId);

      } else if (event.type === 'peer-reconnected') {
        setPeerName(event.name);
        peersRef.current.get(event.peerId)?.close();
        pendingPeerSignalsRef.current.delete(event.peerId);
        if (peerRef.current === peersRef.current.get(event.peerId)) peerRef.current = null;
        peersRef.current.delete(event.peerId);
        channelsRef.current.delete(event.peerId);
        camSendersRef.current.delete(event.peerId);
        micSendersRef.current.delete(event.peerId);
        movieVideoSendersRef.current.delete(event.peerId);
        movieAudioSendersRef.current.delete(event.peerId);
        movieStreamIdsRef.current.delete(event.peerId);
        setRemoteCameraStreams((current) => { const next = { ...current }; delete next[event.peerId]; return next; });
        setRemoteCameraEnabled((current) => { const next = { ...current }; delete next[event.peerId]; return next; });
        peerRef.current ??= peersRef.current.values().next().value ?? null;
        retuneMovieSenders();
        setRoomParticipants((current) => current.map((p) => p.peerId === event.peerId ? {...p, name: event.name} : p));
        await createPeerManager(localPeerIdRef.current > event.peerId, event.peerId);

      } else if (event.type === 'peer-left') {
        setRoomParticipants((current) => current.filter((p) => p.peerId !== event.peerId));
        peersRef.current.get(event.peerId)?.close();
        pendingPeerSignalsRef.current.delete(event.peerId);
        peersRef.current.delete(event.peerId);
        channelsRef.current.delete(event.peerId);
        camSendersRef.current.delete(event.peerId);
        micSendersRef.current.delete(event.peerId);
        movieVideoSendersRef.current.delete(event.peerId);
        movieAudioSendersRef.current.delete(event.peerId);
        movieStreamIdsRef.current.delete(event.peerId);
        setRemoteCameraStreams((current) => { const next = { ...current }; delete next[event.peerId]; return next; });
        setRemoteCameraEnabled((current) => { const next = { ...current }; delete next[event.peerId]; return next; });
        peerRef.current = peersRef.current.values().next().value ?? null;
        setPc(peerRef.current?.pc ?? null);
        channelRef.current = channelsRef.current.values().next().value ?? null;
        if (peersRef.current.size === 0) setPeerName('');
        setControlReady([...channelsRef.current.values()].some((channel) => channel.readyState === 'open'));
        if (peersRef.current.size === 0) {
          setControlReady(false);
          setPeerIsStreaming(false);
          setViewerMovieStream(null);
          setStatus('waiting');
        }

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
            streamerPeerIdRef.current = event.fromPeerId;
            setPeerIsStreaming(true);
          } else if (kind === 'movie-ended') {
            if (streamerPeerIdRef.current === event.fromPeerId) streamerPeerIdRef.current = '';
            setPeerIsStreaming(false);
          }
        } else {
          const manager = peersRef.current.get(event.fromPeerId);
          if (manager) {
            await manager.handleSignal(data);
          } else {
            const pending = pendingPeerSignalsRef.current.get(event.fromPeerId) ?? [];
            pending.push(data);
            pendingPeerSignalsRef.current.set(event.fromPeerId, pending);
          }
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
        if (isCreatorRef.current) {
          navigate('/', { replace: true });
        } else {
          mountedRef.current = false;
          peersRef.current.forEach((pm) => pm.close());
          peersRef.current.clear();
          channelsRef.current.clear();
          pendingPeerSignalsRef.current.clear();
          if (localStreamRef.current) stopStream(localStreamRef.current);
          localStreamRef.current = null;
          movieCaptureStreamRef.current?.getTracks().forEach((track) => track.stop());
          movieCaptureStreamRef.current = null;
          setLocalStream(null);
          setRemoteCameraStreams({});
          setRemoteCameraEnabled({});
          setViewerMovieStream(null);
          setRoomEnded(true);
        }

      } else if (event.type === 'delete-denied') {
        setEndingRoom(false);
        setMediaError('Only the room creator can end the room for everyone.');
      } else if (event.type === 'invite-invalid') {
        setStatus('error');
        setErrorMsg('This invite link is no longer valid. Ask the host for a new one.');
      } else if (event.type === 'kicked') {
        setStatus('error');
        setErrorMsg('You were removed from the room by the host.');
      } else if (event.type === 'invite-rotated') {
        setInviteToken(event.inviteToken);
        try { sessionStorage.setItem(`watch-party-invite:${code}`, event.inviteToken); } catch { /* ok */ }
      }
    });

    sig.connect(code, myName, ownerToken, inviteToken);

    return () => {
      off();
      sig.disconnect();
      if (sigRef.current === sig) sigRef.current = null;
      peersRef.current.forEach((pm) => pm.close());
      peersRef.current.clear();
      pendingPeerSignalsRef.current.clear();
      channelsRef.current.clear();
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
        for (const [remotePeerId, pm] of peersRef.current) {
          const existing = camSendersRef.current.get(remotePeerId);
          const sender = existing ?? pm.addTrack(videoTrack, localStreamRef.current);
          if (existing) await pm.replaceTrack(existing, videoTrack);
          camSendersRef.current.set(remotePeerId, sender);
          camSenderRef.current ??= sender;
        }
        broadcastControl({ t: 'track-toggle', kind: 'video', enabled: true });
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
      for (const [remotePeerId, sender] of camSendersRef.current) {
        const pm = peersRef.current.get(remotePeerId);
        if (pm) await pm.replaceTrack(sender, null);
      }
      // Stop the actual camera track so the indicator light goes off
      localStreamRef.current?.getVideoTracks().forEach((track) => {
        localStreamRef.current?.removeTrack(track);
        track.stop();
      });
      setCameraOn(false);
      setLocalStream(new MediaStream(localStreamRef.current?.getTracks() ?? []));
      broadcastControl({ t: 'track-toggle', kind: 'video', enabled: false });
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
      for (const [remotePeerId, sender] of camSendersRef.current) {
        const pm = peersRef.current.get(remotePeerId);
        if (pm) await pm.replaceTrack(sender, nextTrack);
      }
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
        for (const [remotePeerId, pm] of peersRef.current) {
          const existing = micSendersRef.current.get(remotePeerId);
          const sender = existing ?? pm.addTrack(audioTrack, localStreamRef.current);
          if (existing) await pm.replaceTrack(existing, audioTrack);
          micSendersRef.current.set(remotePeerId, sender);
          micSenderRef.current ??= sender;
        }
        broadcastControl({ t: 'track-toggle', kind: 'audio', enabled: true });
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
      for (const [remotePeerId, sender] of micSendersRef.current) {
        const pm = peersRef.current.get(remotePeerId);
        if (pm) await pm.replaceTrack(sender, null);
      }
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        localStreamRef.current?.removeTrack(track);
        track.stop();
      });
      setMicOn(false);
      setLocalStream(new MediaStream(localStreamRef.current?.getTracks() ?? []));
      broadcastControl({ t: 'track-toggle', kind: 'audio', enabled: false });
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
    streamerPeerIdRef.current = localPeerIdRef.current;
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
    for (const remotePeerId of peersRef.current.keys()) {
      if (!movieStreamIdsRef.current.has(remotePeerId)) movieStreamIdsRef.current.set(remotePeerId, stream.id);
      sig.sendSignal({ type: 'stream-meta', streamId: movieStreamIdsRef.current.get(remotePeerId)!, kind: 'movie' }, remotePeerId);
    }

    async function setupTrack(track: MediaStreamTrack) {
      if (generation !== movieCaptureGenerationRef.current || track.readyState !== 'live') return;
      if (track.kind === 'video') {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint = 'motion';
      }

      for (const [remotePeerId, activePm] of peersRef.current) {
        const senders = track.kind === 'video' ? movieVideoSendersRef.current : movieAudioSendersRef.current;
        let sender = senders.get(remotePeerId);
        if (sender) await sender.replaceTrack(track);
        else {
          sender = activePm.addTrack(track, stream);
          senders.set(remotePeerId, sender);
          movieStreamIdsRef.current.set(remotePeerId, stream.id);
        }
        if (track.kind === 'video') {
          movieVideoSenderRef.current ??= sender;
          setTimeout(() => { void applyQualityToSender(sender!, qualityRef.current, sourceHeight, peersRef.current.size); }, 500);
        } else movieAudioSenderRef.current ??= sender;
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
    streamerPeerIdRef.current = '';
    // Mute senders but keep them alive for restart.
    for (const sender of movieVideoSendersRef.current.values()) { try { await sender.replaceTrack(null); } catch { /* ignore */ } }
    for (const sender of movieAudioSendersRef.current.values()) { try { await sender.replaceTrack(null); } catch { /* ignore */ } }
    for (const remotePeerId of peersRef.current.keys()) sigRef.current?.sendSignal({ type: 'stream-meta', streamId: movieStreamIdsRef.current.get(remotePeerId) ?? '', kind: 'movie-ended' }, remotePeerId);
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
      await Promise.all([...movieVideoSendersRef.current.values()].map((sender) => applyQualityToSender(sender, newQuality, sourceHeight, peersRef.current.size)));
    }
  }

  // Viewer sends command to streamer
  function sendPlayCmd(action: 'play' | 'pause' | 'seek', time: number): boolean {
    const commandChannel = streamerPeerIdRef.current
      ? channelsRef.current.get(streamerPeerIdRef.current) ?? null
      : channelRef.current;
    const sent = sendControl(commandChannel, { t: 'cmd', action, time });
    if (sent) pendingPlaybackActionRef.current = { action, time, expiresAt: Date.now() + 3_000 };
    return sent;
  }

  // Streamer broadcasts state to viewer
  function broadcastState(playing: boolean, time: number) {
    const duration = streamerVideoRef.current?.duration ?? 0;
    const safeTime = Number.isFinite(time) && time >= 0 ? time : 0;
    setPlayback({ playing, time: safeTime, duration: Number.isFinite(duration) ? duration : 0 });
    broadcastControl({ t: 'state', playing, time: safeTime, duration: Number.isFinite(duration) ? duration : 0 });
  }

  // Chat
  function handleSendChat(text: string) {
    if (!broadcastControl({ t: 'chat', text: text.slice(0, 500), name: myNameRef.current.slice(0, 30) })) return;
    setChatMessages((prev) => [
      ...prev,
      { id: ++chatIdCounter, name: myNameRef.current, text, mine: true },
    ].slice(-200));
  }

  function handleSendReaction(emoji: ReactionMessage['emoji']) {
    if (!broadcastControl({ t: 'reaction', emoji })) return;
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

  // ── Tab visibility warning for the streamer ────────────────────────
  useEffect(() => {
    const handler = () => setTabHidden(document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // ── Host controls ─────────────────────────────────────────────────
  function handleKick(targetPeerId: string) {
    sigRef.current?.kickPeer(targetPeerId);
  }

  const [rotatingInvite, setRotatingInvite] = useState(false);
  function handleRotateInvite() {
    if (rotatingInvite) return;
    setRotatingInvite(true);
    sigRef.current?.rotateInvite();
    // Reset spinner after 5s in case server is slow
    window.setTimeout(() => setRotatingInvite(false), 5_000);
  }
  // Once invite-rotated arrives, the state update from the event handler above clears rotatingInvite
  useEffect(() => { setRotatingInvite(false); }, [inviteToken]);

  // ── Render ────────────────────────────────────────────────────────

  if (roomEnded) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-950 px-6 text-white">
        <section className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 text-center shadow-2xl">
          <h1 className="flex justify-center"><Brand /></h1>
          <p className="mt-7 text-xs font-semibold uppercase tracking-[0.18em] text-amber-300">Room closed</p>
          <h2 className="mt-2 text-2xl font-semibold">The host ended this watch party.</h2>
          <p className="mt-3 text-sm leading-6 text-gray-400">Your camera and room connection have been turned off. You can return home to start or join another room.</p>
          <button onClick={() => navigate('/', { replace: true })} className="mt-7 rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white transition hover:bg-blue-500">Return home</button>
        </section>
      </main>
    );
  }

  if (status === 'full') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center space-y-4">
          <p className="text-2xl font-bold">Room is full 🚫</p>
          <p className="text-gray-400">This room already has 5 people.</p>
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
  const partyPresence = roomParticipants.length === 0
    ? 'Waiting for more people to join'
    : roomParticipants.length === 1
      ? `${peerName || 'Your friend'} is here`
      : `${roomParticipants.length} guests are here`;
  const otherParticipantsLabel = roomParticipants.length > 1
    ? `${roomParticipants.length} other participants`
    : peerName || 'the other participant';

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
          {isCreator && (
            <button
              onClick={handleRotateInvite}
              disabled={rotatingInvite}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-xs font-medium text-gray-300 transition hover:bg-gray-800 disabled:opacity-50"
              aria-label="Generate a new invite link"
              title="Invalidate the old invite link and generate a new one"
            >
              {rotatingInvite ? '…' : '🔄'}<span className="hidden sm:inline">New invite</span>
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
                    {inviteToken ? `${window.location.origin}/r/${code}?t=${inviteToken}` : window.location.href}
                  </code>
                  <CopyButton value={inviteToken ? `${window.location.origin}/r/${code}?t=${inviteToken}` : window.location.href} className="rounded bg-gray-700 px-3 py-1.5 text-sm text-white hover:bg-gray-600" />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Connected */}
        {(hasPeer || isStreaming) && (
          <div className={`room-stage flex h-full w-full flex-col items-center justify-center gap-4 mx-auto ${!isStreaming && !peerIsStreaming ? 'max-w-6xl' : 'theater-active max-w-5xl'}`}>

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
              <section className="theater-lobby" aria-labelledby="theater-title">
                <div className="theater-proscenium">
                  <div className="theater-bulbs" aria-hidden="true">{Array.from({ length: 13 }, (_, i) => <i key={i} />)}</div>
                  <div className="theater-curtain theater-curtain-left" aria-hidden="true" />
                  <div className="theater-curtain theater-curtain-right" aria-hidden="true" />
                  <div className="theater-screen-frame">
                    <div className="theater-screen-scene">
                      <div className="theater-screen-stars" aria-hidden="true" />
                      <div className="theater-screen-copy">
                        <span className="theater-kicker"><i /> PRIVATE SCREENING <b>·</b> ROOM {code}</span>
                        <div className="theater-film-icon" aria-hidden="true"><Icon name="film" size={22} /></div>
                        <h2 id="theater-title">Your room is ready.</h2>
                        <p>{partyPresence}. Pick a movie when you’re ready.</p>
                        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!movieSupported} className="theater-start-button">
                          <Icon name="film" size={17} /> Choose a movie <span aria-hidden="true">↗</span>
                        </button>
                      </div>
                      <div className="theater-screen-reflection" aria-hidden="true" />
                    </div>
                  </div>
                  <div className="theater-stage-edge" aria-hidden="true" />
                  <div className="theater-seats" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</div>
                  <div className="theater-aisle-glow" aria-hidden="true" />
                </div>
                <div className="theater-lobby-footer"><span className="theater-live-dot" /> {partyPresence} <b>·</b> Share a movie when you’re ready</div>
              </section>
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

        {/* Participant camera tiles */}
        <div className="absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
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
            <div className="grid grid-cols-2 gap-2 overflow-y-auto max-h-[70vh]">
              <CameraTile stream={localStream} label={`${myName} (you)`} muted mirrored />
              {roomParticipants.map((participant) => (
                <div key={participant.peerId} className="relative group">
                  <CameraTile
                    stream={remoteCameraStreams[participant.peerId] ?? null}
                    label={participant.name}
                    videoEnabled={remoteCameraEnabled[participant.peerId] ?? null}
                  />
                  {isCreator && (
                    <button
                      onClick={() => handleKick(participant.peerId)}
                      className="absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded bg-black/60 text-xs text-rose-400 opacity-0 transition hover:bg-black/80 hover:text-rose-200 group-hover:opacity-100 focus-visible:opacity-100"
                      title={`Remove ${participant.name}`}
                      aria-label={`Remove ${participant.name} from room`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
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
        {/* Streamer tab-visibility warning */}
        {isStreaming && tabHidden && (
          <div role="alert" className="fixed bottom-16 left-1/2 z-50 -translate-x-1/2 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-900/90 px-5 py-3 text-sm font-medium text-amber-200 shadow-xl backdrop-blur">
            <span aria-hidden="true">⚠️</span> Keep this tab visible. Minimizing may stutter the stream.
          </div>
        )}
      </main>

      {/* Controls + Chat bar */}
      <div className="theater-controls flex flex-shrink-0 items-center justify-between border-t border-gray-800 bg-gray-900 px-6 py-2">
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
            <p className="mt-2 text-sm leading-6 text-gray-400">This will disconnect you and {otherParticipantsLabel} and close this room.</p>
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
