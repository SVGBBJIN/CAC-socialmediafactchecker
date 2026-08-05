// node --test test-browser-resolve.js
//
// The browser-worker tier: when it fires, when it deliberately doesn't, and what happens to
// the original error when the worker can't help. No network — the worker is a stub function
// throughout, which is also the point of `browserResolveImpl` being injectable.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  browserWorkerFromEnv,
  browserResolve,
  worthEscalating,
  ESCALATED_KINDS,
} from "./lib/browser-resolve.js";
import { resolveClipParts, toGeminiContents } from "./lib/gemini.js";
import { findTikTokLinks, TikTokError } from "./lib/tiktok.js";

const VIDEO_ID = "6718335390845095173";
const SOURCE_URL = `https://www.tiktok.com/@scout2015/video/${VIDEO_ID}`;
const MEDIA_URL =
  "https://v16m.tiktokcdn-us.com/d838b2be25adb61a68f7fbe5d74e9f63/6a6ab84a/video/tos/x.mp4";

const WORKER = { url: "https://worker.example/", token: "s3cret" };

/** The wire shape the worker answers with — `hintFromResolved`'s, which is what it must be. */
function workerPayload(overrides = {}) {
  return {
    kind: "video",
    videoID: VIDEO_ID,
    mediaURL: MEDIA_URL,
    mimeType: "video/mp4",
    caption: "Scramble up ur name",
    authorName: "scout2015",
    duration: 10,
    width: 576,
    height: 1024,
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  };
}

/* ---------------- config ---------------- */

test("the tier is off unless a worker URL is set", () => {
  assert.equal(browserWorkerFromEnv({}), null);
  assert.equal(browserWorkerFromEnv({ BROWSER_WORKER_URL: "   " }), null);
  assert.equal(browserWorkerFromEnv({ BROWSER_WORKER_URL: "not a url" }), null);
});

test("a remote worker must be https, but a loopback one may be http", () => {
  // A token over plaintext is a token in the clear, so http is refused off-box.
  assert.equal(browserWorkerFromEnv({ BROWSER_WORKER_URL: "http://worker.example/" }), null);
  assert.ok(browserWorkerFromEnv({ BROWSER_WORKER_URL: "https://worker.example/" }));
  // Local development runs the worker on the same machine.
  assert.ok(browserWorkerFromEnv({ BROWSER_WORKER_URL: "http://127.0.0.1:8080/" }));
  assert.ok(browserWorkerFromEnv({ BROWSER_WORKER_URL: "http://localhost:8080/" }));
});

test("the token is optional and carried when present", () => {
  const bare = browserWorkerFromEnv({ BROWSER_WORKER_URL: "https://worker.example/" });
  assert.equal(bare.token, null);
  const withToken = browserWorkerFromEnv({
    BROWSER_WORKER_URL: "https://worker.example/",
    BROWSER_WORKER_TOKEN: " s3cret ",
  });
  assert.equal(withToken.token, "s3cret");
});

/* ---------------- which failures escalate ---------------- */

test("only failures a browser could plausibly get past are escalated", () => {
  for (const kind of ["rateLimited", "forbidden", "malformed", "upstream"]) {
    assert.ok(worthEscalating(new TikTokError("x", { kind })), `${kind} should escalate`);
  }
  // A private post is nothing a browser can see either; an expired URL is already repaired
  // over plain HTTP; a file that is too large does not get smaller in a browser.
  for (const kind of ["unavailable", "notAVideo", "tooLarge", "expired"]) {
    assert.equal(worthEscalating(new TikTokError("x", { kind })), false, `${kind} must not`);
  }
});

test("an unclassified error is not escalated", () => {
  assert.equal(worthEscalating(new Error("something went wrong")), false);
  assert.equal(worthEscalating(null), false);
  assert.equal(worthEscalating({ kind: "somethingNew" }), false, "new kinds opt in deliberately");
});

/* ---------------- the client ---------------- */

test("a worker answer is validated exactly as a client hint is", async () => {
  let seen = null;
  const resolved = await browserResolve(SOURCE_URL, {
    platform: "TikTok",
    worker: WORKER,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, { resolved: workerPayload() });
    },
  });

  assert.equal(seen.url, "https://worker.example/");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.authorization, "Bearer s3cret");
  assert.deepEqual(JSON.parse(seen.init.body), { url: SOURCE_URL, platform: "TikTok" });

  assert.equal(resolved.mediaURL, MEDIA_URL);
  assert.equal(resolved.videoID, VIDEO_ID);
  // Stamped from the link we already had, never read off the payload.
  assert.equal(resolved.sourceURL, SOURCE_URL);
  // The one field that would become an outbound header on our request to someone's CDN.
  assert.equal(resolved.referer, undefined);
});

test("a worker naming a host the platform doesn't serve from is rejected", async () => {
  const resolved = await browserResolve(SOURCE_URL, {
    platform: "TikTok",
    worker: WORKER,
    fetchImpl: async () =>
      jsonResponse(200, {
        resolved: workerPayload({ mediaURL: "https://tiktokcdn.com.evil.test/x.mp4" }),
      }),
  });
  assert.equal(resolved, null, "suffix match is on a dot boundary");
});

test("a worker answering for the wrong platform's CDN is rejected", async () => {
  // An Instagram request must not come back with a TikTok CDN URL: each platform's
  // allowlist is the one its own downloader will re-check against.
  const resolved = await browserResolve("https://www.instagram.com/reel/Cabc123/", {
    platform: "Instagram",
    worker: WORKER,
    fetchImpl: async () => jsonResponse(200, { resolved: workerPayload() }),
  });
  assert.equal(resolved, null);
});

test("a worker answering with an image set is rejected", async () => {
  // The worker resolves video posts only — a photo post's slide order is load-bearing and
  // it reads media off the network in fetch order, so it declines rather than guessing.
  // If one ever did answer with a carousel, the shape has to survive validation on its own
  // merits rather than because it came from us.
  const resolved = await browserResolve(SOURCE_URL, {
    platform: "TikTok",
    worker: WORKER,
    fetchImpl: async () =>
      jsonResponse(200, { resolved: workerPayload({ kind: "images", images: [] }) }),
  });
  assert.equal(resolved, null, "an empty slide set is not a post");
});

test("every worker failure is null rather than a throw", async () => {
  const cases = [
    ["a transport error", async () => { throw new Error("ECONNREFUSED"); }],
    ["a 502", async () => jsonResponse(502, { error: "resolve failed" })],
    ["a 404 miss", async () => jsonResponse(404, { error: "no media found" })],
    ["a body that isn't JSON", async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } })],
    ["an empty answer", async () => jsonResponse(200, {})],
  ];
  for (const [what, fetchImpl] of cases) {
    const resolved = await browserResolve(SOURCE_URL, {
      platform: "TikTok",
      worker: WORKER,
      fetchImpl,
    });
    assert.equal(resolved, null, what);
  }
});

test("no worker configured means no request at all", async () => {
  let called = false;
  const resolved = await browserResolve(SOURCE_URL, {
    platform: "TikTok",
    worker: null,
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, { resolved: workerPayload() });
    },
  });
  assert.equal(resolved, null);
  assert.equal(called, false);
});

/* ---------------- the tier, inside the clip pipeline ---------------- */

const messages = [{ role: "user", content: `check ${SOURCE_URL}` }];

function tikTokProvider(overrides) {
  return {
    platform: "TikTok",
    find: findTikTokLinks,
    matches: () => true,
    download: async () => ({ bytes: Buffer.from("mp4"), mimeType: "video/mp4" }),
    ...overrides,
  };
}

test("a throttled resolve is rescued by the worker", async () => {
  let escalated = 0;
  const clips = await resolveClipParts(messages, {
    providers: [
      tikTokProvider({
        resolve: async () => {
          throw new TikTokError("Instagram rate-limited the query.", { kind: "rateLimited" });
        },
      }),
    ],
    browserWorker: WORKER,
    browserResolveImpl: async () => {
      escalated += 1;
      return { ...workerPayload(), sourceURL: SOURCE_URL };
    },
  });

  assert.equal(escalated, 1);
  const entry = clips.attachments.get(SOURCE_URL);
  assert.equal(entry.error, undefined, "the rescue replaces the failure");
  assert.ok(entry.part.inline_data, "and the clip is attached as normal");
});

test("a resolve failure the browser can't help with never reaches the worker", async () => {
  let escalated = 0;
  const clips = await resolveClipParts(messages, {
    providers: [
      tikTokProvider({
        resolve: async () => {
          throw new TikTokError("That post is private.", { kind: "unavailable" });
        },
      }),
    ],
    browserWorker: WORKER,
    browserResolveImpl: async () => {
      escalated += 1;
      return { ...workerPayload(), sourceURL: SOURCE_URL };
    },
  });

  assert.equal(escalated, 0, "a private post is nothing a browser sees either");
  assert.match(clips.attachments.get(SOURCE_URL).error, /private/);
});

test("a worker that can't help leaves the original error intact", async () => {
  const clips = await resolveClipParts(messages, {
    providers: [
      tikTokProvider({
        resolve: async () => {
          throw new TikTokError("TikTok embed state was not the expected JSON", {
            kind: "malformed",
          });
        },
      }),
    ],
    browserWorker: WORKER,
    browserResolveImpl: async () => null,
  });

  const entry = clips.attachments.get(SOURCE_URL);
  // The user is told about their link, not about our infrastructure.
  assert.match(entry.error, /embed state was not the expected JSON/);
  const contents = toGeminiContents(messages, { clips });
  assert.doesNotMatch(contents[0].parts[0].text, /worker|browser/i);
});

test("with no worker configured the pipeline behaves exactly as before", async () => {
  const clips = await resolveClipParts(messages, {
    providers: [
      tikTokProvider({
        resolve: async () => {
          throw new TikTokError("TikTok rate-limited us.", { kind: "rateLimited" });
        },
      }),
    ],
  });
  assert.match(clips.attachments.get(SOURCE_URL).error, /rate-limited/);
});

test("a CDN that refuses the download is escalated too, and re-downloaded from the fresh URL", async () => {
  let downloads = 0;
  const clips = await resolveClipParts(messages, {
    providers: [
      tikTokProvider({
        resolve: async () => ({
          sourceURL: SOURCE_URL,
          videoID: VIDEO_ID,
          mediaURL: MEDIA_URL,
          mimeType: "video/mp4",
          kind: "video",
          caption: "Scramble up ur name",
          authorName: "scout2015",
        }),
        download: async (resolved) => {
          downloads += 1;
          if (downloads === 1) {
            throw new TikTokError("TikTok's CDN refused the download (HTTP 451).", {
              kind: "forbidden",
            });
          }
          assert.equal(resolved.mediaURL, `${MEDIA_URL}?fresh`, "downloads the worker's URL");
          return { bytes: Buffer.from("mp4"), mimeType: "video/mp4" };
        },
      }),
    ],
    browserWorker: WORKER,
    browserResolveImpl: async () => ({
      ...workerPayload({ mediaURL: `${MEDIA_URL}?fresh` }),
      sourceURL: SOURCE_URL,
    }),
  });

  assert.equal(downloads, 2);
  assert.ok(clips.attachments.get(SOURCE_URL).part.inline_data);
});

test("an expired URL is still repaired over plain HTTP, without spending a browser", async () => {
  let escalated = 0;
  let resolves = 0;
  let downloads = 0;
  const clips = await resolveClipParts(messages, {
    providers: [
      tikTokProvider({
        resolve: async () => {
          resolves += 1;
          return {
            sourceURL: SOURCE_URL,
            videoID: VIDEO_ID,
            mediaURL: resolves === 1 ? MEDIA_URL : `${MEDIA_URL}?fresh`,
            mimeType: "video/mp4",
            kind: "video",
          };
        },
        download: async () => {
          downloads += 1;
          if (downloads === 1) {
            throw new TikTokError("expired", { kind: "expired" });
          }
          return { bytes: Buffer.from("mp4"), mimeType: "video/mp4" };
        },
      }),
    ],
    browserWorker: WORKER,
    browserResolveImpl: async () => {
      escalated += 1;
      return null;
    },
  });

  assert.equal(resolves, 2, "the cheap HTTP re-resolve is what fixes an expiry");
  assert.equal(escalated, 0, "so the browser is never asked");
  assert.ok(clips.attachments.get(SOURCE_URL).part.inline_data);
});

test("the worker is not asked once the clip budget has gone", async () => {
  let escalated = 0;
  const clips = await resolveClipParts(messages, {
    providers: [
      tikTokProvider({
        resolve: async () => {
          throw new TikTokError("throttled", { kind: "rateLimited" });
        },
      }),
    ],
    // Already expired by the time the resolve fails.
    budgetMs: 1,
    browserWorker: WORKER,
    browserResolveImpl: async () => {
      escalated += 1;
      return { ...workerPayload(), sourceURL: SOURCE_URL };
    },
  });

  assert.equal(escalated, 0, "escalating past the budget turns a fast failure into a slow one");
  assert.ok(clips.attachments.get(SOURCE_URL).error);
});

test("ESCALATED_KINDS is the whole contract, and it is a closed set", () => {
  // Guards against a kind being added to a platform module and silently starting to spend
  // browser time, or against this set quietly growing to "everything".
  assert.deepEqual(
    [...ESCALATED_KINDS].sort(),
    ["forbidden", "malformed", "rateLimited", "upstream"],
  );
});
