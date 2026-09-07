import { useState, type ReactNode } from "react";
import "./MobileShell.css";

export interface MobileShellProps {
  /** The check's own title, or "New check" before anything is pasted. */
  title: string;
  /** "TikTok · checked 2 minutes ago", or what to do when nothing is selected. */
  subtitle?: string;
  /** The clip, if there is one. Omit for a link-less conversation or an empty shell and the
   * strip isn't drawn at all — a black band above the sheet would promise a player that
   * isn't there. */
  media?: ReactNode;
  /** The summary card, above the claims. */
  summary?: ReactNode;
  /** The claim cards, or the empty card. */
  children?: ReactNode;
  /** The composer. */
  composer?: ReactNode;
  /** `<Sidebar>` — the library, off-canvas behind the hamburger. */
  drawer?: ReactNode;
  /** Fills the sheet with its child instead of stacking (the empty state). */
  empty?: boolean;
}

/**
 * The phone layout: title bar, video strip, claim sheet, composer, each with an edge of its
 * own, plus the library as a drawer. The strip is 24vh and expands to 62vh on a tap — height
 * the reader trades for sheet, rather than a fixed decoration — and with it expanded the
 * claims shrink to title-and-verdict.
 *
 * The expanded/drawer state is held here rather than lifted out: both are "right now"
 * gestures, not preferences, and a check opened tomorrow should start on its analysis. The
 * product keeps the same two on `data-drawer`/`data-media` attributes for the same reason.
 */
export function MobileShell({ title, subtitle, media, summary, children, composer, drawer, empty }: MobileShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`mshell${expanded ? " media-expanded" : ""}`}>
      <div className="mshell-topbar">
        {drawer ? (
          <button type="button" className="hamburger-btn" aria-label="Open checks" onClick={() => setDrawerOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
        ) : null}
        <div className="mshell-title-wrap">
          <h1 className="mshell-title" title={title}>{title}</h1>
          {subtitle ? <div className="mshell-sub">{subtitle}</div> : null}
        </div>
      </div>

      {media ? (
        <div
          className={`mshell-media${expanded ? " expanded" : ""}`}
          // Tapping the collapsed strip expands it: a 24vh strip is a big target for "I want
          // to see this", and the chevron alone makes the reader aim. Collapsing stays the
          // chevron's job — a tap on an expanded player is play/pause.
          onClick={() => !expanded && setExpanded(true)}
        >
          {media}
          <button
            type="button"
            className="expand-btn"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse video" : "Expand video"}
            title={expanded ? "Collapse video" : "Expand video"}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>
      ) : null}

      <div className="mshell-sheet">
        {media ? <div className="sheet-handle" aria-hidden="true" /> : null}
        {summary}
        {empty ? <div className="mshell-empty">{children}</div> : <div className="mshell-claims">{children}</div>}
      </div>

      {composer ? <div className="mshell-entrybar">{composer}</div> : null}

      {drawer ? (
        <>
          <div className={`mshell-scrim${drawerOpen ? " open" : ""}`} onClick={() => setDrawerOpen(false)} />
          <div className={`mshell-drawer${drawerOpen ? " open" : ""}`}>{drawer}</div>
        </>
      ) : null}
    </div>
  );
}
