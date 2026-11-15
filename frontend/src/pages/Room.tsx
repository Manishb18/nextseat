import { useEffect, useRef, useState } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { SignalingClient } from '../lib/signaling';

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

  const [myName] = useState(() => state?.name ?? 'Guest');
  const [status, setStatus] = useState<'connecting' | 'connected' | 'full' | 'error'>('connecting');
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const sigRef = useRef<SignalingClient | null>(null);

  useEffect(() => {
    if (!code) return;
    // Redirect to home if no name was provided
    if (!state?.name) {
      navigate('/', { replace: true });
      return;
    }

    const sig = new SignalingClient();
    sigRef.current = sig;

    const off = sig.on((event) => {
      switch (event.type) {
        case 'joined':
          setStatus('connected');
          setPeers(event.peers);
          break;
        case 'peer-joined':
          setPeers((prev) => [...prev, { peerId: event.peerId, name: event.name }]);
          break;
        case 'peer-left':
          setPeers((prev) => prev.filter((p) => p.peerId !== event.peerId));
          break;
        case 'room-full':
          setStatus('full');
          break;
        case 'error':
          setStatus('error');
          setErrorMsg(event.message);
          break;
      }
    });

    sig.connect(code, myName);

    return () => {
      off();
      sig.disconnect();
    };
  }, [code, myName, navigate, state]);

  if (status === 'full') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center space-y-4">
          <p className="text-2xl font-bold">Room is full 🚫</p>
          <p className="text-gray-400">This room already has 2 people.</p>
          <button
            onClick={() => navigate('/')}
            className="rounded-lg bg-blue-600 px-6 py-2 font-semibold hover:bg-blue-500"
          >
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
          <button
            onClick={() => navigate('/')}
            className="rounded-lg bg-blue-600 px-6 py-2 font-semibold hover:bg-blue-500"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 text-white">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold">🎬 Watch Party</span>
          <span className="rounded bg-gray-800 px-2 py-0.5 font-mono text-sm text-gray-400">
            {code}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">
            {status === 'connecting' ? '⏳ Connecting…' : `👤 ${myName}`}
          </span>
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 items-center justify-center p-6">
        {status === 'connecting' ? (
          <div className="text-center space-y-4">
            <div className="text-4xl animate-pulse">⏳</div>
            <p className="text-gray-400">Joining room {code}…</p>
          </div>
        ) : (
          <div className="text-center space-y-6 max-w-md">
            <p className="text-xl font-semibold">Room {code}</p>
            {peers.length <= 1 ? (
              <div className="rounded-xl bg-gray-900 p-6 space-y-2">
                <p className="text-gray-400">Waiting for someone to join…</p>
                <p className="text-sm text-gray-500">
                  Share this code with your friend:{' '}
                  <span className="font-mono font-bold text-white">{code}</span>
                </p>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(`${window.location.origin}/r/${code ?? ''}`);
                  }}
                  className="mt-2 w-full rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium hover:bg-gray-600"
                >
                  Copy invite link
                </button>
              </div>
            ) : (
              <div className="rounded-xl bg-gray-900 p-6 space-y-2">
                <p className="text-green-400 font-semibold">✅ Both people are here!</p>
                <div className="space-y-1 text-sm text-gray-400">
                  {peers.map((p) => (
                    <p key={p.peerId}>👤 {p.name}</p>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Camera, mic, and movie sharing coming next.
                </p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
