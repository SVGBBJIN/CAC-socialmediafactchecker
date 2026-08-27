import "./VerdictBadge.css";

/** The closed four-verdict vocabulary — kept in sync with public/claims.js's VERDICTS map
 * and the FACT_CHECK_SYSTEM_PROMPT in lib/verified-chat.js. Don't add a fifth. */
export type VerdictKey = "contradicted" | "disputed" | "corroborated" | "insufficient";

const VERDICTS: Record<VerdictKey, { label: string; css: "bad" | "warn" | "good" | "muted" }> = {
  contradicted: { label: "Contradicted", css: "bad" },
  disputed: { label: "Disputed", css: "warn" },
  corroborated: { label: "Corroborated", css: "good" },
  insufficient: { label: "Insufficient evidence", css: "muted" },
};

/** One glyph per verdict color, not per verdict key — `v.css` is already the axis
 * everything else (background, border, text color) keys off. Decorative; the badge's own
 * text is what a screen reader announces. */
const BADGE_ICONS: Record<"bad" | "warn" | "good" | "muted", JSX.Element> = {
  bad: <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" fill="none" />,
  warn: <path d="M12 4l9 16H3z M12 10v4 M12 17.2v.1" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  good: <path d="M4 12.5l5 5L20 6" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  muted: <path d="M9 9a3 3 0 116 0c0 2-3 2.5-3 5 M12 17.5v.1" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />,
};

export interface VerdictBadgeProps {
  /** Which of the four closed verdicts to render. */
  verdict: VerdictKey;
}

/**
 * The verdict pill a fact-check card ends on — one of Contradicted, Disputed,
 * Corroborated, or Insufficient evidence. Renders both the whole-answer badge
 * (`verdictHTML`) and each claim's own badge in the split-panes layout use.
 */
export function VerdictBadge({ verdict }: VerdictBadgeProps) {
  const v = VERDICTS[verdict];
  return (
    <div className="badges">
      <span className={`badge verdict ${v.css}`}>
        <svg className="badge-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">{BADGE_ICONS[v.css]}</svg>
        {v.label}
      </span>
    </div>
  );
}
