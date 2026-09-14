import "./BrandHud.css";

const TICKS = Array.from({ length: 12 }, (_, i) => i);

/**
 * The brand HUD: scan rings orbited by four labelled pills ("Sources"/"Context"/"Facts"/
 * "Clarity") — ported from `web/public/index.html`'s `.brand-hud*` rules and
 * `brandHudMarkup` in `web/public/app.js`, itself ported from the TRASE Design System's own
 * Matrix. Used for the claims pane's empty/landing state (see the product's `renderChatPane`)
 * — unlike `LoadingDial`, this one never switches variant and keeps turning gently on its
 * own (the middle ring's slow rotation, the core's own pulse) since there's no pipeline
 * stage to represent before a check has even started.
 */
export function BrandHud() {
  return (
    <div className="brand-hud" aria-hidden="true">
      <div className="brand-hud-cluster">
        <div className="brand-hud-ring m1" />
        <div className="brand-hud-ring m2" />
        <div className="brand-hud-ring m3" />
        <div className="brand-hud-ticks">
          {TICKS.map((i) => (
            <i key={i} style={{ transform: `rotate(${i * 30}deg)` }} />
          ))}
        </div>
        <div className="brand-hud-core">
          <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <circle cx="32" cy="32" r="21" stroke="var(--accent)" strokeWidth="2.5" strokeDasharray="27 6 27 6" strokeLinecap="round" />
            <line x1="14" y1="32" x2="50" y2="32" stroke="var(--accent)" strokeWidth="1.5" opacity="0.55" />
            <circle cx="32" cy="32" r="6" fill="var(--accent)" />
            <rect x="41" y="28" width="5" height="8" rx="1.5" fill="var(--accent-2)" />
          </svg>
        </div>
        <div className="brand-hud-node n1" />
        <div className="brand-hud-node n2" />
        <div className="brand-hud-node n3" />
      </div>
      <span className="brand-hud-pill sources">Sources</span>
      <span className="brand-hud-pill context">Context</span>
      <span className="brand-hud-pill facts">Facts</span>
      <span className="brand-hud-pill clarity">Clarity</span>
    </div>
  );
}
