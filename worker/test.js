// node --test test.js
//
// Covers the part of the worker that decides where the browser is allowed to go. The
// Playwright half needs a browser and a live post, so it isn't tested here — but `vetPostURL`
// is what stands between a request and an arbitrary navigation, and it is pure.

import { test } from "node:test";
import assert from "node:assert/strict";

import { vetPostURL } from "./urls.js";

test("accepts the post URLs each platform actually serves", () => {
  assert.ok(vetPostURL("https://www.tiktok.com/@scout2015/video/6718335390845095173", "TikTok"));
  assert.ok(vetPostURL("https://www.tiktok.com/@memezar/photo/7449708266168274208", "TikTok"));
  assert.ok(vetPostURL("https://vm.tiktok.com/ZMabc123/", "TikTok"));
  assert.ok(vetPostURL("https://www.instagram.com/reel/Cabc123/", "Instagram"));
  assert.ok(vetPostURL("https://instagram.com/p/Cabc123/", "Instagram"));
});

test("refuses a host that only looks like the platform", () => {
  // Suffix matching is on a dot boundary, so this is not tiktok.com.
  assert.equal(vetPostURL("https://tiktok.com.evil.test/@a/video/1", "TikTok"), null);
  assert.equal(vetPostURL("https://eviltiktok.com/@a/video/1", "TikTok"), null);
  assert.equal(vetPostURL("https://instagram.com.evil.test/reel/x/", "Instagram"), null);
});

test("refuses one platform's link under the other's allowlist", () => {
  assert.equal(vetPostURL("https://www.instagram.com/reel/Cabc123/", "TikTok"), null);
  assert.equal(vetPostURL("https://www.tiktok.com/@a/video/1", "Instagram"), null);
});

test("refuses anything that isn't https, and anything carrying credentials", () => {
  assert.equal(vetPostURL("http://www.tiktok.com/@a/video/1", "TikTok"), null);
  assert.equal(vetPostURL("file:///etc/passwd", "TikTok"), null);
  assert.equal(vetPostURL("https://user:pw@www.tiktok.com/@a/video/1", "TikTok"), null);
});

test("refuses an unknown platform and a URL that will not parse", () => {
  assert.equal(vetPostURL("https://www.tiktok.com/@a/video/1", "YouTube"), null);
  assert.equal(vetPostURL("not a url", "TikTok"), null);
  assert.equal(vetPostURL(null, "TikTok"), null);
});
