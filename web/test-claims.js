// Unit tests for public/claims.js. No DOM and no network, per the convention in
// CLAUDE.md — the module is deliberately pure so the marker syntax and verdict parsing can
// be pinned down without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VERDICTS,
  splitVerdict,
  splitClaims,
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
