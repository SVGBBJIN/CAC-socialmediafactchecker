import "./SourcePill.css";

export interface Source {
  url: string;
  domain: string;
  title: string;
}

export interface SourcePillsProps {
  /** The sources a check was run against — one pill per source, each just its domain. */
  sources: Source[];
  /** Count of sources retrieved past the handful shown, rendered as a plain (non-link) pill. */
  moreCount?: number;
}

/**
 * A row of link pills for the sources a check cited — replaces the old collapsed
 * "Sources (N)" list, since a `[3]` citation marker in the text already links to the
 * same page.
 */
export function SourcePills({ sources, moreCount }: SourcePillsProps) {
  if (!sources.length) return null;
  return (
    <div className="source-pills" aria-label={`Checked against ${sources.length} source${sources.length === 1 ? "" : "s"}`}>
      {sources.map((s) => (
        <a key={s.url} className="source-pill" href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>
          {s.domain}
        </a>
      ))}
      {moreCount ? <span className="source-pill more">+{moreCount} more</span> : null}
    </div>
  );
}
