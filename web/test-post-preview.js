// node --test test-post-preview.js
//
// The last metadata tier: the post page's own Open Graph tags, for a clip that could not be
// downloaded and whose resolve carried nothing. No network — `fetchImpl` is a stub
// throughout, and the pipeline tests drive it through the provider's `preview` hook.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchPostPreview, looksLikeInterstitial } from "./lib/post-preview.js";
import { resolveClipParts, toGeminiContents } from "./lib/gemini.js";
import { findTikTokLinks, TikTokError } from "./lib/tiktok.js";

const VIDEO_ID = "6718335390845095173";
const SOURCE_URL = `https://www.tiktok.com/@scout2015/video/${VIDEO_ID}`;
const REEL_URL = "https://www.instagram.com/reel/Cabc123/";

/** A head shaped like the real thing: tags in both attribute orders, entities escaped. */
function pageHTML({
  title = "Scout, Suki &amp; Stella on TikTok",
  description = "Scramble up ur name &amp; I&#39;ll try to guess it",
  image = "https://p16.tiktokcdn.com/thumb.jpeg",
} = {}) {
  return `<!doctype html><html><head>
    <meta charset="utf-8">
    <meta property="og:title" content="${title}">
    <meta content="${description}" property="og:description">
    <meta name="og:image" content="${image}">
  </head><body><div id="app"></div></body></html>`;
}

/** A response whose body streams in chunks, the way a real one arrives. */
function htmlResponse(html, { ok = true, status = 200, url } = {}) {
  return {
    ok,
    status,
    url,
    headers: { get: () => "text/html; charset=utf-8" },
    body: {
      async *[Symbol.asyncIterator]() {
        const buffer = Buffer.from(html, "utf8");
        for (let i = 0; i < buffer.length; i += 64) yield buffer.subarray(i, i + 64);
      },
    },
  };
}

/* ---------------- reading the tags ---------------- */

test("reads the caption, creator and thumbnail off a post page", async () => {
  const preview = await fetchPostPreview(SOURCE_URL, {
    platform: "TikTok",
    fetchImpl: async () => htmlResponse(pageHTML()),
  });

  // og:description is the caption on both platforms, and entities are decoded.
  assert.equal(preview.title, "Scramble up ur name & I'll try to guess it");
  // TikTok puts the handle in the path, which survives every markup change.
  assert.equal(preview.authorName, "scout2015");
  assert.equal(preview.thumbnailURL, "https://p16.tiktokcdn.com/thumb.jpeg");
});

test("falls back to og:title when a post carries no description", async () => {
  const preview = await fetchPostPreview(SOURCE_URL, {
    platform: "TikTok",
    fetchImpl: async () =>
      htmlResponse(`<head><meta property="og:title" content="A silent clip"></head>`),
  });
  assert.equal(preview.title, "A silent clip");
});

test("an Instagram reel gets a caption where it never had one before", async () => {
  // Instagram's oEmbed needs a Meta App Review token, so this tier is the only metadata it
  // has ever had — a reel whose resolve carried nothing used to be lost outright.
  const preview = await fetchPostPreview(REEL_URL, {
    platform: "Instagram",
    fetchImpl: async () =>
      htmlResponse(pageHTML({ description: "3 things the study actually said" })),
  });
  assert.equal(preview.title, "3 things the study actually said");
  // Its URLs carry only a shortcode, so there is no handle to read out of the path.
  assert.equal(preview.authorName, null);
});

test("stops reading at the byte cap instead of failing on it", async () => {
  // The tags are in the head and the rest is bundle, so hitting the cap is the plan rather
  // than an error — unlike readCapped, where the cap means the file was too big.
  const html = pageHTML() + "x".repeat(2_000_000);
  const preview = await fetchPostPreview(SOURCE_URL, {
    platform: "TikTok",
    maxBytes: 4096,
    fetchImpl: async () => htmlResponse(html),
  });
  assert.equal(preview.title, "Scramble up ur name & I'll try to guess it");
});

/* ---------------- what it refuses ---------------- */

test("a login wall is not a caption", async () => {
  // These return 200 with well-formed tags describing the *site*. Passing one on would tell
  // the model the post says "Log in to Instagram", which looks like content and is not.
  for (const description of [
    "Log in to Instagram to see photos and videos from your friends",
    "Sign up to see photos from your friends",
    "Watch the latest videos from scout2015",
  ]) {
    const preview = await fetchPostPreview(REEL_URL, {
      platform: "Instagram",
      fetchImpl: async () => htmlResponse(pageHTML({ title: "Instagram", description })),
    });
    assert.equal(preview, null, description);
  }
});

test("a page with no tags at all is a miss, not an empty caption", async () => {
  const preview = await fetchPostPreview(SOURCE_URL, {
    platform: "TikTok",
    fetchImpl: async () => htmlResponse("<head><title>nothing useful</title></head>"),
  });
  assert.equal(preview, null);
});

test("refuses any URL that isn't an https post page on that platform", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return htmlResponse(pageHTML());
  };
  const refused = [
    ["http://www.tiktok.com/@a/video/1", "TikTok"],
    ["https://tiktok.com.evil.test/@a/video/1", "TikTok"],
    ["https://user:pw@www.tiktok.com/@a/video/1", "TikTok"],
    [SOURCE_URL, "Instagram"],
    [REEL_URL, "TikTok"],
    ["not a url", "TikTok"],
    [SOURCE_URL, "YouTube"],
  ];
  for (const [url, platform] of refused) {
    assert.equal(await fetchPostPreview(url, { platform, fetchImpl }), null, `${platform} ${url}`);
  }
  assert.equal(called, false, "refused before a request is made");
});

test("a redirect that leaves the platform is not a post page", async () => {
  const preview = await fetchPostPreview(REEL_URL, {
    platform: "Instagram",
    fetchImpl: async () =>
      htmlResponse(pageHTML(), { url: "https://login.example.com/accounts/login/" }),
  });
  assert.equal(preview, null);
});

test("every transport failure is null rather than a throw", async () => {
  const cases = [
    ["a dead connection", async () => { throw new Error("ECONNREFUSED"); }],
    ["a 404", async () => htmlResponse("", { ok: false, status: 404 })],
    ["a bodyless response", async () => ({ ok: true, status: 200, headers: { get: () => "" }, body: null })],
  ];
  for (const [what, fetchImpl] of cases) {
    assert.equal(await fetchPostPreview(SOURCE_URL, { platform: "TikTok", fetchImpl }), null, what);
  }
});

test("looksLikeInterstitial treats an empty preview as one", () => {
  assert.equal(looksLikeInterstitial(null, null), true);
  assert.equal(looksLikeInterstitial("", "   "), true);
  assert.equal(looksLikeInterstitial(null, "A real caption about a real claim"), false);
});

/* ---------------- the tier, inside the clip pipeline ---------------- */

const messages = [{ role: "user", content: `check ${SOURCE_URL}` }];

function provider(overrides) {
  return {
    platform: "TikTok",
    find: findTikTokLinks,
    matches: () => true,
    resolve: async () => ({
      sourceURL: SOURCE_URL,
      videoID: VIDEO_ID,
      kind: "video",
      mediaURL: "https://v16m.tiktokcdn-us.com/x.mp4",
      mimeType: "video/mp4",
      caption: null,
      authorName: null,
    }),
    download: async () => {
      throw new TikTokError("TikTok's CDN refused the download (HTTP 500).");
    },
    ...overrides,
  };
}

test("a clip with no metadata anywhere else is described by its page preview", async () => {
  const clips = await resolveClipParts(messages, {
    providers: [
      provider({
        oEmbed: async () => null,
        preview: async () => ({
          title: "Scramble up ur name",
          authorName: "scout2015",
          thumbnailURL: null,
        }),
      }),
    ],
  });

  const contents = toGeminiContents(messages, { clips });
  assert.equal(contents[0].parts.length, 1, "no video part — only the note");
  assert.match(contents[0].parts[0].text, /Scramble up ur name/);
  assert.match(contents[0].parts[0].text, /scout2015/);
  // Why the clip is missing still rides along: a caption is not the same as having watched.
  assert.match(contents[0].parts[0].text, /CDN refused the download/);
});

test("oEmbed still wins where a platform has one, and the page is left alone", async () => {
  let previews = 0;
  const clips = await resolveClipParts(messages, {
    providers: [
      provider({
        oEmbed: async () => ({ title: "From oEmbed", authorName: "scout2015", thumbnailURL: null }),
        preview: async () => {
          previews += 1;
          return { title: "From the page", authorName: null, thumbnailURL: null };
        },
      }),
    ],
  });

  assert.equal(previews, 0, "the cheaper documented endpoint is not second-guessed");
  assert.match(toGeminiContents(messages, { clips })[0].parts[0].text, /From oEmbed/);
});

test("the resolve's own caption still outranks both — it costs no request at all", async () => {
  let calls = 0;
  const count = async () => {
    calls += 1;
    return { title: "later tier", authorName: null, thumbnailURL: null };
  };
  const clips = await resolveClipParts(messages, {
    providers: [
      provider({
        resolve: async () => ({
          sourceURL: SOURCE_URL,
          videoID: VIDEO_ID,
          kind: "video",
          mediaURL: "https://v16m.tiktokcdn-us.com/x.mp4",
          mimeType: "video/mp4",
          caption: "Straight from the resolve",
          authorName: "scout2015",
        }),
        oEmbed: count,
        preview: count,
      }),
    ],
  });

  assert.equal(calls, 0);
  assert.match(toGeminiContents(messages, { clips })[0].parts[0].text, /Straight from the resolve/);
});

test("a preview that throws leaves the download error standing", async () => {
  const clips = await resolveClipParts(messages, {
    providers: [
      provider({
        oEmbed: async () => null,
        preview: async () => {
          throw new Error("the page fell over");
        },
      }),
    ],
  });

  const entry = clips.attachments.get(SOURCE_URL);
  assert.match(entry.error, /CDN refused the download/);
  assert.equal(entry.metadataOnly, undefined);
  // The user hears about their link, not about our page fetch.
  assert.doesNotMatch(toGeminiContents(messages, { clips })[0].parts[0].text, /fell over/);
});

test("a provider with no preview hook simply skips the tier", async () => {
  // Which is also what keeps a test that supplies its own providers from making a network
  // call it never asked for.
  const clips = await resolveClipParts(messages, {
    providers: [provider({ oEmbed: async () => null })],
  });
  assert.match(clips.attachments.get(SOURCE_URL).error, /CDN refused the download/);
  assert.equal(clips.attachments.get(SOURCE_URL).metadataOnly, undefined);
});
