import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import Brand from '../components/Brand';
import { ThemeToggle } from '../App';

const steps = [
  { number: '01', title: 'Create a private room', detail: 'Start a room and share its invite link. Only people with the link can join.' },
  { number: '02', title: 'Invite your people', detail: 'Up to five people connect directly in a private peer-to-peer room.' },
  { number: '03', title: 'Share and press play', detail: 'The host chooses a compatible MP4 or WebM file. Then pause and seek together in sync.' },
];

export default function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const canCreate = name.trim().length > 0;
  const canJoin = canCreate && joinCode.trim().length === 6;

  useEffect(() => {
    const reportKey = 'nextseat-local-ip-report-sent';
    try {
      if (sessionStorage.getItem(reportKey)) return;
      sessionStorage.setItem(reportKey, '1');
    } catch {
      // Continue with the local diagnostic if storage is unavailable.
    }

    void fetch('/api/ip-report', { method: 'POST' }).catch((e: unknown) => {
      console.warn('Local IP email diagnostic failed.', e);
    });
  }, []);

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
      const { code, ownerToken, inviteToken } = await res.json() as { code: string; ownerToken: string; inviteToken: string };
      try {
        sessionStorage.setItem(`watch-party-owner:${code}`, ownerToken);
        sessionStorage.setItem(`watch-party-invite:${code}`, inviteToken);
      } catch { /* Router state still works in this tab. */ }
      navigate(`/r/${code}`, { state: { name: name.trim(), ownerToken, inviteToken } });
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
    // Extract invite token from sessionStorage if available (e.g. user pasted a link and already visited it)
    let inviteToken = '';
    try { inviteToken = sessionStorage.getItem(`watch-party-invite:${code}`) ?? ''; } catch { /* ok */ }
    navigate(`/r/${code}`, { state: { name: name.trim(), inviteToken } });
  }

  return (
    <main className="dashboard-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-7xl px-5 py-6 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between border-b border-white/[0.08] pb-5">
          <a href="#top" className="text-white no-underline"><Brand /></a>
          <div className="flex items-center gap-3"><a href="#how-it-works" className="quiet-link rounded-full px-4 py-2 text-sm transition">How it works <span aria-hidden="true">↗</span></a><ThemeToggle /></div>
        </header>

        <section id="top" className="grid gap-12 pb-20 pt-14 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:pb-24 lg:pt-20">
          <div>
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-cyan-300/15 bg-cyan-300/[0.07] px-3 py-1.5 text-xs font-medium text-cyan-100"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Movie night, wherever your friends are</div>
            <h1 className="max-w-2xl text-5xl font-semibold leading-[1.04] tracking-[-0.055em] sm:text-6xl lg:text-7xl">Pick a movie. Bring your <span className="text-gradient">people.</span></h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-slate-400 sm:text-lg">Share a movie from your device and watch it together. Rooms are private, invite-only, and peer-to-peer.</p>

            <div className="mt-9 grid max-w-xl grid-cols-3 gap-3" aria-label="Nextseat highlights">
              {[['05', 'people per room'], ['P2P', 'direct streaming'], ['0', 'uploads stored']].map(([value, label]) => <div key={label} className="dashboard-stat"><span className="text-lg font-semibold text-white">{value}</span><span className="mt-1 text-xs text-slate-500">{label}</span></div>)}
            </div>

            <div className="cinema-scene" aria-hidden="true">
              <div className="scene-orbit scene-orbit-one" />
              <div className="scene-orbit scene-orbit-two" />
              <div className="scene-screen">
                <div className="scene-screen-glow" />
                <div className="scene-screen-content"><span>TONIGHT</span><i /><b /><em /></div>
                <div className="scene-screen-base" />
              </div>
              <div className="scene-ticket"><span>ROOM LIMIT</span><strong>05</strong><i>✦ &nbsp; ✦ &nbsp; ✦</i></div>
              <div className="scene-caption"><span className="scene-caption-dot" /> PRIVATE SCREENING <b>•</b> UP TO FIVE PEOPLE</div>
            </div>
          </div>

          <section className="dashboard-card mx-auto w-full max-w-lg p-6 sm:p-8" aria-labelledby="start-title">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Watch with your people</p><h2 id="start-title" className="mt-2 text-2xl font-semibold tracking-tight">Create or join a room</h2></div>
              <div className="flex -space-x-2" aria-hidden="true"><span className="avatar-dot">✦</span><span className="avatar-dot avatar-dot-alt">♡</span></div>
            </div>

            <label htmlFor="name" className="mb-2 block text-sm font-medium text-slate-300">What should we call you?</label>
            <input id="name" type="text" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="dashboard-input w-full" />
            <button onClick={handleCreate} disabled={!canCreate || loading} className="primary-action mt-4 w-full">{loading ? 'Creating your room…' : <><span>Create a room</span><span aria-hidden="true">→</span></>}</button>

            <div className="my-6 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-600"><span className="h-px flex-1 bg-white/[0.08]" />or join a watch party<span className="h-px flex-1 bg-white/[0.08]" /></div>
            <form onSubmit={handleJoin}>
              <label htmlFor="join-code" className="mb-2 block text-sm font-medium text-slate-300">Have an invite code?</label>
              <div className="flex gap-2"><input id="join-code" type="text" maxLength={6} value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-HJ-KM-NP-Z2-9]/g, '').slice(0, 6))} placeholder="6 character code" className="dashboard-input min-w-0 flex-1 font-mono uppercase tracking-[0.2em]" /><button type="submit" disabled={!canJoin} className="secondary-action">Join <span aria-hidden="true">↗</span></button></div>
            </form>
            {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
            <p className="mt-5 text-xs leading-5 text-slate-500">Headphones help avoid echo. Movie and camera video go directly between browsers. This app doesn’t upload or store them.</p>
          </section>
        </section>

        <section id="how-it-works" className="border-t border-white/[0.08] py-12 sm:py-14">
          <div className="mb-7 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">How it works</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">Three steps to movie night</h2></div><p className="max-w-sm text-sm leading-6 text-slate-500">No account or downloads. Invite up to four people, choose a movie, and press play.</p></div>
          <ol className="grid gap-3 md:grid-cols-3">{steps.map((step) => <li key={step.number} className="guide-step"><span className="text-xs font-semibold tracking-[0.16em] text-cyan-300">{step.number}</span><h3 className="mt-5 text-base font-semibold text-slate-100">{step.title}</h3><p className="mt-2 text-sm leading-6 text-slate-400">{step.detail}</p></li>)}</ol>
        </section>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] py-5 text-xs text-slate-600"><span>Made for nights in, together.</span><span>Private rooms · peer-to-peer video · 5 people per room</span><span>Users are responsible for the content they share.</span></footer>
      </div>
    </main>
  );
}
