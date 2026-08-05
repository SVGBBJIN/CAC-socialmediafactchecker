// Resolving a post with a real browser, when resolving it with a bare fetch didn't work.
//
// The platform resolvers in lib/tiktok.js and lib/instagram.js are anonymous HTTP: read an
// embed page, or run the GraphQL query instagram.com's own client runs. That is the right
// default — it is one round trip, it needs no credential, and it is what makes a reel cost
// what a TikTok costs. It also fails in ways that have nothing to do with the post being
// unavailable:
//
//   - `rateLimited` — a 429 is Instagram's *normal* answer to anonymous datacenter traffic.
//     lib/retry.js already backs off and tries again, and when the whole budget goes to
//     429s the link is lost to something that is not about the link.
//   - `forbidden` — the endpoint declining us specifically, rather than declining everyone.
//   - `malformed` — the payload shape moved. The parser is broken; the *page* is fine, and
//     a browser rendering it does not care what shape the blob underneath is in.
//
// All three are the same shape of failure: the post is public and a browser can see it,
// and we cannot, because we are not a browser. So this module asks one — a worker service
// running a real Chromium with a real session, which navigates to the post and reports the
// media URL it finds.
//
// ## What this is not
//
// It is not screen recording. That path exists in `Sources/SeerCapture` and is dead: it is
// real-time by construction (a 60s clip costs 60s), it needs a visible surface to record,
// and ReplayKit's audio tap comes back silent from a web view — see the header on
// `ScreenRecorderCaptureSource.swift`. The insight that makes a browser worth running here
// is not that it can be *recorded*, it is that it holds a session: cookies, a `Referer`,
// and a JS runtime that has already executed. Once it has resolved the post, the CDN URL it
// found is fetchable by an ordinary anonymous request — that is the same property the whole
// direct-fetch arm rests on — so the bytes still come down the normal path at network
// speed. The worker replaces the *resolve*, not the download.
//
// ## The worker is not trusted
//
// Its reply goes through `validateHint` from lib/resolve-hint.js, unmodified and for the
// same reasons: an https URL on the platform's own CDN allowlist or nothing, a bounded
// caption, a `videoID` that matches the identifier shape, no `referer` (the one field that
// would become an outbound header on our request to someone else's CDN), and `sourceURL`
// stamped from the link we already have rather than read from the payload. The downloader
// then re-checks the host anyway, exactly as it does for a client hint.
//
// That is deliberate rather than incidental. The worker is operator-configured
// infrastructure, so it is not hostile the way a browser-supplied hint is — but its *output*
// is derived from a third-party page it just rendered, which is precisely the input the
// validator exists to bound. Sharing one validator between the two means there is one
// description of what a resolve is allowed to say, and no second copy to drift.
//
// Unlike a client hint, a worker resolve *is* cacheable: the reason hints are kept out of
// the process-global clip cache is that one user's crafted payload would be served to the
// next person who pasted the same link, and a server-side worker configured by the operator
// is not user-controlled. See `resolveClipParts`.

import { validateHint } from "./resolve-hint.js";
import { fetchWithTimeout } from "./media-fetch.js";

/**
 * Which resolve failures are worth a second opinion from a browser.
 *
 * The test is "would a browser see something we didn't", and for most kinds the answer is
 * plainly no — so they are excluded rather than left to time out:
 *
 *   - `unavailable` is the platform saying the post is private, deleted or region-blocked.
 *     A browser gets the same nothing, more slowly.
 *   - `notAVideo` means the link was never a post. There is nothing to render.
 *   - `tooLarge` is about the file we already found, and a browser does not make it smaller.
 *   - `expired` is a signed URL that aged out, and `resolveClipParts` already repairs it by
 *     resolving again — cheaply, over HTTP. Escalating would be slower and no more correct.
 *
 * What is left is the set above: throttled, refused, or a parser that has fallen behind the
 * page. Kinds we don't recognise are not escalated, so a new failure mode has to be
 * classified deliberately before it can start spending browser time.
 */
export const ESCALATED_KINDS = new Set(["rateLimited", "forbidden", "malformed", "upstream"]);

/**
 * Longest to wait on the worker, headers and body together.
 *
 * A page load plus a media-URL sighting on a warm context is a couple of seconds; this is
 * the ceiling before the link is given up on and reported as the note it would have been
 * anyway. Deliberately well under `CLIP_BUDGET_MS` — the escalation is the *slow* path
 * already, and one that runs the clip budget to zero has turned a fast failure into a slow
 * one for no answer.
 */
export const BROWSER_RESOLVE_TIMEOUT_MS = 20_000;

/** Read the worker's address and credential. Absent URL means the tier is off. */
export function browserWorkerFromEnv(env = process.env) {
  const url = typeof env?.BROWSER_WORKER_URL === "string" ? env.BROWSER_WORKER_URL.trim() : "";
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // http is allowed only for a loopback worker, which is the local-development shape
  // (`node worker/server.js` on the same box). Anything reachable over a network carries a
  // token, and a token over plaintext is a token in the clear.
  const loopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;

  const token = typeof env?.BROWSER_WORKER_TOKEN === "string" ? env.BROWSER_WORKER_TOKEN.trim() : "";
  return { url: parsed.toString(), token: token || null };
}

/** A worker that could not answer. Never surfaced to the user — see `browserResolve`. */
export class BrowserResolveError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserResolveError";
  }
}

/**
 * Ask the worker to resolve one post, and return a `resolved` the clip pipeline can use.
 *
 * Returns `null` rather than throwing for every failure — a worker that is down, slow,
 * misconfigured or answering nonsense must cost the original error, not replace it. The
 * caller already has a perfectly good reason to report ("Instagram rate-limited us"), and
 * burying it under "the browser worker returned 502" would tell the user about our
 * infrastructure instead of about their link.
 *
 * @param link the URL as it appears in the message. Also what `sourceURL` is stamped from.
 * @param platform "TikTok" | "Instagram" — selects the CDN allowlist the reply is held to.
 */
export async function browserResolve(
  link,
  {
    platform,
    worker,
    fetchImpl = fetch,
    signal,
    timeoutMs = BROWSER_RESOLVE_TIMEOUT_MS,
  } = {},
) {
  if (!worker?.url || !platform || !link) return null;

  let response;
  try {
    response = await fetchWithTimeout(worker.url, {
      fetchImpl,
      signal,
      timeoutMs,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(worker.token ? { authorization: `Bearer ${worker.token}` } : {}),
      },
      body: JSON.stringify({ url: link, platform }),
    });
  } catch {
    return null;
  }

  if (!response?.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  // The same validator a client hint goes through, and the same posture: anything
  // unexpected is `null`, which means the caller keeps the error it already had.
  return validateHint(payload?.resolved ?? payload, { platform, link });
}

/**
 * Whether a failure should be escalated to the worker at all.
 *
 * Errors arrive here as the platform modules' own `TikTokError`/`InstagramError`, which
 * carry `kind`; anything without one is an unclassified failure and is not escalated, for
 * the same reason an unrecognised kind isn't.
 */
export function worthEscalating(error) {
  return Boolean(error?.kind) && ESCALATED_KINDS.has(error.kind);
}
