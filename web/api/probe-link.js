// POST /api/probe-link — "is there actually something at this URL, and what is it?"
//
// The browser can't answer that itself: every platform this app accepts blocks
// cross-origin reads, so a client-side fetch of a pasted link comes back opaque whether
// the post is live, deleted, or fictional. Intake used to fill that gap with a regex over
// the hostname. This route replaces the guess with the fact — see lib/link-probe.js for
// what it will and won't fetch, and why the vetting there is not optional.
//
// It answers 200 for a link that doesn't work: "nothing is there" is a successful probe.
// Non-200 here means the probe itself couldn't run — bad request, refused URL, rate limit
// — and the client falls back to URL-shape classification when it sees one.

import { probeLink, ProbeRefused } from "../lib/link-probe.js";
import {
  checkRateLimit,
  clientKey,
  config,
  GuardError,
  passwordMatches,
} from "../lib/guard.js";

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

/**
 * Probes get their own, looser budget rather than sharing /api/chat's.
 *
 * The shared limit exists to protect the Gemini quota, and a probe spends none of it — it
 * costs one HEAD to a public host. Counting probes against that limit would mean every
 * paste consumed a fact-check's worth of allowance before the fact-check ran, and a user
 * correcting a typo twice would be rate-limited out of the thing they were paying for.
 * Still bounded, on a separate key, so this can't be used as an open pinger either.
 */
const PROBE_BURST_FACTOR = 4;

function authorizeProbe(req, limits) {
  if (limits.password) {
    const supplied = req.headers["x-app-password"];
    if (!passwordMatches(supplied, limits.password)) {
      throw new GuardError("Wrong or missing passphrase.", 401);
    }
  }
  return checkRateLimit(`probe:${clientKey(req)}`, {
    ...limits,
    perMinute: limits.perMinute * PROBE_BURST_FACTOR,
    perDay: limits.perDay * PROBE_BURST_FACTOR,
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJSON(res, 405, { error: "Use POST." }, { allow: "POST" });
  }

  const limits = config();
  let body;
  try {
    authorizeProbe(req, limits);
    body = await readBody(req);
  } catch (error) {
    if (error instanceof GuardError) {
      const headers = error.retryAfter ? { "retry-after": String(error.retryAfter) } : {};
      return sendJSON(res, error.status, { error: error.message }, headers);
    }
    return sendJSON(res, 400, { error: "Could not read the request." });
  }

  const url = typeof body?.url === "string" ? body.url : "";
  if (!url) return sendJSON(res, 400, { error: "Request needs a `url`." });

  try {
    const probe = await probeLink(url);
    return sendJSON(res, 200, probe);
  } catch (error) {
    if (error instanceof ProbeRefused) {
      return sendJSON(res, error.status === 200 ? 200 : 400, {
        error: error.message,
        kind: error.kind,
      });
    }
    console.error("[probe-link]", error);
    return sendJSON(res, 500, { error: "Could not check that link." });
  }
}
