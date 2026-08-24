import "./LibraryItem.css";
import type { VerdictKey } from "./VerdictBadge";

const DOT: Record<VerdictKey | "running" | "error", "bad" | "warn" | "good" | "muted"> = {
  contradicted: "bad",
  disputed: "warn",
  corroborated: "good",
  insufficient: "muted",
  running: "warn",
  error: "muted",
};

export interface LibraryItemProps {
  title: string;
  platform: string;
  /** "Checking…" / "Failed" / the verdict label, per statusLabel in public/app.js. */
  statusLabel: string;
  /** Drives the status dot's color — one of the four verdicts, or the running/error states. */
  status: keyof typeof DOT;
  active?: boolean;
  onSelect?: () => void;
}

/** One row in the sidebar's check history — a thumbnail, title, platform, and a status dot
 * whose color reads the same verdict vocabulary VerdictBadge uses. */
export function LibraryItem({ title, platform, statusLabel, status, active, onSelect }: LibraryItemProps) {
  return (
    <li
      className={`lib-item${active ? " active" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.();
        }
      }}
    >
      <div className="lib-thumb" />
      <div className="lib-meta">
        <div className="lib-title">{title}</div>
        <div className="lib-sub">
          <span className={`dot ${DOT[status]}`} />
          {platform} · {statusLabel}
        </div>
      </div>
    </li>
  );
}
