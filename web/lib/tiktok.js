// TikTok → an MP4 the model can watch.
//
// An embed-page trick, a fixed set of URL shapes, and a "strict about the fields we need,
// permissive about the ones we don't" parse. The reasoning is below.
//
// ## Why this is not just another `file_data` part
//
// A YouTube link costs us nothing: we hand Gemini the watch URL and it fetches the video
// itself (see `toGeminiContents` in gemini.js). There is no equivalent for TikTok — the
// model will not go and get a TikTok post — so the bytes have to arrive in the request.
// That means this module does the work Gemini does for us on the YouTube path: find the
// video, fetch it, and hand back something attachable.
//
// TikTok's oEmbed endpoint is no help; it returns a `blockquote` that only becomes a
// video once TikTok's own JavaScript hydrates it. But what that script builds is an
// iframe pointed at `tiktok.com/embed/v2/<id>`, and that page is served to anonymous
// requests with its state inlined as JSON under `__FRONTITY_CONNECT_STATE__` — including
// a direct CDN URL for the MP4.
//
// ## What that costs
//
// `__FRONTITY_CONNECT_STATE__` is not a documented API, and it can change shape without
// notice. So every parse failure below is distinct and loud: when TikTok moves this, the
// error says which step stopped finding what it expected, which is the difference between
// a ten-minute fix and a re-investigation.
//
// Re-verified live on 2026-07-28 against `/embed/v2/6718335390845095173`: the embed page
// returned HTTP 200 to an anonymous request, the blob parsed at the documented path, and
// the extracted URL served a 3.2 MB `video/mp4` with no credential and no `Referer`.

import {
  fetchWithTimeout,
  fetchStream,
  hostAllowed,
  readCapped,
  downloadImageSet,
  StalledTransferError,
} from "./media-fetch.js";
import { withRetry, retryAfterMs } from "./retry.js";

/** Longest we'll wait for the embed page, and for the CDN to start sending the file. */
export const EMBED_TIMEOUT_MS = 15_000;
export const MEDIA_TIMEOUT_MS = 60_000;

/**
 * The same, per slide of a photo post. Shorter than a clip's, because a slide is a
 * few hundred KB rather than tens of MB — and a dozen of them are in flight.
 */
export const IMAGE_TIMEOUT_MS = 30_000;

/**
 * Slides retry less hard than a clip does: one repeat, on a short curve, inside a small
 * budget. A slide that won't come is skipped rather than failing the post, so spending a
 * clip's patience on each of twelve of them buys a worse trade than giving up early.
 */
export const IMAGE_RETRY = { retries: 1, baseMs: 400, maxMs: 2_000, budgetMs: 20_000 };

/**
 * Ceiling on a clip we're willing to hold in memory and forward.
 *
 * Short-form video is a few MB; a minute of it is tens. Anything far past that is a sign
 * the URL resolved to something other than a clip. Lower than the Swift downloader's
 * ceiling on purpose: this runs in a serverless function that buffers the whole file and
 * then base64-encodes a copy of it, so the real cost is roughly double the number below.
 */
export const MAX_MEDIA_BYTES = 48 * 1024 * 1024;

/**
 * Above this, the clip goes through the Files API instead of riding inline.
 *
 * `generateContent` caps the whole request at 20 MB and base64 costs about a third on
 * top, leaving room for the prompt. Same threshold as `DirectMediaExtractor`.
 */
export const INLINE_BYTE_LIMIT = 14 * 1024 * 1024;

/** TikTok serves the embed page differently to an obvious bot. The UA its iframe carries. */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const EMBED_BASE = "https://www.tiktok.com/embed/v2";

/** TikTok's real oEmbed endpoint — title, author, thumbnail. No video, see below. */
const OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";

/**
 * Hosts we'll fetch media bytes from.
 *
 * The media URL is read out of a third party's JSON blob, so without this the endpoint
 * would fetch whatever that blob names — a general-purpose request proxy pointed at our
 * own network, reachable by anyone who can paste a link. The embed page we read it from
 * is fixed (`www.tiktok.com`, path built from a digits-only ID), so this is the only
 * place an attacker-controlled URL enters.
 *
 * Matched as domain suffixes, never as substrings, so `tiktokcdn.com.evil.test` is not a
 * match. A rejected host is named in the error: if TikTok starts serving from a family
 * that isn't here, the fix is one line and the message says which line.
 */
export const ALLOWED_MEDIA_HOSTS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "tiktokcdn-in.com",
  "tiktokv.com",
  "tiktokv.us",
  "ttwstatic.com",
  "muscdn.com",
  "byteoversea.com",
];

/**
 * A TikTok step that failed in a way worth telling the user about.
 *
 * `kind` separates "this link will never work" from "try again": the caller drops the
 * video and tells the model why either way, but only the latter is worth a retry.
 */
export class TikTokError extends Error {
  constructor(message, { kind = "upstream", retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = "TikTokError";
    this.kind = kind;
    this.retryable = retryable;
    // What the server asked us to wait, when it said. `withRetry` prefers this over its
    // own backoff curve: a host that has published a number knows better than we do.
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * How hard each step tries again. Both are `withRetry` option bags — see lib/retry.js.
 *
 * The metadata steps are cheap and quick, so they retry on a short curve. The download is
 * neither, so its budget is what actually bounds it: three 60-second attempts would be
 * three minutes of silence, and `remainingMs` shrinks each attempt's own deadline to fit
 * what is left.
 */
export const RESOLVE_RETRY = { retries: 2, baseMs: 350, maxMs: 3_000, budgetMs: 25_000 };
export const MEDIA_RETRY = { retries: 2, baseMs: 600, maxMs: 5_000, budgetMs: 75_000 };

/**
 * Which failures are worth repeating *against the same URL*.
 *
 * Narrower than `error.retryable`, and deliberately so. A signed CDN URL that comes back
 * 403 has expired, and asking the same expired URL again is the one retry that cannot
 * possibly work — the fix is to resolve the post again for a fresh URL, which is the
 * caller's job (`resolveClipParts` in lib/gemini.js does it). It stays marked retryable so
 * that caller knows the link is fine and the URL isn't; it just isn't repeated here.
 */
const retryableInPlace = (error) => error?.retryable === true && error?.kind !== "expired";

/* ---------------- URL shapes ---------------- */

/**
 * Mirrors `Platform.detect(from:)`'s TikTok branch. Matched as a domain so a host like
 * `tiktok.com.evil.test` isn't treated as TikTok.
 */
export function isTikTokHost(hostname) {
  const bare = String(hostname ?? "").toLowerCase();
  return bare === "tiktok.com" || bare.endsWith(".tiktok.com");
}

/**
 * TikTok IDs are 19-digit snowflakes today, but were shorter in 2019 and there is no
 * guarantee they stay 19. Checked for shape — all digits, plausible length — rather than
 * an exact count, which would reject the platform's own oEmbed example.
 */
function numericID(candidate) {
  const raw = String(candidate ?? "");
  const trimmed = raw.endsWith(".html") ? raw.slice(0, -5) : raw;
  if (trimmed.length < 8 || trimmed.length > 25) return null;
  return /^[0-9]+$/.test(trimmed) ? trimmed : null;
}

/**
 * The numeric post ID, when the URL states it outright.
 *
 * Handles `/@user/video/<id>`, `/@user/photo/<id>`, `/embed/v2/<id>`, `/embed/<id>`,
 * `/v/<id>.html` and a bare `?item_id=`. Returns null only for short links, which have to
 * be followed before they name anything.
 *
 * ## `/photo/` is not a type signal
 *
 * This used to return null for any path containing `photo`, on the reasoning that a
 * photo-mode post is a slideshow of stills with no video to fetch — so declining early
 * gave the user "that isn't a video" instead of a confusing empty result.
 *
 * Both halves of that turned out to be wrong. The pipeline can read photo posts now (see
 * `parseEmbedPage`), so there is something to fetch. And the path never distinguished them
 * in the first place: TikTok serves `/video/<id>` and `/photo/<id>` interchangeably for the
 * same post, and which one a share sheet produces does not track what the post contains.
 * Verified on 2026-08-04 — `/@memezar/photo/7449708266168274208` resolves to an ordinary
 * video, with `imagePostInfo: null` and a populated `itemInfos.video.urls`. So a `/photo/`
 * URL was costing us real videos, not just slideshows.
 *
 * Only the payload says what a post is. This function returns an ID; `parseEmbedPage`
 * decides what the ID turned out to be.
 */
export function tikTokPostID(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (!isTikTokHost(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);

  const photoAt = segments.indexOf("photo");
  if (photoAt !== -1 && photoAt + 1 < segments.length) {
    const id = numericID(segments[photoAt + 1]);
    if (id) return id;
  }

  const videoAt = segments.findIndex((s) => s === "video" || s === "v");
  if (videoAt !== -1 && videoAt + 1 < segments.length) {
    const id = numericID(segments[videoAt + 1]);
    if (id) return id;
  }

  // /embed/v2/<id> and /embed/<id>
  const embedAt = segments.indexOf("embed");
  if (embedAt !== -1) {
    for (const candidate of segments.slice(embedAt + 1)) {
      const id = numericID(candidate);
      if (id) return id;
    }
  }

  const itemID = numericID(url.searchParams.get("item_id"));
  if (itemID) return itemID;

  return null;
}

/** Share links that resolve to a real URL only by being followed. */
export function isTikTokShortLink(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") return true;
  // The `www.tiktok.com/t/<code>` form is the same redirect with a longer host.
  return isTikTokHost(host) && url.pathname.split("/").filter(Boolean)[0] === "t";
}

/** Whether a URL is a TikTok link this module could do something with. */
export function isTikTokLink(urlString) {
  return tikTokPostID(urlString) !== null || isTikTokShortLink(urlString);
}

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;

/**
 * Every distinct TikTok link mentioned anywhere in a message, in first-seen order.
 *
 * Deduplicated by URL text rather than by video ID, because a short link's ID isn't known
 * until it has been followed. The second, ID-level dedupe happens after resolution — see
 * `resolveTikTokParts` in gemini.js, which is what stops a short link and its canonical
 * form from both being attached.
 */
export function findTikTokLinks(text) {
  const found = [];
  const seen = new Set();
  for (const match of String(text).matchAll(URL_PATTERN)) {
    // Trailing punctuation from prose — "watch this: <url>." — is not part of the URL.
    const candidate = match[0].replace(/[.,;:!?)\]]+$/, "");
    if (!isTikTokLink(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}

/* ---------------- Embed page → media URL ---------------- */

/**
 * Pulls the JSON out of `<script id="__FRONTITY_CONNECT_STATE__" …>{…}</script>`.
 *
 * Scanned by hand rather than with a regex: the blob is ~24 KB of JSON containing
 * arbitrary user text, and a lazy `.*?` spanning it is both slower and easier to get
 * subtly wrong than finding two delimiters.
 *
 * The name appears more than once on the page — the state blob is followed by bootstrap
 * code referring to `window.__FRONTITY_CONNECT_STATE__` — so every occurrence is tried
 * and the first whose script body actually opens a JSON object wins, rather than trusting
 * the first match to be the right one.
 */
export function extractStateBlob(html) {
  const marker = "__FRONTITY_CONNECT_STATE__";
  const text = String(html ?? "");
  let from = 0;

  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) return null;
    from = at + marker.length;

    // The opening tag continues past the id attribute; the body starts after `>`.
    const tagEnd = text.indexOf(">", from);
    if (tagEnd === -1) continue;
    const closing = text.indexOf("</script>", tagEnd);
    if (closing === -1) continue;

    const body = text.slice(tagEnd + 1, closing).trim();
    if (body.startsWith("{")) return body;
  }
}

/**
 * A photo-mode post's slides, or null if this post isn't one.
 *
 * `videoData.imagePostInfo.displayImages[]`, each carrying `{width, height, urlList}` —
 * captured live on 2026-08-04 from `/embed/v2/7553302113757990166` (2 slides) and
 * `/embed/v2/7240568259186019630` (16 slides). `urlList` holds the same image on two
 * mirror hosts (`p16-…` and `p19-common-sign.tiktokcdn-us.com`); the first is taken and
 * the rest are spares rather than extra slides, which is why they collapse to one URL here.
 *
 * Note the field is `imagePostInfo`, hanging off `videoData` beside `itemInfos` — *not*
 * the `imagePost` key TikTok's own Content Posting API documents. Those are two different
 * serialisations of the same post, and only this one appears on the embed route.
 */
function photoSlides(page) {
  const displayImages = page?.videoData?.imagePostInfo?.displayImages;
  if (!Array.isArray(displayImages) || displayImages.length === 0) return null;

  const slides = [];
  for (const image of displayImages) {
    const url = (image?.urlList ?? []).find((u) => typeof u === "string" && u.length > 0);
    if (!url) continue;
    slides.push({
      url,
      width: typeof image?.width === "number" ? image.width : null,
      height: typeof image?.height === "number" ? image.height : null,
    });
  }
  return slides.length > 0 ? slides : null;
}

/**
 * Embed page HTML → everything we need about the post.
 *
 * Split out from the fetch so the parser can be tested against a real captured payload
 * without a network call — which is the only way to know it works, given the payload is
 * undocumented and a fixture invented from the docs would prove nothing.
 *
 * Returns either a video post (`kind: "video"`, with `mediaURL`) or a photo-mode post
 * (`kind: "images"`, with `images[]`). Which one is decided here, by what the payload
 * actually carries, and never by the URL — see `tikTokPostID`.
 */
export function parseEmbedPage(html, { videoID, sourceURL }) {
  const blob = extractStateBlob(html);
  if (!blob) {
    throw new TikTokError(
      "TikTok embed page carried no __FRONTITY_CONNECT_STATE__ — the embed page shape has changed",
      { kind: "malformed" },
    );
  }

  let state;
  try {
    state = JSON.parse(blob);
  } catch {
    throw new TikTokError("TikTok embed state was not the expected JSON", { kind: "malformed" });
  }

  // The blob keys its payload by the route it rendered.
  const page = state?.source?.data?.[`/embed/v2/${videoID}`];
  if (!page) {
    throw new TikTokError(`TikTok embed state had no entry for /embed/v2/${videoID}`, {
      kind: "malformed",
    });
  }

  const item = page?.videoData?.itemInfos;
  if (!item) {
    // A valid page that carries no post at all: private, removed, or region-blocked.
    throw new TikTokError(
      "TikTok returned nothing for this link — it may be private, removed, or region-blocked",
      { kind: "unavailable" },
    );
  }

  const author = page?.videoData?.authorInfos;
  const caption = typeof item?.text === "string" && item.text.trim() ? item.text.trim() : null;
  const common = {
    sourceURL,
    videoID,
    // Not required today — the CDN served the files without one — but the embed player
    // sends it, and matching the player is the cheapest insurance against the CDN
    // tightening up.
    referer: "https://www.tiktok.com/",
    authorName: author?.nickName || author?.uniqueId || null,
    caption,
  };

  // Checked before the video branch, not after it: a photo post still carries an
  // `itemInfos.video`, it is just empty (`urls: []`, `duration: 0`). Reading the payload in
  // this order is what makes the *content* decide, rather than the URL that was pasted.
  const slides = photoSlides(page);
  if (slides) {
    const first = slides[0];
    return {
      ...common,
      kind: "images",
      mimeType: "image/jpeg",
      images: slides,
      slideCount: slides.length,
      duration: null,
      width: first.width,
      height: first.height,
    };
  }

  const raw = (item?.video?.urls ?? []).find((u) => typeof u === "string" && u.length > 0);
  if (!raw) {
    throw new TikTokError("TikTok listed no playable source for this post", {
      kind: "unavailable",
    });
  }

  const meta = item?.video?.videoMeta;
  return {
    ...common,
    kind: "video",
    mediaURL: raw,
    mimeType: "video/mp4",
    duration: typeof meta?.duration === "number" ? meta.duration : null,
    width: typeof meta?.width === "number" ? meta.width : null,
    height: typeof meta?.height === "number" ? meta.height : null,
  };
}

/**
 * A short link carries no ID at all — only the redirect knows it. Fetch and read where we
 * landed; `fetch` follows redirects, so `response.url` is the canonical URL.
 */
async function followShortLink(urlString, { fetchImpl, signal, timeoutMs }) {
  let response;
  try {
    response = await fetchWithTimeout(urlString, {
      fetchImpl,
      signal,
      timeoutMs,
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
      // No cookie jar, no auth header, ever — an unauthenticated request is the whole
      // reason this doesn't fall under TikTok's account-ToS terms as well as its scraping
      // ones. Explicit rather than merely "we never set one," so a future change can't
      // grow a session by accident.
      credentials: "omit",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TikTokError(`Could not follow the TikTok short link: ${error.message}`, {
      retryable: true,
    });
  }

  // We only wanted the final URL; don't pull a page down to throw it away.
  await response.body?.cancel?.().catch(() => {});

  const id = tikTokPostID(response.url);
  if (!id) {
    throw new TikTokError("That TikTok short link doesn't point to a video.", {
      kind: "notAVideo",
    });
  }
  return id;
}

/**
 * Shared URL → the MP4 behind it, plus whatever metadata the embed carried.
 *
 * No credential involved: the embed page is public, which is the whole reason this path
 * exists rather than a screen recorder.
 */
export async function resolveTikTokVideo(
  urlString,
  {
    fetchImpl = fetch,
    signal,
    timeoutMs = EMBED_TIMEOUT_MS,
    embedBase = EMBED_BASE,
    sleepImpl,
    retry = RESOLVE_RETRY,
  } = {},
) {
  const retryOptions = { ...retry, signal, sleepImpl, isRetryable: retryableInPlace };

  let videoID = tikTokPostID(urlString);
  if (!videoID && !isTikTokShortLink(urlString)) {
    throw new TikTokError("That link doesn't point to a TikTok video.", { kind: "notAVideo" });
  }

  if (!videoID) {
    videoID = await withRetry(
      () => followShortLink(urlString, { fetchImpl, signal, timeoutMs }),
      retryOptions,
    );
  }

  const html = await withRetry(
    () => fetchEmbedPage(videoID, { fetchImpl, signal, timeoutMs, embedBase }),
    retryOptions,
  );
  return parseEmbedPage(html, { videoID, sourceURL: urlString });
}

/** One go at the embed page. Everything about *repeating* it lives in the caller. */
async function fetchEmbedPage(videoID, { fetchImpl, signal, timeoutMs, embedBase }) {
  let response;
  try {
    response = await fetchWithTimeout(`${embedBase}/${encodeURIComponent(videoID)}`, {
      fetchImpl,
      signal,
      timeoutMs,
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      credentials: "omit",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TikTokError(`Could not reach TikTok: ${error.message}`, { retryable: true });
  }

  if (!response.ok) {
    // An unknown or deleted ID comes back as a 400 from the embed endpoint, not a 404.
    // Translate it, so the user is told the video isn't there rather than that TikTok
    // rejected our request.
    if (response.status === 400 || response.status === 404) {
      throw new TikTokError("TikTok has no video at that link — it may have been removed.", {
        kind: "unavailable",
      });
    }
    const throttled = response.status === 429;
    throw new TikTokError(`TikTok embed page failed (HTTP ${response.status}).`, {
      kind: throttled ? "rateLimited" : "upstream",
      retryable: response.status >= 500 || throttled || response.status === 408,
      retryAfterMs: throttled ? retryAfterMs(response) : null,
    });
  }

  return response.text();
}

/* ---------------- CDN → bytes ---------------- */

/**
 * The size ceiling is enforced as the bytes arrive rather than after the fact — see
 * `readCapped` in media-fetch.js. The Swift downloader checks it *after* its transport has
 * buffered the whole response, because that protocol has no streaming seam; `fetch` does.
 */
const tooLarge = (message) => new TikTokError(message, { kind: "tooLarge" });

/** Fetch the file a `resolveTikTokVideo` result pointed at. */
export async function downloadTikTokMedia(
  resolved,
  {
    fetchImpl = fetch,
    signal,
    timeoutMs = MEDIA_TIMEOUT_MS,
    maxBytes = MAX_MEDIA_BYTES,
    sleepImpl,
    retry = MEDIA_RETRY,
  } = {},
) {
  let mediaURL;
  try {
    mediaURL = new URL(resolved.mediaURL);
  } catch {
    throw new TikTokError("TikTok gave back a media URL that isn't a URL.", { kind: "malformed" });
  }
  if (mediaURL.protocol !== "https:") {
    throw new TikTokError(`Refusing to fetch TikTok media over ${mediaURL.protocol}`, {
      kind: "malformed",
    });
  }
  if (!hostAllowed(mediaURL.hostname, ALLOWED_MEDIA_HOSTS)) {
    throw new TikTokError(
      `Refusing to fetch TikTok media from an unexpected host (${mediaURL.hostname}). ` +
        "If TikTok has moved its CDN, add the domain to ALLOWED_MEDIA_HOSTS in web/lib/tiktok.js.",
      { kind: "malformed" },
    );
  }

  return withRetry(
    ({ remainingMs }) =>
      fetchMediaOnce(mediaURL, resolved, {
        fetchImpl,
        signal,
        maxBytes,
        // Never longer than what is left of the retry budget: an attempt allowed to run
        // its full minute after the budget has all but gone is how "three tries" becomes
        // three minutes of nothing.
        timeoutMs: Math.max(1_000, Math.min(timeoutMs, remainingMs || timeoutMs)),
      }),
    { ...retry, signal, sleepImpl, isRetryable: retryableInPlace },
  );
}

/**
 * Fetch every slide of a photo-mode post.
 *
 * Reuses `fetchMediaOnce` per slide, so an image gets the same deadline-over-the-body,
 * expiry classification and retry treatment a clip does — a photo post's URLs are signed
 * and short-lived exactly like a video's. The bounded, allowlisted loop around it is shared
 * with Instagram; see `downloadImageSet` in media-fetch.js for why a failed slide is
 * skipped rather than fatal.
 */
export async function downloadTikTokImages(
  resolved,
  {
    fetchImpl = fetch,
    signal,
    timeoutMs = IMAGE_TIMEOUT_MS,
    maxSlides,
    maxBytes,
    maxSetBytes,
    sleepImpl,
    retry = IMAGE_RETRY,
  } = {},
) {
  const images = resolved?.images ?? [];
  if (images.length === 0) {
    throw new TikTokError("That TikTok post listed no images.", { kind: "unavailable" });
  }

  return downloadImageSet(images, {
    signal,
    maxSlides,
    maxBytes,
    maxSetBytes,
    allowedHosts: ALLOWED_MEDIA_HOSTS,
    makeError: (message) => new TikTokError(message, { kind: "unavailable" }),
    fetchOne: (url, { maxBytes: slideBytes }) =>
      withRetry(
        ({ remainingMs }) =>
          fetchMediaOnce(url, resolved, {
            fetchImpl,
            signal,
            maxBytes: slideBytes,
            timeoutMs: Math.max(1_000, Math.min(timeoutMs, remainingMs || timeoutMs)),
          }),
        { ...retry, signal, sleepImpl, isRetryable: retryableInPlace },
      ),
  });
}

/** One go at the CDN. Everything about *repeating* it lives in the caller. */
async function fetchMediaOnce(mediaURL, resolved, { fetchImpl, signal, timeoutMs, maxBytes }) {
  let response;
  let release = () => {};
  try {
    // `fetchStream` rather than `fetchWithTimeout`: the deadline has to outlive the
    // headers here, because the headers are the fast part. See lib/media-fetch.js.
    ({ response, release } = await fetchStream(mediaURL.toString(), {
      fetchImpl,
      signal,
      timeoutMs,
      headers: {
        "user-agent": USER_AGENT,
        ...(resolved.referer ? { referer: resolved.referer } : {}),
      },
      credentials: "omit",
    }));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TikTokError(`Could not download the TikTok clip: ${error.message}`, {
      retryable: true,
    });
  }

  try {
    if (!response.ok) {
      // Signed CDN URLs expire; a 403 here usually means the embed page was read too long
      // ago rather than that anything is wrong with the link. Named as its own kind so the
      // caller resolves the post again for a fresh URL instead of asking a dead one twice.
      const expired = response.status === 403 || response.status === 410;
      const throttled = response.status === 429;
      throw new TikTokError(`TikTok's CDN refused the download (HTTP ${response.status}).`, {
        kind: expired ? "expired" : throttled ? "rateLimited" : "upstream",
        retryable: true,
        retryAfterMs: throttled ? retryAfterMs(response) : null,
      });
    }
    if (!response.body) {
      throw new TikTokError("TikTok's CDN returned an empty response.", { retryable: true });
    }

    let bytes;
    try {
      bytes = await readCapped(response, maxBytes, tooLarge);
    } catch (error) {
      if (signal?.aborted || error instanceof TikTokError) throw error;
      // A stalled transfer, or a socket that died partway through the file: the clip is
      // fine, the connection wasn't.
      throw new TikTokError(
        error instanceof StalledTransferError
          ? `TikTok's CDN stopped sending the clip — ${error.message}.`
          : `Could not download the TikTok clip: ${error.message}`,
        { retryable: true },
      );
    }
    if (bytes.length === 0) {
      throw new TikTokError("TikTok's CDN returned an empty file.", { retryable: true });
    }

    // Trust the server's type over the resolver's guess when it sends a usable one: the
    // resolver infers `video/mp4` from context, the CDN knows.
    const declared = response.headers?.get?.("content-type")?.split(";")[0]?.trim();
    const mimeType =
      declared && declared.includes("/") && declared !== "application/octet-stream"
        ? declared
        : resolved.mimeType;

    return { bytes, mimeType };
  } finally {
    release();
  }
}

/* ---------------- Metadata-only fallback ---------------- */

/**
 * TikTok's real oEmbed response for a share URL — title, author, thumbnail. No video in
 * it (see the file header: that's exactly why the embed-state trick exists), but the
 * embed page's CDN URL is signed and short-lived, and every so often it's already dead —
 * or the CDN host has moved — by the time `downloadTikTokMedia` gets to it. Rather than
 * fail the link outright, `resolveClipParts` calls this to give the model *something*:
 * the caption and creator TikTok is happy to hand an anonymous request no matter what.
 *
 * Best-effort: returns `null` on any failure instead of throwing, since this only ever
 * runs as a fallback after the real download already failed — a second error here isn't
 * worth surfacing over the first.
 */
export async function fetchTikTokOEmbed(
  urlString,
  { fetchImpl = fetch, signal, timeoutMs = EMBED_TIMEOUT_MS } = {},
) {
  let response;
  try {
    response = await fetchWithTimeout(`${OEMBED_ENDPOINT}?url=${encodeURIComponent(urlString)}`, {
      fetchImpl,
      signal,
      timeoutMs,
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      credentials: "omit",
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let json;
  try {
    json = await response.json();
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;

  const title = typeof json.title === "string" && json.title.trim() ? json.title.trim() : null;
  const authorName =
    typeof json.author_name === "string" && json.author_name.trim() ? json.author_name.trim() : null;
  const thumbnailURL = typeof json.thumbnail_url === "string" ? json.thumbnail_url : null;
  if (!title && !authorName && !thumbnailURL) return null;

  return { title, authorName, thumbnailURL };
}
