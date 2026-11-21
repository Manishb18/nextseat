import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Brand from '../components/Brand';
import { ThemeToggle } from '../App';

type Step = 'ready' | 'quiz';

export default function Welcome() {
  const navigate = useNavigate();
  const countedVisit = useRef(false);
  const [step, setStep] = useState<Step>('ready');
  const [clickedNo, setClickedNo] = useState(false);
  const [facial, setFacial] = useState('');
  
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

  useEffect(() => {
    if (countedVisit.current) return;
    countedVisit.current = true;
    try {
      const visitKey = 'nextseat-welcome-visits';
      const visits = Number.parseInt(localStorage.getItem(visitKey) ?? '0', 10) || 0;
      if (visits >= 2) {
        navigate('/home', { replace: true });
      } else {
        localStorage.setItem(visitKey, String(visits + 1));
      }
    } catch {
      // Keep the welcome flow usable when browser storage is unavailable.
    }
  }, [navigate]);

  return (
    <main className="welcome-shell flex min-h-screen flex-col px-5 py-6 text-[var(--ink)] sm:px-8">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between">
        <Brand />
        <ThemeToggle />
      </header>

      <section className="welcome-card mx-auto my-auto w-full max-w-xl p-7 sm:p-10" aria-live="polite">
        <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface-raised)] px-3 py-1.5 text-xs font-medium text-[var(--muted)]">
          <span aria-hidden="true">🍿</span> A very official pre-party check
        </div>

        {step === 'ready' && (
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--accent)]">Welcome, you</p>
            <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Hi… welcome to the watch party app.</h1>
            <p className="mt-4 text-base leading-7 text-[var(--muted)]">There are a couple of very important questions before movie night. Are you ready?</p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => setStep('quiz')} className="primary-action w-full">Yes, let’s go <span aria-hidden="true">→</span></button>
              <button type="button" onClick={() => { setClickedNo(true); setStep('quiz'); }} className="secondary-action w-full">No, I’m not ready</button>
            </div>
          </div>
        )}

        {step === 'quiz' && (
          <form onSubmit={(event) => { event.preventDefault(); if (facial) navigate('/home'); }}>
            {clickedNo && <div className="mb-7 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] p-4"><p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--accent)]">Called it</p><p className="mt-2 text-lg font-semibold">I knew you would click “No.”</p><p className="mt-1 text-sm leading-6 text-[var(--muted)]">That was the right answer. You passed the first extremely scientific test.</p></div>}
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--accent)]">Final eligibility check</p>
            <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">What do you use for facial?</h1>
            <label htmlFor="facial" className="mb-2 mt-7 block text-sm font-medium">Choose your answer</label>
            <select id="facial" required value={facial} onChange={(event) => setFacial(event.target.value)} className="dashboard-input w-full">
              <option value="" disabled>Select one…</option>
              <option value="Peda">Peda</option>
              <option value="cowdung">cowdung</option>
              <option value="penda">penda</option>
            </select>
            <button type="submit" disabled={!facial} className="primary-action mt-7 w-full">Unlock the watch party <span aria-hidden="true">→</span></button>
            <p className="mt-4 text-center text-xs text-[var(--muted)]">No wrong answers. Probably.</p>
          </form>
        )}
      </section>
      <footer className="mx-auto mt-8 w-full max-w-5xl text-center text-xs text-[var(--muted)]">Made with questionable judgment and lots of affection.</footer>
    </main>
  );
}
