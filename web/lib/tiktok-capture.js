// TikTok → an MP4 the model can watch, via TikTok's own oEmbed embed player.
//
// This is the *primary* TikTok path. lib/tiktok.js — resolve the embed page's internal
// `__FRONTITY_CONNECT_STATE__` blob to a direct CDN URL and download it — is now the
// fallback, used only when this fails. The reason for the swap is legal/ToS posture, not
// reliability: that blob is undocumented internal state a page serves to its own iframe,
// and reading it is scraping regardless of how cleanly the parser is written. oEmbed is
// TikTok's published, documented integration point for exactly this use — a third party
// showing a TikTok post — and rendering it in a real browser and capturing what plays is
// using that integration point as designed, not reverse-engineering around it.
//
// ## How this works
//
// 1. `GET /oembed?url=...` — the *real*, documented oEmbed endpoint. Returns `html`: a
//    `<blockquote>` plus `<script src=".../embed.js">`. This is what any site embedding a
//    TikTok post runs verbatim.
// 2. That HTML is rendered in a headless browser, on a page whose origin is
//    `https://www.tiktok.com` — `embed.js` checks the parent origin before it will
//    hydrate, the same constraint noted for the Swift capture path's `WebViewEmbedRenderer`
//    (see docs/EXTRACTION_PIPELINE.md). We can't literally be served by tiktok.com, so a
//    request interception answers the top-level navigation with our HTML while every other
//    request — `embed.js`, the iframe it builds, the video it plays — goes over the real
//    network. The browser's own same-origin checks see `location.origin ===
//    "https://www.tiktok.com"` regardless.
// 3. `embed.js` builds an iframe pointed at `tiktok.com/embed/v2/<id>` and that page's
//    player hydrates a normal `<video>` element — the same one a visitor would watch.
// 4. Inside the page: `video.captureStream()` gives a `MediaStream` carrying the decoded
//    video *and audio* tracks, exactly as the element is playing them.
//    `MediaRecorder` records that stream to a WebM `Blob`, which is read back out as
//    base64 and decoded into a `Buffer` on the Node side.
//
// **This has not been run against the live site.** A sandboxed spike run while writing
// this hit a network-layer TLS reset against TikTok from inside a proxied dev environment
// before it could confirm step 4 — so whether the embed's `<video>` actually exposes an
// audio track to `captureStream()` is unconfirmed. `captureStream()`/`MediaRecorder` on an
// `HTMLMediaElement` is a standard, broadly-supported browser API and TikTok's embed
// player is an ordinary `<video>` tag, so there is no *known* reason this shouldn't work —
// but "no known reason" is exactly what lib/tiktok.js's own header warns against trusting
// for anything TikTok-embed-shaped. Run one real capture against a real deployment before
// trusting this in production.
//
// ## What this costs that the fallback didn't
//
// **Real-time, not network-speed.** A `MediaRecorder` records a stream no faster than it
// plays, so a 45-second clip takes at least 45 seconds to capture — the fallback path's
// download took as long as the file's *size* implied, typically single-digit seconds. On
// a platform with a request timeout (Vercel: 10s Hobby / 60s Pro / up to 900s only on
// Enterprise), this puts a hard ceiling on supportable clip length that the fallback did
// not have. `MAX_CAPTURE_MS` is the enforced version of that ceiling.
//
// **A browser in the request path.** Headless Chromium is not a small dependency, and does
// not ship with the platform by default the way `fetch` does. `resolveChromiumExecutable`
// below is the seam: locally it expects a Chromium binary at `PLAYWRIGHT_CHROMIUM_PATH`,
// and on a serverless platform it expects a slimmed serverless-compatible build (e.g.
// `@sparticuz/chromium`) to be installed and resolvable — loaded dynamically so a
// deployment that only needs the fallback path isn't forced to ship a browser at all.

import {
  tikTokVideoID,
  isTikTokShortLink,
  USER_AGENT,
  resolveTikTokVideo,
  downloadTikTokMedia,
} from "./tiktok.js";

/** TikTok's real, documented oEmbed endpoint — the whole point of this module. */
const OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";

/** Longest we'll wait for the embed to load and its player to report ready. */
export const EMBED_LOAD_TIMEOUT_MS = 20_000;

/**
 * Longest a capture is allowed to run, in milliseconds.
 *
 * Recording is real-time (see file header), so this is also, approximately, the longest
 * clip this path can support end to end. Set comfortably under a 60-second (Vercel Pro)
 * function budget once the embed load and Gemini call also have to fit in the same
 * request. A clip that runs past this is cut off rather than left to blow the deadline
 * silently; `TikTokCaptureError` names it so the caller can fall back rather than fail.
 */
export const MAX_CAPTURE_MS = 45_000;

/** Same ceiling `lib/tiktok.js` uses — captured bytes are held in memory the same way. */
export const MAX_CAPTURE_BYTES = 48 * 1024 * 1024;

export class TikTokCaptureError extends Error {
  constructor(message, { kind = "capture", retryable = false } = {}) {
    super(message);
    this.name = "TikTokCaptureError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

/* ---------------- Step 1: resolve via the real oEmbed endpoint ---------------- */

/**
 * A short link carries no ID at all — only the redirect knows it. Mirrors
 * `followShortLink` in lib/tiktok.js exactly, duplicated rather than imported so this
 * module never has to import the state-blob parser it exists to avoid depending on.
 */
async function followShortLink(urlString, { fetchImpl, signal, timeoutMs }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(urlString, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
      credentials: "omit",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TikTokCaptureError(`Could not follow the TikTok short link: ${error.message}`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  await response.body?.cancel?.().catch(() => {});
  const id = tikTokVideoID(response.url);
  if (!id) {
    throw new TikTokCaptureError("That TikTok short link doesn't point to a video.", {
      kind: "notAVideo",
    });
  }
  return { videoID: id, canonicalURL: response.url };
}

/**
 * URL → video ID, canonical URL and the oEmbed payload — everything needed to render the
 * embed. Cheap and read-only: one redirect follow (short links only) plus one GET against
 * TikTok's documented oEmbed endpoint. No internal state blob, no CDN URL, nothing this
 * path wouldn't do if it only ever showed a title and thumbnail.
 */
export async function resolveTikTokEmbed(
  urlString,
  { fetchImpl = fetch, signal, timeoutMs = EMBED_LOAD_TIMEOUT_MS } = {},
) {
  let videoID = tikTokVideoID(urlString);
  let canonicalURL = urlString;
  if (!videoID) {
    if (!isTikTokShortLink(urlString)) {
      throw new TikTokCaptureError("That link doesn't point to a TikTok video.", {
        kind: "notAVideo",
      });
    }
    const followed = await followShortLink(urlString, { fetchImpl, signal, timeoutMs });
    videoID = followed.videoID;
    canonicalURL = followed.canonicalURL;
  }

  let response;
  try {
    response = await fetchImpl(`${OEMBED_ENDPOINT}?url=${encodeURIComponent(canonicalURL)}`, {
      signal,
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      credentials: "omit",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TikTokCaptureError(`Could not reach TikTok's oEmbed endpoint: ${error.message}`, {
      retryable: true,
    });
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 404) {
      throw new TikTokCaptureError("TikTok has no video at that link — it may have been removed.", {
        kind: "unavailable",
      });
    }
    throw new TikTokCaptureError(`TikTok's oEmbed endpoint failed (HTTP ${response.status}).`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new TikTokCaptureError("TikTok's oEmbed endpoint returned unexpected data.", {
      kind: "malformed",
    });
  }

  if (typeof json?.html !== "string" || !json.html.includes("tiktok-embed")) {
    throw new TikTokCaptureError("TikTok's oEmbed endpoint returned no embeddable player.", {
      kind: "malformed",
    });
  }

  return {
    sourceURL: canonicalURL,
    videoID,
    embedHTML: json.html,
    authorName: typeof json.author_name === "string" ? json.author_name : null,
    // Named `caption` rather than `title` to match the field `describeClip` in
    // lib/gemini.js already reads off every other provider's resolved shape.
    caption: typeof json.title === "string" ? json.title : null,
    thumbnailURL: typeof json.thumbnail_url === "string" ? json.thumbnail_url : null,
  };
}

/* ---------------- Step 2: render the embed and capture what plays ---------------- */

/**
 * Where to find a Chromium binary to launch.
 *
 * Checked in order:
 * 1. `PLAYWRIGHT_CHROMIUM_PATH` — an explicit path, for local dev against a manually
 *    installed browser.
 * 2. `@sparticuz/chromium` — a slimmed, serverless-packaged Chromium build. Loaded
 *    dynamically so a deployment that never calls this function isn't forced to install
 *    a browser at all; `web/package.json` lists it as an optional dependency for exactly
 *    that reason.
 *
 * Neither found is a configuration error, not a capture failure — thrown as
 * `TikTokCaptureError({kind: "unconfigured"})` so the caller falls back rather than
 * retries something that will never succeed without an operator fixing the deployment.
 *
 * `loadSparticuz` is an injection seam for tests: it defaults to the real dynamic import,
 * which — once `@sparticuz/chromium` is installed at all — always succeeds regardless of
 * `env`, making "neither is configured" otherwise untestable without actually uninstalling
 * a package.
 */
export async function resolveChromiumExecutable(
  env = process.env,
  loadSparticuz = () => import("@sparticuz/chromium"),
) {
  if (env.PLAYWRIGHT_CHROMIUM_PATH) return env.PLAYWRIGHT_CHROMIUM_PATH;
  try {
    const sparticuz = await loadSparticuz();
    return await sparticuz.default.executablePath();
  } catch {
    throw new TikTokCaptureError(
      "No Chromium executable configured for TikTok capture. Set PLAYWRIGHT_CHROMIUM_PATH " +
        "or install @sparticuz/chromium.",
      { kind: "unconfigured" },
    );
  }
}

/**
 * Renders `resolved.embedHTML` under a `https://www.tiktok.com` origin so `embed.js`
 * hydrates it, then records whatever the resulting `<video>` element plays — image and
 * audio together — via `captureStream()` + `MediaRecorder`, run from inside the page.
 *
 * `browserFactory` and `env` are injection seams for tests; left unset, this launches a
 * real headless Chromium via `playwright-core`, which callers must have installed.
 */
export async function captureTikTokEmbed(
  resolved,
  {
    signal,
    timeoutMs = EMBED_LOAD_TIMEOUT_MS,
    maxCaptureMs = MAX_CAPTURE_MS,
    maxBytes = MAX_CAPTURE_BYTES,
    browserFactory = defaultBrowserFactory,
    env = process.env,
    loadSparticuz,
  } = {},
) {
  if (signal?.aborted) throw new TikTokCaptureError("Aborted.", { kind: "aborted" });

  const executablePath = await (loadSparticuz
    ? resolveChromiumExecutable(env, loadSparticuz)
    : resolveChromiumExecutable(env));
  const browser = await browserFactory({ executablePath });

  try {
    const page = await browser.newPage();
    const onAbort = () => page.close().catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const hostPath = `/__seer_embed__/${resolved.videoID}`;
      await page.route(`**${hostPath}`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><body>${resolved.embedHTML}</body></html>`,
        }),
      );
      await page.goto(`https://www.tiktok.com${hostPath}`, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      const frameHandle = await page.waitForSelector("iframe", { timeout: timeoutMs }).catch(() => null);
      if (!frameHandle) {
        throw new TikTokCaptureError("TikTok's embed player never loaded.", { kind: "unavailable" });
      }
      const frame = await frameHandle.contentFrame();
      if (!frame) {
        throw new TikTokCaptureError("TikTok's embed iframe carried no accessible document.", {
          kind: "malformed",
        });
      }
      await frame.waitForSelector("video", { timeout: timeoutMs });

      const captured = await frame.evaluate(
        async ({ maxCaptureMs, maxBytes }) => {
          const video = document.querySelector("video");
          video.muted = false;
          video.volume = 1.0;
          try {
            await video.play();
          } catch (error) {
            return { error: `Could not start playback: ${error.message}` };
          }

          if (typeof video.captureStream !== "function") {
            return { error: "This browser build has no captureStream() support." };
          }
          const stream = video.captureStream();
          if (stream.getAudioTracks().length === 0) {
            return {
              error: "TikTok's embed player exposed no audio track to capture.",
              videoTracks: stream.getVideoTracks().length,
            };
          }

          const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
            ? "video/webm;codecs=vp9,opus"
            : "video/webm";
          const chunks = [];
          let bytesSoFar = 0;
          const recorder = new MediaRecorder(stream, { mimeType });
          const overLimit = new Promise((resolve) => {
            recorder.ondataavailable = (event) => {
              if (event.data.size === 0) return;
              bytesSoFar += event.data.size;
              chunks.push(event.data);
              if (bytesSoFar > maxBytes) resolve("overLimit");
            };
          });

          const stopped = new Promise((resolve) => (recorder.onstop = resolve));
          // A clip that loops or fails to report `ended` (both observed on other short-form
          // embeds) must not record forever; `duration` on a live-recorded clip's
          // `<video>` is `Infinity` until metadata settles, so this floor never fires early.
          const naturalEnd = new Promise((resolve) => video.addEventListener("ended", () => resolve("ended"), { once: true }));
          const ceiling = new Promise((resolve) => setTimeout(() => resolve("ceiling"), maxCaptureMs));

          recorder.start(250);
          const why = await Promise.race([naturalEnd, ceiling, overLimit]);
          if (recorder.state !== "inactive") recorder.stop();
          await stopped;

          const blob = new Blob(chunks, { type: mimeType });
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = "";
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
          }

          return {
            ok: true,
            reason: why,
            mimeType,
            base64: btoa(binary),
            duration: Number.isFinite(video.duration) ? video.duration : null,
          };
        },
        { maxCaptureMs, maxBytes },
      );

      if (captured.error) {
        throw new TikTokCaptureError(captured.error, { kind: "unavailable" });
      }
      const bytes = Buffer.from(captured.base64, "base64");
      if (bytes.length === 0) {
        throw new TikTokCaptureError("The capture produced no bytes.", { retryable: true });
      }
      if (bytes.length > maxBytes) {
        throw new TikTokCaptureError(
          `Captured clip is over the ${Math.round(maxBytes / 1_048_576)} MB limit.`,
          { kind: "tooLarge" },
        );
      }

      return {
        bytes,
        mimeType: captured.mimeType,
        duration: captured.duration ?? resolved.duration ?? null,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/** The real launcher, isolated so tests never import `playwright-core`. */
async function defaultBrowserFactory({ executablePath }) {
  const { chromium } = await import("playwright-core");
  return chromium.launch({
    executablePath,
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"],
  });
}

/* ---------------- Combined: the shape CLIP_PROVIDERS expects ---------------- */

/**
 * `resolve` for the `TikTok` entry in `lib/gemini.js`'s `CLIP_PROVIDERS` — see the note
 * there on why `resolve` and `download` are split. This is the metadata-only half:
 * `resolveTikTokEmbed` alone, oEmbed only, no browser launched yet.
 */
export async function resolveTikTokPrimary(urlString, options) {
  return resolveTikTokEmbed(urlString, options);
}

/**
 * `download` for the same entry: launch, render, capture — falling back to the old
 * embed-state-blob + CDN download (`lib/tiktok.js`) when capture fails.
 *
 * That fallback is a deliberate demotion, not a removal: `web/README.md` and
 * `docs/EXTRACTION_PIPELINE.md` documented the CDN-scrape path as the primary TikTok route
 * because it was faster and more reliable than the screen-capture path it replaced. Both
 * of those properties are still true of it relative to *this* path — network-speed rather
 * than real-time, no browser to launch — which is exactly why it's worth keeping as the
 * second attempt rather than deleting: a capture failure (embed didn't hydrate in time,
 * Chromium isn't configured on this deployment, the clip ran past `MAX_CAPTURE_MS`) still
 * has a real shot at reaching the model instead of falling straight to metadata-only.
 *
 * `resolved` here is `resolveTikTokPrimary`'s output — oEmbed metadata, no media URL — so
 * a fallback has to re-resolve via the old, state-blob-reading path before it can
 * download; that second resolve only ever runs once capture has already failed.
 */
export async function downloadTikTokWithFallback(resolved, options = {}) {
  try {
    return await captureTikTokEmbed(resolved, options);
  } catch (captureError) {
    if (options.signal?.aborted) throw captureError;
    try {
      const fallbackResolved = await resolveTikTokVideo(resolved.sourceURL, options);
      return await downloadTikTokMedia(fallbackResolved, options);
    } catch {
      // The capture error is the more informative one for a link that was never
      // capturable at all (region-blocked, private, removed); the fallback's own failure
      // is usually a repeat of the same underlying unavailability.
      throw captureError;
    }
  }
}
