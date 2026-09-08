import type { ReactNode } from "react";
import "./SettingsMenu.css";

export interface SettingsTab {
  id: string;
  label: string;
  content: ReactNode;
}

export interface SettingsMenuProps {
  tabs: SettingsTab[];
  /** Which tab's section is shown. Uncontrolled use isn't supported on purpose — the
   * product keeps the active tab in its own settings state so it survives a reopen. */
  activeTab: string;
  onTabChange?: (id: string) => void;
  onClose?: () => void;
}

/**
 * Settings as a full page rather than a modal card: a nav rail down the left and one
 * section beside it. Rendered here as a plain element so it can be laid out in a design
 * canvas; the product wraps the same markup in a <dialog> so Esc and the backdrop work.
 */
export function SettingsMenu({ tabs, activeTab, onTabChange, onClose }: SettingsMenuProps) {
  const current = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  return (
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-head">
          <span className="settings-nav-mark">
            <svg viewBox="0 0 64 64" fill="none">
              <g stroke="currentColor" strokeWidth="2.25">
                <circle cx="32" cy="32" r="21" strokeDasharray="27 6 27 6" strokeLinecap="round" />
              </g>
              <circle cx="32" cy="32" r="5.5" fill="currentColor" />
              <rect x="40" y="29" width="4" height="6" rx="1" fill="var(--accent-2)" />
            </svg>
          </span>
          Settings
        </div>
        <div className="settings-nav-list">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`settings-nav-item${tab.id === current?.id ? " active" : ""}`}
              aria-current={tab.id === current?.id ? "true" : undefined}
              onClick={() => onTabChange?.(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="settings-nav-foot">
          <button type="button" className="settings-close" onClick={onClose}>
            Done
          </button>
        </div>
      </nav>
      <div className="settings-content">
        <section className="settings-section">{current?.content}</section>
      </div>
    </div>
  );
}

export interface SettingsRowProps {
  label: string;
  /** The line under the label — what the setting actually does. */
  hint?: string;
  /** The control itself: a `<Switch>`, a `<SegControl>`, an input. */
  children?: ReactNode;
}

/** One label/control pair, hairline-separated from the next. */
export function SettingsRow({ label, hint, children }: SettingsRowProps) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">{label}</div>
        {hint ? <div className="settings-row-sub">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label: string;
}

/** A checkbox wearing a track and a thumb — still a real checkbox underneath, so it is
 * focusable and announced as one. */
export function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <span className="switch">
      <input type="checkbox" checked={checked} aria-label={label} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="track" />
      <span className="thumb" />
    </span>
  );
}

export interface SegControlProps {
  options: { value: string; label: string }[];
  value: string;
  onChange?: (value: string) => void;
}

/** Two or three mutually exclusive choices — theme, text size — where a dropdown would
 * hide the options behind a click. */
export function SegControl({ options, value, onChange }: SegControlProps) {
  return (
    <div className="seg-control">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? "active" : undefined}
          aria-pressed={option.value === value}
          onClick={() => onChange?.(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
