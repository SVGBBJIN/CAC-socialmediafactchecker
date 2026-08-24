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
      <span className={`badge verdict ${v.css}`}>{v.label}</span>
    </div>
  );
}
