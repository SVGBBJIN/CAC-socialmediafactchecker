// POST /api/page-outline — "this looks like a front page; what's actually on it?"
//
// The parser refuses a homepage as a check subject (see `looksLikeIndexPage` in
// lib/article.js): there is no single claim on one, and a model handed a wall of headlines
// checks whichever it happens to see. That refusal used to arrive at the end of a full
// fact-check run, which is the most expensive possible moment to be told that the link was
// the wrong link.
//
// So intake asks first, and asks for something better than a refusal: the headlines, as
// links. The reader picks one and that click is the check the paste could not be.
//
// This is the second route that fetches a host the user named, and it is deliberately the
// same fetch as the check's — `fetchPageOutline` shares `readPage` with `fetchArticle`, so
// the scheme allowlist, the per-hop DNS checks, the redirect cap, the deadline and the size
// cap are one implementation rather than two that can drift. What differs is only what
// comes back: link text and same-origin URLs, never the page's prose. A non-200 here means
// the outline couldn't be taken, and intake simply carries on as it did before it existed.

import { fetchPageOutline, ArticleError } from "../lib/article.js";
import { ProbeRefused } from "../lib/link-probe.js";
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
 * Looser than /api/chat's budget and tighter than /api/probe-link's.
 *
 * Same reasoning as the probe's: this spends no Gemini quota, so counting it against the
 * fact-check allowance would charge a reader for pasting. But it downloads a page rather
 * than reading a header, so it gets half the probe's burst — enough that correcting a URL
 * twice is free, not enough to be an open page-fetching proxy.
 */
const OUTLINE_BURST_FACTOR = 2;

function authorizeOutline(req, limits) {
  if (limits.password) {
    const supplied = req.headers["x-app-password"];
    if (!passwordMatches(supplied, limits.password)) {
      throw new GuardError("Wrong or missing passphrase.", 401);
    }
  }
  return checkRateLimit(`outline:${clientKey(req)}`, {
    ...limits,
    perMinute: limits.perMinute * OUTLINE_BURST_FACTOR,
    perDay: limits.perDay * OUTLINE_BURST_FACTOR,
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJSON(res, 405, { error: "Use POST." }, { allow: "POST" });
  }

  const limits = config();
  let body;
  try {
    authorizeOutline(req, limits);
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
    return sendJSON(res, 200, await fetchPageOutline(url));
  } catch (error) {
    if (error instanceof ProbeRefused || error instanceof ArticleError) {
      // Not a failure of this route: the page answered, and what it answered is something
      // the check itself would refuse. Intake has nothing to offer, which is a 200 with an
      // empty outline rather than an error to report.
      return sendJSON(res, 200, { url, index: false, headlines: [], error: error.message });
    }
    console.error("[page-outline]", error);
    return sendJSON(res, 500, { error: "Could not read that page." });
  }
}
