// The re-check: a claim given a decisive verdict with no source under it gets the search it
// skipped, and its block is rewritten against what came back. See lib/claim-repair.js.
//
// Pure, no network, no dependencies — the convention in CLAUDE.md. `search` and `ask` are
// stubs; the end-to-end path through verifiedChat is covered in test-search.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  uncitedClaims,
  spliceRepairs,
  repairPrompt,
  repairUncitedClaims,
  MAX_REPAIR_CLAIMS,
} from "./lib/claim-repair.js";
import { CitationLedger } from "./lib/citations.js";
import { splitClaims } from "./public/claims.js";

function result(claim, urls, snippet = "snippet") {
  return {
    query: claim,
    claim,
    provider: "test",
    retrievedAt: "2026-01-01",
    results: urls.map((url, i) => ({ title: `Title ${i}`, url, domain: new URL(url).hostname, snippet })),
  };
}

function ledgerWith(...urls) {
  const ledger = new CitationLedger();
  if (urls.length) ledger.record(result("earlier", urls));
  return ledger;
}

const block = (claim, body, verdict) => `[[claim: ${claim}]]\n${body}\nVERDICT: ${verdict}`;

/** Drive the generator to completion, returning its frames and its return value. */
async function run(gen) {
  const frames = [];
  let step = await gen.next();
  while (!step.done) {
    frames.push(step.value);
    step = await gen.next();
  }
  return { frames, value: step.value };
}

/* ---------------------------------------------------------------- uncitedClaims */

test("uncitedClaims picks out a decisive verdict with no marker under it", () => {
  const answer = [
    block("The bridge opened in 2011", "The clip says so at [t=0:04].", "Corroborated"),
    block("It cost $2bn", "Records show $2.1bn [1].", "Corroborated"),
  ].join("\n");
  const found = uncitedClaims(answer, ledgerWith("https://a.example/1"));
  assert.deepEqual(found.map((c) => c.title), ["The bridge opened in 2011"]);
});

test("uncitedClaims treats Contradicted and Disputed the same as Corroborated", () => {
  const answer = [
    block("A", "No source here.", "Contradicted"),
    block("B", "No source here either.", "Disputed"),
  ].join("\n");
  assert.equal(uncitedClaims(answer, ledgerWith()).length, 2);
});

test("uncitedClaims leaves Insufficient evidence alone — it is honest with nothing cited", () => {
  const answer = block("A", "I could not find a source for this.", "Insufficient evidence");
  assert.deepEqual(uncitedClaims(answer, ledgerWith("https://a.example/1")), []);
});

test("uncitedClaims counts a marker the ledger cannot resolve as no citation", () => {
  const answer = block("A", "Some page says so [9].", "Corroborated");
  assert.equal(uncitedClaims(answer, ledgerWith("https://a.example/1")).length, 1);
});

test("uncitedClaims returns nothing for an answer with no claim blocks", () => {
  assert.deepEqual(uncitedClaims("Hi! Send me a link.", ledgerWith()), []);
});

/* ---------------------------------------------------------------- spliceRepairs */

test("spliceRepairs replaces only the uncited block and keeps its original claim line", () => {
  const answer = [
    block("First claim", "Backed by [1].", "Corroborated"),
    block("Second claim", "Said at [t=0:10]. True.", "Corroborated"),
  ].join("\n");
  const originals = uncitedClaims(answer, ledgerWith("https://a.example/1"));
  const reply = block("Second claim, reworded", "Said at [t=0:10]. The record confirms it [2].", "Corroborated");

  const { text, repaired } = spliceRepairs(answer, originals, reply);
  assert.equal(repaired, 1);
  assert.equal(
    text,
    [
      block("First claim", "Backed by [1].", "Corroborated"),
      block("Second claim", "Said at [t=0:10]. The record confirms it [2].", "Corroborated"),
    ].join("\n"),
  );
  assert.deepEqual(
    splitClaims(text).map((c) => c.title),
    ["First claim", "Second claim"],
  );
});

test("spliceRepairs can move a verdict, and normalises it to the closed vocabulary", () => {
  const answer = block("A", "True.", "Corroborated");
  const originals = uncitedClaims(answer, ledgerWith());
  const { text } = spliceRepairs(answer, originals, block("A", "Only the topic is covered [1].", "Unverified"));
  assert.equal(splitClaims(text)[0].verdictKey, "insufficient");
  assert.match(text, /VERDICT: Insufficient evidence$/);
});

test("spliceRepairs keeps the original when the rewrite has no verdict line", () => {
  const answer = block("A", "True.", "Corroborated");
  const originals = uncitedClaims(answer, ledgerWith());
  const { text, repaired } = spliceRepairs(answer, originals, "[[claim: A]]\nThe record says [1] and then it stopp");
  assert.equal(repaired, 0);
  assert.equal(text, answer);
});

test("spliceRepairs leaves text after the last verdict where it was", () => {
  const answer = block("A", "True.", "Corroborated") + "\n";
  const originals = uncitedClaims(answer, ledgerWith());
  const { text } = spliceRepairs(answer, originals, block("A", "Confirmed [1].", "Corroborated"));
  assert.ok(text.endsWith("VERDICT: Corroborated\n"));
});

/* ---------------------------------------------------------------- repairPrompt */

test("repairPrompt hands over each block with the sources found for it", () => {
  const answer = block("The bridge opened in 2011", "Said at [t=0:04].", "Corroborated");
  const [claim] = uncitedClaims(answer, ledgerWith());
  const prompt = repairPrompt([{ claim, description: "[1] Title 0\n    https://a.example/1" }]);
  assert.match(prompt, /\[\[claim: The bridge opened in 2011\]\]/);
  assert.match(prompt, /Said at \[t=0:04\]\./);
  assert.match(prompt, /\[1\] Title 0/);
  assert.match(prompt, /Insufficient\s+evidence/);
});

/* ---------------------------------------------------------------- repairUncitedClaims */

test("an uncited claim is searched, re-checked and cited", async () => {
  const answer = block("The bridge opened in 2011", "The clip says so [t=0:04]. That is right.", "Corroborated");
  const ledger = ledgerWith();
  const searched = [];
  let asked = null;

  const { frames, value } = await run(
    repairUncitedClaims(answer, {
      ledger,
      search: async (args) => {
        searched.push(args);
        return result(args.claim, ["https://records.example/bridge"], "The bridge opened in 2011.");
      },
      ask: async (prompt) => {
        asked = prompt;
        return block("The bridge opened in 2011", "The clip says so [t=0:04]. Records confirm it [1].", "Corroborated");
      },
    }),
  );

  assert.deepEqual(searched, [{ query: "The bridge opened in 2011", claim: "The bridge opened in 2011" }]);
  assert.equal(ledger.size, 1);
  assert.match(asked, /records\.example\/bridge/);
  assert.equal(value.repaired, 1);
  assert.match(value.text, /Records confirm it \[1\]\./);
  assert.deepEqual(
    frames.map((f) => f.type),
    ["stage", "searching", "search"],
  );
  assert.equal(frames[2].recheck, true);
  assert.deepEqual(frames[2].results.map((r) => r.n), [1]);
});

test("nothing is searched or asked when every decisive verdict is cited", async () => {
  const answer = block("A", "Backed by [1].", "Corroborated");
  const { frames, value } = await run(
    repairUncitedClaims(answer, {
      ledger: ledgerWith("https://a.example/1"),
      search: async () => assert.fail("no search should run"),
      ask: async () => assert.fail("no model call should run"),
    }),
  );
  assert.deepEqual(frames, []);
  assert.equal(value.text, answer);
  assert.equal(value.repaired, 0);
});

test("a failed search or an empty one leaves the block for the audit", async () => {
  const answer = [block("A", "True.", "Corroborated"), block("B", "Also true.", "Corroborated")].join("\n");
  const { frames, value } = await run(
    repairUncitedClaims(answer, {
      ledger: ledgerWith(),
      search: async (args) => {
        if (args.claim === "A") throw new Error("provider down");
        return result(args.claim, []);
      },
      ask: async () => assert.fail("nothing to re-check against"),
    }),
  );
  assert.equal(value.text, answer);
  assert.equal(value.repaired, 0);
  assert.equal(frames.find((f) => f.type === "search" && f.error)?.error, "provider down");
});

test("a model call that fails leaves the answer as it was", async () => {
  const answer = block("A", "True.", "Corroborated");
  const { value } = await run(
    repairUncitedClaims(answer, {
      ledger: ledgerWith(),
      search: async (args) => result(args.claim, ["https://a.example/1"]),
      ask: async () => {
        throw new Error("every model is busy");
      },
    }),
  );
  assert.equal(value.text, answer);
  assert.equal(value.repaired, 0);
});

test("at most MAX_REPAIR_CLAIMS claims are re-checked in one turn", async () => {
  const answer = Array.from({ length: MAX_REPAIR_CLAIMS + 2 }, (_, i) =>
    block(`Claim ${i}`, "True.", "Corroborated"),
  ).join("\n");
  let searches = 0;
  await run(
    repairUncitedClaims(answer, {
      ledger: ledgerWith(),
      search: async (args) => {
        searches += 1;
        return result(args.claim, []);
      },
      ask: async () => "",
    }),
  );
  assert.equal(searches, MAX_REPAIR_CLAIMS);
});
