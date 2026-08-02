// Instagram → an MP4 the model can watch.
//
// Same job as lib/tiktok.js, and deliberately the same interface, so `resolveClipParts`
// in gemini.js treats the two platforms as one kind of thing: a link goes in, a resolved
// clip and then bytes come out. What differs is only *where* the media URL is found.
//
// ## Why this route, and not the two obvious ones
//
// docs/SPIKE-instagram.md ruled out the documented paths and left Instagram unshipped:
//
//   - the legacy `api.instagram.com/oembed` endpoint is retired (500);
//   - `graph.facebook.com/…/instagram_oembed` answers without a token, but what it returns
//     is the *loading placeholder* blockquote — no author, no thumbnail, no media. Making
//     it return anything real needs an App access token with `oembed_read`, which needs a
//     Meta app that has passed App Review. And even then oEmbed carries an embed, not a
//     file: the clip would still have to be screen-recorded to be watched.
//
// The spike closed by asking one question — *does Instagram's embed iframe expose a media
// URL the way TikTok's does?* — and the answer, re-tested on 2026-08-02, is **no**:
// `/reel/<shortcode>/embed/captioned/` returns 200 to an anonymous request but ships a
// React shell with no media in it. `/api/v1/media/<pk>/info/` redirects to login, and
// `i.instagram.com`'s equivalent answers `login_required`.
//
// What *does* work anonymously is the query instagram.com's own web client runs to render
// a post: a POST to `/graphql/query` with a `doc_id` and `{"shortcode": …}`, carrying a
// CSRF token from a plain GET of the homepage. That returns the full media object,
// including `video_url` — a signed CDN link that then serves the MP4 with no credential.
//
// Verified live on 2026-08-02 against three public reels: the query returned
// `xdt_shortcode_media` with `video_url`, and the CDN served `video/mp4` (6.2 MB and
// 9.9 MB clips) to a request carrying nothing but a browser user-agent.
//
// ## What that costs
//
// `doc_id` is not a documented API. It is a server-side query hash that Instagram rotates,
// and when it moves this stops working — so it is overridable from the environment
// (`INSTAGRAM_DOC_ID`) to make recovery a config change rather than a deploy, and every
// parse failure below is distinct and loud about which step stopped finding what it
// expected. Instagram also rate-limits anonymous traffic from datacenter IPs harder than
// TikTok does; a 401/429 is reported as retryable rather than as a broken link, because
// that is what it usually is.

import { fetchWithTimeout, hostAllowed, readCapped } from "./media-fetch.js";

/** Longest we'll wait for the query, and for the CDN to start sending the file. */
export const QUERY_TIMEOUT_MS = 15_000;
export const MEDIA_TIMEOUT_MS = 60_000;

/**
 * Ceiling on a clip we're willing to hold in memory and forward.
 *
 * Same number and same reasoning as TikTok's: this runs in a serverless function that
 * buffers the whole file and then base64-encodes a copy, so the real cost is roughly
 * double. Reels run longer than the average TikTok — up to three minutes — so this is the
 * limit a legitimate post is most likely to hit, and the message says so plainly.
 */
export const MAX_MEDIA_BYTES = 48 * 1024 * 1024;

/** The user-agent instagram.com's own web client sends. */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** The web client's public app id. Constant, and sent by every logged-out page load. */
const IG_APP_ID = "936619743392459";

const GRAPHQL_URL = "https://www.instagram.com/graphql/query";
const HOME_URL = "https://www.instagram.com/";

/**
 * The persisted query that returns a post by shortcode.
 *
 * Overridable without a deploy: when Instagram rotates this, the fix is one environment
 * variable, and the error thrown below names it. Comma-separated values are tried in
 * order, so a new id can be rolled out ahead of the old one being retired.
 */
export const DEFAULT_DOC_IDS = ["10015901848480474"];

export function configuredDocIDs(env = process.env) {
  const raw = String(env?.INSTAGRAM_DOC_ID ?? "").trim();
  if (!raw) return DEFAULT_DOC_IDS;
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : DEFAULT_DOC_IDS;
}

/**
 * Hosts we'll fetch media bytes from.
 *
 * The media URL is read out of Instagram's JSON, so without this the endpoint would fetch
 * whatever that JSON named — a general-purpose request proxy pointed at our own network,
 * reachable by anyone who can paste a link. `fbcdn.net` is here because Instagram media
 * has always been served from both families and the split is not ours to predict.
 *
 * Matched as domain suffixes, never as substrings, so `cdninstagram.com.evil.test` is not
 * a match. A rejected host is named in the error.
 */
export const ALLOWED_MEDIA_HOSTS = ["cdninstagram.com", "fbcdn.net"];

/**
 * An Instagram step that failed in a way worth telling the user about.
 *
 * Mirrors `TikTokError`: `kind` separates "this link will never work" from "try again",
 * and the caller drops the video and tells the model why either way.
 */
export class InstagramError extends Error {
  constructor(message, { kind = "upstream", retryable = false } = {}) {
    super(message);
    this.name = "InstagramError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

/* ---------------- URL shapes ---------------- */

/** Matched as a domain so a host like `instagram.com.evil.test` isn't treated as ours. */
export function isInstagramHost(hostname) {
  const bare = String(hostname ?? "").toLowerCase();
  return (
    bare === "instagram.com" ||
    bare.endsWith(".instagram.com") ||
    bare === "instagr.am" ||
    bare.endsWith(".instagr.am")
  );
}

/**
 * Shortcodes are base64url over the media's numeric id: letters, digits, `-` and `_`.
 *
 * Checked for shape rather than an exact length — 11 characters is today's norm, older
 * posts are shorter and nothing promises they stay put — which is also what keeps a path
 * segment like `explore` or a username from being read as one.
 */
function shortcodeShaped(candidate) {
  const raw = String(candidate ?? "");
  if (raw.length < 5 || raw.length > 30) return null;
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

/**
 * The post's shortcode, when the URL states it outright.
 *
 * Handles `/reel/<sc>/`, `/reels/<sc>/`, `/p/<sc>/`, `/tv/<sc>/` and the profile-prefixed
 * `/<username>/reel/<sc>/` form, with any tracking query (`?igsh=…`) ignored. Returns null
 * for share links, which have to be followed, and for profile or explore URLs, which name
 * no single post.
 */
export function instagramShortcode(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (!isInstagramHost(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  // `/share/…` is a redirect, not a post: it carries a code of its own that is not a
  // shortcode, and reading it as one would query for a post that doesn't exist.
  if (segments[0] === "share") return null;

  const kinds = new Set(["reel", "reels", "p", "tv"]);
  const at = segments.findIndex((segment) => kinds.has(segment.toLowerCase()));
  if (at === -1 || at + 1 >= segments.length) return null;
  return shortcodeShaped(segments[at + 1]);
}

/**
 * Share links that resolve to a real URL only by being followed.
 *
 * Instagram's share sheet now hands out `/share/…` URLs — `/share/reel/<code>`,
 * `/share/p/<code>`, or a bare `/share/<code>` — whose code is not the post's shortcode.
 */
export function isInstagramShortLink(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (!isInstagramHost(url.hostname)) return false;
  return url.pathname.split("/").filter(Boolean)[0] === "share";
}

/** Whether a URL is an Instagram link this module could do something with. */
export function isInstagramLink(urlString) {
  return instagramShortcode(urlString) !== null || isInstagramShortLink(urlString);
}

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;

/**
 * Every distinct Instagram link mentioned anywhere in a message, in first-seen order.
 *
 * Deduplicated by URL text rather than by shortcode, because a share link's shortcode
 * isn't known until it has been followed. The second, post-level dedupe happens after
 * resolution — see `resolveClipParts` in gemini.js.
 */
export function findInstagramLinks(text) {
  const found = [];
  const seen = new Set();
  for (const match of String(text).matchAll(URL_PATTERN)) {
    // Trailing punctuation from prose — "watch this: <url>." — is not part of the URL.
    const candidate = match[0].replace(/[.,;:!?)\]]+$/, "");
    if (!isInstagramLink(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}

/* ---------------- Session ---------------- */

/**
 * How long a seeded CSRF token is reused before a fresh one is fetched.
 *
 * The seed is a page load we pay for and Instagram counts. Reusing it matters: anonymous
 * traffic from a datacenter IP gets rate-limited quickly, and a seed per resolve doubles
 * the request count for no benefit — the token stays valid far longer than this.
 */
export const SESSION_TTL_MS = 10 * 60 * 1000;

/** Cookies worth echoing back. Everything else the homepage sets is for a logged-in app. */
const SESSION_COOKIES = new Set(["csrftoken", "mid", "ig_did", "datr"]);

let cachedSession = null;
let inFlightSession = null;

/** Drops the cached session, so the next resolve seeds a new one. Exported for tests. */
export function resetInstagramSession() {
  cachedSession = null;
  inFlightSession = null;
}

function readSetCookies(response) {
  const headers = response.headers;
  if (typeof headers?.getSetCookie === "function") return headers.getSetCookie();
  const raw = headers?.get?.("set-cookie");
  return raw ? [raw] : [];
}

/**
 * A GET of the homepage, for the cookies it sets.
 *
 * The GraphQL endpoint rejects a request with no CSRF token — it answers 403 with the
 * "Page Not Found" shell, which looks like a dead link and isn't one — so this runs first
 * and its token rides on every query.
 */
async function seedSession({ fetchImpl, signal, timeoutMs }) {
  let response;
  try {
    response = await fetchWithTimeout(HOME_URL, {
      fetchImpl,
      signal,
      timeoutMs,
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new InstagramError(`Could not reach Instagram: ${error.message}`, { retryable: true });
  }

  // We only wanted the headers; don't pull 600 KB of page down to throw it away.
  await response.body?.cancel?.().catch(() => {});

  const jar = new Map();
  for (const line of readSetCookies(response)) {
    for (const pair of String(line).split(/,(?=[^;,]+=)/)) {
      const [name, ...rest] = pair.split(";")[0].split("=");
      const key = name?.trim();
      if (key && SESSION_COOKIES.has(key)) jar.set(key, rest.join("=").trim());
    }
  }

  const csrfToken = jar.get("csrftoken");
  if (!csrfToken) {
    throw new InstagramError(
      "Instagram's homepage set no csrftoken cookie — the anonymous session shape has changed",
      { kind: "malformed" },
    );
  }

  return {
    csrfToken,
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
}

/**
 * The current session, seeding one if needed.
 *
 * Concurrent callers share a single seed rather than each fetching their own: two links in
 * one message resolve in parallel, and without this that is two homepage loads to obtain
 * two interchangeable tokens.
 */
async function session({ fetchImpl, signal, timeoutMs, refresh = false }) {
  if (refresh) resetInstagramSession();
  if (cachedSession && cachedSession.expiresAt > Date.now()) return cachedSession;
  if (!inFlightSession) {
    inFlightSession = seedSession({ fetchImpl, signal, timeoutMs })
      .then((seeded) => {
        cachedSession = seeded;
        return seeded;
      })
      .finally(() => {
        inFlightSession = null;
      });
  }
  return inFlightSession;
}

/* ---------------- Shortcode → media URL ---------------- */

const MAX_CAPTION_CHARS = 2000;

function captionOf(media) {
  const text = media?.edge_media_to_caption?.edges?.[0]?.node?.text;
  if (typeof text !== "string" || !text.trim()) return null;
  return text.trim().slice(0, MAX_CAPTION_CHARS);
}

/**
 * A post that is a carousel: the video, if one of its slides is a video.
 *
 * A mixed carousel is a normal thing to fact-check — a still frame plus the clip it came
 * from — so the first video slide is taken rather than declining the whole post.
 */
function videoChild(media) {
  const edges = media?.edge_sidecar_to_children?.edges ?? [];
  for (const edge of edges) {
    const node = edge?.node;
    if (typeof node?.video_url === "string" && node.video_url) return node;
  }
  return null;
}

/**
 * The GraphQL response → everything we need about the clip.
 *
 * Split out from the fetch so the parser can be tested against a real captured payload
 * without a network call — the payload is undocumented, and a fixture invented from
 * documentation would prove nothing.
 */
export function parseMediaResponse(payload, { shortcode, sourceURL }) {
  if (!payload || typeof payload !== "object") {
    throw new InstagramError("Instagram's response was not the expected JSON", {
      kind: "malformed",
    });
  }

  // `errors` with a null `data` is how a retired doc_id reports itself, and it is the
  // failure most likely to be waiting when this breaks — so it says what to do about it.
  const media = payload?.data?.xdt_shortcode_media;
  if (!media) {
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      const first = payload.errors[0]?.message || "unknown error";
      throw new InstagramError(
        `Instagram rejected the post query (${first}). The doc_id may have been rotated — ` +
          "set INSTAGRAM_DOC_ID to a current one.",
        { kind: "malformed" },
      );
    }
    // A well-formed answer carrying no post: deleted, private, or an account whose posts
    // are login-gated for logged-out viewers.
    throw new InstagramError(
      "Instagram returned no post for that link — it may be private, removed, or " +
        "viewable only when signed in.",
      { kind: "unavailable" },
    );
  }

  const source = typeof media.video_url === "string" && media.video_url ? media : videoChild(media);
  if (!source) {
    throw new InstagramError(
      media?.__typename === "XDTGraphSidecar"
        ? "That Instagram post is a carousel of stills — there's no video to fetch."
        : "That Instagram link is a photo post, not a video.",
      { kind: "notAVideo" },
    );
  }

  const duration = Number(source.video_duration ?? media.video_duration);
  const dimensions = source.dimensions ?? media.dimensions ?? {};
  const owner = media.owner ?? {};

  return {
    sourceURL,
    // The shortcode is the post's identity, and what the dedupe in gemini.js keys on: two
    // links to the same reel — share link and canonical — must not download twice.
    videoID: media.shortcode || shortcode,
    mediaURL: source.video_url,
    mimeType: "video/mp4",
    // Not required today — the CDN served the file without one — but instagram.com sends
    // it, and matching the player is the cheapest insurance against the CDN tightening up.
    referer: HOME_URL,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: typeof dimensions.width === "number" ? dimensions.width : null,
    height: typeof dimensions.height === "number" ? dimensions.height : null,
    authorName: owner.username || owner.full_name || null,
    caption: captionOf(media),
  };
}

/**
 * A share link carries no shortcode at all — only the redirect knows it. Fetch and read
 * where we landed; `fetch` follows redirects, so `response.url` is the canonical URL.
 */
async function followShareLink(urlString, { fetchImpl, signal, timeoutMs }) {
  let response;
  try {
    response = await fetchWithTimeout(urlString, {
      fetchImpl,
      signal,
      timeoutMs,
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      redirect: "follow",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new InstagramError(`Could not follow the Instagram share link: ${error.message}`, {
      retryable: true,
    });
  }

  await response.body?.cancel?.().catch(() => {});

  const shortcode = instagramShortcode(response.url);
  if (!shortcode) {
    throw new InstagramError("That Instagram share link doesn't point to a post.", {
      kind: "notAVideo",
    });
  }
  return shortcode;
}

/** One `doc_id` attempt. Separated so the caller can walk a list of them. */
async function queryPost(shortcode, docID, { fetchImpl, signal, timeoutMs, auth, sourceURL }) {
  const body = new URLSearchParams({
    doc_id: docID,
    variables: JSON.stringify({ shortcode }),
  });

  let response;
  try {
    response = await fetchWithTimeout(GRAPHQL_URL, {
      fetchImpl,
      signal,
      timeoutMs,
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/x-www-form-urlencoded",
        accept: "*/*",
        "x-ig-app-id": IG_APP_ID,
        "x-csrftoken": auth.csrfToken,
        cookie: auth.cookie,
        referer: `${HOME_URL}reel/${shortcode}/`,
      },
      body: body.toString(),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new InstagramError(`Could not reach Instagram: ${error.message}`, { retryable: true });
  }

  if (!response.ok) {
    // 401 and 429 both mean "not right now" rather than "not ever": Instagram throttles
    // anonymous traffic, and a shared IP hits that without the link being at fault.
    if (response.status === 401 || response.status === 429) {
      throw new InstagramError(
        "Instagram is rate-limiting anonymous requests right now — try that link again shortly.",
        { kind: "rateLimited", retryable: true },
      );
    }
    if (response.status === 403) {
      throw new InstagramError("Instagram refused the post query (HTTP 403).", {
        kind: "forbidden",
        retryable: true,
      });
    }
    throw new InstagramError(`Instagram's post query failed (HTTP ${response.status}).`, {
      retryable: response.status >= 500,
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new InstagramError("Instagram's response was not the expected JSON", {
      kind: "malformed",
    });
  }

  return parseMediaResponse(payload, { shortcode, sourceURL });
}

/**
 * Shared URL → the MP4 behind it, plus whatever metadata the post carried.
 *
 * No credential involved: the query runs as a logged-out visitor, which is the whole
 * reason this path exists rather than a Meta app and a screen recorder.
 */
export async function resolveInstagramVideo(
  urlString,
  { fetchImpl = fetch, signal, timeoutMs = QUERY_TIMEOUT_MS, docIDs = configuredDocIDs() } = {},
) {
  let shortcode = instagramShortcode(urlString);
  if (!shortcode) {
    if (!isInstagramShortLink(urlString)) {
      throw new InstagramError("That link doesn't point to an Instagram post.", {
        kind: "notAVideo",
      });
    }
    shortcode = await followShareLink(urlString, { fetchImpl, signal, timeoutMs });
  }

  let auth = await session({ fetchImpl, signal, timeoutMs });
  let lastError = null;

  for (const [index, docID] of docIDs.entries()) {
    for (const attempt of [0, 1]) {
      try {
        return await queryPost(shortcode, docID, {
          fetchImpl,
          signal,
          timeoutMs,
          auth,
          sourceURL: urlString,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        // A 403 on a token we cached ten minutes ago is most likely the token, not the
        // link: re-seed once and try the same query again before blaming Instagram.
        if (attempt === 0 && error?.kind === "forbidden") {
          auth = await session({ fetchImpl, signal, timeoutMs, refresh: true });
          continue;
        }
        break;
      }
    }
    // Only a rotated query is worth trying the next id for. "Private post" and "photo
    // post" are answers, and asking them again under a different id changes nothing.
    if (lastError?.kind !== "malformed" || index === docIDs.length - 1) break;
  }

  throw lastError ?? new InstagramError("Instagram returned nothing for that link.");
}

/* ---------------- CDN → bytes ---------------- */

const tooLarge = (message) => new InstagramError(message, { kind: "tooLarge" });

/** Fetch the file a `resolveInstagramVideo` result pointed at. */
export async function downloadInstagramMedia(
  resolved,
  { fetchImpl = fetch, signal, timeoutMs = MEDIA_TIMEOUT_MS, maxBytes = MAX_MEDIA_BYTES } = {},
) {
  let mediaURL;
  try {
    mediaURL = new URL(resolved.mediaURL);
  } catch {
    throw new InstagramError("Instagram gave back a media URL that isn't a URL.", {
      kind: "malformed",
    });
  }
  if (mediaURL.protocol !== "https:") {
    throw new InstagramError(`Refusing to fetch Instagram media over ${mediaURL.protocol}`, {
      kind: "malformed",
    });
  }
  if (!hostAllowed(mediaURL.hostname, ALLOWED_MEDIA_HOSTS)) {
    throw new InstagramError(
      `Refusing to fetch Instagram media from an unexpected host (${mediaURL.hostname}). ` +
        "If Instagram has moved its CDN, add the domain to ALLOWED_MEDIA_HOSTS in " +
        "web/lib/instagram.js.",
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
    throw new InstagramError(`Could not download the Instagram clip: ${error.message}`, {
      retryable: true,
    });
  }

  if (!response.ok) {
    // The CDN URL is signed and expires; a 403 here usually means the post was resolved
    // too long ago rather than that anything is wrong with the link.
    throw new InstagramError(`Instagram's CDN refused the download (HTTP ${response.status}).`, {
      retryable: true,
    });
  }
  if (!response.body) {
    throw new InstagramError("Instagram's CDN returned an empty response.", { retryable: true });
  }

  const bytes = await readCapped(response, maxBytes, tooLarge);
  if (bytes.length === 0) {
    throw new InstagramError("Instagram's CDN returned an empty file.", { retryable: true });
  }

  // Trust the server's type over the resolver's guess when it sends a usable one.
  const declared = response.headers?.get?.("content-type")?.split(";")[0]?.trim();
  const mimeType =
    declared && declared.includes("/") && declared !== "application/octet-stream"
      ? declared
      : resolved.mimeType;

  return { bytes, mimeType };
}
