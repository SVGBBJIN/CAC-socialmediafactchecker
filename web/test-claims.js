// Unit tests for public/claims.js. No DOM and no network, per the convention in
// CLAUDE.md — the module is deliberately pure so the marker syntax and verdict parsing can
// be pinned down without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VERDICTS,
  splitVerdict,
  splitClaims,
  claimsPreamble,
  claimsOverview,
  attributeSources,
  citedNumbers,
  readableAnswer,
  claimDiff,
  aggregateVerdictKey,
} from "./public/claims.js";

import { cleanCitations } from "./lib/citation-cleanup.js";
import { CitationLedger } from "./lib/citations.js";

/* ---------------------------------------------------------------- splitVerdict */

test("splitVerdict pulls the trailing VERDICT line off and returns the verdict key", () => {
  const { text, verdictKey } = splitVerdict("The claim is false.\n\nVERDICT: Contradicted");
  assert.equal(text, "The claim is false.");
  assert.equal(verdictKey, "contradicted");
});

test("splitVerdict is case-insensitive and tolerates a trailing period", () => {
  assert.equal(splitVerdict("x\nverdict: disputed.").verdictKey, "disputed");
  assert.equal(splitVerdict("x\nVERDICT: CORROBORATED").verdictKey, "corroborated");
});

test("splitVerdict accepts 'insufficient' with or without 'evidence'", () => {
  assert.equal(splitVerdict("x\nVERDICT: Insufficient").verdictKey, "insufficient");
  assert.equal(splitVerdict("x\nVERDICT: Insufficient evidence").verdictKey, "insufficient");
});

test("splitVerdict leaves text with no VERDICT line untouched", () => {
  const { text, verdictKey } = splitVerdict("Just a normal reply, no verdict here.");
  assert.equal(text, "Just a normal reply, no verdict here.");
  assert.equal(verdictKey, null);
});

test("splitVerdict only matches a VERDICT line at the very end of the given text", () => {
  // This is what lets splitClaims call it on one claim's own slice and get that claim's
  // own verdict, not bleed into whatever the next claim's block says.
  const { text, verdictKey } = splitVerdict("VERDICT: Contradicted is mentioned mid-sentence here.");
  assert.equal(verdictKey, null);
  assert.equal(text, "VERDICT: Contradicted is mentioned mid-sentence here.");
});

test("splitVerdict accepts a close synonym and maps it to the canonical key", () => {
  assert.equal(splitVerdict("x\nVERDICT: False").verdictKey, "contradicted");
  assert.equal(splitVerdict("x\nVERDICT: Misleading").verdictKey, "disputed");
  assert.equal(splitVerdict("x\nVERDICT: True").verdictKey, "corroborated");
  assert.equal(splitVerdict("x\nVERDICT: Unverified").verdictKey, "insufficient");
  assert.equal(splitVerdict("x\nVERDICT: Partly true.").verdictKey, "disputed");
});

test("splitVerdict rejects a verdict word that maps to nothing", () => {
  assert.equal(splitVerdict("x\nVERDICT: Satire").verdictKey, null);
});

test("every VERDICTS key round-trips through splitVerdict", () => {
  for (const key of Object.keys(VERDICTS)) {
    const label = VERDICTS[key].label; // e.g. "Insufficient evidence"
    assert.equal(splitVerdict(`x\nVERDICT: ${label}`).verdictKey, key);
  }
});

/* ---------------------------------------------------------------- splitClaims */

test("splitClaims returns null for an answer with no claim markers", () => {
  assert.equal(splitClaims("Hi! I'm a fact-checker, ask me to check a link."), null);
  assert.equal(splitClaims(""), null);
  assert.equal(splitClaims(null), null);
});

test("splitClaims splits a multi-claim answer into one block per marker", () => {
  const answer = [
    "[[claim: The video says unemployment hit a 50-year low]]",
    "This is accurate according to the bureau's release [1].",
    "VERDICT: Corroborated",
    "[[claim: It also claims the policy was unanimous]]",
    "Records show two dissents [2].",
    "VERDICT: Contradicted",
  ].join("\n");

  const claims = splitClaims(answer);
  assert.equal(claims.length, 2);

  assert.equal(claims[0].title, "The video says unemployment hit a 50-year low");
  assert.match(claims[0].text, /according to the bureau's release \[1\]/);
  assert.equal(claims[0].verdictKey, "corroborated");
  // The next claim's marker is not part of this one's text.
  assert.doesNotMatch(claims[0].text, /\[\[claim:/);

  assert.equal(claims[1].title, "It also claims the policy was unanimous");
  assert.match(claims[1].text, /two dissents \[2\]/);
  assert.equal(claims[1].verdictKey, "contradicted");
});

test("splitClaims handles a single claim the same way as many", () => {
  const answer = "[[claim: The clip is unedited]]\nNo evidence of editing was found [1].\nVERDICT: Insufficient evidence";
  const claims = splitClaims(answer);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].title, "The clip is unedited");
  assert.equal(claims[0].verdictKey, "insufficient");
});

test("splitClaims tolerates a claim with no parseable verdict (cut off mid-turn)", () => {
  const answer = "[[claim: A number is quoted]]\nStill checking this against the filing";
  const claims = splitClaims(answer);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].verdictKey, null);
  assert.equal(claims[0].text, "Still checking this against the filing");
});

test("splitClaims is case-insensitive on the marker keyword", () => {
  const claims = splitClaims("[[CLAIM: Loud claim]]\nBody text\nVERDICT: Disputed");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].title, "Loud claim");
});

test("splitClaims requires the marker to be alone on its own line", () => {
  // A model that mentions the syntax mid-sentence, or a page's own text quoted back that
  // happens to contain the string, must not be read as a real marker — same defensive
  // posture the old claim-detection heuristic failed at, just enforced by shape instead of
  // a guess about meaning. See the doc comment on splitClaims.
  assert.equal(splitClaims("The app uses [[claim: …]] markers internally."), null);
  assert.equal(splitClaims("Prefix text [[claim: X]] suffix text"), null);
});

test("splitClaims keeps a multi-line claim body intact", () => {
  const answer = [
    "[[claim: A long claim]]",
    "First paragraph of evidence [1].",
    "",
    "Second paragraph with a bullet:",
    "- **Part one:** true [2].",
    "- **Part two:** false [3].",
    "VERDICT: Disputed",
  ].join("\n");
  const claims = splitClaims(answer);
  assert.equal(claims.length, 1);
  assert.match(claims[0].text, /First paragraph of evidence \[1\]/);
  assert.match(claims[0].text, /Part two:\*\* false \[3\]/);
});

/* ---------------------------------------------------------------- aggregateVerdictKey */

test("aggregateVerdictKey picks the worst finding among the claims", () => {
  const key = (verdictKey) => ({ verdictKey });
  assert.equal(aggregateVerdictKey([key("corroborated"), key("contradicted")]), "contradicted");
  assert.equal(aggregateVerdictKey([key("corroborated"), key("disputed")]), "disputed");
  assert.equal(aggregateVerdictKey([key("corroborated"), key("insufficient")]), "insufficient");
  assert.equal(aggregateVerdictKey([key("corroborated"), key("corroborated")]), "corroborated");
});

test("aggregateVerdictKey ignores claims with no verdict of their own", () => {
  const key = (verdictKey) => ({ verdictKey });
  assert.equal(aggregateVerdictKey([key(null), key("disputed")]), "disputed");
  assert.equal(aggregateVerdictKey([key(null), key(null)]), null);
});

test("aggregateVerdictKey of an empty list is null, not a guess", () => {
  assert.equal(aggregateVerdictKey([]), null);
});

/* ---------------------------------------------------------------- claimDiff */

test("claimDiff asks for a rebuild when the first marker arrives", () => {
  assert.deepEqual(claimDiff(null, splitClaims("[[claim: One]]\nchecking")), {
    rebuild: true,
    settled: [],
  });
});

test("claimDiff asks for a rebuild when a later marker adds a box", () => {
  const before = splitClaims("[[claim: One]]\nwhy\nVERDICT: Corroborated");
  const after = splitClaims("[[claim: One]]\nwhy\nVERDICT: Corroborated\n[[claim: Two]]\nchecking");
  const { rebuild, settled } = claimDiff(before, after);
  assert.equal(rebuild, true);
  // The rebuild redraws every box, settled ones included, so there is no in-place work left.
  assert.deepEqual(settled, []);
});

test("claimDiff reports the claim whose verdict line just landed", () => {
  // The exact moment a box can stop shimmering: the model closed the block the system
  // prompt asked it to close. Nothing is inferred from the prose above it.
  const before = splitClaims("[[claim: One]]\nthe evidence [1]");
  const after = splitClaims("[[claim: One]]\nthe evidence [1]\nVERDICT: Contradicted");
  assert.deepEqual(claimDiff(before, after), { rebuild: false, settled: [0] });
});

test("claimDiff reports nothing while a claim is only growing text", () => {
  const before = splitClaims("[[claim: One]]\nthe");
  const after = splitClaims("[[claim: One]]\nthe evidence so far");
  assert.deepEqual(claimDiff(before, after), { rebuild: false, settled: [] });
});

test("claimDiff does not re-report a claim that already settled", () => {
  const settled = splitClaims("[[claim: One]]\nwhy\nVERDICT: Disputed");
  assert.deepEqual(claimDiff(settled, settled), { rebuild: false, settled: [] });
});

test("claimDiff settles only the claim that closed, not its unfinished neighbours", () => {
  // The whole point: on a multi-claim check the earlier blocks are finished and readable
  // long before the last one is, and each is handed over on its own.
  const answer = (second) => splitClaims(`[[claim: One]]\nwhy\nVERDICT: Corroborated\n[[claim: Two]]\n${second}`);
  const before = answer("still checking");
  const after = answer("done\nVERDICT: Contradicted");
  assert.deepEqual(claimDiff(before, after), { rebuild: false, settled: [1] });
});

test("claimDiff treats an answer with no markers as nothing to draw", () => {
  // A greeting or a follow-up: `splitClaims` returns null, and null is not "zero claims".
  assert.deepEqual(claimDiff(null, splitClaims("hello there")), { rebuild: false, settled: [] });
});

/* ---------------------------------------------------------------- coexistence with citations */

test("citation cleanup leaves claim markers alone", () => {
  // The whole reason the marker is `[[claim: …]]` and not something that could ever look
  // like `[n]`: the server's citation pass deletes any bracketed group it cannot resolve
  // against the ledger, and this must not be in its blast radius.
  const ledger = new CitationLedger();
  ledger.record({
    claim: "rates",
    query: "interest rates",
    results: [{ title: "Rates", url: "https://example.com/rates", domain: "example.com" }],
  });

  const answer = "[[claim: Rates fell last quarter]]\nConfirmed by the filing [1]. Invented [9].\nVERDICT: Corroborated";
  const cleaned = cleanCitations(answer, ledger);

  assert.match(cleaned.text, /\[\[claim: Rates fell last quarter\]\]/);
  assert.match(cleaned.text, /\[1\]/);
  assert.doesNotMatch(cleaned.text, /\[9\]/);

  // And the marker still parses out cleanly on the far side of citation cleanup.
  const claims = splitClaims(cleaned.text);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].verdictKey, "corroborated");
});

/* ---------------------------------------------------------------- formatting tolerance */

// The prompt asks for a bare marker and a bare VERDICT line, and a compliant answer writes
// them. These pin down the net underneath: a model drafting prose reaches for markdown
// without being asked, and a claim losing its badge — or, worse, reading as unfinished to
// `claimDiff` and shimmering forever — over a pair of asterisks is the app being pickier
// than the fact it is rendering. What stays mandatory is tested at the bottom: the double
// brackets, the word VERDICT, one of the four findings, and the line being last.

test("splitVerdict accepts the label emphasised on either side of the colon", () => {
  assert.equal(splitVerdict("x\n**VERDICT:** Contradicted").verdictKey, "contradicted");
  assert.equal(splitVerdict("x\n**VERDICT: Contradicted**").verdictKey, "contradicted");
  assert.equal(splitVerdict("x\nVERDICT: *Disputed*").verdictKey, "disputed");
  assert.equal(splitVerdict("x\n__VERDICT__: Corroborated").verdictKey, "corroborated");
});

test("splitVerdict accepts a dash in place of the colon, and a bullet or hashes before it", () => {
  assert.equal(splitVerdict("x\nVerdict — Corroborated.").verdictKey, "corroborated");
  assert.equal(splitVerdict("x\nVerdict – Disputed").verdictKey, "disputed");
  assert.equal(splitVerdict("x\n- VERDICT: Insufficient evidence").verdictKey, "insufficient");
  assert.equal(splitVerdict("x\n### VERDICT: Contradicted").verdictKey, "contradicted");
});

test("splitVerdict takes the whole line with it, markdown included", () => {
  const { text } = splitVerdict("The reading is below the limit.\n\n**VERDICT:** Contradicted");
  assert.equal(text, "The reading is below the limit.");
});

test("splitClaims reads a marker that has been bolded, bulleted or numbered", () => {
  const claims = splitClaims(
    "**[[claim: A]]**\nbody\nVERDICT: Contradicted\n" +
      "- [[claim: B]]\nbody\nVERDICT: Corroborated\n" +
      "2. [[claim: C]]\nbody\nVERDICT: Disputed\n" +
      "## [[claim: D]]\nbody\nVERDICT: Insufficient evidence",
  );
  assert.deepEqual(
    claims.map((c) => [c.title, c.verdictKey]),
    [
      ["A", "contradicted"],
      ["B", "corroborated"],
      ["C", "disputed"],
      ["D", "insufficient"],
    ],
  );
});

test("splitClaims tolerates spacing inside the marker", () => {
  const claims = splitClaims("[[ claim : Spaced out ]]\nbody\nVERDICT: Disputed");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].title, "Spaced out");
});

test("a marker still being streamed is not a claim until its brackets close", () => {
  assert.equal(splitClaims("[[claim: half a titl"), null);
  const claims = splitClaims("[[claim: whole]]\nbody so far");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].verdictKey, null); // and unfinished until its verdict line lands
});

test("the brackets, the word VERDICT and the four findings all stay mandatory", () => {
  // A line that merely looks like a claim is not one — this is the heuristic the app tore
  // out, and hardening the marker must not quietly put it back.
  assert.equal(splitClaims("Claim: the water is unsafe\nIt isn't."), null);
  assert.equal(splitClaims("1. The water is unsafe."), null);
  assert.equal(splitVerdict("x\nThe finding: Contradicted").verdictKey, null);
  assert.equal(splitVerdict("x\nVERDICT: Probably fine").verdictKey, null);
  // Not the last line in the block, so not this block's verdict.
  assert.equal(splitVerdict("x\nVERDICT: Contradicted\nOne more thought.").verdictKey, null);
});

/* ---------------------------------------------------------------- claimsPreamble */

test("claimsPreamble returns the context line before the first claim", () => {
  const answer = [
    "This is a comedy sketch; the claims below are the real ones under the jokes.",
    "",
    "[[claim: Inflation hit 40%]]",
    "It peaked at 9.1% [1].",
    "VERDICT: Contradicted",
  ].join("\n");
  assert.equal(
    claimsPreamble(answer),
    "This is a comedy sketch; the claims below are the real ones under the jokes.",
  );
  // Parsing the preamble must not disturb the claims themselves.
  assert.equal(splitClaims(answer).length, 1);
});

test("claimsPreamble is null when the answer opens on a claim, or has none", () => {
  assert.equal(claimsPreamble("[[claim: X]]\nbody\nVERDICT: Disputed"), null);
  assert.equal(claimsPreamble("  \n\n[[claim: X]]\nbody"), null);
  assert.equal(claimsPreamble("Just a reply, no claims."), null);
  assert.equal(claimsPreamble(undefined), null);
});


/* ---------------------------------------------------------------- tolerant parsing */

test("splitClaims reads a marker with its body starting on the same line", () => {
  // The old `$` anchor made this marker invisible, and its whole check merged into the card
  // above it — two claims rendered as one, under the first one's title.
  const claims = splitClaims(
    "[[claim: First]]\nBody one.\nVERDICT: Corroborated\n[[claim: Second]] Body two starts here [2].\nVERDICT: Contradicted",
  );
  assert.equal(claims.length, 2);
  assert.equal(claims[1].title, "Second");
  assert.equal(claims[1].text, "Body two starts here [2].");
  assert.equal(claims[1].verdictKey, "contradicted");
});

test("splitClaims keeps a bracketed timestamp inside the title whole", () => {
  const [claim] = splitClaims("[[claim: The senator said it [t=0:12-0:18]]]\nbody\nVERDICT: Disputed");
  assert.equal(claim.title, "The senator said it [t=0:12-0:18]");
});

test("splitClaims accepts a numbered marker and a dash for the colon", () => {
  const claims = splitClaims("[[Claim 1: One]]\na\nVERDICT: True\n[[claim — Two]]\nb\nVERDICT: False");
  assert.deepEqual(claims.map((c) => [c.title, c.verdictKey]), [
    ["One", "corroborated"],
    ["Two", "contradicted"],
  ]);
});

test("a claim keeps its verdict when something follows the VERDICT line", () => {
  // A `---` separator or a stray line used to cost the claim its badge, because the verdict
  // had to be the block's very last line. It only ever has to be in its own block.
  const claims = splitClaims(
    "[[claim: A]]\nbody a\nVERDICT: Disputed\n\n---\n\nA stray line.\n[[claim: B]]\nbody b\nVERDICT: Corroborated",
  );
  assert.equal(claims[0].verdictKey, "disputed");
  assert.equal(claims[0].text, "body a\n\nA stray line.");
  assert.equal(claims[1].verdictKey, "corroborated");
});

test("text after the last verdict is the overview, not the last claim's body", () => {
  const unmarked = "[[claim: A]]\nbody\nVERDICT: Contradicted\n\nOverall, the video is mostly wrong.";
  assert.equal(splitClaims(unmarked)[0].verdictKey, "contradicted");
  assert.equal(splitClaims(unmarked)[0].text, "body");
  assert.equal(claimsOverview(unmarked), "Overall, the video is mostly wrong.");

  const marked = "[[claim: A]]\nbody\nVERDICT: Corroborated\n[[overview]]\nIt holds up [1].";
  assert.equal(splitClaims(marked).length, 1);
  assert.equal(claimsOverview(marked), "It holds up [1].");
  assert.equal(claimsOverview("[[claim: A]]\nbody\nVERDICT: Corroborated"), null);
  assert.equal(claimsOverview("No claims at all."), null);
});

test("an overview written ahead of the claims is the overview, not the preamble", () => {
  const answer = [
    "This is satire [3].",
    "[[overview]]",
    "Mostly wrong [1].",
    "[[claim: A]]",
    "body a",
    "VERDICT: Contradicted",
    "[[claim: B]]",
    "body b",
    "VERDICT: Corroborated",
  ].join("\n");
  const claims = splitClaims(answer);
  assert.deepEqual(claims.map((claim) => claim.title), ["A", "B"]);
  assert.deepEqual(claims.map((claim) => claim.verdictKey), ["contradicted", "corroborated"]);
  assert.equal(claims[1].text, "body b");
  assert.equal(claimsOverview(answer), "Mostly wrong [1].");
  assert.equal(claimsPreamble(answer), "This is satire [3].");
  // Offsets still point into the whole answer, which the corroboration audit relies on.
  assert.equal(answer.slice(claims[0].verdict.start, claims[0].verdict.end), "\nVERDICT: Contradicted");
  assert.equal(answer.slice(claims[1].range.start, claims[1].range.end), "[[claim: B]]\nbody b\nVERDICT: Corroborated");
});

test("mid-stream, a leading overview is whole before the first claim has finished", () => {
  assert.equal(splitClaims("[[overview]]\nMostly wrong."), null);
  const partial = "[[overview]]\nMostly wrong.\n[[claim: A]]\nbody so f";
  assert.equal(splitClaims(partial)[0].verdictKey, null);
  assert.equal(claimsOverview(partial), "Mostly wrong.");
  assert.equal(claimsPreamble(partial), null);
});

test("a verdict's span still starts at the newline before it", () => {
  // The corroboration audit replaces this span with a note and a fresh verdict line, and
  // relies on the leading newline to keep the two apart.
  const answer = "[[claim: A]]\nbody\nVERDICT: Corroborated\n\nOverall fine.";
  const [claim] = splitClaims(answer);
  assert.equal(claim.verdict.text, "\nVERDICT: Corroborated");
  assert.equal(answer.slice(claim.verdict.start, claim.verdict.end), claim.verdict.text);
});

/* ---------------------------------------------------------------- source attribution */

test("citedNumbers reads single and grouped markers, never timestamps", () => {
  assert.deepEqual(citedNumbers("a [2] b [1, 3] c [2] at [t=0:12] and [0:40]"), ["2", "1", "3"]);
});

test("attributeSources puts each source on the card that cites it", () => {
  const sources = [1, 2, 3, 4, 5].map((n) => ({ n, url: `https://e.com/${n}` }));
  const rawAnswer = [
    "This is satire [5].",
    "[[claim: A [1]]]",
    "body [2]",
    "VERDICT: Corroborated",
    "[[claim: B]]",
    "body [2][3]",
    "VERDICT: Disputed",
    "[[overview]]",
    "Summary.",
  ].join("\n");
  const out = attributeSources({ rawAnswer, claims: splitClaims(rawAnswer), sources });
  assert.deepEqual(out.claims.map((list) => list.map((s) => s.n)), [[1, 2], [2, 3]]);
  assert.deepEqual(out.preamble.map((s) => s.n), [5]);
  assert.deepEqual(out.overview, []);
  // Nothing cites source 4, so it is the only one left for the row after the claims.
  assert.deepEqual(out.other.map((s) => s.n), [4]);
});


/* ---------------------------------------------------------------- readableAnswer */

test("readableAnswer turns the app's block syntax into words for copying", () => {
  const answer = "Intro.\n\n[[claim: A]]\nbody [1]\nVERDICT: Corroborated\n[[overview]]\nIt holds up.";
  assert.equal(
    readableAnswer(answer),
    "Intro.\n\nClaim: A\nbody [1]\nVERDICT: Corroborated\nOverview: It holds up.",
  );
  // The reader switched the overview off: it stays out of the copy, too.
  assert.equal(readableAnswer(answer, { overview: false }), "Intro.\n\nClaim: A\nbody [1]\nVERDICT: Corroborated");
  assert.equal(readableAnswer("Just a reply."), "Just a reply.");

  const leading = "Intro.\n\n[[overview]]\nIt holds up.\n[[claim: A]]\nbody [1]\nVERDICT: Corroborated";
  assert.equal(
    readableAnswer(leading),
    "Intro.\n\nOverview: It holds up.\n\nClaim: A\nbody [1]\nVERDICT: Corroborated",
  );
  // Switched off, only the overview goes — never the claims after it.
  assert.equal(readableAnswer(leading, { overview: false }), "Intro.\n\nClaim: A\nbody [1]\nVERDICT: Corroborated");
});
