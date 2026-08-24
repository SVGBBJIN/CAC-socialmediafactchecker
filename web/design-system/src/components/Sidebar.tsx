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
          <svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="10" stroke="currentColor" strokeWidth="2" /><circle cx="16" cy="16" r="3" fill="currentColor" /></svg>
        </span>
        <span className="wordmark">Seer</span>
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
