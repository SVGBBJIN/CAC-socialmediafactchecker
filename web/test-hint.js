// node --test test-hint.js
//
// Covers the resolve hint: what survives validation, and the two rules that keep an
// optimisation from becoming a way to change someone else's answer — a hinted resolve is
// never cached, and a hinted failure re-resolves for real.

import { test } from "node:test";
import assert from "node:assert/strict";

import { hintFromResolved, validateHint, validateHints, MAX_HINTS } from "./lib/resolve-hint.js";
import { resolveClipParts, resetClipCache, findClipLinks } from "./lib/gemini.js";

const TIKTOK_LINK = "https://www.tiktok.com/@a/video/7123456789";
const CDN = "https://v16-webapp.tiktokcdn.com/clip.mp4";

/** What `resolveTikTokVideo` hands back for a video post. */
function resolvedVideo(overrides = {}) {
  return {
    sourceURL: TIKTOK_LINK,
    videoID: "7123456789",
    referer: "https://www.tiktok.com/",
    authorName: "someone",
    caption: "a caption",
    kind: "video",
    mediaURL: CDN,
    mimeType: "video/mp4",
    duration: 30,
    width: 576,
    height: 1024,
    ...overrides,
  };
}

const linksFor = (text) => findClipLinks(text);

/* ------------------------------------------------------------------ the wire shape */

test("the hint drops the two fields that must not come from a caller", () => {
  const hint = hintFromResolved(resolvedVideo());
  // A client-set referer would become a header on our own fetch to someone's CDN.
  assert.equal("referer" in hint, false);
  // The server already knows the link; re-deriving it means the field naming the post to
  // the model can't be set by the caller.
  assert.equal("sourceURL" in hint, false);
  assert.equal(hint.mediaURL, CDN);
  assert.equal(hint.videoID, "7123456789");
});

test("a hint round-trips into a resolved the pipeline can use", () => {
  const hint = hintFromResolved(resolvedVideo());
  const resolved = validateHint(hint, { platform: "TikTok", link: TIKTOK_LINK });

  assert.equal(resolved.kind, "video");
  assert.equal(resolved.mediaURL, CDN);
  assert.equal(resolved.caption, "a caption");
  // Stamped from the link, never read from the payload.
  assert.equal(resolved.sourceURL, TIKTOK_LINK);
});

test("an image post round-trips with its whole sequence", () => {
  const hint = hintFromResolved({
    ...resolvedVideo(),
    kind: "images",
    mimeType: "image/jpeg",
    images: [
      { url: "https://p16.tiktokcdn.com/1.jpg", width: 10, height: 20 },
      { url: "https://p16.tiktokcdn.com/2.jpg", width: 10, height: 20 },
    ],
  });
  const resolved = validateHint(hint, { platform: "TikTok", link: TIKTOK_LINK });
  assert.equal(resolved.kind, "images");
  assert.equal(resolved.slideCount, 2);
});

/* -------------------------------------------------------------------- rejections */

test("a hint naming a host the platform doesn't serve from is refused", () => {
  const hint = hintFromResolved(resolvedVideo({ mediaURL: "https://evil.test/clip.mp4" }));
  assert.equal(validateHint(hint, { platform: "TikTok", link: TIKTOK_LINK }), null);
});

test("the allowlist is suffix-matched, so a lookalike host is refused", () => {
  const hint = hintFromResolved(resolvedVideo({ mediaURL: "https://tiktokcdn.com.evil.test/x.mp4" }));
  assert.equal(validateHint(hint, { platform: "TikTok", link: TIKTOK_LINK }), null);
});

test("plain http is refused even on an allowed host", () => {
  const hint = hintFromResolved(resolvedVideo({ mediaURL: "http://v16.tiktokcdn.com/clip.mp4" }));
  assert.equal(validateHint(hint, { platform: "TikTok", link: TIKTOK_LINK }), null);
});

test("one bad slide refuses the whole set rather than attaching the rest", () => {
  const hint = hintFromResolved({
    ...resolvedVideo(),
    kind: "images",
    mimeType: "image/jpeg",
    images: [
      { url: "https://p16.tiktokcdn.com/1.jpg" },
      { url: "https://evil.test/2.jpg" },
    ],
  });
  assert.equal(validateHint(hint, { platform: "TikTok", link: TIKTOK_LINK }), null);
});

test("free text is bounded rather than trusted at whatever length it arrives", () => {
  const hint = hintFromResolved(resolvedVideo({ caption: "x".repeat(5000) }));
  const resolved = validateHint(hint, { platform: "TikTok", link: TIKTOK_LINK });
  assert.equal(resolved.caption.length, 500);
});

test("a mime type we don't attach is refused", () => {
  const hint = hintFromResolved(resolvedVideo({ mimeType: "text/html" }));
  assert.equal(validateHint(hint, { platform: "TikTok", link: TIKTOK_LINK }), null);
});

test("junk in the ID field is refused", () => {
  for (const videoID of ["../../etc", "id with spaces", "", "x".repeat(100)]) {
    const hint = hintFromResolved(resolvedVideo({ videoID }));
    assert.equal(validateHint(hint, { platform: "TikTok", link: TIKTOK_LINK }), null, videoID);
  }
});

/* ------------------------------------------------------------------ the map form */

test("a hint for a link the message never mentions is dropped", () => {
  const text = `Fact-check this video: ${TIKTOK_LINK}`;
  const hints = validateHints(
    { "https://www.tiktok.com/@b/video/999": hintFromResolved(resolvedVideo()) },
    linksFor(text),
  );
  assert.equal(hints.size, 0);
});

test("a hint for a link the message does mention is keyed for the pipeline", () => {
  const text = `Fact-check this video: ${TIKTOK_LINK}`;
  const hints = validateHints({ [TIKTOK_LINK]: hintFromResolved(resolvedVideo()) }, linksFor(text));
  assert.equal(hints.size, 1);
  assert.ok(hints.has(`TikTok:${TIKTOK_LINK}`));
});

test("the payload is bounded", () => {
  const raw = {};
  for (let i = 0; i < MAX_HINTS + 10; i += 1) raw[`https://www.tiktok.com/@a/video/${i}`] = {};
  assert.doesNotThrow(() => validateHints(raw, []));
});

test("garbage in the hints field is survivable", () => {
  for (const raw of [null, "nope", 42, []]) {
    assert.equal(validateHints(raw, linksFor(TIKTOK_LINK)).size, 0);
  }
});

/* --------------------------------------------------- behaviour in the clip stage */

const stubProvider = (resolveImpl) => [
  {
    platform: "TikTok",
    find: () => [],
    matches: (u) => u.startsWith("https://www.tiktok.com/"),
    resolve: resolveImpl,
    download: async () => ({ bytes: Buffer.from("mp4"), mimeType: "video/mp4" }),
  },
];

const message = [{ role: "user", content: `Fact-check this video: ${TIKTOK_LINK}` }];

test("a valid hint skips the resolve entirely", async () => {
  let resolveCalls = 0;
  const providers = stubProvider(async () => {
    resolveCalls += 1;
    return resolvedVideo();
  });
  const hints = validateHints({ [TIKTOK_LINK]: hintFromResolved(resolvedVideo()) }, linksFor(message[0].content));

  const { attachments } = await resolveClipParts(message, { providers, hints, apiKey: "k" });
  assert.equal(resolveCalls, 0);
  assert.ok(attachments.get(TIKTOK_LINK)?.part);
});

test("with no hint the resolve runs as it always did", async () => {
  let resolveCalls = 0;
  const providers = stubProvider(async () => {
    resolveCalls += 1;
    return resolvedVideo();
  });
  await resolveClipParts(message, { providers, apiKey: "k" });
  assert.equal(resolveCalls, 1);
});

test("a stale hint costs one failed download, then resolves for real", async () => {
  let resolveCalls = 0;
  let downloadCalls = 0;
  const providers = [
    {
      ...stubProvider(async () => {
        resolveCalls += 1;
        return resolvedVideo({ mediaURL: "https://v16-webapp.tiktokcdn.com/fresh.mp4" });
      })[0],
      download: async (resolved) => {
        downloadCalls += 1;
        // The hinted URL has aged out; the freshly resolved one works.
        if (resolved.mediaURL === CDN) throw new Error("403 from the CDN");
        return { bytes: Buffer.from("mp4"), mimeType: "video/mp4" };
      },
    },
  ];
  const hints = validateHints({ [TIKTOK_LINK]: hintFromResolved(resolvedVideo()) }, linksFor(message[0].content));

  const { attachments } = await resolveClipParts(message, { providers, hints, apiKey: "k" });
  assert.equal(downloadCalls, 2);
  assert.equal(resolveCalls, 1);
  // The answer is the same one the unhinted path would have produced.
  assert.ok(attachments.get(TIKTOK_LINK)?.part);
  assert.equal(attachments.get(TIKTOK_LINK)?.error, undefined);
});

test("a hinted resolve is never written to the process-global clip cache", async () => {
  resetClipCache();
  let resolveCalls = 0;
  const providers = stubProvider(async () => {
    resolveCalls += 1;
    return resolvedVideo();
  });
  const hints = validateHints({ [TIKTOK_LINK]: hintFromResolved(resolvedVideo()) }, linksFor(message[0].content));

  await resolveClipParts(message, { providers, hints, apiKey: "k", cache: true });
  assert.equal(resolveCalls, 0);

  // The next request for the same link — a different user on the same warm instance — must
  // not be served bytes the previous caller named. It resolves for itself.
  await resolveClipParts(message, { providers, apiKey: "k", cache: true });
  assert.equal(resolveCalls, 1);
  resetClipCache();
});

test("a resolve we did ourselves is still cached", async () => {
  resetClipCache();
  let resolveCalls = 0;
  const providers = stubProvider(async () => {
    resolveCalls += 1;
    return resolvedVideo();
  });

  await resolveClipParts(message, { providers, apiKey: "k", cache: true });
  await resolveClipParts(message, { providers, apiKey: "k", cache: true });
  assert.equal(resolveCalls, 1);
  resetClipCache();
});
