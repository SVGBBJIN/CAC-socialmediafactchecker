// Unit tests for public/timestamps.js. No DOM and no network, per the convention in
// CLAUDE.md — the module is deliberately pure so the marker syntax and the playhead lookup
// can be pinned down without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TIMESTAMP_MARKER,
  parseClock,
  formatClock,
  extractTimestamps,
  plainTimestamps,
  timeline,
  activeAt,
  DEFAULT_MARK_SECONDS,
} from "./public/timestamps.js";

import { cleanCitations } from "./lib/citation-cleanup.js";
import { CitationLedger } from "./lib/citations.js";

/* ---------------------------------------------------------------- clocks */

test("parseClock reads m:ss, h:mm:ss and bare seconds", () => {
  assert.equal(parseClock("0:07"), 7);
  assert.equal(parseClock("1:05"), 65);
  assert.equal(parseClock("12:30"), 750);
  assert.equal(parseClock("1:02:03"), 3723);
  assert.equal(parseClock("90"), 90);
});

test("parseClock rejects anything that isn't a clock", () => {
  assert.equal(parseClock(""), null);
  assert.equal(parseClock("later"), null);
  assert.equal(parseClock("1:2:3:4"), null);
  assert.equal(parseClock("1:-5"), null);
  assert.equal(parseClock(null), null);
});

test("formatClock drops the hour until there is one", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(7), "0:07");
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(3723), "1:02:03");
  // A negative or nonsense seek target formats as the start rather than as garbage.
  assert.equal(formatClock(-4), "0:00");
  assert.equal(formatClock(NaN), "0:00");
});

/* ---------------------------------------------------------------- extraction */

test("extractTimestamps finds points and spans in text order", () => {
  const marks = extractTimestamps(
    "The clip opens with a claim about interest rates [t=0:12] and repeats it later [t=1:05-1:20].",
  );
  assert.deepEqual(
    marks.map(({ start, end }) => ({ start, end })),
    [
      { start: 12, end: null },
      { start: 65, end: 80 },
    ],
  );
  assert.equal(marks[0].raw, "[t=0:12]");
});

test("extractTimestamps accepts en and em dashes for a span", () => {
  assert.deepEqual(
    extractTimestamps("a [t=0:10–0:20] b [t=0:30—0:40]").map((m) => [m.start, m.end]),
    [
      [10, 20],
      [30, 40],
    ],
  );
});

test("a backwards or empty span keeps its start and loses its end", () => {
  assert.deepEqual(
    extractTimestamps("[t=1:00-0:30] [t=2:00-2:00]").map((m) => [m.start, m.end]),
    [
      [60, null],
      [120, null],
    ],
  );
});

test("extractTimestamps ignores things that only look like markers", () => {
  assert.deepEqual(extractTimestamps("cited [3] and [t=] and [t=nope] and 0:12"), []);
});

test("the marker is matched case-insensitively", () => {
  assert.deepEqual(
    extractTimestamps("[T=0:05]").map((m) => m.start),
    [5],
  );
});

/* ---------------------------------------------------------------- coexistence with citations */

test("citation cleanup leaves timestamp markers alone", () => {
  // The whole reason the syntax carries `t=`: the server's citation pass deletes any
  // `[n]` it cannot resolve, and a bare `[0:12]` would be in its blast radius.
  const ledger = new CitationLedger();
  ledger.record({
    claim: "rates",
    query: "interest rates",
    results: [{ title: "Rates", url: "https://example.com/rates", domain: "example.com" }],
  });

  const answer = "The clip says rates fell [t=0:12], which the filing contradicts [1]. Invented [9].";
  const cleaned = cleanCitations(answer, ledger);

  assert.match(cleaned.text, /\[t=0:12\]/);
  assert.match(cleaned.text, /\[1\]/);
  assert.doesNotMatch(cleaned.text, /\[9\]/);
});

/* ---------------------------------------------------------------- plain text */

test("plainTimestamps rewrites markers for copied text and touches nothing else", () => {
  assert.equal(
    plainTimestamps("Claim [t=0:12] and span [t=1:05-1:20], cited [2]."),
    "Claim [0:12] and span [1:05–1:20], cited [2].",
  );
});

/* ---------------------------------------------------------------- windows */

test("timeline sorts out-of-order marks and runs each up to the next", () => {
  const windows = timeline([
    { start: 60, end: null, id: "late" },
    { start: 10, end: null, id: "early" },
  ]);
  assert.deepEqual(
    windows.map(({ id, from, to }) => ({ id, from, to })),
    [
      { id: "early", from: 10, to: 22 }, // capped by DEFAULT_MARK_SECONDS, not by 60
      { id: "late", from: 60, to: 60 + DEFAULT_MARK_SECONDS },
    ],
  );
});

test("a mark's window never runs past the next mark's start", () => {
  const windows = timeline([
    { start: 10, end: 90 }, // the model wrote a span that swallows the next claim
    { start: 20, end: null },
  ]);
  assert.deepEqual(
    windows.map(({ from, to }) => [from, to]),
    [
      [10, 20],
      [20, 32],
    ],
  );
});

test("the last mark's window is bounded even with nothing after it", () => {
  const [only] = timeline([{ start: 5, end: null }]);
  assert.equal(only.to, 5 + DEFAULT_MARK_SECONDS);
});

test("an explicit span shorter than the default is honoured", () => {
  const [only] = timeline([{ start: 5, end: 8 }]);
  assert.equal(only.to, 8);
});

/* ---------------------------------------------------------------- the playhead */

test("activeAt finds the window the playhead is inside", () => {
  const windows = timeline([
    { start: 10, end: null, id: "a" },
    { start: 40, end: 50, id: "b" },
  ]);
  assert.equal(activeAt(windows, 10)?.id, "a"); // inclusive at the start
  assert.equal(activeAt(windows, 21)?.id, "a");
  assert.equal(activeAt(windows, 45)?.id, "b");
});

test("activeAt returns null between claims and past the end", () => {
  const windows = timeline([{ start: 10, end: null }]);
  assert.equal(activeAt(windows, 0), null);
  assert.equal(activeAt(windows, 22), null); // exclusive at the end
  assert.equal(activeAt(windows, 999), null);
  assert.equal(activeAt(windows, NaN), null);
});

test("activeAt on an answer with no timestamps is null, not a throw", () => {
  assert.equal(activeAt(timeline(extractTimestamps("no marks here")), 5), null);
});

/* ---------------------------------------------------------------- the regex itself */

test("TIMESTAMP_MARKER is reusable across calls despite being global", () => {
  // `matchAll` and `replace` reset `lastIndex` themselves; this guards against a future
  // caller reaching for `.test()`, which would not.
  const text = "[t=0:01] [t=0:02]";
  assert.equal(extractTimestamps(text).length, 2);
  assert.equal(extractTimestamps(text).length, 2);
  assert.equal(TIMESTAMP_MARKER.lastIndex, 0);
});
