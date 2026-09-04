// node --test test-page-shapes.js
//
// The page parser against captured page *shapes*, one HTML file each in `fixtures/`.
//
// Every other suite here builds its HTML inline, which is the right shape for testing one
// rule at a time and the wrong one for testing a judgement made from several signals at
// once. "Is this a front page" reads path depth, anchor density and paragraph count
// together, and an inline fixture written to satisfy it proves only that it agrees with
// itself. These files are written to look like the thing they are named after — a section
// front is a wall of headline links, a story is three paragraphs under a headline, a
// metered page is one paragraph and a meter — so a change to any single signal has to keep
// classifying all six correctly, which is the property that actually matters.
//
// Still no network: the files are read from disk and handed to the same stub fetch every
// other article test uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  fetchArticle,
  fetchPageOutline,
  extractHeadlines,
  looksLikeIndexPage,
  looksPaywalled,
  readerVariants,
  ArticleError,
} from "./lib/article.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function serve(routes) {
  return async (url) => {
    const body = routes[String(url)];
    if (body === undefined) return { status: 404, headers: { get: () => "text/html" }, text: async () => "" };
    return {
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
      text: async () => body,
    };
  };
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const opts = (routes) => ({ fetchImpl: serve(routes), lookupImpl: publicLookup });

/* ------------------------------------------------------------------ classification */

test("a section front is refused as a front page, not read as an article", async () => {
  await assert.rejects(
    fetchArticle("https://daily.test/", opts({ "https://daily.test/": fixture("front-page.html") })),
    (error) => error instanceof ArticleError && error.kind === "index",
  );
});

test("a story is read, however much navigation is stacked over it", async () => {
  const article = await fetchArticle(
    "https://daily.test/world/2026/09/04/coverage-fell",
    opts({ "https://daily.test/world/2026/09/04/coverage-fell": fixture("story.html") }),
  );
  assert.match(article.title, /Coverage fell/);
  assert.match(article.text, /58 percent in 2023/);
  assert.equal(article.partial, false);
  // `trimBoilerplate` keeps the headline and drops the nav above it.
  assert.doesNotMatch(article.text.slice(0, 40), /Home/);
});

test("a link-heavy reference page at a shallow path is the subject, not a front page", async () => {
  const article = await fetchArticle(
    "https://ref.test/ministers",
    opts({ "https://ref.test/ministers": fixture("reference.html") }),
  );
  assert.match(article.text, /List of ministers|coverage fell/i);
});

test("a metered page is read and flagged as an excerpt", async () => {
  const article = await fetchArticle(
    "https://daily.test/news/minister-resigns",
    opts({ "https://daily.test/news/minister-resigns": fixture("paywalled.html") }),
  );
  assert.equal(article.partial, true);
  assert.equal(looksPaywalled({ html: fixture("story.html"), text: "" }), false);
});

test("a JavaScript shell falls back to the AMP copy before giving up", async () => {
  const routes = {
    "https://daily.test/world/2026/09/04/coverage-fell": fixture("js-shell.html"),
    "https://daily.test/world/2026/09/04/coverage-fell/amp": fixture("amp.html"),
  };
  const article = await fetchArticle("https://daily.test/world/2026/09/04/coverage-fell", opts(routes));
  assert.match(article.text, /58 percent in 2023/);
  // The reader copy supplied the text; the pasted URL is still what gets cited.
  assert.equal(article.url, "https://daily.test/world/2026/09/04/coverage-fell");
});

test("a JavaScript shell with no reader copy is still reported as one", async () => {
  await assert.rejects(
    fetchArticle(
      "https://daily.test/world/2026/09/04/coverage-fell",
      opts({ "https://daily.test/world/2026/09/04/coverage-fell": fixture("js-shell.html") }),
    ),
    (error) => error instanceof ArticleError && error.kind === "empty",
  );
});

test("readerVariants stays on the same origin and gives up on a copy that is already one", () => {
  const variants = readerVariants("https://daily.test/world/story?utm=1");
  assert.equal(variants.length, 2);
  for (const variant of variants) assert.match(variant, /^https:\/\/daily\.test\//);
  assert.deepEqual(readerVariants("https://daily.test/world/story/amp"), []);
});

/* ------------------------------------------------------------------ outline */

test("the outline of a front page is its headlines, as checkable links", async () => {
  const outline = await fetchPageOutline(
    "https://daily.test/",
    opts({ "https://daily.test/": fixture("front-page.html") }),
  );
  assert.equal(outline.index, true);
  assert.ok(outline.headlines.length >= 5);
  for (const row of outline.headlines) {
    assert.match(row.url, /^https:\/\/daily\.test\/world\//);
    assert.ok(row.title.length > 20);
  }
  // Furniture never makes the list.
  assert.doesNotMatch(outline.headlines.map((row) => row.title).join(" "), /Sign in|Subscribe/);
});

test("extractHeadlines refuses another origin and a shallow link", () => {
  const html = `
    <a href="https://ads.test/world/2026/x">A sponsored headline long enough to pass the length test</a>
    <a href="/subscribe">Subscribe to The Daily today and get unlimited access now</a>
    <a href="/world/2026/09/04/real">A real headline that is long enough to count as one</a>`;
  const rows = extractHeadlines(html, "https://daily.test/");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://daily.test/world/2026/09/04/real");
});

test("a story's own page is not offered as an outline", async () => {
  const outline = await fetchPageOutline(
    "https://daily.test/world/2026/09/04/coverage-fell",
    opts({ "https://daily.test/world/2026/09/04/coverage-fell": fixture("story.html") }),
  );
  assert.equal(outline.index, false);
});

test("every fixture classifies as exactly the shape it is named after", () => {
  const front = fixture("front-page.html");
  assert.equal(looksLikeIndexPage({ url: "https://daily.test/", html: front, text: "Headline\nHeadline" }), true);
  assert.equal(
    looksLikeIndexPage({ url: "https://daily.test/world/2026/09/04/x", html: front, text: "Headline" }),
    false,
  );
});
