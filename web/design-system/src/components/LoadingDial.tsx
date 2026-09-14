import "./LoadingDial.css";

export type DialVariant = "watching" | "searching" | "compiling";

export interface LoadingDialProps {
  /** Which of the three animated moods to play. */
  variant?: DialVariant;
  /** Paused, dimmed, seal check drawn — what the running card switches to once a turn
   * finishes (`resolveIris` in public/app.js). */
  resolved?: boolean;
}

const TICKS = Array.from({ length: 12 }, (_, i) => i);

/**
 * The loading dial: rings, twelve ticks, a pulsing core and three orbiting nodes — ported
 * from `web/public/index.html`'s `.dial`/`.dial-*` rules and `irisMarkup`/`dialVariant` in
 * `web/public/app.js`, itself ported from the TRASE Design System's own MatrixLoader. This
 * replaces the six-blade "iris" flower the product used before this sync; `.iris-wrap`
 * stays the outer container name (and the settled/resolved state it carries) since nothing
 * about *that* concept changed, only what turns inside it.
 */
export function LoadingDial({ variant = "watching", resolved = false }: LoadingDialProps) {
  return (
    <div className={`iris-wrap${resolved ? " resolved" : ""}`} data-variant={variant} aria-hidden="true">
      <div className="dial">
        <div className="dial-ring r1" />
        <div className="dial-ring r2" />
        <div className="dial-ring r3" />
        <div className="dial-ticks">
          {TICKS.map((i) => (
            <i key={i} style={{ "--i": i, transform: `rotate(${i * 30}deg)` } as React.CSSProperties} />
          ))}
        </div>
        <div className="dial-sweep" />
        <div className="dial-arc" />
        <div className="dial-scan" />
        <div className="dial-core">
          <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <circle cx="32" cy="32" r="21" stroke="var(--accent)" strokeWidth="2.5" strokeDasharray="27 6 27 6" strokeLinecap="round" />
            <line x1="14" y1="32" x2="50" y2="32" stroke="var(--accent)" strokeWidth="1.5" opacity="0.55" />
            <circle cx="32" cy="32" r="6" fill="var(--accent)" />
            <rect x="41" y="28" width="5" height="8" rx="1.5" fill="var(--accent-2)" />
          </svg>
        </div>
        <div className="dial-node n1" />
        <div className="dial-node n2" />
        <div className="dial-node n3" />
      </div>
      <svg className="seal-svg" viewBox="0 0 100 100" aria-hidden="true">
        <path className="seal-check" d="M32 52 L44 64 L70 36" stroke="var(--good)" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
