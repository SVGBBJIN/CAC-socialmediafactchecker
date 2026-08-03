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
import { authorize, config, GuardError } from "../lib/guard.js";

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

  try {
    // Same reasoning as /api/chat's clipOptions.jitter: a random pre-request pause so this
    // route's requests don't land on a uniform cadence either.
    const resolved = await resolve(url, { jitter: true });
    let mediaHost;
    try {
      mediaHost = new URL(resolved.mediaURL).hostname;
    } catch {
      console.error(`[resolve-media] resolver returned a media URL that isn't a URL: ${resolved.mediaURL}`);
      return sendJSON(res, 502, { error: "Could not resolve that video." });
    }
    if (!hostAllowed(mediaHost, allowedHosts)) {
      console.error(`[resolve-media] refusing to hand back an unexpected media host: ${mediaHost}`);
      return sendJSON(res, 502, { error: "Could not resolve that video." });
    }
    return sendJSON(res, 200, {
      mediaURL: resolved.mediaURL,
      mimeType: resolved.mimeType,
      width: resolved.width,
      height: resolved.height,
    });
  } catch (error) {
    if (error instanceof TikTokError || error instanceof InstagramError) {
      // A link that will never work is the caller's problem; anything else is upstream's.
      return sendJSON(res, error.kind === "notAVideo" ? 400 : 502, { error: error.message });
    }
    console.error("[resolve-media]", error);
    return sendJSON(res, 500, { error: "Could not resolve that video." });
  }
}
