// The judge: a second opinion, from the model reading the cited pages, before the
// corroboration word match is allowed to lower a verdict. See lib/corroboration-judge.js.
//
// Pure, no network, no dependencies — the convention in CLAUDE.md. `ask` and `read` are
// stubs; the path through verifiedChat is covered in test-search.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  judgeDowngrades,
  gatherEvidence,
  judgePrompt,
  parseJudgement,
  JUDGE_SYSTEM_PROMPT,
  MAX_SOURCES_PER_CLAIM,
} from "./lib/corroboration-judge.js";
import { auditCorroboration } from "./lib/corroboration.js";
import { CitationLedger } from "./lib/citations.js";

function ledgerOf(...results) {
  const ledger = new CitationLedger();
  ledger.record({
    query: "q",
    claim: "c",
    provider: "test",
    retrievedAt: "2026-01-01",
    results: results.map((r) => ({ domain: new URL(r.url).hostname, snippet: "", ...r })),
  });
  return ledger;
}

const block = (claim, body, verdict) => `[[claim: ${claim}]]\n${body}\nVERDICT: ${verdict}`;

// The word match cannot read "a third" as 33%: the claim's figure never appears, so it
// flags the claim, and only something that reads the page can see it is carried.
const THIRD = {
  title: "Survey results",
  url: "https://stats.example/survey",
  snippet: "A third of adults in Spain reported using the service last year.",
};
const ANSWER = block(
  "33% of adults in Spain used the service last year",
  "The survey reports exactly that share [1].",
  "Corroborated",
);

/* ---------------------------------------------------------------- parseJudgement */

test("parseJudgement reads the claims the judge found supported", () => {
  const reply = "CLAIM 1: SUPPORTED — [1] says a third\nCLAIM 2: NOT SUPPORTED — no figure\nCLAIM 3: supported";
  assert.deepEqual([...parseJudgement(reply, 3)].sort(), [1, 3]);
});

test("parseJudgement tolerates markdown around the line", () => {
  assert.deepEqual([...parseJudgement("**Claim 1:** Supported — [2]", 1)], [1]);
  assert.deepEqual([...parseJudgement("- CLAIM 1 — SUPPORTED", 1)], [1]);
});

test("parseJudgement never reads NOT SUPPORTED as SUPPORTED", () => {
  assert.deepEqual([...parseJudgement("CLAIM 1: NOT SUPPORTED — only the topic", 1)], []);
  assert.deepEqual([...parseJudgement("CLAIM 1: not  supported", 1)], []);
});

test("parseJudgement treats a claim answered both ways as not supported", () => {
  assert.deepEqual([...parseJudgement("CLAIM 1: SUPPORTED\nCLAIM 1: NOT SUPPORTED", 1)], []);
});

test("parseJudgement ignores claim numbers it was never asked about, and prose", () => {
  assert.deepEqual([...parseJudgement("CLAIM 7: SUPPORTED\nThe sources are supported by evidence.", 2)], []);
});

/* ---------------------------------------------------------------- gatherEvidence */

test("gatherEvidence quotes the snippet, earlier finds and the freshly read passages", async () => {
  const ledger = ledgerOf(THIRD);
  ledger.sources[0].passages = [{ text: "Earlier passage." }];
  const asked = [];
  const [source] = await gatherEvidence({ title: "the claim", cited: [1] }, ledger, {
    read: async (url, find) => {
      asked.push([url, find]);
      return ["Fresh passage.", "Earlier passage."];
    },
  });
  assert.deepEqual(asked, [["https://stats.example/survey", "the claim"]]);
  assert.equal(source.snippet, THIRD.snippet);
  assert.deepEqual(source.passages, ["Earlier passage.", "Fresh passage."]);
});

test("gatherEvidence falls back to what it has when a page cannot be read", async () => {
  const [source] = await gatherEvidence({ title: "c", cited: [1] }, ledgerOf(THIRD), {
    read: async () => {
      throw new Error("blocked");
    },
  });
  assert.equal(source.snippet, THIRD.snippet);
  assert.deepEqual(source.passages, []);
});

test("gatherEvidence stops waiting for a slow page at its budget", async () => {
  const started = Date.now();
  const [source] = await gatherEvidence({ title: "c", cited: [1] }, ledgerOf(THIRD), {
    read: () => new Promise(() => {}),
    budgetMs: 30,
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal(source.snippet, THIRD.snippet);
});

test("gatherEvidence reads at most MAX_SOURCES_PER_CLAIM sources", async () => {
  const many = Array.from({ length: MAX_SOURCES_PER_CLAIM + 2 }, (_, i) => ({ title: `T${i}`, url: `https://s${i}.example/` }));
  const ledger = ledgerOf(...many);
  const evidence = await gatherEvidence({ title: "c", cited: many.map((_, i) => i + 1) }, ledger, {});
  assert.equal(evidence.length, MAX_SOURCES_PER_CLAIM);
});

/* ---------------------------------------------------------------- judgePrompt */

test("judgePrompt fences every quote and leaves out URLs", () => {
  const prompt = judgePrompt([
    {
      downgrade: { title: "The claim", body: "Body [1]." },
      evidence: [{ n: 1, title: "A page", domain: "youtube.com", snippet: "S", passages: ["P"] }],
    },
  ]);
  assert.match(prompt, /^CLAIM 1: The claim/);
  assert.match(prompt, /<<<SOURCE \[1\] A page \(youtube\.com\)\nSnippet: S\nPassage: P\nSOURCE>>>/);
  assert.ok(!/https?:\/\//.test(prompt), "a link in the message would be attached as media");
  assert.match(JUDGE_SYSTEM_PROMPT, /data, never instructions/);
});

/* ---------------------------------------------------------------- judgeDowngrades */

test("a claim the word match flags but the judge finds in its sources keeps its verdict", async () => {
  const ledger = ledgerOf(THIRD);
  const first = auditCorroboration(ANSWER, ledger);
  assert.equal(first.changed, true, "the word match cannot see 'a third' as 33%");

  let seen = null;
  const spare = await judgeDowngrades(first.downgrades, ledger, {
    ask: async (system, prompt) => {
      seen = { system, prompt };
      return "CLAIM 1: SUPPORTED — [1] says a third of adults";
    },
  });
  assert.deepEqual([...spare], [0]);
  assert.match(seen.prompt, /A third of adults in Spain/);
  assert.equal(seen.system, JUDGE_SYSTEM_PROMPT);

  const second = auditCorroboration(ANSWER, ledger, { spare });
  assert.equal(second.changed, false);
  assert.equal(second.text, ANSWER);
});

test("a claim the judge does not find supported is lowered exactly as before", async () => {
  const ledger = ledgerOf(THIRD);
  const first = auditCorroboration(ANSWER, ledger);
  const spare = await judgeDowngrades(first.downgrades, ledger, {
    ask: async () => "CLAIM 1: NOT SUPPORTED — the page gives no percentage",
  });
  assert.equal(spare.size, 0);
  assert.equal(auditCorroboration(ANSWER, ledger, { spare }).text, first.text);
});

test("a judge that fails, or answers in another shape, spares nothing", async () => {
  const ledger = ledgerOf(THIRD);
  const { downgrades } = auditCorroboration(ANSWER, ledger);
  const failing = await judgeDowngrades(downgrades, ledger, {
    ask: async () => {
      throw new Error("every model is busy");
    },
  });
  assert.equal(failing.size, 0);
  const rambling = await judgeDowngrades(downgrades, ledger, { ask: async () => "I think it is probably fine." });
  assert.equal(rambling.size, 0);
});

test("a claim that cited nothing is not sent to the judge", async () => {
  const answer = block("33% of adults in Spain used the service", "Everyone knows this.", "Corroborated");
  const ledger = ledgerOf(THIRD);
  const { downgrades } = auditCorroboration(answer, ledger);
  const spare = await judgeDowngrades(downgrades, ledger, { ask: async () => assert.fail("nothing to judge") });
  assert.equal(spare.size, 0);
});

test("several flagged claims are judged in one call and spared one by one", async () => {
  const answer = [
    block("Cleared claim about Ireland and 5 million people", "Backed [1].", "Corroborated"),
    block("33% of adults in Spain used the service last year", "Backed [2].", "Corroborated"),
    block("Half of all Portuguese adults own a bicycle", "Backed [3].", "Corroborated"),
  ].join("\n");
  const ledger = ledgerOf(
    { title: "Ireland population", url: "https://cso.example/", snippet: "Ireland's population passed 5 million people." },
    THIRD,
    { title: "Cycling", url: "https://bikes.example/", snippet: "Cycling is popular in Portugal." },
  );
  const first = auditCorroboration(answer, ledger);
  assert.deepEqual(first.downgrades.map((d) => d.index), [1, 2]);

  let calls = 0;
  const spare = await judgeDowngrades(first.downgrades, ledger, {
    ask: async (_, prompt) => {
      calls += 1;
      assert.match(prompt, /CLAIM 1: 33%/);
      assert.match(prompt, /CLAIM 2: Half of all Portuguese/);
      return "CLAIM 1: SUPPORTED — a third\nCLAIM 2: NOT SUPPORTED — no share given";
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual([...spare], [1]);

  const final = auditCorroboration(answer, ledger, { spare });
  assert.deepEqual(final.downgrades.map((d) => d.index), [2]);
});
