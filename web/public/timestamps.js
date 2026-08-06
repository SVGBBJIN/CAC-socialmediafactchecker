// Where in the video a claim was made.
//
// The model is asked (see `composeCheckPrompt` in app.js, and the WHEN A VIDEO IS ATTACHED
// section of the system prompt) to mark each claim it lists with the moment it happens, as
// `[t=0:12]` or `[t=0:12-0:20]` for a span. This module is the only thing that knows that
// syntax: it turns a marker into seconds, turns seconds back into a clock, and works out
// which marker the playhead is currently inside.
//
// Two reasons the marker is `[t=…]` and not a bare `[0:12]`:
//
// - A citation marker is `[3]`, and `lib/citation-cleanup.js` rewrites, merges, caps and
//   *deletes* `[n]` groups on the server before the answer reaches the browser. A timestamp
//   has to be a shape that pass cannot mistake for a citation — its `MARKER_GROUP` regex is
//   digits-only, so anything carrying `t=` and a colon travels through untouched.
// - It is unambiguous to a reader who sees the raw text (a copied answer, the history
//   replayed into a follow-up) rather than the rendered chip.
//
// Pure and DOM-free on purpose, like `device.js` — that is what lets `test-timestamps.js`
// exercise it in Node with no browser and no network, per the convention in CLAUDE.md.

// h:mm:ss, m:ss, or a bare count of seconds. Minutes and seconds are held to two digits
// each so a stray `[t=1:2:3:4]` is simply not a marker rather than a marker meaning
// something nobody intended.
const CLOCK = String.raw`\d{1,3}(?::[0-5]\d){0,2}`;

/**
 * One timestamp marker. `g`-flagged, so callers that need it more than once must reset
 * `lastIndex` or use it through `String.replace`/`matchAll`, which do that themselves.
 *
 * The separator for a span accepts a hyphen, an en dash or an em dash: the model is writing
 * prose, and which dash it reaches for is not something worth failing over. Whitespace
 * around it is optional for the same reason.
 */
export const TIMESTAMP_MARKER = new RegExp(
  String.raw`\[t=(${CLOCK})(?:\s*[-–—]\s*(${CLOCK}))?\]`,
  "gi",
);

/**
 * A clock string as a number of seconds, or null if it isn't one.
 *
 * `1:05` is a minute and five seconds, never an hour and five minutes — short-form video is
 * what this app checks, so the smallest units are the ones that are always present. That is
 * the same rule every player's own scrubber uses.
 */
export function parseClock(text) {
  const parts = String(text ?? "").trim().split(":");
  if (parts.length === 0 || parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    seconds = seconds * 60 + Number(part);
  }
  return Number.isFinite(seconds) ? seconds : null;
}

/** Seconds as the clock a player would show: `0:07`, `4:31`, `1:02:03`. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Every timestamp in a piece of answer text, in the order it was written.
 *
 * `end` is null unless the model wrote a span, and a span whose end is at or before its
 * start is treated as no span at all rather than as a zero-length one — a backwards range
 * is a typo, and the useful part of it (where to seek to) is still the start.
 */
export function extractTimestamps(text) {
  const found = [];
  for (const match of String(text ?? "").matchAll(TIMESTAMP_MARKER)) {
    const start = parseClock(match[1]);
    if (start == null) continue;
    const end = match[2] == null ? null : parseClock(match[2]);
    found.push({
      raw: match[0],
      index: match.index,
      start,
      end: end != null && end > start ? end : null,
    });
  }
  return found;
}

/**
 * The same text with each marker rewritten as a plain `[0:12]`.
 *
 * For the places an answer leaves the app as text rather than as markup — copy, share — where
 * `[t=0:12]` is app syntax leaking out. Nothing else is touched, including citation markers.
 */
export function plainTimestamps(text) {
  return String(text ?? "").replace(TIMESTAMP_MARKER, (raw, start, end) => {
    const from = parseClock(start);
    if (from == null) return raw;
    const to = end == null ? null : parseClock(end);
    return to != null && to > from ? `[${formatClock(from)}–${formatClock(to)}]` : `[${formatClock(from)}]`;
  });
}

/**
 * How long a marker with no end stays the current one, in seconds.
 *
 * A claim is highlighted from its own timestamp until the next one starts — that is the
 * span the reader means by "the bit being talked about now". This cap is for the last
 * marker in an answer, which has no next one: without it, the final claim would stay lit
 * for the entire rest of the video, including a minute of outro that has nothing to do
 * with it.
 */
export const DEFAULT_MARK_SECONDS = 12;

/**
 * Timestamps as playback windows: sorted by start, each running until the next one begins.
 *
 * Written as a separate step from `extractTimestamps` because the two orders are different
 * and both matter. The text order is what the chips are rendered in; this order is what the
 * playhead is compared against, and a model that timestamps a claim out of sequence (a
 * summary at the top citing a moment near the end) must not make the lookup non-monotonic.
 *
 * Items keep whatever else the caller put on them — in the browser that is the chip element
 * itself, which is how the highlight finds what to light up without ids in the markup.
 */
export function timeline(marks) {
  const sorted = [...marks].filter((m) => Number.isFinite(m.start)).sort((a, b) => a.start - b.start);
  return sorted.map((mark, index) => {
    const next = sorted[index + 1];
    // An explicit span the model wrote is honoured, but never past the next claim: two
    // claims cannot both be the one being made right now, and the later one wins its own
    // start. Failing that, the default window, which is itself clipped the same way.
    const ceiling = next ? next.start : Infinity;
    const own = mark.end ?? mark.start + DEFAULT_MARK_SECONDS;
    return { ...mark, from: mark.start, to: Math.min(own, ceiling) };
  });
}

/**
 * Which window the playhead is in, or null between them.
 *
 * Null is a real answer and not a failure: the video is playing over something nobody made
 * a claim about, and lighting up the nearest chip anyway would tell the reader that the
 * sentence on screen is being spoken when it is not.
 */
export function activeAt(windows, seconds) {
  if (!Number.isFinite(seconds)) return null;
  // Last match wins, so a zero-length or overlapping window (a span the model wrote that
  // covers the next claim's start) resolves to the later claim — the same rule `timeline`
  // applies when it clips.
  let active = null;
  for (const window of windows) {
    if (seconds >= window.from && seconds < window.to) active = window;
  }
  return active;
}
