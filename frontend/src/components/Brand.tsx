export default function Brand({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
  return (
    <span className={`nextseat-brand ${className}`}>
      <span className="nextseat-mark" aria-hidden="true">
        <svg viewBox="0 0 40 40" fill="none">
          <path d="M11 7.5v14.25c0 2.35 1.9 4.25 4.25 4.25H28" stroke="currentColor" strokeWidth="3.25" strokeLinecap="round" />
          <path d="M29 5.5v11.75c0 2.35-1.9 4.25-4.25 4.25H18" stroke="currentColor" strokeWidth="3.25" strokeLinecap="round" />
          <path d="m17 27 8 4.5-8 4.5V27Z" fill="#a5f3fc" />
        </svg>
      </span>
      {!compact && <span className="nextseat-wordmark">Nextseat<span>.</span></span>}
    </span>
  );
}
