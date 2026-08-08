// Unit tests for public/research.js. No DOM and no network, per the convention in
// CLAUDE.md — the tracker is deliberately pure so the FIFO matching between a `searching`
// announcement and the `search`/`find` frames that resolve it can be pinned down without a
// browser. Rendering the tracked items as HTML (app.js's researchChipHTML) is not covered
// here for the same reason it isn't covered anywhere else in this suite: app.js has
// top-level DOM reads that make it unimportable outside a browser.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createResearchTracker, visibleItems, MAX_VISIBLE_RESEARCH_CHIPS } from "./public/research.js";

function searching(searches = [], reads = []) {
  return { type: "searching", searches, reads };
}

/* ---------------------------------------------------------------- dispatch */

test("onSearching adds one pending item per search and per read, in order", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(
    searching(
      [{ query: "measles cases 2026", claim: "Cases have tripled" }],
      [{ url: "https://a.example", find: "the revised figure", claim: "The agency revised it" }],
    ),
  );

  assert.equal(tracker.items.length, 2);
  assert.deepEqual(
    tracker.items.map((i) => [i.kind, i.label, i.status]),
    [
      ["search", "measles cases 2026", "pending"],
      ["find", "the revised figure", "pending"],
    ],
  );
});

test("a read with no `find` text falls back to the URL, and an empty query gets a placeholder", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(searching([{ query: "" }], [{ url: "https://a.example" }]));

  assert.equal(tracker.items[0].label, "searching…");
  assert.equal(tracker.items[1].label, "https://a.example");
});

test("two searching frames — two rounds — just keep appending", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(searching([{ query: "q1" }]));
  tracker.onSearching(searching([{ query: "q2" }], [{ find: "f1" }]));

  assert.deepEqual(
    tracker.items.map((i) => i.label),
    ["q1", "q2", "f1"],
  );
});

/* ---------------------------------------------------------------- resolution */

test("onSearch resolves the oldest pending search to done, leaving reads alone", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(searching([{ query: "q1" }], [{ find: "f1" }]));
  tracker.onSearch({ type: "search", query: "q1" });

  assert.deepEqual(
    tracker.items.map((i) => [i.kind, i.status]),
    [
      ["search", "done"],
      ["find", "pending"],
    ],
  );
});

test("onSearch with an error resolves to error, not done", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(searching([{ query: "q1" }]));
  tracker.onSearch({ type: "search", query: "q1", error: "the brave search API rejected the key." });

  assert.equal(tracker.items[0].status, "error");
});

test("onFind resolves the oldest pending read, independent of search resolution", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(searching([{ query: "q1" }], [{ find: "f1" }]));
  tracker.onFind({ type: "find", url: "https://a.example", matches: 2 });

  assert.deepEqual(
    tracker.items.map((i) => [i.kind, i.status]),
    [
      ["search", "pending"],
      ["find", "done"],
    ],
  );
});

test("resolutions are FIFO within a tool — the first search dispatched is the first resolved", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(searching([{ query: "first" }, { query: "second" }, { query: "third" }]));

  tracker.onSearch({ type: "search" }); // resolves "first"
  tracker.onSearch({ type: "search", error: "dropped as a straggler" }); // resolves "second"

  assert.deepEqual(
    tracker.items.map((i) => [i.label, i.status]),
    [
      ["first", "done"],
      ["second", "error"],
      ["third", "pending"],
    ],
  );
});

test("searches and reads resolve on independent queues even when interleaved in one round", () => {
  // The case the doc comment on createResearchTracker calls out by name: a round that
  // mixes tool calls doesn't guarantee `search`/`find` completion frames arrive paired with
  // how the dispatch happened to list them, only that each type resolves in its own order.
  const tracker = createResearchTracker();
  tracker.onSearching(
    searching(
      [{ query: "search-a" }, { query: "search-b" }],
      [{ find: "find-a" }, { find: "find-b" }],
    ),
  );

  // Completion order: find-a, search-a, find-b, search-b — deliberately not matching
  // dispatch order, since the two tools genuinely race independently.
  tracker.onFind({ type: "find" });
  tracker.onSearch({ type: "search" });
  tracker.onFind({ type: "find", error: "could not be read" });
  tracker.onSearch({ type: "search", error: "timed out" });

  assert.deepEqual(
    Object.fromEntries(tracker.items.map((i) => [i.label, i.status])),
    { "search-a": "done", "search-b": "error", "find-a": "done", "find-b": "error" },
  );
});

test("a completion with nothing pending on that queue is a no-op, not a throw", () => {
  const tracker = createResearchTracker();
  assert.doesNotThrow(() => tracker.onSearch({ type: "search" }));
  assert.doesNotThrow(() => tracker.onFind({ type: "find" }));
  assert.equal(tracker.items.length, 0);

  // Nor does an extra completion past what was dispatched corrupt what's already there.
  tracker.onSearching(searching([{ query: "q1" }]));
  tracker.onSearch({ type: "search" });
  assert.doesNotThrow(() => tracker.onSearch({ type: "search" }));
  assert.deepEqual(tracker.items.map((i) => i.status), ["done"]);
});

/* ---------------------------------------------------------------- reset */

test("reset drops every item and both queues, so a stale resolution can't reach the next turn", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(searching([{ query: "q1" }], [{ find: "f1" }]));
  tracker.reset();

  assert.equal(tracker.items.length, 0);
  // The queues are empty too — a completion frame arriving after reset (a straggler from
  // the turn that just ended) resolves nothing rather than reaching into the new turn's
  // first item.
  assert.doesNotThrow(() => tracker.onSearch({ type: "search" }));
  assert.equal(tracker.items.length, 0);

  tracker.onSearching(searching([{ query: "q2" }]));
  assert.deepEqual(tracker.items.map((i) => i.label), ["q2"]);
});

/* ---------------------------------------------------------------- visibleItems */

test("visibleItems returns everything when there are fewer than the cap", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(searching([{ query: "q1" }, { query: "q2" }]));
  assert.deepEqual(visibleItems(tracker).map((i) => i.label), ["q1", "q2"]);
});

test("visibleItems keeps the tail, in dispatch order, once past the cap", () => {
  const tracker = createResearchTracker();
  const labels = ["a", "b", "c", "d", "e", "f"];
  tracker.onSearching(searching(labels.map((query) => ({ query }))));

  // Dispatch order survives the trim — a reversed list would read as the row shuffling on
  // every new arrival rather than just growing.
  assert.deepEqual(visibleItems(tracker, 4).map((i) => i.label), ["c", "d", "e", "f"]);
});

test("visibleItems defaults to MAX_VISIBLE_RESEARCH_CHIPS", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(
    searching(Array.from({ length: MAX_VISIBLE_RESEARCH_CHIPS + 3 }, (_, i) => ({ query: `q${i}` }))),
  );
  assert.equal(visibleItems(tracker).length, MAX_VISIBLE_RESEARCH_CHIPS);
});

test("visibleItems is read-only with respect to the tracker — it doesn't drain items", () => {
  const tracker = createResearchTracker();
  tracker.onSearching(searching([{ query: "q1" }]));
  visibleItems(tracker);
  visibleItems(tracker);
  assert.equal(tracker.items.length, 1);
});
