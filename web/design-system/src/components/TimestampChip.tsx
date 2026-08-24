import "./TimestampChip.css";

export interface TimestampChipProps {
  /** The formatted mark, e.g. "0:12" or "0:12-0:18" — public/timestamps.js owns the
   * parsing/formatting this string comes from. */
  label: string;
  /** Playhead is currently inside this claim's window. */
  playing?: boolean;
  /** The CDN URL never resolved, so there's nothing to seek — stays legible, stops
   * inviting a click. */
  dead?: boolean;
  /** An article or photo carousel has no player to seek — rendered as inert text. */
  static?: boolean;
  onClick?: () => void;
}

/**
 * The `[t=M:SS]` marker a video check writes after each claim, rendered as a chip that
 * seeks the video pane. Deliberately not styled like a citation — a citation leaves the
 * page, a timestamp moves the player a few inches away.
 */
export function TimestampChip({ label, playing, dead, static: isStatic, onClick }: TimestampChipProps) {
  const cls = ["ts-chip", playing && "playing", dead && "dead", isStatic && "static"].filter(Boolean).join(" ");
  return (
    <span className={cls} onClick={isStatic ? undefined : onClick} role={isStatic ? undefined : "button"} tabIndex={isStatic ? undefined : 0}>
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
      {label}
    </span>
  );
}
