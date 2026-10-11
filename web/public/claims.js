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
 *
 * It must open its line (after an optional bullet, number, heading or emphasis) — a marker
 * mentioned mid-sentence is prose about the syntax, not the syntax. What may follow it on
 * the same line is the start of the claim's body: the model is asked to put the marker on a
 * line of its own, and when it doesn't, the old `$` anchor made the whole marker invisible,
 * so that claim's check silently merged into the card above it, verdict and all.
 *
 * The title may hold a bracket of its own — `[[claim: X said it [t=0:12]]]` — which is why it
 * is matched as plain text or whole `[…]` groups rather than lazily up to the first `]]`,
 * which landed inside the timestamp. `[[Claim 2: …]]` and a dash for the colon are the same
 * kind of drift `VERDICT_ALIASES` absorbs.
 */
const CLAIM_MARKER =
  /^[ \t]*(?:[-*\u2022]|#{1,6}|\d+[.)])?[ \t]*(?:\*\*|__|\*|_)?\[\[[ \t]*claim(?:[ \t]*#?\d+)?[ \t]*[:\u2014\u2013-][ \t]*((?:[^[\]\n]|\[[^[\]\n]*\])+?)[ \t]*\]\](?:\*\*|__|\*|_)?[ \t]*(?:[:\u2014\u2013-][ \t]*)?/gim;

/**
 * `[[overview]]` — the model's short overall summary (see the CLAIM STRUCTURE section of the
 * system prompt). Same opening-the-line rule as the claim marker; the summary may start on
 * the marker's own line.
 *
 * The prompt asks for it first, ahead of the claims, so the reader gets the gist before the
 * cards stream in; it runs from the marker to the first `[[claim: …]]` line (see
 * `leadingOverview`). Answers written before that change put it last, after the final
 * verdict, where it runs to the end of the text (see `claimsEnd`) — both still parse.
 */
const OVERVIEW_MARKER =
  /^[ \t]*(?:#{1,6})?[ \t]*(?:\*\*|__|\*|_)?\[\[[ \t]*overview[ \t]*\]\](?:\*\*|__|\*|_)?[ \t]*:?[ \t]*/im;

/** A VERDICT line anywhere in a block — `VERDICT_LINE` without its end-of-text anchor. */
const ANY_VERDICT_LINE = new RegExp(
  `^[ \\t]*(?:[-*\u2022]|#{1,6})?[ \\t]*${EMPH}?\\s*verdict\\s*${EMPH}?[ \\t]*[:\u2014\u2013-][ \\t]*${EMPH}?[ \\t]*(${ALIAS_PATTERN})[ \\t]*${EMPH}?[ \\t]*[.!]?[ \\t]*$`,
  "gim",
);

/** A markdown rule (`---`, `***`, `___`) — a separator the model draws between blocks,
 * never content. */
const RULE_LINES = /^[ \t]*(?:[-*_][ \t]*){3,}$/gm;

function stripRules(text) {
  return text.replace(RULE_LINES, "").trim();
}

/** The first `[[claim: …]]` marker in `text`, or `null`. */
function firstClaimMarker(text) {
  CLAIM_MARKER.lastIndex = 0;
  const first = CLAIM_MARKER.exec(text);
  CLAIM_MARKER.lastIndex = 0;
  return first;
}

/**
 * An `[[overview]]` block written ahead of the claims, as offsets into `text`: `start` (the
 * marker), `bodyStart` (just after it) and `end` (the first claim marker, or the end of the
 * text while the claims have yet to stream in). `null` when the overview, if any, comes
 * after the first claim — the older, trailing shape.
 */
function leadingOverview(text) {
  const marker = text.match(OVERVIEW_MARKER);
  if (!marker) return null;
  const first = firstClaimMarker(text);
  if (first && first.index < marker.index) return null;
  return { start: marker.index, bodyStart: marker.index + marker[0].length, end: first ? first.index : text.length };
}

/** Where the claims stop: a trailing `[[overview]]` marker at or after `from` (where the
 * claims start) if there is one, else the whole text. */
function claimsEnd(text, from = 0) {
  const match = text.slice(from).match(OVERVIEW_MARKER);
  return match ? from + match.index : text.length;
}

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
  const parsed = parseClaims(rawAnswer);
  return parsed ? parsed.claims : null;
}

/**
 * The work behind `splitClaims`, plus the one thing it finds that isn't a claim: text after
 * the last claim's verdict, which is the overview (see `claimsOverview`).
 *
 * A claim's verdict is the *last* VERDICT line in its own block, not only a VERDICT line
 * that happens to be the very last line. Each block is cut at the next marker, so a VERDICT
 * line inside it can only be its own — anchoring to the very end bought nothing on that
 * front, and it cost the badge every time the model wrote anything after it: a `---`
 * separator, a closing "Overall…" paragraph, a stray line before the next claim. Text after
 * the verdict stays in that claim's body (it was written about this claim more than any
 * other), except after the last claim, where it is the overview.
 */
function parseClaims(rawAnswer) {
  const full = String(rawAnswer ?? "");
  const lead = leadingOverview(full);
  const end = claimsEnd(full, lead ? lead.end : 0);
  const text = full.slice(0, end);
  const markers = [...text.slice(lead ? lead.end : 0).matchAll(CLAIM_MARKER)].map((marker) => {
    marker.index += lead ? lead.end : 0;
    return marker;
  });
  if (markers.length === 0) return null;

  let trailing = "";
  const claims = markers.map((marker, index) => {
    const start = marker.index + marker[0].length;
    const isLast = index + 1 === markers.length;
    const sliceEnd = isLast ? end : markers[index + 1].index;
    const slice = text.slice(start, sliceEnd);

    let verdictMatch = null;
    for (const match of slice.matchAll(ANY_VERDICT_LINE)) verdictMatch = match;

    const verdictKey = verdictMatch
      ? VERDICT_KEY_BY_ALIAS.get(verdictMatch[1].toLowerCase().replace(/\s+/g, " ").trim()) ?? null
      : null;
    let body = stripRules(verdictMatch ? slice.slice(0, verdictMatch.index) : slice);
    if (verdictMatch) {
      const after = stripRules(slice.slice(verdictMatch.index + verdictMatch[0].length));
      if (isLast) trailing = after;
      else if (after) body = body ? `${body}\n\n${after}` : after;
    }

    return {
      title: marker[1].trim(),
      text: body,
      verdictKey,
      // Offsets into the answer this block was parsed out of, so a caller can rewrite one
      // claim's verdict line without re-serialising — and therefore without reflowing —
      // everything around it. `verdict` is null exactly when no VERDICT line was found: a
      // block cut off mid-turn has no line to point at. Nothing in the browser reads these;
      // they are here because the server-side corroboration audit (lib/corroboration.js)
      // needs to parse claims with the same code that renders them rather than a second
      // copy of this syntax.
      range: { start: marker.index, end: sliceEnd },
      verdict: verdictMatch ? verdictSpan(slice, start, verdictMatch) : null,
    };
  });

  const leading = lead ? stripRules(full.slice(lead.bodyStart, lead.end)) : "";
  const marked = end < full.length ? full.slice(end).replace(OVERVIEW_MARKER, "").trim() : "";
  const overview = [leading, trailing, marked].filter(Boolean).join("\n\n");
  return { claims, overview: overview || null };
}

/**
 * A verdict line's place in the whole answer. The newline in front of it is part of the
 * span, as it always was when the line had to be the block's last: the corroboration audit
 * replaces this span with its note *and* a fresh verdict line, and relies on that leading
 * newline to put the two on separate lines.
 */
function verdictSpan(slice, offset, match) {
  const lead = match.index > 0 && slice[match.index - 1] === "\n" ? 1 : 0;
  const start = offset + match.index - lead;
  return { start, end: offset + match.index + match[0].length, text: slice.slice(match.index - lead, match.index + match[0].length) };
}

/**
 * The model's short overall read of the post — what it argues as a whole and how that holds
 * up — written ahead of the first claim (or, in older answers, after the last), or `null`
 * when there is none (or no claims at all).
 *
 * Asked for behind an `[[overview]]` marker, but any text after the last claim's verdict is
 * taken as the overview with or without one: a model that writes "Overall, …" after its
 * last VERDICT line means exactly this, and gluing it onto the last claim's card instead
 * used to cost that claim its verdict badge.
 */
export function claimsOverview(rawAnswer) {
  return parseClaims(rawAnswer)?.overview ?? null;
}

/**
 * The text an answer opens with before its first `[[claim: …]]` marker, or `null` when
 * there is none (or no markers at all — then the whole answer is the body, not a preamble).
 *
 * The prompt allows exactly one thing here: a line of context about the post as a whole
 * that no single claim owns — chiefly "this is a sketch/satire, and these are the real
 * claims under the jokes" (see WHEN THE POST IS A SKETCH, SATIRE OR PARODY in
 * lib/verified-chat.js). `splitClaims` starts each block at its marker, so without this the
 * line was parsed out of every rendering and the reader never saw it — the model telling
 * them what they were looking at, dropped on the floor by the app.
 */
export function claimsPreamble(rawAnswer) {
  const text = String(rawAnswer ?? "");
  const first = firstClaimMarker(text);
  if (!first) return null;
  // An overview written ahead of the claims is the overview card's, not part of this note.
  const lead = leadingOverview(text);
  const preamble = text.slice(0, lead ? lead.start : first.index).trim();
  return preamble || null;
}

/**
 * An answer as text a person reads outside this app — copied, shared — with the app's own
 * block syntax turned into words: `[[claim: X]]` becomes `Claim: X`, `[[overview]]` becomes
 * `Overview:`. With `overview: false` (the reader switched the Overview card off) the
 * overview is left out altogether rather than relabelled.
 */
export function readableAnswer(text, { overview = true } = {}) {
  let out = String(text ?? "");
  const lead = leadingOverview(out);
  const marker = out.match(OVERVIEW_MARKER);
  if (lead) {
    // Written ahead of the claims: relabel it, or cut just the overview, never what follows.
    const body = out.slice(lead.bodyStart, lead.end).trim();
    out = out.slice(0, lead.start) + (overview && body ? `Overview: ${body}\n\n` : "") + out.slice(lead.end);
  } else if (marker) {
    out = overview
      ? out.slice(0, marker.index) + "Overview: " + out.slice(marker.index + marker[0].length).replace(/^\n+/, "")
      : out.slice(0, marker.index).trimEnd();
  }
  CLAIM_MARKER.lastIndex = 0;
  // The marker's own line break is not part of the match, so one is added only when the
  // body began on the marker's line.
  out = out.replace(CLAIM_MARKER, (match, title, offset, whole) => {
    const next = whole[offset + match.length];
    return `Claim: ${title.trim()}${next === undefined || next === "\n" ? "" : "\n"}`;
  });
  CLAIM_MARKER.lastIndex = 0;
  return out.replace(/\n{3,}/g, "\n\n");
}

/** The `[n]` numbers a piece of answer text cites, in the order it first cites them. A
 * timestamp (`[t=0:12]`, `[0:12]`) has a colon or a `t=`, so it is never read as one. */
export function citedNumbers(text) {
  const seen = [];
  for (const group of String(text ?? "").matchAll(/\[(\d+(?:\s*[,;]\s*\d+)*)\]/g)) {
    for (const n of group[1].split(/\s*[,;]\s*/)) if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

/**
 * Which of a turn's sources belong on which card: `{ claims, preamble, overview, other }`,
 * `claims` holding one list per claim.
 *
 * A source goes where it is cited: on the claim whose title or body cites it, in the intro
 * note or the overview if that is where it is cited, and — only if nothing on screen cites
 * it at all — in `other`, the row after the last claim. It used to be one pile on the last
 * claim's card, which read as that claim's evidence: the sources of four claims under the
 * fourth. A source two claims both cite appears on both; that is the truth about it.
 */
export function attributeSources({ rawAnswer, claims, sources } = {}) {
  const all = sources ?? [];
  const byNumber = new Map(all.map((source) => [String(source.n), source]));
  const pick = (text) => citedNumbers(text).map((n) => byNumber.get(n)).filter(Boolean);
  const perClaim = (claims ?? []).map((claim) => pick(`${claim.title}\n${claim.text}`));
  const preamble = pick(claimsPreamble(rawAnswer) ?? "");
  const overview = pick(claimsOverview(rawAnswer) ?? "");
  const placed = new Set([...perClaim.flat(), ...preamble, ...overview]);
  return { claims: perClaim, preamble, overview, other: all.filter((source) => !placed.has(source)) };
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
