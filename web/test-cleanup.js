// node --test test-cleanup.js
//
// Citation cleanup. Every test here is guarding one of two properties, and they pull in
// opposite directions:
//
//   - **Redundancy goes.** Repeated markers, two numbers that are one page, runaway stacks,
//     a bibliography the model typed itself.
//   - **Nothing else does.** A sentence that arrived cited stays cited, no marker is
//     invented, no number is silently repointed at a different page, and the prose itself
//     comes out byte-identical apart from the markers.
//
// The second is the one worth the most tests, because a cleanup pass that quietly changes
// what an answer says or where a citation points would be far worse than the untidiness it
// was written to remove.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CitationLedger, auditAnswer } from "./lib/citations.js";
import {
  cleanCitations,
  canonicalURL,
  mergeMap,
  stripModelBibliography,
  MAX_MARKERS_PER_SENTENCE,
} from "./lib/citation-cleanup.js";

/** A ledger holding the given URLs, numbered 1..n in order. */
function ledgerOf(...urls) {
  const ledger = new CitationLedger();
  ledger.record({
    query: "q",
    claim: "A claim under test.",
    provider: "test",
    retrievedAt: "2026-07-30T00:00:00Z",
    results: urls.map((url, index) => ({
      title: `Source ${index + 1}`,
      url,
      domain: new URL(url).hostname,
      snippet: "",
    })),
  });
  return ledger;
}

const FOUR = () =>
  ledgerOf(
    "https://a.example/one",
    "https://b.example/two",
    "https://c.example/three",
    "https://d.example/four",
  );

/* ---------------- canonical URLs ---------------- */

test("canonicalURL sees through the ways one page is written twice", () => {
  const canonical = canonicalURL("https://www.Example.com/story/");
  assert.equal(canonicalURL("http://example.com/story"), canonical);
  assert.equal(canonicalURL("https://example.com/story#section-2"), canonical);
  assert.equal(canonicalURL("https://example.com/story?utm_source=twitter&utm_medium=x"), canonical);
  assert.equal(canonicalURL("https://example.com/story/amp/"), canonical);
  assert.equal(canonicalURL("https://example.com/story?fbclid=abc"), canonical);
});

test("canonicalURL keeps meaningful query strings, which are not tracking", () => {
  // `?id=` on a court docket or a dataset is the page's identity. Stripping it would merge
  // two different documents into one citation, which is the opposite of the point.
  assert.notEqual(
    canonicalURL("https://courts.example/case?id=1"),
    canonicalURL("https://courts.example/case?id=2"),
  );
});

test("canonicalURL does not throw on something that is not a URL", () => {
  assert.equal(canonicalURL("not a url"), "not a url");
});

test("mergeMap points every duplicate at the lowest number", () => {
  const ledger = ledgerOf(
    "https://a.example/one",
    "https://a.example/one?utm_source=x",
    "https://b.example/two",
  );
  const merge = mergeMap(ledger.sources);
  assert.equal(merge.get(1), 1);
  assert.equal(merge.get(2), 1, "the same page, reached by a tracked link");
  assert.equal(merge.get(3), 3);
});

/* ---------------- the redundancy the pass exists to remove ---------------- */

test("a marker repeated inside one sentence is written once", () => {
  const { text, removed } = cleanCitations(
    "The rate fell to 4.2% [1][1] in March [1].",
    FOUR(),
    { renumber: false },
  );
  assert.equal(text, "The rate fell to 4.2% [1] in March.");
  assert.equal(removed.duplicateMarkers, 2);
});

test("a comma-separated group is deduplicated too", () => {
  const { text } = cleanCitations("Officials confirmed the revision [1, 1, 2].", FOUR(), {
    renumber: false,
  });
  assert.equal(text, "Officials confirmed the revision [1][2].");
});

test("two numbers that are one page collapse into one marker", () => {
  const ledger = ledgerOf("https://a.example/story", "https://www.a.example/story?utm_source=x");
  const { text, removed } = cleanCitations(
    "Two outlets reported the figure [1][2].",
    ledger,
    { renumber: false },
  );
  // This is the most misleading form of redundancy: [1][2] reads as corroboration and is
  // one page found twice.
  assert.equal(text, "Two outlets reported the figure [1].");
  assert.equal(removed.mergedSources, 1);
  assert.equal(removed.duplicateMarkers, 1);
});

test("a runaway stack is capped, keeping the sources cited first", () => {
  const { text, removed } = cleanCitations(
    "The agency revised the figure down [1][2][3][4].",
    FOUR(),
    { renumber: false },
  );
  assert.equal(text, "The agency revised the figure down [1][2][3].");
  assert.equal(removed.cappedMarkers, 1);
  assert.equal(MAX_MARKERS_PER_SENTENCE, 3);
});

test("the next sentence gets its own citation, cap and dedupe reset", () => {
  const { text } = cleanCitations(
    "The rate fell to 4.2% [1]. That was published in March [1]. Officials called it routine [1].",
    FOUR(),
    { renumber: false },
  );
  // A number repeated in a *later* sentence is not redundant — that sentence needs a source
  // of its own, and taking it away would create the uncited claim the audit exists to catch.
  assert.equal(
    text,
    "The rate fell to 4.2% [1]. That was published in March [1]. Officials called it routine [1].",
  );
});

test("each list item is its own claim", () => {
  const { text } = cleanCitations("- Coverage fell [1]\n- Fatalities were flat [1]", FOUR(), {
    renumber: false,
  });
  assert.equal(text, "- Coverage fell [1]\n- Fatalities were flat [1]");
});

/* ---------------- renumbering ---------------- */

test("renumbering makes the markers ascend and closes the gaps", () => {
  const { text, sources, cited } = cleanCitations(
    "Coverage fell [3]. Fatalities were unchanged [1]. The methodology is old [4].",
    FOUR(),
  );
  assert.equal(text, "Coverage fell [1]. Fatalities were unchanged [2]. The methodology is old [3].");
  assert.deepEqual(cited, [1, 2, 3]);
  // A rename applied everywhere at once: the new [1] is the page that was [3].
  assert.deepEqual(
    sources.map((source) => [source.n, source.url]),
    [
      [1, "https://c.example/three"],
      [2, "https://a.example/one"],
      [3, "https://d.example/four"],
    ],
  );
});

test("a source the answer never cites is left out of the list", () => {
  const { sources } = cleanCitations("Coverage fell [2].", FOUR());
  assert.deepEqual(sources.map((source) => source.url), ["https://b.example/two"]);
});

test("renumbering and merging compose without repointing a marker", () => {
  const ledger = ledgerOf(
    "https://a.example/one",
    "https://b.example/two",
    "https://b.example/two/amp/",
  );
  const { text, sources } = cleanCitations("Fell [2][3]. Confirmed elsewhere [1].", ledger);
  assert.equal(text, "Fell [1]. Confirmed elsewhere [2].");
  assert.deepEqual(
    sources.map((source) => [source.n, source.url]),
    [
      [1, "https://b.example/two"],
      [2, "https://a.example/one"],
    ],
  );
});

/* ---------------- the model's own bibliography ---------------- */

test("a Sources list the model typed is removed", () => {
  const ledger = FOUR();
  const answer =
    "The rate fell to 4.2% [1].\n\nSources:\n1. https://a.example/one — Source 1\n2. https://b.example/two";
  const { text, removed } = cleanCitations(answer, ledger, { renumber: false });
  assert.equal(text, "The rate fell to 4.2% [1].");
  assert.equal(removed.bibliographyStripped, true);
});

test("a heading that introduces prose is not mistaken for a bibliography", () => {
  const prose = "## Sources\nThe agency publishes two datasets, and both were checked here.";
  const { text, stripped } = stripModelBibliography(prose);
  assert.equal(stripped, false);
  assert.equal(text, prose);
});

test("stripping a bibliography never cuts the answer short", () => {
  const answer = "Coverage fell [1].\n\nReferences\n- https://a.example/one\n\nBut the review continues.";
  // The tail is not mostly entries, so the whole thing is left alone rather than truncating
  // an answer to tidy it — the worse of the two failures by a wide margin.
  const { stripped } = stripModelBibliography(answer);
  assert.equal(stripped, false);
});

/* ---------------- what cleanup must never do ---------------- */

test("a fabricated marker is left exactly where the model wrote it", () => {
  const ledger = ledgerOf("https://a.example/one");
  const { text } = cleanCitations("Coverage fell [1]. Fatalities rose [7].", ledger, {
    renumber: false,
  });
  // Deleting [7] would erase the evidence for the "Unverified" banner the reader is about to
  // be shown, leaving an answer that looks clean and is not.
  assert.match(text, /\[7\]/);
});

test("every cited sentence still carries a citation after cleanup", () => {
  const ledger = ledgerOf("https://a.example/one", "https://a.example/one?utm_campaign=z");
  const answer =
    "The Bureau said coverage fell to 58% in 2023 [1][2]. Officials called the fall routine [2][1].";
  const { text } = cleanCitations(answer, ledger);

  // Both sentences are checkable claims. Merging two markers that are one page must not
  // leave either of them bare — that would turn a tidy-up into an audit failure.
  const audit = auditAnswer(text, ledger);
  assert.deepEqual(
    audit.violations.filter((violation) => violation.type === "uncited_claim"),
    [],
  );
  assert.equal(text, "The Bureau said coverage fell to 58% in 2023 [1]. Officials called the fall routine [1].");
});

test("the prose is untouched apart from the markers", () => {
  const ledger = FOUR();
  const answer =
    'He said "it fell." Then the Bureau published the figure [1][1], which was 4.2% [1].\n\n' +
    "**Verdict:** misleading [2].";
  const { text } = cleanCitations(answer, ledger, { renumber: false });
  // The sentence splitter consumes the closing quote and the space after it; a pass that
  // split and rejoined naively would eat the quote off `"it fell."` here.
  assert.equal(
    text,
    'He said "it fell." Then the Bureau published the figure [1], which was 4.2%.\n\n**Verdict:** misleading [2].',
  );
});

test("an answer with nothing to tidy is reported as unchanged", () => {
  const answer = "Coverage fell to 58% in 2023 [1]. Fatalities were unchanged [2].";
  const { text, changed } = cleanCitations(answer, FOUR(), { renumber: false });
  assert.equal(changed, false);
  assert.equal(text, answer);
});

test("an answer with no markers at all survives intact", () => {
  const answer = "I could not find a source for any of this, so I am not going to say either way.";
  const { text, sources, changed } = cleanCitations(answer, FOUR());
  assert.equal(text, answer);
  assert.equal(changed, false);
  assert.deepEqual(sources, []);
});

test("code fences are not citation sites", () => {
  // A `[1]` inside a code sample is an array index. Renumbering it would corrupt the sample.
  const answer = "Coverage fell [2].\n\n```js\nconst first = rows[1];\n```";
  const { text } = cleanCitations(answer, FOUR());
  assert.match(text, /rows\[1\]/);
});
