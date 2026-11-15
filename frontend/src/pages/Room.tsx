import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { SignalingClient } from '../lib/signaling';
import { PeerManager, type IceConfig } from '../lib/peer';
import { getLocalMedia, stopStream, setTrackEnabled } from '../lib/media';
import { onControl, sendControl } from '../lib/controls';
import CameraTile from '../components/CameraTile';
import Controls from '../components/Controls';

interface LocationState {
  name?: string;
}

interface PeerInfo {
  peerId: string;
  name: string;
}

type Quality = '480p' | '720p' | '1080p';

/** Check if captureStream is available in this browser. */
function canCaptureStream(): boolean {
  const proto = HTMLMediaElement.prototype as HTMLMediaElement & {
    mozCaptureStream?: () => MediaStream;
  };
  return typeof proto.captureStream === 'function' ||
    typeof proto.mozCaptureStream === 'function';
}

export default function Room() {
  const { code } = useParams<{ code: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LocationState | null;
  const myName = state?.name ?? 'Guest';

  // Connection state
  const [status, setStatus] = useState<'connecting' | 'connected' | 'full' | 'error'>('connecting');
  const [connState, setConnState] = useState<RTCPeerConnectionState>('new');
  const [errorMsg, setErrorMsg] = useState('');
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [peerName, setPeerName] = useState('');

  // Media state
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteCamHidden, setRemoteCamHidden] = useState(false);

  // Movie state
  const [isStreaming, setIsStreaming] = useState(false);
  const [quality, setQuality] = useState<Quality>('720p');
  const movieSupported = canCaptureStream();

  // Refs for mutable objects that shouldn't trigger re-renders
  const sigRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<PeerManager | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const camSenderRef = useRef<RTCRtpSender | null>(null);
  const micSenderRef = useRef<RTCRtpSender | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);

  // ── Setup signaling + peer connection ──────────────────────────────

  useEffect(() => {
    if (!code || !state?.name) {
      navigate('/', { replace: true });
      return;
    }

    const sig = new SignalingClient();
    sigRef.current = sig;

    // Fetch ICE config and create peer connection after joining
    const off = sig.on(async (event) => {
      if (event.type === 'joined') {
        setStatus('connected');
        setPeers(event.peers);

        // Fetch ICE config from backend
        let iceConfig: IceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
        try {
          const res = await fetch('/api/ice-config');
          if (res.ok) iceConfig = await res.json() as IceConfig;
        } catch {
          // Fall back to default STUN
        }

        const pm = new PeerManager(iceConfig, {
          polite: event.polite,
          signaling: sig,

          onTrack: (trackEvent) => {
            // Build a remote stream from incoming tracks
            const stream = trackEvent.streams[0];
            if (stream) setRemoteStream(stream);
          },

          onDataChannel: (channel) => {
            if (channel.label === 'control') {
              channelRef.current = channel;
              onControl(channel, (msg) => {
                // Phase 4: handle commands
                console.debug('[control]', msg);
              });
            }
          },

          onConnectionStateChange: (s) => {
            setConnState(s);
          },

          onIceConnectionStateChange: (s) => {
            // ICE restart on failure
            if (s === 'failed') {
              pm.restartIce();
            }
          },
        });

        // If impolite, the data channel is already created inside PeerManager
        if (!event.polite && pm.controlChannel) {
          channelRef.current = pm.controlChannel;
        }

        peerRef.current = pm;

      } else if (event.type === 'peer-joined') {
        setPeers((prev) => [...prev, { peerId: event.peerId, name: event.name }]);
        setPeerName(event.name);

      } else if (event.type === 'peer-left') {
        setPeers((prev) => prev.filter((p) => p.peerId !== event.peerId));
        setPeerName('');
        setRemoteStream(null);

      } else if (event.type === 'room-full') {
        setStatus('full');

      } else if (event.type === 'signal') {
        // Route signaling messages to the peer manager
        await peerRef.current?.handleSignal(event.data);

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

  // ── Camera toggle ──────────────────────────────────────────────────

  const handleToggleCamera = useCallback(async () => {
    const pc = peerRef.current;
    if (!pc) return;

    if (!cameraOn) {
      // Turn camera on
      try {
        const { stream, videoTrack } = await getLocalMedia(true, false);
        if (!videoTrack) return;
        setLocalStream((prev) => {
          if (prev) {
            prev.addTrack(videoTrack);
            return prev;
          }
          return stream;
        });
        localStreamRef.current = localStreamRef.current ?? stream;
        const sender = pc.addTrack(videoTrack, localStreamRef.current ?? stream);
        camSenderRef.current = sender;
        setCameraOn(true);
        sendControl(channelRef.current, { t: 'track-toggle', kind: 'video', enabled: true });
      } catch (err) {
        console.error('[media] camera error', err);
      }
    } else {
      // Turn camera off
      if (camSenderRef.current) {
        pc.removeTrack(camSenderRef.current);
        camSenderRef.current = null;
      }
      setCameraOn(false);
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'video', enabled: false });
    }
  }, [cameraOn]);

  // ── Mic toggle ────────────────────────────────────────────────────

  const handleToggleMic = useCallback(async () => {
    const pc = peerRef.current;
    if (!pc) return;

    if (!micOn) {
      try {
        const { stream, audioTrack } = await getLocalMedia(false, true);
        if (!audioTrack) return;
        const sender = pc.addTrack(audioTrack, localStreamRef.current ?? stream);
        micSenderRef.current = sender;
        setMicOn(true);
        sendControl(channelRef.current, { t: 'track-toggle', kind: 'audio', enabled: true });
      } catch (err) {
        console.error('[media] mic error', err);
      }
    } else {
      if (micSenderRef.current) {
        pc.removeTrack(micSenderRef.current);
        micSenderRef.current = null;
      }
      setMicOn(false);
      sendControl(channelRef.current, { t: 'track-toggle', kind: 'audio', enabled: false });
    }
  }, [micOn]);

  // ── Movie sharing (placeholder, fully implemented in Phase 3) ──────

  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleShareMovie() {
    fileInputRef.current?.click();
  }

  function handleStopSharing() {
    setIsStreaming(false);
  }

  // ── Render ────────────────────────────────────────────────────────

  if (status === 'full') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center space-y-4">
          <p className="text-2xl font-bold">Room is full 🚫</p>
          <p className="text-gray-400">This room already has 2 people.</p>
          <button onClick={() => navigate('/')} className="rounded-lg bg-blue-600 px-6 py-2 font-semibold hover:bg-blue-500">
            Go Home
          </button>
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
          <button onClick={() => navigate('/')} className="rounded-lg bg-blue-600 px-6 py-2 font-semibold hover:bg-blue-500">
            Go Home
          </button>
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
          {/* Connection badge placeholder — Phase 4 */}
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            connState === 'connected' ? 'bg-green-900 text-green-300' :
            connState === 'failed'    ? 'bg-red-900 text-red-300' :
            'bg-yellow-900 text-yellow-300'
          }`}>
            {connState === 'new' || connState === 'checking' ? '⏳ Connecting' :
             connState === 'connected' ? '🟢 Connected' :
             connState === 'disconnected' ? '🔴 Disconnected' :
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
            <div className="rounded-xl bg-gray-900 p-6 space-y-2">
              <p className="text-gray-400">Waiting for someone to join…</p>
              <p className="text-sm text-gray-500">
                Share this link with your friend:
              </p>
              <div className="flex gap-2">
                <code className="flex-1 truncate rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-300">
                  {window.location.href}
                </code>
                <button
                  onClick={() => { void navigator.clipboard.writeText(window.location.href); }}
                  className="rounded bg-gray-700 px-3 py-1.5 text-sm hover:bg-gray-600"
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Both peers connected */
          <div className="flex h-full w-full items-center justify-center">
            <p className="text-gray-500 text-sm">
              {peerName ? `🟢 ${peerName} is here` : '🟢 Both people connected'}
              — movie player appears in Phase 3
            </p>
          </div>
        )}

        {/* Camera tiles — floating top-right */}
        <div className="absolute right-4 top-4 flex flex-col gap-2">
          {/* Local camera */}
          <CameraTile
            stream={localStream}
            label={`${myName} (you)`}
            muted
            mirrored
          />
          {/* Remote camera */}
          {hasPeer && !remoteCamHidden && (
            <CameraTile
              stream={remoteStream}
              label={peerName || 'Peer'}
              onHide={() => setRemoteCamHidden(true)}
            />
          )}
          {/* Show remote camera button */}
          {hasPeer && remoteCamHidden && (
            <button
              onClick={() => setRemoteCamHidden(false)}
              className="rounded-xl bg-gray-800 px-3 py-2 text-xs text-gray-400 hover:bg-gray-700"
            >
              Show camera
            </button>
          )}
        </div>
      </main>

      {/* Controls bar */}
      <Controls
        cameraOn={cameraOn}
        micOn={micOn}
        onToggleCamera={() => { void handleToggleCamera(); }}
        onToggleMic={() => { void handleToggleMic(); }}
        canShareMovie={movieSupported}
        isStreaming={isStreaming}
        onShareMovie={handleShareMovie}
        onStopSharing={handleStopSharing}
        quality={quality}
        onQualityChange={setQuality}
        showQuality={isStreaming}
      />

      {/* Hidden file input for movie picking (Phase 3) */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp4,.webm,.mov,.mkv"
        className="hidden"
      />
    </div>
  );
}
