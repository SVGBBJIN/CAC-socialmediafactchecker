import { useLayoutEffect, useRef, useState } from "react";
import "./SourcePill.css";

export interface Source {
  url: string;
  domain: string;
  title: string;
  /** Not populated by anything today — see the matching comment in web/public/app.js's
   * sourceDetailHTML. Handled here anyway so a future ledger entry that does carry one
   * needs no template changes. */
  excerpt?: string;
}

export interface SourcePillsProps {
  /** The sources a check was run against — one pill per source, each just its domain. */
  sources: Source[];
}

function SourceDetail({ s }: { s: Source }) {
  return (
    <>
      <span className="source-expand-domain">{s.domain}</span>
      {s.title ? <span className="source-expand-title">{s.title}</span> : null}
      {s.excerpt ? <span className="source-expand-excerpt">&ldquo;{s.excerpt}&rdquo;</span> : null}
    </>
  );
}

/**
 * A row of link pills for the sources a check cited — replaces the old collapsed
 * "Sources (N)" list, since a `[3]` citation marker in the text already links to the
 * same page. The title (and excerpt, if a source ever carries one) shows in a hover
 * popover rather than only a native tooltip. Whatever doesn't fit the row's own first
 * line collapses behind a "+N more" toggle, measured against the row's actual rendered
 * width — ported from `collapseSourcePillsOverflow` in web/public/app.js — rather than a
 * fixed inline count, so a narrow card and a wide one don't get the same cutoff.
 */
export function SourcePills({ sources }: SourcePillsProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(sources.length);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      const pills = Array.from(row.children).filter(
        (child): child is HTMLElement => child.classList.contains("source-pill") && !child.classList.contains("more"),
      );
      if (pills.length < 2) {
        setCut(sources.length);
        return;
      }
      const firstTop = pills[0].offsetTop;
      const wrapIndex = pills.findIndex((p, i) => i > 0 && p.offsetTop !== firstTop);
      setCut(wrapIndex === -1 ? sources.length : wrapIndex);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [sources]);

  if (!sources.length) return null;
  const visible = sources.slice(0, cut);
  const rest = sources.slice(cut);

  return (
    <div className="source-pills">
      <div
        className="source-pills-row"
        ref={rowRef}
        aria-label={`Checked against ${sources.length} source${sources.length === 1 ? "" : "s"}`}
      >
        {visible.map((s) => (
          <a key={s.url} className="source-pill" href={s.url} target="_blank" rel="noopener noreferrer">
            <span className="source-pill-domain">{s.domain}</span>
            {s.title || s.excerpt ? (
              <span className="source-pill-popover">
                <SourceDetail s={s} />
              </span>
            ) : null}
          </a>
        ))}
        {rest.length ? (
          <button
            type="button"
            className={`source-pill more${expanded ? " open" : ""}`}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            +{rest.length} more
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        ) : null}
      </div>
      {expanded && rest.length ? (
        <div className="source-expand">
          {rest.map((s) => (
            <a key={s.url} className="source-expand-item" href={s.url} target="_blank" rel="noopener noreferrer">
              <SourceDetail s={s} />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
