// What kind of publisher a source is. See public/source-quality.js.
//
// Pure, no network, no DOM — the convention in CLAUDE.md.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_TIERS,
  TIERS,
  classifySource,
  normaliseTiers,
  rankResults,
} from "./public/source-quality.js";

const tierOf = (url) => classifySource(url);

test("an institution publishing about itself is primary", () => {
  assert.equal(tierOf("https://www.gov.uk/government/news/x"), "primary");
  assert.equal(tierOf("https://ons.gov.uk/economy/inflation"), "primary");
  assert.equal(tierOf("https://www.nhs.uk/conditions/measles/"), "primary");
  assert.equal(tierOf("https://stanford.edu/paper"), "primary");
  assert.equal(tierOf("https://www.who.int/news-room/x"), "primary");
  assert.equal(tierOf("https://www.nature.com/articles/s41586"), "primary");
  // A company's own newsroom is that company speaking, which is primary for what the
  // company said — the reader is told which it is, which is the point of the label.
  assert.equal(tierOf("https://acme.example/newsroom/we-did-a-thing"), "primary");
});

test("an outlet with an editor is news, fact-checkers included", () => {
  assert.equal(tierOf("https://www.bbc.co.uk/news/uk-1"), "news");
  assert.equal(tierOf("https://www.reuters.com/world/x"), "news");
  assert.equal(tierOf("https://fullfact.org/health/x"), "news");
});

test("an encyclopedia, archive or data portal is reference", () => {
  // Language editions are subdomains, so the match has to be a suffix one.
  assert.equal(tierOf("https://en.wikipedia.org/wiki/Elephant"), "reference");
  assert.equal(tierOf("https://simple.wikipedia.org/wiki/Elephant"), "reference");
  assert.equal(tierOf("https://web.archive.org/web/2020/http://x.com"), "reference");
  assert.equal(tierOf("https://ourworldindata.org/co2"), "reference");
});

test("a platform where anyone may post is a forum", () => {
  // The case that started this: a Corroborated verdict resting on r/BarbaraWalters4Scale.
  assert.equal(tierOf("https://www.reddit.com/r/BarbaraWalters4Scale/comments/1"), "forum");
  assert.equal(tierOf("https://x.com/someone/status/1"), "forum");
  assert.equal(tierOf("https://someone.substack.com/p/post"), "forum");
  assert.equal(tierOf("https://someone.blogspot.com/2024/01/post.html"), "forum");
  assert.equal(tierOf("https://www.youtube.com/watch?v=1"), "forum");
});

test("a forum wins over an institutional suffix, not the other way round", () => {
  // A university's subreddit is still a subreddit, and this is the direction an error
  // should fall.
  assert.equal(tierOf("https://www.reddit.com/r/stanford.edu"), "forum");
});

test("an unrecognised domain is unranked, not condemned", () => {
  // Most of the web is a regional paper or a trade publication. Defaulting these to the
  // bottom tier would mean switching the filter on threw away nearly everything.
  assert.equal(tierOf("https://www.someregionalpaper.co.uk/news/story-1"), "news");
  assert.equal(tierOf("not a url at all"), "news");
  assert.equal(classifySource({ domain: "bbc.co.uk" }), "news");
});

test("the tier list is cleaned up rather than believed", () => {
  assert.deepEqual(normaliseTiers(["forum", "news"]), ["news", "forum"]); // declared order
  // Junk is dropped; a name that isn't a tier can't be smuggled in.
  assert.deepEqual(normaliseTiers(["news", "nonsense"]), ["news"]);
  // Nothing left is a contradiction, and answering it with an empty ledger on every check
  // would look broken rather than obedient.
  assert.deepEqual(normaliseTiers([]), ALL_TIERS);
  assert.deepEqual(normaliseTiers(["nope"]), ALL_TIERS);
  assert.deepEqual(normaliseTiers(undefined), ALL_TIERS);
  assert.deepEqual(normaliseTiers("news"), ALL_TIERS);
});

test("results are tagged, filtered and ordered best-supported first", () => {
  const results = [
    { url: "https://www.reddit.com/r/x/1" },
    { url: "https://en.wikipedia.org/wiki/X" },
    { url: "https://www.gov.uk/x" },
    { url: "https://www.bbc.co.uk/news/1" },
  ];

  assert.deepEqual(
    rankResults(results).map((r) => r.tier),
    ["primary", "news", "reference", "forum"],
  );
  // Excluding a tier removes it from the list entirely — this is what makes the setting a
  // filter on the evidence rather than on the display.
  assert.deepEqual(
    rankResults(results, ["primary", "news"]).map((r) => r.url),
    ["https://www.gov.uk/x", "https://www.bbc.co.uk/news/1"],
  );
});

test("within one tier the provider's own ordering is left alone", () => {
  // The search engine ranked these against the query; nothing here knows better, and
  // re-sorting by domain would replace a relevance ranking with an alphabetical one.
  const results = [
    { url: "https://www.zzz-paper.com/b" },
    { url: "https://www.aaa-paper.com/a" },
  ];
  assert.deepEqual(
    rankResults(results).map((r) => r.url),
    ["https://www.zzz-paper.com/b", "https://www.aaa-paper.com/a"],
  );
});

test("every tier has a place in the declared order", () => {
  assert.deepEqual(TIERS, ["primary", "news", "reference", "forum"]);
  assert.deepEqual(ALL_TIERS, TIERS);
});
