import type { ReactNode } from "react";
import "./ClaimCard.css";
import { VerdictBadge, type VerdictKey } from "./VerdictBadge";
import { SourcePills, type Source } from "./SourcePill";

export interface ClaimCardProps {
  /** Position label in a claim-grid box, e.g. "Claim 2 of 4" — omit for the whole-answer
   * card, where there's no set of same-shape siblings to distinguish it from. */
  eyebrow?: string;
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
}

/**
 * One box in the split-panes claim feed — eyebrow, claim title, analysis text, verdict
 * badge, and the sources it was checked against. The product's `claimPanesHTML` renders
 * one of these per `[[claim: …]]` marker the model wrote; `splitClaims` (public/claims.js)
 * is what does that splitting, never sentence-level guessing.
 */
export function ClaimCard({ eyebrow, pending, title, children, verdict, sources }: ClaimCardProps) {
  return (
    <div className="claim-card">
      {eyebrow ? <span className={`claim-eyebrow${pending ? " pending" : ""}`}>{eyebrow}</span> : null}
      {title ? <h3 className="claim-title">{title}</h3> : null}
      <div className="claim-text">{children}</div>
      {verdict ? <VerdictBadge verdict={verdict} /> : null}
      {sources?.length ? <SourcePills sources={sources} /> : null}
    </div>
  );
}
