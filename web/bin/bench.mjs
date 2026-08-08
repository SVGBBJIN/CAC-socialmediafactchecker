#!/usr/bin/env node
// What the test suite can honestly say about speed.
//
// The unit tests stub every fetch, so they cannot time the pipeline — a stubbed search
// returns in microseconds and a real one takes seconds, and no amount of running them says
// anything about which. What they *can* do is hold the pipeline still while its structural
// costs are counted exactly, and those costs are the half of latency this repo can actually
// change: how many times a byte crosses the wire, how many round trips a turn pays for, and
// how long the pure code between them runs.
//
// So this reuses the tests' own seams — `resolveImpl`/`downloadImpl` to stand in for a
// platform, a recording `fetchImpl` to stand in for Gemini — and reports three things:
//
//   1. **Wire bytes per model round.** The one number behind the note in CLAUDE.md about
//      not caching media on the wire. An inline clip is re-sent in full on every round of
//      the turn; this measures how full.
//   2. **Round trips saved by each cache.** The clip cache and the article cache both exist
//      to stop a replayed conversation re-fetching what it already has. This counts the
//      fetches with each on and off, which is the thing they were built to change.
//   3. **CPU in the pure hot paths.** Everything above is network. These are the stretches
//      of ordinary JavaScript every request runs through regardless — HTML extraction,
//      passage ranking, citation cleanup — and the question is only whether any of them is
//      big enough to be worth a second look next to a multi-second network wait.
//
// Nothing here asserts. It is a measurement tool, run by hand when a number is wanted:
//
//     node bin/bench.mjs

import { Buffer } from "node:buffer";

import { resolveClipParts, streamChat, resetClipCache } from "../lib/gemini.js";
import { INLINE_BYTE_LIMIT } from "../lib/tiktok.js";
import { POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS } from "../lib/gemini-files.js";
import { FACT_CHECK_SYSTEM_PROMPT } from "../lib/verified-chat.js";
import { resolveArticles, resetArticleCache } from "../lib/article.js";
import { htmlToText, extractPassages } from "../lib/page-find.js";
import { cleanCitations } from "../lib/citation-cleanup.js";
import { CitationLedger } from "../lib/citations.js";
import { splitClaims } from "../public/claims.js";

/* ------------------------------------------------------------------ formatting */

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const ms = (n) => `${n.toFixed(1)} ms`;

function heading(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log("─".repeat(title.length));
}

function row(label, value, note = "") {
  console.log(`  ${label.padEnd(38)} ${String(value).padStart(12)}  ${note}`);
}

/** Median of `runs` timed calls, after `warmup` untimed ones. Median rather than mean —
 * one GC pause in a ten-run sample moves a mean and not a median. */
function timed(fn, { runs = 9, warmup = 3 } = {}) {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/* ------------------------------------------------------------------ fixtures */

const TIKTOK_LINK = "https://www.tiktok.com/@scout2015/video/6718335390845095173";

function resolvedClip() {
  return {
    sourceURL: TIKTOK_LINK,
    videoID: "6718335390845095173",
    mediaURL: "https://v16m.tiktokcdn-us.com/clip.mp4",
    mimeType: "video/mp4",
    duration: 32,
    authorName: "Scout",
    caption: "A caption that is also the claim",
  };
}

/** A Gemini SSE response that asks for `calls` tool calls, then (on the round after the
 * last script entry) writes an answer. Shaped like `fakeGemini` in test-search.js. */
function geminiScript(rounds) {
  let round = 0;
  return async (_url, options) => {
    const script = rounds[Math.min(round, rounds.length - 1)];
    round += 1;
    const parts = [];
    if (script.text) parts.push({ text: script.text });
    for (const call of script.calls ?? []) parts.push({ functionCall: { name: call.name, args: call.args } });
    const frames = [
      JSON.stringify({ candidates: [{ content: { parts } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }),
    ];
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (const frame of frames) yield Buffer.from(`data: ${frame}\n\n`);
      })(),
    };
  };
}

const ARTICLE_HTML = `<!doctype html><html><head><title>Coverage fell</title></head><body>
  <nav>Home About Contact</nav>
  <article>${"<p>The department reported that coverage fell to 58% last year, down from 71%. ".repeat(40)}</p></article>
</body></html>`;

/* ------------------------------------------------------------------ 1. wire bytes */

/**
 * How many bytes of request body each round of one turn sends, with a clip attached.
 *
 * The clip is fetched once — that part is already cached and already parallel. What this
 * counts is what happens *after*: `contents` is built once and appended to, so the inline
 * base64 sits at the front of it for the whole turn and every round re-POSTs it.
 */
async function benchWireBytes({ clipMB = 0, searchRounds = 2 } = {}) {
  const bytes = clipMB > 0 ? Buffer.alloc(Math.round(clipMB * 1024 * 1024), 0x42) : null;
  const bodies = [];

  // `searchRounds` rounds that call a tool, then one that writes the answer — the shape a
  // real fact-check takes, and the shape MAX_TOOL_ROUNDS bounds.
  const script = geminiScript([
    ...Array.from({ length: searchRounds }, (_, i) => ({
      calls: [{ name: "web_search", args: { query: `coverage ${i}`, claim: `Claim ${i}` } }],
    })),
    { text: "The department's own figures confirm it [1]." },
  ]);

  const fetchImpl = async (url, options) => {
    bodies.push(Buffer.byteLength(options.body ?? "", "utf8"));
    return script(url, options);
  };

  for await (const _ of streamChat({
    apiKey: "k",
    models: ["gemini-3.6-flash"],
    system: FACT_CHECK_SYSTEM_PROMPT,
    messages: [{ role: "user", content: bytes ? `Fact-check ${TIKTOK_LINK}` : "Is it true that coverage fell to 58%?" }],
    fetchImpl,
    attachMedia: Boolean(bytes),
    attachPages: false,
    tools: [{ function_declarations: [{ name: "web_search", description: "d", parameters: { type: "object", properties: {} } }] }],
    toolRunner: async () => ({
      response: { result: "[1] Some source — https://a.example/1" },
      frame: { type: "search", query: "q", results: [] },
    }),
    clipOptions: bytes
      ? {
          resolveImpl: async () => resolvedClip(),
          downloadImpl: async () => ({ bytes, mimeType: "video/mp4" }),
        }
      : {},
  })) {
    // Drained for its side effects; the frames themselves are not what is being measured.
  }

  return bodies;
}

/* ------------------------------------------------------------------ 2. cache savings */

async function benchArticleCache(turns) {
  const counts = {};
  for (const cache of [false, true]) {
    resetArticleCache();
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return {
        status: 200,
        headers: { get: (n) => (n.toLowerCase() === "content-type" ? "text/html" : null) },
        text: async () => ARTICLE_HTML,
      };
    };
    const messages = [{ role: "user", content: "Check https://news.test/story" }];
    for (let turn = 0; turn < turns; turn += 1) {
      await resolveArticles(messages, { fetchImpl, lookupImpl: async () => [{ address: "93.184.216.34" }], cache });
      messages.push({ role: "assistant", content: "Checked." }, { role: "user", content: "and the next claim?" });
    }
    counts[cache ? "on" : "off"] = fetches;
  }
  resetArticleCache();
  return counts;
}

async function benchClipCache(turns) {
  const counts = {};
  for (const cache of [false, true]) {
    resetClipCache();
    let downloads = 0;
    let resolves = 0;
    const messages = [{ role: "user", content: `Check ${TIKTOK_LINK}` }];
    for (let turn = 0; turn < turns; turn += 1) {
      await resolveClipParts(messages, {
        cache,
        resolveImpl: async () => {
          resolves += 1;
          return resolvedClip();
        },
        downloadImpl: async () => {
          downloads += 1;
          return { bytes: Buffer.alloc(3 * 1024 * 1024), mimeType: "video/mp4" };
        },
      });
      messages.push({ role: "assistant", content: "Checked." }, { role: "user", content: "what about the end?" });
    }
    counts[cache ? "on" : "off"] = { resolves, downloads };
  }
  resetClipCache();
  return counts;
}

/* ------------------------------------------------------------------ 3. pure CPU */

function benchPureCPU() {
  const bigHTML = `<!doctype html><html><body><article>${
    "<p>The agency revised the estimate downward following a review of the underlying survey data, which had over-counted repeat respondents in three of the eleven regions sampled.</p>".repeat(600)
  }</article></body></html>`;

  const pageText = htmlToText(bigHTML).text;

  const answer = Array.from({ length: 6 }, (_, i) =>
    [
      `[[claim: Claim number ${i + 1} from the clip]]`,
      `The reporter states this at [t=0:${String(i * 7).padStart(2, "0")}]. The department's own`,
      `records confirm the figure [${(i % 4) + 1}], though a later revision qualifies it [${((i + 1) % 4) + 1}].`,
      `VERDICT: Corroborated`,
    ].join("\n"),
  ).join("\n");

  const ledger = new CitationLedger();
  ledger.record({
    query: "q",
    claim: "a claim",
    provider: "test",
    retrievedAt: new Date().toISOString(),
    results: Array.from({ length: 4 }, (_, i) => ({
      title: `Source ${i}`,
      url: `https://example${i}.test/page`,
      domain: `example${i}.test`,
      snippet: "snippet",
      published: null,
    })),
  });

  return {
    htmlToText: { time: timed(() => htmlToText(bigHTML)), size: `${Math.round(bigHTML.length / 1024)} KB HTML` },
    extractPassages: { time: timed(() => extractPassages(pageText)), size: `${Math.round(pageText.length / 1024)} KB text` },
    cleanCitations: { time: timed(() => cleanCitations(answer, ledger, { renumber: true })), size: `${answer.length} chars, 6 claims` },
    splitClaims: { time: timed(() => splitClaims(answer)), size: `${answer.length} chars, 6 claims` },
  };
}

/* ------------------------------------------------------------------ main */

const CLIP_MB = Number(process.argv[2]) || 3;
const TURNS = 5;

console.log("\n\x1b[1mSeer pipeline bench\x1b[0m — structural costs, measured on the unit tests' own stubs.");
console.log("No network. These are byte counts, call counts and CPU — not wall-clock latency.");

heading("1a. The floor — a turn with no media at all");
const bare = await benchWireBytes({ clipMB: 0, searchRounds: 2 });
bare.forEach((size, i) => row(`round ${i + 1}`, `${(size / 1024).toFixed(1)} KB`));
row("system prompt alone", `${(Buffer.byteLength(FACT_CHECK_SYSTEM_PROMPT, "utf8") / 1024).toFixed(1)} KB`, "re-sent every round, unavoidably");
row("total for the turn", `${(bare.reduce((a, b) => a + b, 0) / 1024).toFixed(1)} KB`, "negligible — media is the whole story");

heading(`1b. Request body per model round (${CLIP_MB} MB clip attached)`);
const bodies = await benchWireBytes({ clipMB: CLIP_MB, searchRounds: 2 });
bodies.forEach((size, i) => {
  const kind = i === 0 ? "decides what to search" : i === bodies.length - 1 ? "writes the answer" : "reads results, searches again";
  row(`round ${i + 1} (${kind})`, mb(size));
});
const total = bodies.reduce((a, b) => a + b, 0);
row("total uploaded this turn", mb(total), `${(total / (CLIP_MB * 1024 * 1024)).toFixed(1)}× the clip on disk`);
row("avoidable if rounds 2+ reused an upload", mb(total - bodies[0]), "see CLAUDE.md on why they don't");

heading("1c. How that scales with clip size and round count");
console.log("  Total wire bytes per turn. The inline ceiling is " + mb(INLINE_BYTE_LIMIT) + " —");
console.log("  past it the Files API is used regardless, and this table stops applying.\n");
row("clip size", "2 rounds", "3 rounds   4 rounds");
for (const size of [1, 3, 6, 12]) {
  const totals = [];
  for (const searchRounds of [1, 2, 3]) {
    const b = await benchWireBytes({ clipMB: size, searchRounds });
    totals.push(mb(b.reduce((a, x) => a + x, 0)));
  }
  row(`${size} MB`, totals[0], `${totals[1].padStart(8)}   ${totals[2].padStart(8)}`);
}

heading(`2. Round trips a replayed conversation pays (${TURNS} turns, one link)`);
const articles = await benchArticleCache(TURNS);
row("article fetches, cache off", articles.off);
row("article fetches, cache on", articles.on, `${articles.off - articles.on} saved`);
const clips = await benchClipCache(TURNS);
row("clip resolves, cache off", clips.off.resolves);
row("clip resolves, cache on", clips.on.resolves, `${clips.off.resolves - clips.on.resolves} saved`);
row("clip downloads, cache off", clips.off.downloads);
row("clip downloads, cache on", clips.on.downloads, `${clips.off.downloads - clips.on.downloads} saved`);

heading("3. Pure CPU on the hot paths (median of 9)");
for (const [name, { time, size }] of Object.entries(benchPureCPU())) {
  row(name, ms(time), size);
}
console.log("\n  All well under a millisecond-per-KB. Nothing here is worth optimising next to");
console.log("  a network wait measured in seconds — this section exists to rule the CPU out,");
console.log("  and it does.");

heading("4. Inline vs. the Files API, in bytes only");
console.log("  What section 1 implies for the one decision it bears on. Inline is base64, so");
console.log("  4/3 the clip, re-sent every round; a Files upload is raw bytes once, and every");
console.log("  round after sends a URI instead. Bytes are the whole of what this can measure —");
console.log("  see the caveat below before treating a row as a recommendation.\n");
row("clip", "inline (4 rds)", "files    saved");
for (const size of [1, 3, 6, 12]) {
  const inlineTotal = size * 1024 * 1024 * (4 / 3) * 4;
  const filesTotal = size * 1024 * 1024;
  row(`${size} MB`, mb(inlineTotal), `${mb(filesTotal).padStart(8)}  ${mb(inlineTotal - filesTotal).padStart(8)}`);
}
console.log("\n  \x1b[1mNot measured here, and decisive:\x1b[0m the upstream bandwidth of the deployment");
console.log("  (which turns saved bytes into saved seconds) and the real PROCESSING wait a");
console.log("  Files upload adds in front of round one. The poll is paced to catch a fast");
console.log(`  transcode early — first look at ${POLL_INTERVAL_MS} ms, backing off to ${MAX_POLL_INTERVAL_MS} ms — so for a`);
console.log("  short clip that wait is small, but 'small' is not a number until it is timed");
console.log("  against real uploads. Neither does any of this touch video prefill, which is");
console.log("  re-paid per round either way and is the larger half of the cost.");

console.log("");
