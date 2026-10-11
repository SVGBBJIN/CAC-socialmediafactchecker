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

// The marker the prompt asks for is exactly `[t=M:SS]` or `[t=M:SS-M:SS]`, and most of the
// time that is what arrives. But the model is writing prose, and the shapes it drifts into
// are a short, predictable list — every one of which used to reach the reader as raw
// bracket text sitting in the middle of a sentence, a broken parser in plain sight:
//
//   [t=0:12]           the canonical point             [t = 0:12]       spaced
//   [t=0:12-0:20]      span, any dash or "to"          [t=0:12s]        a stray unit
//   [t=1:05, 1:10]     several moments in one bracket  [t=12s] [t=1m05s] unit form
//   [0:12] [0:12-0:20] the `t=` forgotten              [t=0:12.5]       fractional seconds
//   (t=0:12)           parentheses instead             [t=1:5]          one-digit seconds
//
// What stays out is just as deliberate. A bracket without `t=` has to contain a colon to
// count — `[12]` is a citation, and `lib/citation-cleanup.js` deletes any it cannot resolve,
// so claiming one as a timestamp would put a real citation in the wrong pass. Unbracketed
// times in running prose ("at 0:12") are left alone: there is no marker there to replace,
// only words, and turning prose into controls is guessing.

// h:mm:ss or m:ss, the seconds allowed one digit (`1:5`) or a fraction (`0:12.5`).
const COLON_CLOCK = String.raw`\d{1,3}(?::[0-5]?\d){1,2}(?:\.\d+)?`;
// `12s`, `1m05s`, `1m 5s`, `2m`, `1h2m3s`, `45 sec`. Either seconds or minutes must be
// present, so a bare `h` never matches on its own.
const UNIT_CLOCK = String.raw`(?:\d{1,2}\s?h\s?)?(?:\d{1,3}\s?m(?:in)?\s?)?\d{1,5}(?:\.\d+)?\s?s(?:ec)?|(?:\d{1,2}\s?h\s?)?\d{1,3}\s?m(?:in)?`;
// A plain count of seconds — only ever after `t=`, where nothing else can be meant.
const BARE_SECONDS = String.raw`\d{1,5}(?:\.\d+)?`;

const PREFIX = String.raw`t\s*[=:]\s*`;
const RANGE = String.raw`\s*(?:-|–|—|\bto\b)\s*`;
const SEPARATOR = String.raw`\s*(?:[,;]|\band\b)\s*`;

function list(point) {
  const span = `(?:${point})s?(?:${RANGE}(?:${PREFIX})?(?:${point})s?)?`;
  return `${span}(?:${SEPARATOR}(?:${PREFIX})?${span})*`;
}

const ANY_POINT = `${COLON_CLOCK}|${UNIT_CLOCK}|${BARE_SECONDS}`;

/**
 * One timestamp marker, in any of the shapes above. `g`-flagged, so callers that need it
 * more than once must reset `lastIndex` or use it through `String.replace`/`matchAll`,
 * which do that themselves.
 *
 * It finds a marker and nothing more — no capture groups. One bracket can hold several
 * moments, so what it holds is read by `marksIn`, not by groups that could only ever have
 * held one start and one end.
 */
export const TIMESTAMP_MARKER = new RegExp(
  [
    String.raw`\[\s*${PREFIX}(?:${list(ANY_POINT)})\s*\]`,
    String.raw`\(\s*${PREFIX}(?:${list(ANY_POINT)})\s*\)`,
    String.raw`\[\s*(?:${list(COLON_CLOCK)})\s*\]`,
  ].join("|"),
  "gi",
);

/**
 * A clock string as a number of seconds, or null if it isn't one.
 *
 * `1:05` is a minute and five seconds, never an hour and five minutes — short-form video is
 * what this app checks, so the smallest units are the ones that are always present. That is
 * the same rule every player's own scrubber uses. Unit forms (`1m05s`, `45s`) and a stray
 * trailing `s` on a clock (`0:12s`) read the way they would to a person.
 */
export function parseClock(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (!value) return null;

  const units = value.match(
    /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?$/,
  );
  if (units && (units[1] || units[2] || units[3])) {
    return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  }

  const parts = value.replace(/s$/, "").split(":");
  if (parts.length > 3) return null;
  let seconds = 0;
  for (const [i, part] of parts.entries()) {
    // Only the last part — the seconds — may carry a fraction.
    const shape = i === parts.length - 1 ? /^\d+(?:\.\d+)?$/ : /^\d+$/;
    if (!shape.test(part)) return null;
    seconds = seconds * 60 + Number(part);
  }
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Every moment one matched marker holds, in the order written: `[t=0:12]` is one,
 * `[t=1:05, 1:10-1:20]` is two. Each is `{ start, end }`, with `end` null unless a span was
 * written and runs forward — a backwards range is a typo, and the useful part of it (where
 * to seek to) is still the start. An empty array means the marker held nothing readable.
 */
export function marksIn(marker) {
  const inner = String(marker ?? "")
    .trim()
    .slice(1, -1)
    .trim()
    .replace(/^t\s*[=:]\s*/i, "");
  const marks = [];
  for (const item of inner.split(/\s*(?:[,;]|\band\b)\s*/i)) {
    if (!item) continue;
    const [from, to] = item
      .replace(/^t\s*[=:]\s*/i, "")
      .split(/\s*(?:-|–|—|\bto\b)\s*/i)
      .map((part) => part.replace(/^t\s*[=:]\s*/i, ""));
    const start = parseClock(from);
    if (start == null) continue;
    const end = to == null ? null : parseClock(to);
    marks.push({ start, end: end != null && end > start ? end : null });
  }
  return marks;
}

/**
 * The same text with every marker replaced by whatever `render(marks, raw)` returns for it.
 * A marker that held nothing readable is left exactly as written — that is not something
 * this module can make a better guess about than the reader can.
 */
export function mapTimestamps(text, render) {
  return String(text ?? "").replace(TIMESTAMP_MARKER, (raw) => {
    const marks = marksIn(raw);
    return marks.length ? render(marks, raw) : raw;
  });
}

/** A mark as the clock text a reader sees: `0:12`, or `1:05–1:20` for a span. */
export function markLabel({ start, end }) {
  return end != null && end > start ? `${formatClock(start)}–${formatClock(end)}` : formatClock(start);
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
    for (const mark of marksIn(match[0])) {
      found.push({ raw: match[0], index: match.index, ...mark });
    }
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
  return mapTimestamps(text, (marks) => `[${marks.map(markLabel).join(", ")}]`);
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
