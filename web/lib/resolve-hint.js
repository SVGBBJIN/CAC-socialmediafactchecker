// Carrying a resolve across two serverless functions, through the only thing they share:
// the browser.
//
// Intake verifies a pasted link by calling /api/resolve-media, which runs the platform's
// real resolve — an embed page for TikTok, a post query for Instagram. Moments later the
// user hits Check, /api/chat runs, and `resolveClipParts` resolves the same link all over
// again. Two round trips to the platform for one answer.
//
// The obvious fix — a cache both routes read — does not work here, and fails in the worst
// way. api/chat.js and api/resolve-media.js are built as *separate* Vercel functions, so a
// module-level Map in a shared lib/ file gives each of them its own copy. It would work
// perfectly in `node server.js`, where both handlers live in one process, and silently do
// nothing in production. That is the same trap web/README.md already documents for the
// rate-limit counters.
//
// So the resolve travels with the request instead: the client is handed the result it
// already paid for and hands it back when it asks for the check. The server treats it as a
// hint, never as truth — the download re-validates the host exactly as it always has, and
// any failure discards the hint and resolves properly. A stale or malicious hint therefore
// costs a wasted attempt and produces the same answer, never a wrong one.
//
// Two rules make that hold, and both are load-bearing:
//
//   1. `referer` is not carried. It is the one field that becomes an outbound request
//      header, and a client-set header on our fetch to someone's CDN is not a thing to
//      allow. The downloaders already treat it as optional, and if a CDN ever starts
//      requiring it the hinted download fails, re-resolves, and succeeds with the real
//      one — so dropping it costs nothing and needs no second copy of each platform's
//      referer rule.
//
//   2. A hinted resolve is never written to the clip cache. That cache is process-global
//      and shared by every request a warm instance serves, so caching client-supplied data
//      would let one user's crafted hint be served to the next person who pastes the same
//      link. See `resolveClipParts`, which is where the rule is actually enforced.

import { ALLOWED_MEDIA_HOSTS as TIKTOK_MEDIA_HOSTS } from "./tiktok.js";
import { ALLOWED_MEDIA_HOSTS as INSTAGRAM_MEDIA_HOSTS } from "./instagram.js";
import { hostAllowed } from "./media-fetch.js";

/** Which CDN families each platform's media may name. The downloaders' own lists. */
const MEDIA_HOSTS = {
  TikTok: TIKTOK_MEDIA_HOSTS,
  Instagram: INSTAGRAM_MEDIA_HOSTS,
};

/** What a clip or a slide may claim to be. Anything else is not something we attach. */
const MIME_TYPES = new Set(["video/mp4", "image/jpeg", "image/png", "image/webp"]);

/** Matches the cap `describeClip` already applies to a server-resolved caption. */
const MAX_CAPTION_CHARS = 500;
const MAX_AUTHOR_CHARS = 120;

/** A photo post is a handful of stills; past this it is not a shape we produced. */
const MAX_SLIDES = 40;

/** Bounds the whole payload — a hint is metadata, and metadata does not run long. */
export const MAX_HINTS = 4;

/**
 * The wire shape, built from a resolve we did ourselves.
 *
 * Deliberately not the whole `resolved` object. What is left out is as much the point as
 * what is kept: `referer` for the reason above, and `sourceURL` because the server already
 * knows the link — it is the text in the message — and re-deriving it there means the one
 * field that names the post to the model can never be set by the caller.
 */
export function hintFromResolved(resolved) {
  if (!resolved || typeof resolved !== "object") return null;

  const common = {
    videoID: resolved.videoID ?? null,
    mimeType: resolved.mimeType ?? null,
    caption: resolved.caption ?? null,
    authorName: resolved.authorName ?? null,
    width: resolved.width ?? null,
    height: resolved.height ?? null,
  };

  if (resolved.kind === "images") {
    return {
      ...common,
      kind: "images",
      slideCount: resolved.slideCount ?? resolved.images?.length ?? 0,
      images: (resolved.images ?? []).map((image) => ({
        url: image.url,
        width: image.width ?? null,
        height: image.height ?? null,
      })),
    };
  }

  return {
    ...common,
    kind: "video",
    mediaURL: resolved.mediaURL,
    duration: resolved.duration ?? null,
  };
}

function boundedString(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An https URL on one of `allowed`, or null. The same check the downloader will redo. */
function vettedMediaURL(raw, allowed) {
  if (typeof raw !== "string" || !raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return hostAllowed(url.hostname, allowed) ? url.toString() : null;
}

/**
 * One untrusted hint → a `resolved` the clip pipeline can use, or `null`.
 *
 * Fails closed and fails silently on anything unexpected. A rejected hint is not an error
 * worth telling anyone about: it means the check resolves the link itself, which is what
 * it did before any of this existed, so the only cost of being wrong here is latency.
 *
 * `sourceURL` is stamped from `link` rather than read from the payload — see
 * `hintFromResolved`.
 */
export function validateHint(raw, { platform, link }) {
  const allowed = MEDIA_HOSTS[platform];
  if (!allowed || !raw || typeof raw !== "object") return null;

  // Checked at its real length rather than trimmed to fit. Truncating free text is fine —
  // a shortened caption is still that caption — but an identifier that has been cut is a
  // *different* identifier, and this one keys both the per-request dedupe and the clip
  // cache. Too long is malformed, not something to make fit.
  const videoID = typeof raw.videoID === "string" ? raw.videoID.trim() : "";
  if (!videoID || videoID.length > 64 || !/^[A-Za-z0-9_-]+$/.test(videoID)) return null;

  const mimeType = boundedString(raw.mimeType, 40);
  if (!mimeType || !MIME_TYPES.has(mimeType)) return null;

  const common = {
    sourceURL: link,
    videoID,
    mimeType,
    caption: boundedString(raw.caption, MAX_CAPTION_CHARS),
    authorName: boundedString(raw.authorName, MAX_AUTHOR_CHARS),
    width: finiteNumber(raw.width),
    height: finiteNumber(raw.height),
  };

  if (raw.kind === "images") {
    const source = Array.isArray(raw.images) ? raw.images : [];
    if (source.length === 0 || source.length > MAX_SLIDES) return null;
    const images = [];
    for (const image of source) {
      const url = vettedMediaURL(image?.url, allowed);
      // All or nothing: a post is its whole sequence, and quietly attaching the slides
      // that happened to pass would change what the model is looking at.
      if (!url) return null;
      images.push({ url, width: finiteNumber(image?.width), height: finiteNumber(image?.height) });
    }
    return {
      ...common,
      kind: "images",
      images,
      slideCount: images.length,
      duration: null,
    };
  }

  if (raw.kind !== "video") return null;
  const mediaURL = vettedMediaURL(raw.mediaURL, allowed);
  if (!mediaURL) return null;

  return { ...common, kind: "video", mediaURL, duration: finiteNumber(raw.duration) };
}

/**
 * The `clipHints` field off a request body → the map `resolveClipParts` takes.
 *
 * Keyed `platform:link`, matching the clip cache's own key, so the two are interchangeable
 * at the point of use. Entries whose link isn't one the message actually mentions are
 * dropped: a hint is an answer to a question the request is already asking, and one that
 * names a link nobody pasted has nothing to attach itself to.
 *
 * @param links the links found in the message, as `findClipLinks` returns them.
 */
export function validateHints(raw, links) {
  const hints = new Map();
  if (!raw || typeof raw !== "object") return hints;

  const byLink = new Map(links.map(({ link, provider }) => [link, provider.platform]));
  let seen = 0;
  for (const [link, payload] of Object.entries(raw)) {
    if (seen >= MAX_HINTS) break;
    seen += 1;
    const platform = byLink.get(link);
    if (!platform) continue;
    const resolved = validateHint(payload, { platform, link });
    if (resolved) hints.set(`${platform}:${link}`, resolved);
  }
  return hints;
}
