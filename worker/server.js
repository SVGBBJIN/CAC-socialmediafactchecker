// The browser worker's one route: POST / → resolve a post, return its media URL.
//
// Deliberately tiny, and deliberately not on the byte path. It answers with a URL and some
// metadata; web/ does the downloading through its own allowlist, caps and retries. That
// keeps the blast radius of this service to "a resolve that didn't work", which is the same
// blast radius it has when it isn't running at all.
//
// Run it anywhere that can hold a warm Chromium — a small container, a VM, a Fly machine.
// Not a serverless function: a cold Chromium launch per request is most of the latency this
// service exists to avoid, and neither Vercel's runtime nor its execution ceiling suits a
// browser.

import http from "node:http";
import { resolvePost, closeBrowser } from "./resolve.js";

const PORT = Number(process.env.PORT || 8080);

/** Shared secret. Set it whenever the worker is reachable by anything but localhost. */
const TOKEN = (process.env.BROWSER_WORKER_TOKEN || "").trim();

/**
 * Which interface to listen on — and, with no token set, the only thing standing in front
 * of the service.
 *
 * `tokenMatches` returns true when `TOKEN` is empty, so an unconfigured worker answers
 * anyone who can reach it. That was always the intent for local development, and the
 * startup line below has always said so out loud ("no token set — localhost only") — but
 * the listen call bound every interface, so the promise in that message was not one the
 * code kept. On any host where the port is reachable, an unconfigured worker is free
 * browser-automation compute for whoever finds it, and a way to drive traffic at TikTok and
 * Instagram from someone else's address.
 *
 * `vetPostURL` still bounds *where* the browser can be pointed, and that is the check that
 * matters most (see urls.js) — this is the other half: who may point it at all. So the
 * default binds to loopback exactly as web/server.js does, for the same stated reason, and
 * a deployment that wants the worker reachable says so with `HOST` — by which point it
 * should also have set a token.
 */
const HOST = process.env.HOST || (TOKEN ? "0.0.0.0" : "127.0.0.1");

/**
 * How many pages may be open at once.
 *
 * Each context is a real browser session with real memory behind it, and this runs on one
 * small box. Past the limit a caller is turned away immediately rather than queued: the
 * client's own deadline (`BROWSER_RESOLVE_TIMEOUT_MS`) is short, and a request that waits
 * in line only to time out has spent the clip budget for nothing. A fast 503 lets web/
 * report the original platform error while it is still worth reporting.
 */
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 4);
let inFlight = 0;

/** Longest one resolve may take inside the browser. */
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS || 15_000);

/** Bounds the body. A resolve request is two short strings; anything larger is not one. */
const MAX_BODY_BYTES = 4_096;

const PLATFORMS = new Set(["TikTok", "Instagram"]);

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Constant-time-ish token comparison.
 *
 * Not because a timing attack on a resolve worker is a likely path in, but because the
 * alternative costs one line and there is no reason to hand out the prefix length.
 */
function tokenMatches(header) {
  if (!TOKEN) return true;
  const offered = String(header || "").replace(/^Bearer\s+/i, "");
  if (offered.length !== TOKEN.length) return false;
  let differing = 0;
  for (let i = 0; i < TOKEN.length; i += 1) {
    differing |= offered.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  }
  return differing === 0;
}

const server = http.createServer(async (req, res) => {
  // Unauthenticated, no browser involved, and useful for a container health check.
  if (req.method === "GET" && req.url === "/health") {
    return sendJSON(res, 200, { ok: true, inFlight });
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    return res.end();
  }
  if (!tokenMatches(req.headers.authorization)) {
    return sendJSON(res, 401, { error: "bad token" });
  }
  if (inFlight >= MAX_CONCURRENCY) {
    // Turned away rather than queued — see MAX_CONCURRENCY.
    return sendJSON(res, 503, { error: "busy" });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJSON(res, 400, { error: "bad body" });
  }

  const { url, platform } = body ?? {};
  if (typeof url !== "string" || !PLATFORMS.has(platform)) {
    return sendJSON(res, 400, { error: "url and platform are required" });
  }

  inFlight += 1;
  const started = Date.now();
  try {
    const resolved = await resolvePost(url, platform, { timeoutMs: RESOLVE_TIMEOUT_MS });
    const ms = Date.now() - started;
    // Logged either way: this path only runs after something already failed, so how often
    // it succeeds is the only evidence of whether it is worth running at all.
    console.log(`[worker] ${platform} ${resolved ? "hit" : "miss"} ${ms}ms ${url}`);
    if (!resolved) return sendJSON(res, 404, { error: "no media found" });
    return sendJSON(res, 200, { resolved });
  } catch (error) {
    console.log(`[worker] ${platform} error ${Date.now() - started}ms ${error?.message}`);
    return sendJSON(res, 502, { error: "resolve failed" });
  } finally {
    inFlight -= 1;
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[worker] listening on ${HOST}:${PORT}` +
      (TOKEN
        ? ""
        : HOST === "127.0.0.1"
          ? " (no token set — bound to loopback)"
          : " — WARNING: no BROWSER_WORKER_TOKEN set and not bound to loopback; anyone who can reach this port can drive the browser"),
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(async () => {
      await closeBrowser();
      process.exit(0);
    });
  });
}
