// POST /api/resolve-media — the Library UI's video pane needs an actual MP4 for TikTok,
// since there's no iframe embed for TikTok the way there is for YouTube. This exposes the
// same resolution step /api/chat already does internally (see lib/tiktok.js) so the
// frontend can point a <video> element at it directly, instead of duplicating the embed-
// page scrape client-side (which would also hit TikTok's CORS wall from the browser).
//
// YouTube needs no round trip: a video ID is enough to build an embed URL, so the client
// resolves that itself and never calls this route for it.

import { resolveTikTokVideo, isTikTokHost, TikTokError } from "../lib/tiktok.js";
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

  if (!isTikTokHost(hostname)) {
    return sendJSON(res, 400, { error: "Only TikTok links resolve to a direct media URL." });
  }

  try {
    const resolved = await resolveTikTokVideo(url);
    return sendJSON(res, 200, {
      mediaURL: resolved.mediaURL,
      mimeType: resolved.mimeType,
      width: resolved.width,
      height: resolved.height,
    });
  } catch (error) {
    if (error instanceof TikTokError) {
      return sendJSON(res, error.kind === "notAVideo" ? 400 : 502, { error: error.message });
    }
    console.error("[resolve-media]", error);
    return sendJSON(res, 500, { error: "Could not resolve that video." });
  }
}
