// Searching and filtering the library. See public/library-search.js.
//
// Pure, no network, no DOM — the convention in CLAUDE.md. Entries are built by hand in the
// shape app.js stores them in (see `normalizeEntry` and `runCheck`).

import test from "node:test";
import assert from "node:assert/strict";

import {
  filterLibrary,
  matchesFilters,
  platformsIn,
  searchTextFor,
  verdictsIn,
} from "./public/library-search.js";

const zoo = {
  id: "1",
  title: "🐘🐘 #fyp #sandiego",
  url: "https://www.tiktok.com/@someone/video/123",
  platform: "TikTok",
  verdictKey: "contradicted",
  claims: [
    { title: "The elephants are in front of the San Diego Zoo", text: "The clip shows [1] a different enclosure." },
  ],
  sources: [{ domain: "reddit.com" }, { domain: "sandiegozoo.org" }],
  followups: [{ question: "Which enclosure is it?", answer: "The Elephant Odyssey habitat." }],
};

const astley = {
  id: "2",
  title: "Rick Astley - Never Gonna Give You Up",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  platform: "YouTube",
  verdictKey: "insufficient",
  claims: null,
  answer: "There is nothing here to check.",
  sources: [],
  followups: [],
};

const library = [zoo, astley];

test("a search matches what the reader remembers, not only the title", () => {
  // The three searches that returned nothing: the subject, the platform, the verdict.
  assert.deepEqual(filterLibrary(library, { text: "elephant" }), [zoo]);
  assert.deepEqual(filterLibrary(library, { text: "youtube" }), [astley]);
  assert.deepEqual(filterLibrary(library, { text: "contradicted" }), [zoo]);
});

test("a search reaches the claim text, the sources and the follow-ups", () => {
  assert.deepEqual(filterLibrary(library, { text: "san diego zoo" }), [zoo]);
  assert.deepEqual(filterLibrary(library, { text: "reddit" }), [zoo]);
  assert.deepEqual(filterLibrary(library, { text: "odyssey" }), [zoo]);
});

test("every word must appear, but not in one field and not in order", () => {
  assert.deepEqual(filterLibrary(library, { text: "contradicted tiktok" }), [zoo]);
  assert.deepEqual(filterLibrary(library, { text: "tiktok contradicted" }), [zoo]);
  // One word that matches and one that doesn't is not a match.
  assert.deepEqual(filterLibrary(library, { text: "tiktok astley" }), []);
});

test("a partial word narrows, because this is a find-as-you-type box", () => {
  assert.deepEqual(filterLibrary(library, { text: "eleph" }), [zoo]);
});

test("chips narrow what the text found, and a null chip is 'any'", () => {
  assert.deepEqual(filterLibrary(library, { verdict: "insufficient" }), [astley]);
  assert.deepEqual(filterLibrary(library, { platform: "TikTok" }), [zoo]);
  // Platform is a display string, so its case must not decide the match.
  assert.deepEqual(filterLibrary(library, { platform: "tiktok" }), [zoo]);
  // ANDed: a chip and a query that disagree leave nothing.
  assert.deepEqual(filterLibrary(library, { text: "elephant", verdict: "insufficient" }), []);
  assert.deepEqual(filterLibrary(library, {}), library);
});

test("the haystack never carries a source's prose, only its domain", () => {
  const text = searchTextFor({ ...zoo, sources: [{ domain: "bbc.co.uk", title: "Elephants of the world", snippet: "..." }] });
  assert.ok(text.includes("bbc.co.uk"));
  assert.ok(!text.includes("elephants of the world"));
});

test("only the chips a library can actually use are offered", () => {
  assert.deepEqual(platformsIn(library), ["TikTok", "YouTube"]);
  // Fixed order, the one VERDICTS declares — not frequency, so the row doesn't move
  // between visits.
  assert.deepEqual(verdictsIn(library), ["contradicted", "insufficient"]);
  assert.deepEqual(verdictsIn([]), []);
  assert.deepEqual(platformsIn([{ platform: "" }]), []);
});

test("a row with nothing on it yet is not a match and is not a crash", () => {
  assert.equal(matchesFilters(null, { text: "x" }), false);
  assert.equal(matchesFilters({ id: "3" }, {}), true);
  assert.equal(matchesFilters({ id: "3" }, { text: "x" }), false);
});
