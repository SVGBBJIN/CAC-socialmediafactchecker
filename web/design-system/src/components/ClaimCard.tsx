import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./ClaimCard.css";
import { VerdictBadge, type VerdictKey } from "./VerdictBadge";
import { SourcePills, type Source } from "./SourcePill";

const BLADE_ROTATIONS = [0, 60, 120, 180, 240, 300];

/**
 * The busy mark. `resolved` is the settled state — blades stopped and dimmed, seal drawn —
 * which is what the empty card holds behind its line and what the running card switches to
 * when a turn finishes. Mirrors `irisMarkup` in public/app.js.
 */
export function Iris({ resolved }: { resolved?: boolean }) {
  return (
    <div className={`iris-wrap${resolved ? " resolved" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 100 100">
        <g>
          {BLADE_ROTATIONS.map((rot) => (
            <rect
              key={rot}
              className="blade"
              style={{ "--rot": `${rot}deg` } as CSSProperties}
              x="46"
              y="10"
              width="8"
              height="34"
              rx="4"
            />
          ))}
        </g>
        <path
          className="seal-check"
          d="M32 52 L44 64 L70 36"
          stroke="var(--good)"
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** Adds the `.in` class a frame after mount, the way `revealIn` (public/app.js) does — the
 * title, analysis text and claim count all start at opacity 0 and fade in from there. */
function useRevealed() {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return revealed;
}

/**
 * Pointer-driven 3D tilt plus the violet glare that follows the cursor. Skipped outright
 * under `prefers-reduced-motion`: a tilt is a flourish, not information, so it is the first
 * thing to go. The product does the same thing with a delegated listener on the claims pane
 * (`handleCardTilt`), because its cards are torn down and rebuilt as a check streams in.
 */
function useTilt() {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  const [glareStyle, setGlareStyle] = useState<CSSProperties>({ opacity: 0 });
  const enabled = useRef(true);
  useEffect(() => {
    enabled.current = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!enabled.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    setStyle({
      transform: `perspective(900px) rotateX(${(0.5 - py) * 4.5}deg) rotateY(${(px - 0.5) * 4.5}deg) scale3d(1.006,1.006,1.006)`,
    });
    setGlareStyle({
      opacity: 1,
      background: `radial-gradient(circle at ${px * 100}% ${py * 100}%, rgba(156,140,240,0.12), transparent 60%)`,
    });
  };
  const onMouseLeave = () => {
    setStyle({ transform: "perspective(900px) rotateX(0deg) rotateY(0deg) scale3d(1,1,1)" });
    setGlareStyle((current) => ({ ...current, opacity: 0 }));
  };
  return { ref, style, glareStyle, onMouseMove, onMouseLeave };
}

/** Which state the card is in. Omit for a finished claim. */
export type ClaimCardLoading = "empty" | "spinner" | "resolved" | "found" | "skeleton";

export interface ClaimCardProps {
  /** Position label in a claim-grid box, e.g. "Claim 2 of 4" — omit for the whole-answer
   * card, where there's no set of same-shape siblings to distinguish it from. */
  eyebrow?: ReactNode;
  /** Still being checked — the accent-tinted pending eyebrow state. */
  pending?: boolean;
  /** The claim's own text, reproducing the `[[claim: …]]` marker. */
  title?: string;
  /** The analysis body. Timestamp chips and citation links are composed as children of
   * this prose (rendered from lib/citation-cleanup.js-cleaned markdown in the product);
   * pass rendered ReactNode here rather than a raw string. */
  children?: ReactNode;
  verdict?: VerdictKey;
  sources?: Source[];
  /** Which in-flight state to draw instead of a finished claim. */
  loading?: ClaimCardLoading;
  /** "spinner": what the check is doing right now. */
  stageText?: string;
  /** "spinner": how many sources have been retrieved into the ledger so far. */
  sourceCount?: number;
  /** "spinner": the live elapsed clock, already formatted ("1:04"). */
  elapsedTime?: string;
  /** "spinner": 0–100, the eased perceived-progress bar. */
  progress?: number;
  /** "found": how many claims the model named. */
  claimCount?: number;
  /** "empty": the invitation over the settled iris. */
  emptyText?: string;
}

/**
 * One box in the split-panes claim feed, and every state it passes through on the way
 * there. The product's `claimPanesHTML` renders one of these per `[[claim: …]]` marker the
 * model wrote; `splitClaims` (public/claims.js) is what does that splitting, never
 * sentence-level guessing.
 */
export function ClaimCard({
  eyebrow,
  pending,
  title,
  children,
  verdict,
  sources,
  loading,
  stageText,
  sourceCount,
  elapsedTime,
  progress,
  claimCount,
  emptyText = "Paste a link or ask a question to get started.",
}: ClaimCardProps) {
  const revealed = useRevealed();
  const tilt = useTilt();

  const shell = (className: string, body: ReactNode) => (
    <div
      className={className}
      ref={tilt.ref}
      style={tilt.style}
      onMouseMove={tilt.onMouseMove}
      onMouseLeave={tilt.onMouseLeave}
    >
      <div className="tilt-glare" style={tilt.glareStyle} />
      {body}
    </div>
  );

  if (loading === "empty") {
    return shell(
      "claim-card claim-empty",
      <div className="card-loading">
        <div className="empty-stack">
          <Iris resolved />
          <p className="claim-empty-text">{emptyText}</p>
        </div>
      </div>,
    );
  }

  if (loading === "found") {
    return shell(
      "claim-card",
      <div className="card-loading">
        {/* Still turning, not resolved: naming a count is not the same as being done — the
         * check keeps running after this moment, and an iris that stopped here would say
         * otherwise. This was the design system's own fix (it used to show the bare number
         * alone), ported into the product as the same gap in its claim-grid status strip:
         * see `claimGridStatusHTML` in public/app.js. */}
        <Iris />
        <div className={`found-count${revealed ? " in" : ""}`}>{claimCount ?? 0}</div>
        <div className="status-text">{claimCount === 1 ? "claim found" : "claims found"}</div>
      </div>,
    );
  }

  if (loading === "spinner" || loading === "resolved") {
    const resolved = loading === "resolved";
    return shell(
      "claim-card",
      <div className="card-loading">
        <Iris resolved={resolved} />
        {/* `role="status"` on the stage line and nowhere else in this card: it is the one
            node whose text says what the check is doing. The clock and the bar tick every
            second and would drown it out. */}
        <div className="status-text stage-text" role="status">
          {resolved ? "Verified." : stageText || "Sending to the model…"}
        </div>
        <div className="source-counter">{sourceCount ? `Source ${sourceCount}` : " "}</div>
        <div className="elapsed-time">{elapsedTime || "0:00"}</div>
        {resolved ? null : (
          <div className="mini-progress wide">
            <div className="mini-progress-bar" style={{ width: `${progress ?? 30}%` }} />
          </div>
        )}
      </div>,
    );
  }

  if (loading === "skeleton") {
    return shell(
      "claim-card",
      <>
        {eyebrow ? <span className="claim-eyebrow pending">{eyebrow}</span> : null}
        {title ? <h3 className="claim-title in">{title}</h3> : null}
        <div className="skeleton-body" aria-hidden="true">
          <span className="skeleton-line" />
          <span className="skeleton-line" />
          <span className="skeleton-line short" />
        </div>
      </>,
    );
  }

  return shell(
    "claim-card",
    <>
      {eyebrow ? <span className={`claim-eyebrow${pending ? " pending" : ""}`}>{eyebrow}</span> : null}
      {title ? <h3 className={`claim-title${revealed ? " in" : ""}`}>{title}</h3> : null}
      <div className={`claim-text${revealed ? " in" : ""}`}>{children}</div>
      {verdict ? <VerdictBadge verdict={verdict} /> : null}
      {sources?.length ? <SourcePills sources={sources} /> : null}
    </>,
  );
}
