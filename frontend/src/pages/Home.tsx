import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const canCreate = name.trim().length > 0;
  const canJoin = name.trim().length > 0 && joinCode.trim().length === 6;

  async function handleCreate() {
    if (!canCreate) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error === 'rate_limited' ? 'Too many rooms created. Wait a moment.' : 'Failed to create room');
      }
      const { code, ownerToken } = await res.json() as { code: string; ownerToken: string };
      try { sessionStorage.setItem(`watch-party-owner:${code}`, ownerToken); } catch { /* Router state still works in this tab. */ }
      navigate(`/r/${code}`, { state: { name: name.trim(), ownerToken } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create room');
    } finally {
      setLoading(false);
    }
  }

  function handleJoin(e: FormEvent) {
    e.preventDefault();
    if (!canJoin) return;
    const code = joinCode.trim().toUpperCase();
    navigate(`/r/${code}`, { state: { name: name.trim() } });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
      <div className="w-full max-w-md space-y-8 px-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight">🎬 Watch Party</h1>
          <p className="mt-2 text-gray-400">
            Watch movies together, right in your browser.
          </p>
        </div>

        {/* Name input */}
        <div className="space-y-4 rounded-xl bg-gray-900 p-6 shadow-lg">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-300">
              Your name
            </label>
            <input
              id="name"
              type="text"
              maxLength={30}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              className="mt-1 w-full rounded-lg bg-gray-800 px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Headphones notice */}
          <p className="text-xs text-gray-500">
            🎧 Use headphones to avoid echo during voice chat.
          </p>
        </div>

        {/* Create Room */}
        <div className="rounded-xl bg-gray-900 p-6 shadow-lg">
          <button
            onClick={handleCreate}
            disabled={!canCreate || loading}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Creating…' : 'Create Room'}
          </button>
        </div>

        {/* Divider */}
        <div className="flex items-center gap-4">
          <div className="h-px flex-1 bg-gray-800" />
          <span className="text-sm text-gray-500">or join with a code</span>
          <div className="h-px flex-1 bg-gray-800" />
        </div>

        {/* Join Room */}
        <form
          onSubmit={handleJoin}
          className="rounded-xl bg-gray-900 p-6 shadow-lg"
        >
          <div className="flex gap-3">
            <input
              type="text"
              maxLength={6}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-HJ-KM-NP-Z2-9]/g, '').slice(0, 6))}
              aria-label="Six-character room code"
              placeholder="ROOM CODE"
              className="flex-1 rounded-lg bg-gray-800 px-4 py-2.5 font-mono text-lg tracking-widest text-white placeholder-gray-500 uppercase focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              type="submit"
              disabled={!canJoin}
              className="rounded-lg bg-green-600 px-6 py-2.5 font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Join
            </button>
          </div>
        </form>

        {/* Error */}
        {error && (
          <p className="text-center text-sm text-red-400">{error}</p>
        )}
      </div>
    </div>
  );
}
