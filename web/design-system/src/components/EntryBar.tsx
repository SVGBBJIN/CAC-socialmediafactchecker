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
  /** Renders the attach button to the left of the field. */
  onAttach?: () => void;
  /** Renders the mic button to the right of the field. */
  onMic?: () => void;
  /** The recognizer is running: the field and submit button give way to the waveform, and
   * the mic button turns red — recording, not merely "on". */
  listening?: boolean;
  /** An attached image, shown as a chip on its own row under the field. */
  attachment?: { src: string; name: string; onRemove?: () => void };
}

/**
 * The composer at the bottom of the main pane. One filled submit button, icon-only at every
 * width, with the neutral mic/attach buttons either side of the field — the three are the
 * same size and deliberately not the same weight.
 */
export function EntryBar({
  value,
  onChange,
  onSubmit,
  placeholder = "Paste a link or ask a question…",
  disabled,
  label = "Check",
  onAttach,
  onMic,
  listening,
  attachment,
}: EntryBarProps) {
  return (
    <form
      className="entry-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      {onAttach ? (
        <button type="button" className="icon-btn" onClick={onAttach} aria-label="Attach an image" title="Attach an image">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      ) : null}

      {listening ? (
        <>
          <div className="listening-wave in" aria-hidden="true">
            <span /><span /><span /><span /><span />
          </div>
          <span className="listening-label in">Listening…</span>
        </>
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={placeholder}
        />
      )}

      {onMic ? (
        <button
          type="button"
          className={`icon-btn${listening ? " listening" : ""}`}
          onClick={onMic}
          aria-pressed={listening ? "true" : "false"}
          aria-label={listening ? "Stop listening and submit" : "Speak instead of typing"}
          title={listening ? "Stop listening and submit" : "Speak instead of typing"}
        >
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <path d="M5 11a7 7 0 0014 0M12 18v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}

      {listening ? null : (
        <button type="submit" className="check-btn" disabled={disabled} aria-label={label} title={label}>
          <svg className="check-btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="check-btn-label">{label}</span>
        </button>
      )}

      {attachment ? (
        <div className="image-chip">
          <img src={attachment.src} alt="" />
          <span>{attachment.name}</span>
          <button type="button" onClick={attachment.onRemove} aria-label="Remove image">
            ×
          </button>
        </div>
      ) : null}
    </form>
  );
}
