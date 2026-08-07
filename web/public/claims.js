// Turning a fact-check answer's raw text back into structured claims.
//
// The server returns one narrated, cited block of text — there is no per-claim schema on
// the wire. What makes it structured on this side is the CLAIM STRUCTURE section of the
// system prompt (see lib/verified-chat.js): the model is asked to open each distinct claim
// with a `[[claim: …]]` line and close it with its own `VERDICT: …` line before starting
// the next one. This module is the only thing that knows that syntax — splitting an answer
// into claims, and pulling the verdict line off each one.
//
// Pure and DOM-free on purpose, like device.js and timestamps.js — that is what lets
// test-claims.js exercise it in Node with no browser, per the convention in CLAUDE.md.

export const VERDICTS = {
  contradicted: { label: "Contradicted", css: "bad" },
  disputed: { label: "Disputed", css: "warn" },
  corroborated: { label: "Corroborated", css: "good" },
  insufficient: { label: "Insufficient evidence", css: "muted" },
};

/**
 * The system prompt asks for exactly one of the four `VERDICTS` labels, and that is what a
 * compliant answer writes. This is the net under that, not a replacement for it: a model
 * that drifts to a close synonym — "False" instead of "Contradicted", "Unverified" instead
 * of "Insufficient evidence" — still means one of the four things this app knows how to
 * badge, and losing the badge over word choice would be the app being pickier than the
 * fact it's rendering. Nothing here widens *what* can be reported, only how it can be
 * spelled; a verdict that isn't one of these four keys still parses to `null`, same as
 * before.
 */
const VERDICT_ALIASES = {
  contradicted: ["contradicted", "false", "incorrect", "untrue"],
  disputed: ["disputed", "misleading", "mixed", "partly true", "partially true"],
  corroborated: ["corroborated", "true", "accurate", "confirmed"],
  insufficient: [
    "insufficient",
    "insufficient evidence",
    "unverified",
    "unproven",
    "unclear",
    "cannot verify",
    "no evidence",
  ],
};

const VERDICT_KEY_BY_ALIAS = new Map(
  Object.entries(VERDICT_ALIASES).flatMap(([key, aliases]) => aliases.map((alias) => [alias, key])),
);

// Longest alias first, so "insufficient evidence" matches whole rather than stopping at
// "insufficient" and leaving " evidence" dangling in the text.
const ALIAS_PATTERN = [...VERDICT_KEY_BY_ALIAS.keys()]
  .sort((a, b) => b.length - a.length)
  .map((alias) => alias.replace(/\s+/g, "\\s+"))
  .join("|");

const VERDICT_LINE = new RegExp(`\\n?VERDICT:\\s*(${ALIAS_PATTERN})\\.?\\s*$`, "i");

/**
 * Pulls the trailing `VERDICT: …` line off a block of answer text.
 *
 * Anchored to the *end* of whatever string it's given, not the end of a larger answer —
 * `splitClaims` below relies on that to pull each claim's own verdict off its own slice,
 * independent of every other claim's.
 */
export function splitVerdict(answer) {
  const text = String(answer ?? "");
  const match = text.match(VERDICT_LINE);
  if (!match) return { text, verdictKey: null };
  const alias = match[1].toLowerCase().replace(/\s+/g, " ").trim();
  const key = VERDICT_KEY_BY_ALIAS.get(alias) ?? null;
  return { text: text.slice(0, match.index).trimEnd(), verdictKey: key };
}

/**
 * `[[claim: …]]` — the CLAIM STRUCTURE section of the system prompt's own marker for where
 * one claim's block ends and the next begins. Digit-free by design, the same reasoning
 * `[t=…]` timestamps use (see timestamps.js): `lib/citation-cleanup.js` only ever touches a
 * `[n]`-shaped group, so this can't be mistaken for a citation and deleted on the way out.
 */
const CLAIM_MARKER = /^\[\[claim:\s*(.+?)\]\][ \t]*$/gim;

/**
 * Splits a raw answer into one block per claim, or returns `null` if it has none.
 *
 * `null`, not an empty array, is the signal to render the whole-answer, single-card layout
 * that predates this feature: a follow-up, a greeting, anything the system prompt's own
 * "WHEN THERE IS NOTHING TO CHECK" section covers is never asked to produce a `[[claim: …]]`
 * line, so an answer with zero markers is not "a check with zero claims" — it is not a
 * check at all, and treating it as an empty claims list would be a lie in the other
 * direction from the one this app tore its old claim-detection heuristic out for (see the
 * header of lib/verified-chat.js on why that was removed: guessing "this looks like a
 * claim" from prose broke on a plain "hi"). This one guesses nothing — it only ever acts on
 * a marker the model was explicitly asked to write.
 *
 * Same reasoning covers every answer written before this feature shipped: their stored
 * text has no markers in it either, and they fall back exactly the way a plain
 * conversational turn does — nothing to migrate, nothing that can be told apart from a
 * turn that was never a fact-check in the first place.
 */
export function splitClaims(rawAnswer) {
  const text = String(rawAnswer ?? "");
  const markers = [...text.matchAll(CLAIM_MARKER)];
  if (markers.length === 0) return null;
  return markers.map((marker, index) => {
    const start = marker.index + marker[0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index : text.length;
    const { text: body, verdictKey } = splitVerdict(text.slice(start, end).trim());
    return { title: marker[1].trim(), text: body, verdictKey };
  });
}

/**
 * The one verdict a multi-claim check's library row and search need — the worst finding
 * among its claims, on the theory that "one of these is false" is the headline even when
 * the rest check out. Contradicted outranks disputed outranks insufficient outranks
 * corroborated; a claim with no parseable VERDICT line of its own (a parsing gap, or the
 * turn was cut off mid-claim) doesn't enter the ranking rather than being guessed at.
 *
 * Returns `null`, same as an individual claim's own `verdictKey` would be, when nothing in
 * the list ranks — an empty array, or claims that all failed to parse.
 */
const VERDICT_SEVERITY = ["contradicted", "disputed", "insufficient", "corroborated"];
export function aggregateVerdictKey(claims) {
  let worst = null;
  for (const claim of claims) {
    if (!claim.verdictKey) continue;
    if (worst == null || VERDICT_SEVERITY.indexOf(claim.verdictKey) < VERDICT_SEVERITY.indexOf(worst)) {
      worst = claim.verdictKey;
    }
  }
  return worst;
}
