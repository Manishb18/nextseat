import { useEffect, useRef, useState } from 'react';

export default function CopyButton({ value, className = '', idleLabel = 'Copy' }: { value: string; className?: string; idleLabel?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus('copied');
    } catch {
      setStatus('error');
    }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setStatus('idle'), 1800);
  }

  const label = status === 'copied' ? 'Copied!' : status === 'error' ? 'Copy failed' : idleLabel;
  return (
    <button type="button" onClick={() => { void copy(); }} className={`copy-feedback ${className} ${status === 'copied' ? 'copy-feedback-success' : ''}`} aria-live="polite" aria-label={label}>
      <span key={status} className="copy-feedback-label">{status === 'copied' && <span aria-hidden="true">✓ </span>}{label}</span>
    </button>
  );
}
