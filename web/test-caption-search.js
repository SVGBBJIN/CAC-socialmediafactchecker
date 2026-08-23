// Unit tests for lib/caption-search.js. No DOM and no network, per the convention in
// CLAUDE.md — the module is deliberately pure so "is this caption worth a query, and what
// is the query" can be pinned down without a search provider.

import { test } from "node:test";
import assert from "node:assert/strict";

import { captionQuery, captionText, captionSearchEnabled } from "./lib/caption-search.js";
import { validateSearchQuery } from "./lib/search-schema.js";

/* ---------------------------------------------------------------- captionText */

test("captionText strips hashtags, mentions, links and emoji", () => {
  const text = captionText(
    "🚨 BREAKING: the Ridgeway bridge closed Monday for repairs 😱 @cityofridgeway #news #fyp https://t.co/abc",
  );
  assert.equal(text, "BREAKING: the Ridgeway bridge closed Monday for repairs");
});

test("captionText collapses the whitespace stripping leaves behind", () => {
  assert.equal(captionText("one   #a  #b   two"), "one two");
});

test("captionText handles a null or missing caption", () => {
  assert.equal(captionText(null), "");
  assert.equal(captionText(undefined), "");
});

/* ---------------------------------------------------------------- skip conditions */

test("a caption that is only decoration is not worth a search", () => {
  // The common case on short-form video, and the one this must not spend a query on.
  assert.equal(captionQuery("😂😂😂 #fyp #viral #foryoupage"), null);
  assert.equal(captionQuery("@someone @someoneelse"), null);
  assert.equal(captionQuery("https://example.com/watch"), null);
});

test("a caption too short to assert anything is skipped", () => {
  assert.equal(captionQuery("wait for it"), null);
  assert.equal(captionQuery("look at this"), null);
  assert.equal(captionQuery(""), null);
  assert.equal(captionQuery(null), null);
});

test("a caption with enough words but too few characters is skipped", () => {
  // Four words, well under the character floor — the word count alone would let it through.
  assert.equal(captionQuery("a b c d"), null);
});

/* ---------------------------------------------------------------- the query itself */

test("a substantive caption becomes a query and a truthful claim", () => {
  const result = captionQuery(
    "The Ridgeway bridge was closed Monday because of a structural failure #news",
    { platform: "TikTok" },
  );
  assert.ok(result);
  assert.equal(result.query, "The Ridgeway bridge was closed Monday because of a structural failure");
  // The claim is what the app is actually checking — what the caption *states* — not an
  // assertion that the caption is true. The ledger files sources against this line and the
  // model reads it back, so it has to be honest about whose statement it is.
  assert.match(result.claim, /What the TikTok post's caption states/);
  assert.match(result.claim, /Ridgeway bridge was closed Monday/);
});

test("the pair validates against the real search schema", () => {
  // The whole point of clamping to SEARCH_QUERY_SCHEMA's bounds: this must go through the
  // same door every model-issued query does, not a looser one beside it.
  const result = captionQuery(
    "Officials said the Ridgeway bridge closure will last until at least November",
    { platform: "Instagram" },
  );
  assert.doesNotThrow(() => validateSearchQuery(result));
});

test("an enormous caption is clamped to something the schema accepts", () => {
  const result = captionQuery(`${"the bridge closed on Monday ".repeat(60)}`, { platform: "TikTok" });
  assert.ok(result);
  assert.doesNotThrow(() => validateSearchQuery(result));
});

test("the platform names itself in the claim, and defaults when unknown", () => {
  assert.match(captionQuery("The bridge closed on Monday for repairs work").claim, /the post's caption/);
});

/* ---------------------------------------------------------------- the flag */

test("the caption search is on unless an operator turns it off", () => {
  assert.equal(captionSearchEnabled({}), true);
  assert.equal(captionSearchEnabled({ CAPTION_SEARCH_ENABLED: "false" }), false);
  // Case-insensitive, like every other flag read through `readEnv`.
  assert.equal(captionSearchEnabled({ Caption_Search_Enabled: "FALSE" }), false);
  assert.equal(captionSearchEnabled({ CAPTION_SEARCH_ENABLED: "true" }), true);
});
