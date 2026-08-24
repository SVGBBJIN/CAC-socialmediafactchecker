import "./EntryBar.css";

export interface EntryBarProps {
  value: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** "Ask" vs. "Check" — announced via aria-label/title (see updateComposerMode in
   * public/app.js), never painted on screen. */
  label?: string;
}

/** The link-entry composer row at the bottom of the main pane — a single input plus an
 * icon-only submit button, the same shape at every width. */
export function EntryBar({ value, onChange, onSubmit, placeholder = "Paste a link to fact-check…", disabled, label = "Check" }: EntryBarProps) {
  return (
    <form
      className="entry-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <button type="submit" disabled={disabled} aria-label={label} title={label}>
        <svg className="check-btn-icon" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="check-btn-label">{label}</span>
      </button>
    </form>
  );
}
