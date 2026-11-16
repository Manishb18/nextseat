export default function Brand({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  return (
    <span className={`nextseat-brand ${className}`}>
      <span className="nextseat-mark" aria-hidden="true">
        <svg viewBox="0 0 40 40" fill="none">
          <path d="M10 8v13a5 5 0 0 0 5 5h13M30 7v10a5 5 0 0 1-5 5h-8" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
          <path d="m17 26 8 4.5-8 4.5V26Z" fill="currentColor" />
        </svg>
      </span>
      {!compact && <span className="nextseat-wordmark">Nextseat<span>.</span></span>}
    </span>
  );
}
