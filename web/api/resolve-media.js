// POST /api/resolve-media — the Library UI's video pane needs an actual MP4 for TikTok and
// Instagram, since neither has an iframe embed that plays for a logged-out visitor the way
// YouTube's does. This exposes the same resolution step /api/chat already does internally
// (see lib/tiktok.js and lib/instagram.js) so the frontend can point a <video> element at
// it directly, instead of duplicating the scrape client-side (which would also hit both
// platforms' CORS wall from the browser).
//
// YouTube needs no round trip: a video ID is enough to build an embed URL, so the client
// resolves that itself and never calls this route for it.

import {
  resolveTikTokVideo,
  isTikTokHost,
  TikTokError,
  ALLOWED_MEDIA_HOSTS as TIKTOK_MEDIA_HOSTS,
} from "../lib/tiktok.js";
import {
  resolveInstagramVideo,
  isInstagramHost,
  InstagramError,
  ALLOWED_MEDIA_HOSTS as INSTAGRAM_MEDIA_HOSTS,
} from "../lib/instagram.js";
import { hostAllowed } from "../lib/media-fetch.js";
import { hintFromResolved } from "../lib/resolve-hint.js";
import { authorize, config, GuardError } from "../lib/guard.js";

/**
 * Longest this route may spend resolving one post, across every retry inside it.
 *
 * The platform modules bound each individual *request* (`EMBED_TIMEOUT_MS`,
 * `QUERY_TIMEOUT_MS`) and each retry *sequence* (`RESOLVE_RETRY.budgetMs`), but a share
 * link runs two of those sequences back to back and nothing was bounding the pair. This is
 * that outer bound.
 *
 * Sized against what the caller is: the video pane, filling a player the reader is looking
 * at. Past twenty seconds they have concluded it is broken, and the pane's own fallback —
 * showing the post as a link — is a better answer than a spinner that eventually resolves.
 */
const RESOLVE_BUDGET_MS = 20_000;

/**
 * Per-request timeout inside that budget, below each platform's own default.
 *
 * The defaults (15s for both TikTok's embed read and Instagram's post query) are sized for
 * the fact-check path, where a slow resolve still beats no clip. Here a single request
 * eating three quarters of the whole budget leaves no room for the retry that would have
 * succeeded, so it is cut to give the budget somewhere to spend itself.
 */
const RESOLVE_TIMEOUT_MS = 8_000;

function sendJSON(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body !== "string") return req.body;
    try {
      return JSON.parse(req.body);
    } catch {
      throw new GuardError("Request body is not valid JSON.", 400);
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000) throw new GuardError("Request body too large.", 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GuardError("Request body is not valid JSON.", 400);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJSON(res, 405, { error: "Use POST." }, { allow: "POST" });
  }

  const limits = config();
  let body;
  try {
    // Same gate as /api/chat: this still costs a fetch to TikTok on our dime, so it
    // shares the passphrase check and rate-limit window rather than opening a side door.
    authorize(req, limits);
    body = await readBody(req);
  } catch (error) {
    if (error instanceof GuardError) {
      const headers = error.retryAfter ? { "retry-after": String(error.retryAfter) } : {};
      return sendJSON(res, error.status, { error: error.message }, headers);
    }
    return sendJSON(res, 400, { error: "Could not read the request." });
  }

  const url = typeof body?.url === "string" ? body.url : "";
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return sendJSON(res, 400, { error: "Not a valid URL." });
  }

  const isTikTok = isTikTokHost(hostname);
  const resolve = isTikTok
    ? resolveTikTokVideo
    : isInstagramHost(hostname)
      ? resolveInstagramVideo
      : null;
  if (!resolve) {
    return sendJSON(res, 400, {
      error: "Only TikTok and Instagram links resolve to a direct media URL.",
    });
  }
  // Same list `downloadTikTokMedia`/`downloadInstagramMedia` fetch bytes against — see the
  // README's media-path guarantees. This route never fetches the media itself, but it does
  // hand the URL straight to the browser's own <video> tag, and that URL is read out of an
  // undocumented third-party blob the same way the downloaders' input is. Skipping the
  // check here would leave this the one exit where the platform's own stated invariant —
  // "will not [point at] a host the platform doesn't serve from" — doesn't actually hold.
  const allowedHosts = isTikTok ? TIKTOK_MEDIA_HOSTS : INSTAGRAM_MEDIA_HOSTS;

  // Every URL handed back goes through this, whether it names a clip or a slide. The check
  // is the same one the downloaders make and it is applied here for the same reason.
  const vetted = (candidate) => {
    try {
      return hostAllowed(new URL(candidate).hostname, allowedHosts) ? candidate : null;
    } catch {
      return null;
    }
  };

  // A deadline of our own, plus the browser going away, as one signal.
  //
  // Neither existed before, and the gap is not small: `resolveTikTokVideo` retries under a
  // `budgetMs` of its own, and it makes two of those calls in a row on a share link
  // (follow the redirect, then read the embed page), so a resolve that keeps almost-failing
  // can run for the better part of a minute. Nothing here was watching. On a serverless
  // host that is a function instance held open for an answer nobody is waiting for — the
  // reader gave up, or navigated away, long before it lands — and it is billed and
  // rate-limited as if it were work.
  //
  // So: one budget across the whole resolve, and `res.on("close")` aborts it the moment the
  // tab goes, exactly as /api/chat already does with its own stream. The video pane's own
  // `/api/resolve-media` calls are already superseded by a token (see `renderVideoPane` in
  // public/app.js), so a request whose answer has stopped mattering is a request worth
  // stopping.
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), RESOLVE_BUDGET_MS);
  res.on("close", () => controller.abort());

  try {
    const resolved = await resolve(url, { signal: controller.signal, timeoutMs: RESOLVE_TIMEOUT_MS });

    // A photo-mode TikTok or an Instagram carousel of stills. There is no single URL a
    // `<video>` can play, so the slides are handed back as a list and the pane renders them
    // as images — see `showImageSet` in public/app.js.
    if (resolved.kind === "images") {
      const images = (resolved.images ?? [])
        .filter((image) => vetted(image.url))
        .map((image) => ({ url: image.url, width: image.width, height: image.height }));
      if (images.length === 0) {
        console.error("[resolve-media] every image in that post was on an unexpected host");
        return sendJSON(res, 502, { error: "Could not resolve that post." });
      }
      return sendJSON(res, 200, {
        kind: "images",
        images,
        mimeType: resolved.mimeType,
        width: resolved.width,
        height: resolved.height,
        // The post's own caption/author, same fields lib/tiktok.js and lib/instagram.js
        // already resolve for the fact-check itself (see their `common` objects) — handed
        // back here too so the video pane can title the post by what it actually is
        // instead of by the link that was pasted. Either can be null; the client falls
        // back to the URL exactly as it did before this field existed.
        caption: resolved.caption ?? null,
        authorName: resolved.authorName ?? null,
        // Handed back so the fact-check does not have to run this same resolve again a
        // second later. Opaque to the client: it is passed through untouched, and vetted
        // from scratch on the way in. See lib/resolve-hint.js.
        hint: hintFromResolved({ ...resolved, images }),
      });
    }

    const mediaURL = vetted(resolved.mediaURL);
    if (!mediaURL) {
      console.error(`[resolve-media] refusing to hand back an unexpected media URL: ${resolved.mediaURL}`);
      return sendJSON(res, 502, { error: "Could not resolve that video." });
    }
    return sendJSON(res, 200, {
      kind: "video",
      mediaURL,
      mimeType: resolved.mimeType,
      width: resolved.width,
      height: resolved.height,
      // See the images branch above.
      caption: resolved.caption ?? null,
      authorName: resolved.authorName ?? null,
      hint: hintFromResolved({ ...resolved, mediaURL }),
    });
  } catch (error) {
    // The reader closed the tab. There is nobody to answer and nothing to log.
    if (res.writableEnded || !res.writable) return;
    if (controller.signal.aborted) {
      return sendJSON(res, 504, { error: "That post took too long to resolve." });
    }
    if (error instanceof TikTokError || error instanceof InstagramError) {
      // A link that will never work is the caller's problem; anything else is upstream's.
      return sendJSON(res, error.kind === "notAVideo" ? 400 : 502, { error: error.message });
    }
    console.error("[resolve-media]", error);
    return sendJSON(res, 500, { error: "Could not resolve that video." });
  } finally {
    clearTimeout(budget);
  }
}
