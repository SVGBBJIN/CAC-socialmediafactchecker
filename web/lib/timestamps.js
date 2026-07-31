// Where in the clip a claim was made.
//
// A fact-check of a video answers "is this true". It has never answered "where did they
// say it", and that is the question a reader asks second and cannot currently act on: the
// verdict names a claim, the clip is forty seconds long, and finding the sentence means
// scrubbing. So the model is asked to mark each claim it takes from the video with the
// moment it was made — `[0:42]` — and this module is what makes that marker trustworthy
// enough to open a player with.
//
// It is deliberately the same shape as `lib/citation-cleanup.js`, because it is the same
// problem one layer over. A citation marker says *which page* backs a sentence and is
// checked against the ledger of pages actually retrieved; a timestamp marker says *which
// second* of the clip a sentence came from, and is checked against the clip's own length.
// Both are claims about a thing the reader can go and look at, and both are worthless —
// worse than worthless, because they look checkable — when they point somewhere that does
// not exist.
//
// Three rules, mirroring that file's:
//
//   1. **Only ever change markers.** The prose comes out byte-identical apart from the
//      markers removed and the whitespace they leave behind.
//   2. **Never invent one.** Nothing here adds a timestamp, moves one, or rounds one to a
//      nicer number. A marker is the model's statement about the video; this pass can
//      delete it or leave it, and that is all.
//   3. **Delete only what cannot be true.** A marker past the end of the clip names a
//      moment that does not exist. Everything else is left alone — including every marker
//      in a turn where no clip's length is known, which is most of them.
//
// The asymmetry in rule 3 is worth stating plainly, because it is the honest limit of this
// check. A TikTok arrives through `lib/tiktok.js`, whose embed payload carries the clip's
// duration, so "past the end" is a fact here. A YouTube link is handed to Gemini as a URL
// and nothing in this app ever learns how long the video is — so a YouTube timestamp is
// bounded by nothing, and the most that can be said for it is that the player it opens
// lands somewhere in the video the reader is already looking at. That is a smaller promise
// than the citation ledger makes, and it is not dressed up as a bigger one anywhere in the
// UI: a timestamp is a pointer into the clip, not evidence.

import { outsideCode } from "./citation-cleanup.js";

/**
 * A timestamp marker: `[M:SS]`, `[MM:SS]`, or `[H:MM:SS]` past the hour.
 *
 * Bracketed for the same reason a citation is — it makes the marker a token in the prose
 * rather than a number that happens to have a colon in it. Without the brackets this would
 * match a scoreline, a ratio, a Bible verse and a time of day, and the pass would be
 * rewriting sentences it has no business touching.
 *
 * The hours field is optional rather than a separate pattern because the two forms are the
 * same marker at different lengths, and the model picks between them by how long the clip
 * is. Minutes run to three digits so a long video timed straight through — `[105:30]` —
 * still parses rather than silently rendering as text.
 */
export const TIMESTAMP_MARKER = /\[(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\]/g;

/**
 * How far past the end of a clip a marker may sit and still be believed, in seconds.
 *
 * Not slack for a wrong answer — slack for a disagreement about what "the end" is. Gemini
 * reads video as roughly a frame a second and rounds what it reports; TikTok's own duration
 * is a number off the embed page and is itself rounded. A model that says `[0:45]` about
 * the last sentence of a clip TikTok calls 44.6 seconds long is right, and deleting that
 * marker would be this pass making the answer worse to enforce a boundary neither side
 * measures that precisely.
 */
export const END_TOLERANCE_SECONDS = 2;

/** `[1:02:33]` → 3753. Null for anything that is not a marker. */
export function parseClock(marker) {
  const match = /^\[?(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\]?$/.exec(String(marker).trim());
  if (!match) return null;
  const [, first, second, third] = match;
  return third === undefined
    ? Number(first) * 60 + Number(second)
    : Number(first) * 3600 + Number(second) * 60 + Number(third);
}

/** 3753 → "1:02:33", 42 → "0:42". The inverse of `parseClock`, for labels. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const s = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${s}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${s}`;
}

/**
 * What a marker *becomes* — a link to the platform's own page, or the embed the pill opens
 * over the answer — is deliberately not here. That is browser work, it lives beside the
 * click that uses it in `public/app.js`, and a second copy on this side would be a rule
 * with no caller, drifting from the one that has one. What this module owns is the part
 * the server has to decide: which markers are allowed through to the browser at all.
 */

/**
 * The longest clip in the turn, in seconds, or null when no clip's length is known.
 *
 * The bound is the *longest* rather than per-video on purpose. A marker says when, not
 * which — `[0:42]` in an answer about two clips does not name one of them — so the only
 * statement this pass can make without guessing is that no moment in this turn is later
 * than the longest video it was given. Guessing which clip a marker belongs to in order to
 * apply a tighter bound would delete correct markers whenever the guess went wrong, and a
 * correct marker deleted is the one failure this whole file exists to avoid.
 */
export function knownDuration(videos = []) {
  const durations = videos
    .map((video) => Number(video?.duration))
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  return durations.length > 0 ? Math.max(...durations) : null;
}

/**
 * Delete the timestamp markers that cannot be true, and report the ones that survive.
 *
 * "Cannot be true" is one rule and one rule only: later than the longest clip this turn,
 * plus `END_TOLERANCE_SECONDS`. A turn with no video at all is left completely untouched —
 * the markers there point at nothing, but nothing is drawn around them either — they stay
 * the plain text the model wrote and cost the reader nothing. Deleting them would be this
 * pass editing prose on a suspicion, which is exactly the guesswork that got the old
 * citation auditor removed.
 *
 * Code is skipped, via the same splitter the citation pass uses: `arr[1:23]` in a Python
 * sample is a slice, and rewriting it would change what the answer says.
 *
 * @returns `{text, changed, stamps, dropped}` — `stamps` are the surviving markers as
 *   `{seconds, text}` in the order they appear, which is what the caller logs or counts.
 */
export function cleanTimestamps(text, videos = []) {
  const source = String(text ?? "");
  const limit = knownDuration(videos);
  const stamps = [];
  let dropped = 0;

  const cleaned = outsideCode(source, (prose) =>
    prose.replace(TIMESTAMP_MARKER, (marker) => {
      const seconds = parseClock(marker);
      if (seconds === null) return marker;
      if (limit !== null && seconds > limit + END_TOLERANCE_SECONDS) {
        dropped += 1;
        return "";
      }
      stamps.push({ seconds, text: marker });
      return marker;
    }),
  );

  if (dropped === 0) return { text: source, changed: false, stamps, dropped };
  // A deleted marker leaves the space that separated it from the word before, and often a
  // second one before the full stop. Collapsed the same way `citation-cleanup` collapses
  // its own removals — the sentence has to read as though the marker was never typed.
  const tidied = cleaned
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
  return { text: tidied, changed: tidied !== source, stamps, dropped };
}
