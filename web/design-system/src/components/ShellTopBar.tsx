import type { ReactNode } from "react";
import "./ShellTopBar.css";

export interface ShellTopBarProps {
  /** The check's own title — the post's caption once one resolves, the pasted URL until
   * then. Ellipsised rather than wrapped: the bar is one line tall. */
  title: string;
  /** "TikTok · checked 2 minutes ago", or "checking now" while a turn is in flight. */
  subtitle?: string;
  /** Trailing controls, if the shell puts any here. */
  children?: ReactNode;
}

/**
 * The desktop shell's title bar. Without it the only place the open check is named is its
 * highlighted row in the sidebar — the pane itself never says what you are reading.
 */
export function ShellTopBar({ title, subtitle, children }: ShellTopBarProps) {
  return (
    <div className="shell-topbar">
      <div className="shell-topbar-meta">
        <h2 className="shell-title" title={title}>
          {title}
        </h2>
        {subtitle ? <div className="shell-sub">{subtitle}</div> : null}
      </div>
      {children}
    </div>
  );
}
