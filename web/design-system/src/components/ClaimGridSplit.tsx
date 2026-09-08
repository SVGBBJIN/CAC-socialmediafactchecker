import type { CSSProperties, ReactNode } from "react";
import "./ClaimGridSplit.css";

export interface SplitCell {
  /** Percentages of the stage, so a cell keeps its place as the stage resizes. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Drawn but not yet interactive — a box still growing into place. */
  visible?: boolean;
  content: ReactNode;
}

export interface ClaimGridSplitProps {
  /** The stage's own height; cells are positioned inside it as percentages. */
  height?: number | string;
  cells: SplitCell[];
}

/**
 * The claims pane mid-division: every cell is absolutely positioned and animates its own
 * rect, so a box that already existed slides and resizes into its new slot rather than the
 * whole grid re-flowing under the reader. Give each cell a stable key by index — a cell
 * that changes identity between renders jumps instead of moving.
 */
export function ClaimGridSplit({ height = 520, cells }: ClaimGridSplitProps) {
  return (
    <div className="split-stage" style={{ height }}>
      {cells.map((cell, index) => (
        <div
          key={index}
          className={`split-cell${cell.visible === false ? "" : " visible"}`}
          style={
            {
              left: `${cell.left}%`,
              top: `${cell.top}%`,
              width: `${cell.width}%`,
              height: `${cell.height}%`,
            } as CSSProperties
          }
        >
          {cell.content}
        </div>
      ))}
    </div>
  );
}
