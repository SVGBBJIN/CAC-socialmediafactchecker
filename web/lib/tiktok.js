// TikTok → an MP4 the model can watch.
//
// Mirrors Sources/SeerCore/Media/TikTokMediaResolver.swift and MediaDownloader.swift:
// same embed-page trick, same URL shapes, same "strict about the fields we need,
// permissive about the ones we don't" parse. Read that file for the full reasoning; the
// short version is below.
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

/** Longest we'll wait for the embed page, and for the CDN to start sending the file. */
export const EMBED_TIMEOUT_MS = 15_000;
export const MEDIA_TIMEOUT_MS = 60_000;

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
  constructor(message, { kind = "upstream", retryable = false } = {}) {
    super(message);
    this.name = "TikTokError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

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
 * The numeric video ID, when the URL states it outright.
 *
 * Handles `/@user/video/<id>`, `/embed/v2/<id>`, `/embed/<id>`, `/v/<id>.html` and a bare
 * `?item_id=`. Returns null for short links, which have to be followed, and for
 * `/@user/photo/<id>` carousels, which have no video to fetch.
 */
export function tikTokVideoID(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (!isTikTokHost(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);

  // /@user/photo/<id> — a real post, but a slideshow of stills. Declining here gives the
  // user "that isn't a video" instead of a confusing empty result.
  if (segments.includes("photo")) return null;

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
  return tikTokVideoID(urlString) !== null || isTikTokShortLink(urlString);
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
 * Embed page HTML → everything we need about the clip.
 *
 * Split out from the fetch so the parser can be tested against a real captured payload
 * without a network call — which is the only way to know it works, given the payload is
 * undocumented and a fixture invented from the docs would prove nothing.
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
    // A valid page that carries no video: private, removed, region-blocked, or a
    // photo-carousel post rather than a video.
    throw new TikTokError(
      "TikTok returned no video for this link — it may be private, removed, or a photo post",
      { kind: "unavailable" },
    );
  }

  const raw = (item?.video?.urls ?? []).find((u) => typeof u === "string" && u.length > 0);
  if (!raw) {
    throw new TikTokError("TikTok listed no playable source for this video", {
      kind: "unavailable",
    });
  }

  const meta = item?.video?.videoMeta;
  const author = page?.videoData?.authorInfos;
  const caption = typeof item?.text === "string" && item.text.trim() ? item.text.trim() : null;

  return {
    sourceURL,
    videoID,
    mediaURL: raw,
    mimeType: "video/mp4",
    // Not required today — the CDN served the file without one — but the embed player
    // sends it, and matching the player is the cheapest insurance against the CDN
    // tightening up.
    referer: "https://www.tiktok.com/",
    duration: typeof meta?.duration === "number" ? meta.duration : null,
    width: typeof meta?.width === "number" ? meta.width : null,
    height: typeof meta?.height === "number" ? meta.height : null,
    authorName: author?.nickName || author?.uniqueId || null,
    caption,
  };
}

/** One fetch with a deadline, cleaned up on every exit path. */
async function fetchWithTimeout(url, { fetchImpl, timeoutMs, signal, ...init }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
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
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TikTokError(`Could not follow the TikTok short link: ${error.message}`, {
      retryable: true,
    });
  }

  // We only wanted the final URL; don't pull a page down to throw it away.
  await response.body?.cancel?.().catch(() => {});

  const id = tikTokVideoID(response.url);
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
  { fetchImpl = fetch, signal, timeoutMs = EMBED_TIMEOUT_MS, embedBase = EMBED_BASE } = {},
) {
  let videoID = tikTokVideoID(urlString);
  if (!videoID) {
    if (!isTikTokShortLink(urlString)) {
      throw new TikTokError("That link doesn't point to a TikTok video.", { kind: "notAVideo" });
    }
    videoID = await followShortLink(urlString, { fetchImpl, signal, timeoutMs });
  }

  let response;
  try {
    response = await fetchWithTimeout(`${embedBase}/${encodeURIComponent(videoID)}`, {
      fetchImpl,
      signal,
      timeoutMs,
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
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
    throw new TikTokError(`TikTok embed page failed (HTTP ${response.status}).`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  return parseEmbedPage(await response.text(), { videoID, sourceURL: urlString });
}

/* ---------------- CDN → bytes ---------------- */

function mediaHostAllowed(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return ALLOWED_MEDIA_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Read a response body, refusing to buffer past `maxBytes`.
 *
 * The Swift downloader checks the size *after* the transport has buffered the whole
 * response, because its transport protocol has no streaming seam. `fetch` does, so the
 * check happens here as the bytes arrive: an absurd file is abandoned mid-transfer rather
 * than downloaded in full and then rejected. That matters more in a serverless function,
 * where the buffer is charged against a fixed memory ceiling.
 */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new TikTokError(
      `That clip is ${Math.round(declared / 1_048_576)} MB, over the ` +
        `${Math.round(maxBytes / 1_048_576)} MB limit.`,
      { kind: "tooLarge" },
    );
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength ?? chunk.length ?? 0;
    if (total > maxBytes) {
      // Throwing out of `for await` cancels the underlying stream, so the rest of the
      // file is never pulled down.
      throw new TikTokError(
        `That clip is over the ${Math.round(maxBytes / 1_048_576)} MB limit.`,
        { kind: "tooLarge" },
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Fetch the file a `resolveTikTokVideo` result pointed at. */
export async function downloadTikTokMedia(
  resolved,
  { fetchImpl = fetch, signal, timeoutMs = MEDIA_TIMEOUT_MS, maxBytes = MAX_MEDIA_BYTES } = {},
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
  if (!mediaHostAllowed(mediaURL.hostname)) {
    throw new TikTokError(
      `Refusing to fetch TikTok media from an unexpected host (${mediaURL.hostname}). ` +
        "If TikTok has moved its CDN, add the domain to ALLOWED_MEDIA_HOSTS in web/lib/tiktok.js.",
      { kind: "malformed" },
    );
  }

  let response;
  try {
    response = await fetchWithTimeout(mediaURL.toString(), {
      fetchImpl,
      signal,
      timeoutMs,
      headers: {
        "user-agent": USER_AGENT,
        ...(resolved.referer ? { referer: resolved.referer } : {}),
      },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TikTokError(`Could not download the TikTok clip: ${error.message}`, {
      retryable: true,
    });
  }

  if (!response.ok) {
    // Signed CDN URLs expire; a 403 here usually means the embed page was read too long
    // ago rather than that anything is wrong with the link.
    throw new TikTokError(`TikTok's CDN refused the download (HTTP ${response.status}).`, {
      retryable: true,
    });
  }
  if (!response.body) {
    throw new TikTokError("TikTok's CDN returned an empty response.", { retryable: true });
  }

  const bytes = await readCapped(response, maxBytes);
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
}
