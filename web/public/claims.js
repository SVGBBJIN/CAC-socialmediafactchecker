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
 * The outcome that is not a verdict: a check ran, and the post had no factual claim in it.
 *
 * This is **not** a fifth verdict and must never be added to `VERDICTS` — nothing may parse
 * to it, no `VERDICT:` line may name it, and `VERDICT_ALIASES` must never gain a spelling
 * of it. It is a display state the app reaches on its own, from a fact it already knows for
 * certain: the check completed, the subject was a post, and the model opened no
 * `[[claim: …]]` block at all.
 *
 * Why it is worth having. "Insufficient evidence" is a finding about a claim — *we looked
 * and could not settle this*. Showing it for a music video reads as the check having failed
 * at its job, when what actually happened is that the job was completed and came back
 * empty. Those are opposite messages and the app was sending the wrong one.
 *
 * Why it is safe. It rests on the absence of the model's own marker, not on a guess about
 * prose — the same thing `splitClaims` returning `null` already means, just said out loud
 * instead of quietly falling back to a verdict nobody wrote. It is the exact opposite of
 * the sentence-level claim detection this codebase tore out (see lib/verified-chat.js): it
 * asks nothing of the text.
 */
export const NO_CLAIMS = { label: "No factual claims", css: "muted" };

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

/*
 * What a `VERDICT:` line is allowed to look like.
 *
 * The prompt asks for a bare `VERDICT: Corroborated` on its own line, and that is what a
 * compliant answer writes. Everything optional below is the same kind of net
 * `VERDICT_ALIASES` is: a model drafting prose reaches for markdown without being asked,
 * and losing a claim's whole verdict badge — and, worse, leaving the claim looking unfinished
 * to `claimDiff`, which is what decides when a box stops shimmering — because it emphasised
 * the label is the app being pickier than the fact it is rendering.
 *
 * So the label may be bolded or italicised, either side of the colon; the colon may be an
 * em or en dash; the line may carry a list bullet or heading hashes; and it may end in a
 * period. What is NOT optional is the word VERDICT, one of the four findings, and the line
 * being the last thing in the block — that anchor is load-bearing. `splitClaims` slices
 * each claim's text at the next marker and asks for the verdict at the *end* of that slice,
 * which is what makes a half-written claim mid-stream parse as unfinished rather than
 * borrowing the verdict of the claim before it.
 */
const EMPH = "(?:\\*\\*|__|\\*|_)";
const VERDICT_LINE = new RegExp(
  `\\n?[ \\t]*(?:[-*\u2022]|#{1,6})?[ \\t]*${EMPH}?\\s*verdict\\s*${EMPH}?[ \\t]*[:\u2014\u2013-][ \\t]*${EMPH}?\\s*(${ALIAS_PATTERN})\\s*${EMPH}?[ \\t]*[.!]?[ \\t]*$`,
  "i",
);

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
const CLAIM_MARKER =
  /^[ \t]*(?:[-*\u2022]|#{1,6}|\d+[.)])?[ \t]*(?:\*\*|__|\*|_)?\[\[[ \t]*claim[ \t]*:[ \t]*(.+?)[ \t]*\]\](?:\*\*|__|\*|_)?[ \t]*$/gim;

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
    const slice = text.slice(start, end);
    // Where the trimmed body actually begins in the original answer. `splitVerdict` is
    // handed the trimmed slice, so every offset it reports has to be shifted back by this
    // much to mean anything to a caller holding the whole answer.
    const bodyStart = start + (slice.length - slice.trimStart().length);
    const trimmed = slice.trim();
    const { text: body, verdictKey } = splitVerdict(trimmed);
    const verdictMatch = trimmed.match(VERDICT_LINE);
    return {
      title: marker[1].trim(),
      text: body,
      verdictKey,
      // Offsets into the answer this block was parsed out of, so a caller can rewrite one
      // claim's verdict line without re-serialising — and therefore without reflowing —
      // everything around it. `verdict` is null exactly when `verdictKey` is: a block cut
      // off mid-turn has no line to point at. Nothing in the browser reads these; they are
      // here because the server-side corroboration audit (lib/corroboration.js) needs to
      // parse claims with the same code that renders them rather than a second copy of
      // this syntax.
      range: { start: marker.index, end },
      verdict: verdictMatch
        ? {
            start: bodyStart + verdictMatch.index,
            end: bodyStart + verdictMatch.index + verdictMatch[0].length,
            text: verdictMatch[0],
          }
        : null,
    };
  });
}

/**
 * What changed between two successive parses of the *same* answer as it streams.
 *
 * `splitClaims` is already incremental — it is called on the partial text after every delta
 * — but a consumer that re-renders everything it returns on every token spends the whole
 * stream rebuilding markup that has not changed. This says which of the two things worth
 * doing to apply a parse:
 *
 * - `rebuild` — the set of claim *boxes* is different (a new `[[claim: …]]` marker arrived,
 *   which is the only way the count grows). Nothing short of re-laying-out the grid adds a
 *   box to it, so the consumer redraws.
 * - `settled` — indices whose `VERDICT:` line has arrived since the last parse. That is the
 *   exact moment a claim stops being in progress and becomes readable: its analysis, its
 *   citations and its verdict are all whole, and the box holding it can drop its shimmer
 *   for the real thing while its neighbours are still being written.
 *
 * The two are exclusive by construction: on a rebuild the consumer is redrawing every box
 * anyway and can paint the settled ones as it goes, so `settled` is empty rather than a
 * second list of work to do on markup that does not exist yet.
 *
 * Nothing here guesses. A claim is settled when the model wrote the closing line the system
 * prompt asked it for, the same marker `splitVerdict` already reads — this is not the
 * sentence-level claim detection lib/verified-chat.js describes tearing out.
 *
 * @param previous the last parse applied, or null/undefined for the first one.
 * @param next the current parse — `splitClaims`'s return, so possibly null.
 */
export function claimDiff(previous, next) {
  const before = previous ?? [];
  const after = next ?? [];
  const rebuild =
    after.length !== before.length || after.some((claim, i) => claim.title !== before[i].title);

  const settled = [];
  if (!rebuild) {
    for (const [i, claim] of after.entries()) {
      if (claim.verdictKey && !before[i].verdictKey) settled.push(i);
    }
  }
  return { rebuild, settled };
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
