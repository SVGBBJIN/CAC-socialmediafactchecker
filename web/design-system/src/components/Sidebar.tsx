import type { ReactNode } from "react";
import "./Sidebar.css";

export interface SidebarProps {
  /** Down to a 60px rail of icons — the search box and list have nowhere useful to go at
   * that width, so they're hidden rather than truncated. */
  collapsed?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  onNewCheck?: () => void;
  newCheckDisabled?: boolean;
  /** `<LibraryItem>` rows, or the `.lib-empty` placeholder text. */
  children?: ReactNode;
}

/** The library sidebar: wordmark, "New check", search, and the check-history list. */
export function Sidebar({ collapsed, searchValue, onSearchChange, onNewCheck, newCheckDisabled, children }: SidebarProps) {
  return (
    <div className="sidebar" data-collapsed={collapsed ? "true" : "false"}>
      <div className="sidebar-header">
        <span className="mark">
          <svg viewBox="0 0 64 64" fill="none">
            <g stroke="currentColor" strokeWidth="2.25">
              <circle cx="32" cy="32" r="21" strokeDasharray="27 6 27 6" strokeLinecap="round" />
              <line x1="32" y1="4" x2="32" y2="10" />
              <line x1="32" y1="54" x2="32" y2="60" />
              <line x1="4" y1="32" x2="10" y2="32" />
              <line x1="54" y1="32" x2="60" y2="32" />
            </g>
            <line x1="14" y1="32" x2="50" y2="32" stroke="currentColor" strokeWidth="1.25" opacity="0.55" />
            <circle cx="32" cy="32" r="5.5" fill="currentColor" />
            <rect x="40" y="29" width="4" height="6" rx="1" fill="var(--accent-2)" />
          </svg>
        </span>
        <span className="wordmark">TRASE</span>
      </div>
      <button type="button" className="new-check" onClick={onNewCheck} disabled={newCheckDisabled}>
        <svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        <span className="new-check-label">New check</span>
      </button>
      <input
        className="search"
        type="search"
        placeholder="Search checks…"
        value={searchValue}
        onChange={(e) => onSearchChange?.(e.target.value)}
      />
      <ul className="lib-list">{children}</ul>
    </div>
  );
}
