// node --test test-tiktok-capture.js
//
// The primary TikTok path: real oEmbed → rendered embed → in-page capture. No network, no
// real Chromium — `browserFactory` and `fetchImpl` are stubbed throughout, the same
// injection pattern lib/tiktok.js's own tests use for `fetchImpl`.
//
// What these tests do *not* cover: whether TikTok's actual embed player exposes an audio
// track to `captureStream()`. That's a live-site question a stub can't answer — see the
// header of lib/tiktok-capture.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TikTokCaptureError,
  resolveTikTokEmbed,
  resolveChromiumExecutable,
  captureTikTokEmbed,
  downloadTikTokWithFallback,
} from "./lib/tiktok-capture.js";
import { TikTokError } from "./lib/tiktok.js";

const VIDEO_ID = "6718335390845095173";
const SOURCE_URL = `https://www.tiktok.com/@scout2015/video/${VIDEO_ID}`;
const REAL_EMBED_HTML =
  `<blockquote class="tiktok-embed" cite="${SOURCE_URL}" data-video-id="${VIDEO_ID}"> ` +
  `<section></section></blockquote> <script async src="https://www.tiktok.com/embed.js"></script>`;

function oembedResponse(overrides = {}, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      html: REAL_EMBED_HTML,
      title: "Scramble up ur name",
      author_name: "scout2015",
      thumbnail_url: "https://p16.tiktokcdn.com/thumb.jpg",
      ...overrides,
    }),
  };
}

function redirectResponse(url) {
  return { url, body: { cancel: async () => {} } };
}

/* ---------------- resolveTikTokEmbed ---------------- */

test("resolves a direct video URL against the real oEmbed endpoint", async () => {
  let seenURL;
  const fetchImpl = async (url) => {
    seenURL = url;
    return oembedResponse();
  };

  const resolved = await resolveTikTokEmbed(SOURCE_URL, { fetchImpl });
  assert.equal(resolved.videoID, VIDEO_ID);
  assert.equal(resolved.sourceURL, SOURCE_URL);
  assert.equal(resolved.embedHTML, REAL_EMBED_HTML);
  assert.equal(resolved.authorName, "scout2015");
  assert.equal(resolved.caption, "Scramble up ur name");
  assert.ok(seenURL.startsWith("https://www.tiktok.com/oembed?url="));
  assert.ok(seenURL.includes(encodeURIComponent(SOURCE_URL)));
});

test("follows a short link before calling oEmbed", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes("vm.tiktok.com")) return redirectResponse(SOURCE_URL);
    return oembedResponse();
  };

  const resolved = await resolveTikTokEmbed("https://vm.tiktok.com/ZMabc/", { fetchImpl });
  assert.equal(resolved.videoID, VIDEO_ID);
  assert.equal(resolved.sourceURL, SOURCE_URL);
  assert.equal(seen[0], "https://vm.tiktok.com/ZMabc/");
  assert.ok(seen[1].startsWith("https://www.tiktok.com/oembed?url="));
});

test("a link that is neither a video URL nor a short link is refused up front", async () => {
  await assert.rejects(
    resolveTikTokEmbed("https://www.tiktok.com/@scout2015", { fetchImpl: async () => oembedResponse() }),
    (error) => error instanceof TikTokCaptureError && error.kind === "notAVideo",
  );
});

test("an unknown ID reported as HTTP 400 reads as removed, not as our failure", async () => {
  const fetchImpl = async () => oembedResponse({}, { status: 400 });
  await assert.rejects(
    resolveTikTokEmbed(SOURCE_URL, { fetchImpl }),
    (error) => error.kind === "unavailable" && /removed/.test(error.message),
  );
});

test("oEmbed html with no embeddable player is treated as malformed, not swallowed", async () => {
  const fetchImpl = async () => oembedResponse({ html: "<p>no embed here</p>" });
  await assert.rejects(
    resolveTikTokEmbed(SOURCE_URL, { fetchImpl }),
    (error) => error.kind === "malformed",
  );
});

/* ---------------- resolveChromiumExecutable ---------------- */

test("an explicit PLAYWRIGHT_CHROMIUM_PATH wins over everything else", async () => {
  const path = await resolveChromiumExecutable({ PLAYWRIGHT_CHROMIUM_PATH: "/opt/chrome" });
  assert.equal(path, "/opt/chrome");
});

test("no configured Chromium is reported as unconfigured, not a capture failure", async () => {
  const loadSparticuz = async () => {
    throw new Error("module not installed");
  };
  await assert.rejects(
    resolveChromiumExecutable({}, loadSparticuz),
    (error) => error instanceof TikTokCaptureError && error.kind === "unconfigured",
  );
});

/* ---------------- captureTikTokEmbed ---------------- */

function resolvedEmbed(overrides = {}) {
  return {
    sourceURL: SOURCE_URL,
    videoID: VIDEO_ID,
    embedHTML: REAL_EMBED_HTML,
    authorName: "scout2015",
    caption: "Scramble up ur name",
    thumbnailURL: null,
    ...overrides,
  };
}

/**
 * A stub Playwright browser whose page/frame behave like a hydrated embed and whose
 * in-frame `evaluate` returns a canned capture result — standing in for the whole
 * captureStream()/MediaRecorder dance that only a real browser can actually run.
 */
function stubBrowser({ evaluateResult, hasIframe = true, hasVideo = true, closeCalls } = {}) {
  const routes = [];
  const frame = {
    waitForSelector: async (selector) => {
      if (selector === "video" && !hasVideo) throw new Error("no video");
      return {};
    },
    evaluate: async (fn, args) => {
      if (evaluateResult) return evaluateResult;
      // Exercises the real function body isn't possible without a DOM; callers that care
      // about the in-page logic pass `evaluateResult` directly.
      return { ok: true, mimeType: "video/webm", base64: Buffer.from("x").toString("base64"), duration: 9 };
    },
  };
  const frameHandle = { contentFrame: async () => (hasIframe ? frame : null) };
  const page = {
    route: async (pattern, handler) => routes.push({ pattern, handler }),
    goto: async () => {},
    waitForSelector: async (selector) => (selector === "iframe" && hasIframe ? frameHandle : null),
    close: async () => {},
  };
  return {
    newPage: async () => page,
    close: async () => {
      if (closeCalls) closeCalls.count = (closeCalls.count ?? 0) + 1;
    },
  };
}

test("a successful capture returns the recorded bytes and mime type", async () => {
  const closeCalls = {};
  const browserFactory = async () =>
    stubBrowser({
      evaluateResult: {
        ok: true,
        mimeType: "video/webm;codecs=vp9,opus",
        base64: Buffer.from("fake webm bytes").toString("base64"),
        duration: 9.4,
      },
      closeCalls,
    });

  const media = await captureTikTokEmbed(resolvedEmbed(), {
    browserFactory,
    env: { PLAYWRIGHT_CHROMIUM_PATH: "/opt/chrome" },
  });

  assert.equal(media.bytes.toString(), "fake webm bytes");
  assert.equal(media.mimeType, "video/webm;codecs=vp9,opus");
  assert.equal(media.duration, 9.4);
  assert.equal(closeCalls.count, 1, "the browser is always closed");
});

test("the browser is closed even when the page never hydrates an iframe", async () => {
  const closeCalls = {};
  const browserFactory = async () => stubBrowser({ hasIframe: false, closeCalls });

  await assert.rejects(
    captureTikTokEmbed(resolvedEmbed(), {
      browserFactory,
      env: { PLAYWRIGHT_CHROMIUM_PATH: "/opt/chrome" },
    }),
    (error) => error instanceof TikTokCaptureError && error.kind === "unavailable",
  );
  assert.equal(closeCalls.count, 1);
});

test("an in-page error (no audio track, playback refused) surfaces as TikTokCaptureError", async () => {
  const browserFactory = async () =>
    stubBrowser({
      evaluateResult: { error: "TikTok's embed player exposed no audio track to capture." },
    });

  await assert.rejects(
    captureTikTokEmbed(resolvedEmbed(), {
      browserFactory,
      env: { PLAYWRIGHT_CHROMIUM_PATH: "/opt/chrome" },
    }),
    (error) => error instanceof TikTokCaptureError && /no audio track/.test(error.message),
  );
});

test("a capture over the byte ceiling is refused rather than forwarded", async () => {
  const browserFactory = async () =>
    stubBrowser({
      evaluateResult: {
        ok: true,
        mimeType: "video/webm",
        base64: Buffer.alloc(100).toString("base64"),
        duration: 1,
      },
    });

  await assert.rejects(
    captureTikTokEmbed(resolvedEmbed(), {
      browserFactory,
      maxBytes: 10,
      env: { PLAYWRIGHT_CHROMIUM_PATH: "/opt/chrome" },
    }),
    (error) => error.kind === "tooLarge",
  );
});

test("no configured Chromium fails before a browser is ever launched", async () => {
  let launched = false;
  const browserFactory = async () => {
    launched = true;
    return stubBrowser();
  };
  const loadSparticuz = async () => {
    throw new Error("module not installed");
  };

  await assert.rejects(
    captureTikTokEmbed(resolvedEmbed(), { browserFactory, env: {}, loadSparticuz }),
    (error) => error.kind === "unconfigured",
  );
  assert.equal(launched, false);
});

/* ---------------- downloadTikTokWithFallback ---------------- */

test("capture success never touches the old state-blob fallback", async () => {
  const browserFactory = async () =>
    stubBrowser({
      evaluateResult: {
        ok: true,
        mimeType: "video/webm",
        base64: Buffer.from("captured").toString("base64"),
        duration: 5,
      },
    });

  let fallbackFetchCalled = false;
  const media = await downloadTikTokWithFallback(resolvedEmbed(), {
    browserFactory,
    env: { PLAYWRIGHT_CHROMIUM_PATH: "/opt/chrome" },
    fetchImpl: async () => {
      fallbackFetchCalled = true;
      throw new Error("should not be called");
    },
  });

  assert.equal(media.bytes.toString(), "captured");
  assert.equal(fallbackFetchCalled, false);
});

test("a capture failure falls back to the embed-state-blob + CDN path", async () => {
  const STATE_BLOB =
    `{"source":{"data":{"/embed/v2/${VIDEO_ID}":{"code":200,"isError":false,` +
    `"videoData":{"itemInfos":{"id":"${VIDEO_ID}","text":"cap","video":{"urls":["https://v16.tiktokcdn.com/x.mp4"],` +
    `"videoMeta":{"duration":9}}},"authorInfos":{"nickName":"n"}}}}}}`;

  const browserFactory = async () => stubBrowser({ hasIframe: false });

  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("/embed/v2/")) {
      return { ok: true, status: 200, url: target, text: async () => `<script id="__FRONTITY_CONNECT_STATE__" type="application/json">${STATE_BLOB}</script>` };
    }
    if (target.includes("v16.tiktokcdn.com")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "video/mp4" },
        body: (async function* () {
          yield Buffer.from("fallback bytes");
        })(),
      };
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const media = await downloadTikTokWithFallback(resolvedEmbed(), {
    browserFactory,
    env: { PLAYWRIGHT_CHROMIUM_PATH: "/opt/chrome" },
    fetchImpl,
  });

  assert.equal(media.bytes.toString(), "fallback bytes");
});

test("when both capture and the fallback fail, the capture's own error is what surfaces", async () => {
  const browserFactory = async () => stubBrowser({ hasIframe: false });
  const fetchImpl = async () => {
    throw new TikTokError("TikTok embed page failed (HTTP 500).", { retryable: true });
  };

  await assert.rejects(
    downloadTikTokWithFallback(resolvedEmbed(), {
      browserFactory,
      env: { PLAYWRIGHT_CHROMIUM_PATH: "/opt/chrome" },
      fetchImpl,
    }),
    (error) => error instanceof TikTokCaptureError && error.kind === "unavailable",
  );
});
