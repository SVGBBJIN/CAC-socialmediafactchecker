import "./SummaryCard.css";
import type { VerdictKey } from "./VerdictBadge";

/** The rows, in this order, always all four — the closed vocabulary from
 * public/claims.js's VERDICTS. The design system's own card names a fifth
 * ("Misleading"/"Supported"/"Unverifiable"); this mirrors the product, which cannot add
 * one on this side alone without the prompt and the badge map disagreeing. */
const STATS: { key: VerdictKey; label: string; css: "bad" | "warn" | "good" | "muted" }[] = [
  { key: "contradicted", label: "Contradicted", css: "bad" },
  { key: "disputed", label: "Disputed", css: "warn" },
  { key: "corroborated", label: "Corroborated", css: "good" },
  { key: "insufficient", label: "Insufficient evidence", css: "muted" },
];

export interface SummaryCardProps {
  title?: string;
  /** How many claims landed on each verdict. A claim whose verdict never parsed counts
   * toward `total` and toward none of the rows, the same way it gets no badge. */
  counts?: Partial<Record<VerdictKey, number>>;
  /** Total claims checked — defaults to the sum of `counts`. Pass it when some claims have
   * no verdict, so the subtitle still says how many were looked at. */
  total?: number;
  /** The size the phone sheet uses. */
  compact?: boolean;
}

/** The check at a glance, above the claims themselves. */
export function SummaryCard({ title = "Fact check summary", counts = {}, total, compact }: SummaryCardProps) {
  const analysed = total ?? STATS.reduce((sum, stat) => sum + (counts[stat.key] ?? 0), 0);
  return (
    <div className={`summary-card${compact ? " compact" : ""}`}>
      <h2 className="summary-title">{title}</h2>
      <div className="summary-sub">
        {analysed} claim{analysed === 1 ? "" : "s"} analysed
      </div>
      <div className="summary-stats">
        {STATS.map((stat) => {
          const count = counts[stat.key] ?? 0;
          return (
            <div className="summary-stat" data-count={count} key={stat.key}>
              <span className={`summary-count ${stat.css}`}>{count}</span>
              <span className="summary-label">{stat.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
