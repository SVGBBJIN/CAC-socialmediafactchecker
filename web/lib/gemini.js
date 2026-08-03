// Gemini chat client.
//
// Deliberately mirrors Sources/SeerCore/Gemini/GeminiModel.swift: the same ordered
// model chain, and the same rule for when a failure means "try the next model" rather
// than "give up". Model availability is not a constant — preview IDs get retired and a
// key's tier may not be entitled to the newest model — so pinning one ID breaks in the
// field. See the comments in GeminiModel.swift for the full reasoning.

import {
  findTikTokLinks,
  isTikTokLink,
  resolveTikTokVideo,
  downloadTikTokMedia,
  fetchTikTokOEmbed,
  INLINE_BYTE_LIMIT,
} from "./tiktok.js";
import {
  findInstagramLinks,
  isInstagramLink,
  resolveInstagramVideo,
  downloadInstagramMedia,
} from "./instagram.js";
import { uploadFile, deleteFile } from "./gemini-files.js";
import {
  modelHealth,
  planChain,
  describeDegradation,
  REASONS,
  MAX_COOLDOWN_MS,
  OVERLOAD_COOLDOWN_MS,
} from "./degradation.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * How long the stream may sit silent before we give up on it.
 *
 * Reset by every chunk that arrives, so a long answer is fine and a dead connection is
 * not. Generous because the first token on a video Gemini has to watch legitimately takes
 * a while, and cutting that off looks identical to the model failing.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * How long to wait for response headers, or 0 for no limit — the default.
 *
 * There used to be a 30-second rule here. It is off by default now, which means the wait
 * for headers is bounded by the caller and nothing else: `fetch` without a signal waits
 * indefinitely, so a connection that opens and never answers holds the request, and on
 * Vercel the function instance behind it, until the platform kills it. The browser
 * disconnecting still ends it — `api/chat.js` aborts on `res.on("close")` — so the case
 * this leaves unbounded is specifically a stalled upstream with a client still waiting.
 *
 * The mechanism is kept rather than deleted so a caller that wants a ceiling can pass
 * `requestTimeoutMs` and get the same 504 as before.
 */
export const REQUEST_TIMEOUT_MS = 0;

/**
 * Default ceiling on a single reply, in tokens. Applied even when the caller doesn't
 * pass one explicitly — a spend cap that has to be opted out of is a spend cap that
 * eventually gets forgotten. `web/api/chat.js` overrides this from `MAX_OUTPUT_TOKENS`.
 *
 * Raised from 4096, which was set as "far more prose than a fact-check needs" and was
 * right about the prose and wrong about the budget. On a thinking model this cap covers
 * the *whole* output, thinking included, and the models at the head of the chain think
 * before they search and again before they answer. So the answer gets whatever the
 * reasoning left it, and a fact-check that reads as three paragraphs can run into a cap
 * sized for ten — which arrives as a verdict cut off mid-sentence, right where the
 * citation would have gone.
 *
 * Raising this alone only raises the ceiling both draws from — a model that thinks more
 * just spends the increase on thinking. `DEFAULT_THINKING_BUDGET_TOKENS` below is what
 * actually reserves room for the answer; this cap is the outer bound on the two combined.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/**
 * How many of those tokens a thinking model may spend on its internal reasoning per model
 * call, via Gemini's `generationConfig.thinkingConfig.thinkingBudget`.
 *
 * This is the actual fix for a fact-check truncated mid-verdict, and raising
 * `maxOutputTokens` alone is not: without it, the visible answer and the invisible
 * reasoning draw from one shared pool, a model that thinks longer simply leaves less for
 * the answer, and a bigger pool just moves where that runs out. Capping the reasoning
 * specifically reserves the rest — `maxOutputTokens - thinkingBudgetTokens`, as a floor —
 * for what the reader actually sees.
 *
 * Sent only to models known to support it (`supportsThinkingBudget`); the field does not
 * exist on `gemini-2.0-flash`, and Gemini rejects an unrecognised name outright rather
 * than ignoring it. Not verified against a live thinking-capable response as of writing —
 * `isUnsupportedThinkingConfig` below exists as the fallback if that guess about which
 * models accept the field turns out wrong, so a bad guess degrades to the next model in
 * the chain rather than to a broken turn.
 */
export const DEFAULT_THINKING_BUDGET_TOKENS = 4096;

/**
 * The same cap, for a round that still has its tools — which is to say, a round whose job
 * is to *decide what to look up*, not to write the answer.
 *
 * This is the single largest avoidable wait in a video fact-check. A turn about a
 * short-form clip runs up to `MAX_TOOL_ROUNDS` model calls, and until now every one of
 * them was handed the full 4096-token reasoning budget — including the first, whose entire
 * output is a list of search calls. A thinking model given room to deliberate will use it:
 * the reader waits through thousands of tokens of invisible reasoning, at Flash's output
 * rate, before the first search is even dispatched, and then waits through it again on the
 * next round. The budget is a ceiling rather than a target, so this costs nothing on a
 * round that was going to be brief anyway; what it removes is the rambling one.
 *
 * The *answering* round — the one past the tool budget, where `tools` is withdrawn — keeps
 * the full budget, because that is the round where reasoning turns into the verdict and
 * where cutting it short would show. Enumerating the claims in a clip and naming a query
 * per claim is a shallower task than weighing what came back, and it is budgeted like one.
 *
 * Never raises the caller's cap: the value actually sent is the smaller of the two, so
 * `THINKING_BUDGET_TOKENS=512` still means 512 everywhere.
 */
export const DEFAULT_TOOL_ROUND_THINKING_BUDGET_TOKENS = 1024;

/**
 * How much of a video Gemini is asked to look at, per frame.
 *
 * `generationConfig.mediaResolution` trades visual detail for tokens, and video is where
 * that trade is worth naming: a clip is sampled at a frame a second, so a 45-second TikTok
 * arrives as ~45 images. At the default that is several thousand input tokens the model
 * has to read before it can say anything — on every round of the turn, since the clip
 * stays in the conversation — and it is the largest single contributor to the gap between
 * pasting a link and seeing the first search.
 *
 * Deliberately **not** on by default, even though `low` is the biggest remaining speed
 * lever in this file. On short-form video the claim frequently lives in an on-screen text
 * card rather than in the audio — the system prompt says so in as many words — and reading
 * small text off a frame is exactly what resolution buys. Trading it away silently would
 * make the app faster at the thing it exists to do badly, so the choice is the operator's:
 * set `GEMINI_MEDIA_RESOLUTION=low` (or `medium`) and measure it against clips you care
 * about.
 */
export const MEDIA_RESOLUTIONS = {
  low: "MEDIA_RESOLUTION_LOW",
  medium: "MEDIA_RESOLUTION_MEDIUM",
  high: "MEDIA_RESOLUTION_HIGH",
};

/**
 * Read `GEMINI_MEDIA_RESOLUTION` into the enum Gemini wants, or null for "don't send it".
 *
 * An unrecognised value is ignored rather than thrown on: this is a speed knob, and
 * failing every request in the deployment over a typo in an optional tuning variable is a
 * worse outcome than running at the default speed.
 */
export function mediaResolutionFromEnv(env = process.env) {
  const raw = String(env.GEMINI_MEDIA_RESOLUTION ?? "").trim().toLowerCase();
  if (!raw) return null;
  return MEDIA_RESOLUTIONS[raw] ?? (raw.startsWith("media_resolution_") ? raw.toUpperCase() : null);
}

/**
 * Models that answered a `mediaResolution` with "no such field".
 *
 * Support for the field is guessed at from the version number, the same way
 * `supportsThinkingBudget` guesses, and this is what a wrong guess costs: the model that
 * refused is remembered and the field is dropped for it from the next attempt onward, so
 * the mistake is paid for once rather than on every request. Module-scoped and unbounded
 * on purpose — it can only ever hold model IDs from the configured chain.
 */
const mediaResolutionRefused = new Set();

/**
 * Whether `model` is expected to accept `thinkingConfig.thinkingBudget`.
 *
 * The chain's thinking models are the "3" series and 2.5; "2.0" predates extended
 * thinking and does not have a budget to cap. Matched on the version number rather than
 * listed by name so a new preview ID slots in without a code change — the same reasoning
 * `DEFAULT_MODEL_CHAIN` documents for not pinning IDs.
 */
export function supportsThinkingBudget(model) {
  return !/(?:^|[^0-9])2\.0(?:[^0-9]|$)/.test(String(model));
}

/** Flash 3.6 preferred, then 3.5, 3, 2.5, 2 — same order as `GeminiModelChain.flashPreferred`. */
export const DEFAULT_MODEL_CHAIN = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  // 3-series Flash only ships under the preview ID; there is no `gemini-3-flash`.
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  // The 2-series ID is `2.0`, not `2`.
  "gemini-2.0-flash",
];

export function modelChainFromEnv(env = process.env) {
  const raw = env.GEMINI_MODEL_CHAIN;
  if (!raw) return DEFAULT_MODEL_CHAIN;
  const models = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return models.length > 0 ? models : DEFAULT_MODEL_CHAIN;
}

export class GeminiError extends Error {
  constructor(message, { status = 502, model, retryable = false } = {}) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.model = model;
    this.retryable = retryable;
  }
}

/**
 * Whether a failure against one model means "try the next one".
 *
 * - 404: no such model for this API version. Fall through.
 * - 403: key isn't entitled to this model. Fall through.
 * - 400 mentioning an unknown/unsupported model: fall through.
 * - 429, or anything else that means "out of quota": fall through. Quotas in Gemini are
 *   **per model**, so `gemini-3.6-flash` being rate-limited says nothing at all about
 *   whether `gemini-3.5-flash` will answer — and this is by far the most common way the
 *   preferred model becomes unusable in normal operation. Treating it as terminal, as
 *   this function used to, meant the chain protected against the rare failure (a retired
 *   model ID) and not the frequent one: the whole request failed with a quota message
 *   while four models that would have answered went untried.
 * - A request too large for this model's context window: fall through, then give up on
 *   the chain with a message that says so. See `isContextLimitFailure`.
 * - 503, or a 500 that says the model is overloaded: fall through. Capacity in Gemini is
 *   **per model**, the same way quota is — `gemini-3.6-flash` being full at this instant
 *   says nothing about whether `gemini-3.5-flash` has room, and the newest and most
 *   popular model in the chain is precisely the one most likely to be full. Treating it as
 *   terminal, as this used to, meant the single most common transient upstream failure
 *   killed the request outright while four models that would have answered went untried.
 * - A 400 naming `thinkingConfig` as unknown: fall through. `supportsThinkingBudget` is a
 *   guess about which models accept the field, made without a live response to check it
 *   against — this is what a wrong guess costs instead of costing the whole chain.
 * - Everything else (401/`API_KEY_INVALID`, other 5xx) is terminal here — falling through
 *   would spend the same broken credential four more times, or hammer a genuine outage.
 */
export function shouldFallThrough(status, message = "") {
  // Checked before anything else: a bad key arrives as a 400 or 403 (see
  // `isInvalidKeyFailure`), both of which the rules below would otherwise wave through.
  if (isInvalidKeyFailure(status, message)) return false;
  if (status === 404 || status === 403) return true;
  if (isQuotaFailure(status, message)) return true;
  if (isOverloadedFailure(status, message)) return true;
  if (isContextLimitFailure(status, message)) return true;
  if (isUnsupportedThinkingConfig(status, message)) return true;
  if (isUnsupportedMediaResolution(status, message)) return true;
  if (status !== 400) return false;
  const lowered = message.toLowerCase();
  return (
    lowered.includes("not found") ||
    lowered.includes("not supported") ||
    lowered.includes("unsupported") ||
    lowered.includes("invalid model")
  );
}

/**
 * Whether a failure means "this model has no quota left right now".
 *
 * 429 is the documented status, but it is not the only way this arrives: a project whose
 * generative-language quota is exhausted, or one whose billing has lapsed, can answer 403
 * with `RESOURCE_EXHAUSTED` in the body. The distinction that matters is not the status —
 * it is whether waiting would fix it, because that is what decides both whether to try
 * another model now and whether to keep avoiding this one for the next few requests.
 */
export function isQuotaFailure(status, message = "") {
  if (status === 429) return true;
  if (status !== 400 && status !== 403) return false;
  return /quota|rate[\s_-]?limit|resource[\s_-]?exhausted/i.test(message);
}

/**
 * Whether a failure means "this model has no capacity right this second".
 *
 * 503 is the documented status and the one that reaches users as *Gemini is having trouble
 * (HTTP 503)*. A 500 counts too when the body says overloaded — Gemini's own guidance for
 * `INTERNAL` is to retry or try a different model, which is the same remedy.
 *
 * Kept separate from `isQuotaFailure` even though both fall through the chain, because the
 * two want different cooldowns and say different things to the user. Quota is an allowance
 * that ran out and may take a minute to refresh; overload is Google's capacity at this
 * instant, usually clears in seconds, and is emphatically not something the operator did.
 *
 * A plain 500 with no such wording is *not* included: that is an outage, and walking the
 * whole chain through one adds four failed requests to a service already in trouble.
 */
export function isOverloadedFailure(status, message = "") {
  if (status === 503) return true;
  if (status !== 500) return false;
  return /overload|unavailable|try again|capacity|busy/i.test(message);
}

/**
 * Whether a 400 is Gemini refusing `thinkingConfig` as a field it doesn't recognise.
 *
 * The safety net for `supportsThinkingBudget` guessing wrong. Gemini's protobuf-JSON
 * parser rejects an unknown field name outright ("Unknown name \"thinkingConfig\" ...")
 * rather than ignoring it, so a model this app believes supports thinking but doesn't
 * would otherwise fail the whole chain over one optional parameter.
 */
export function isUnsupportedThinkingConfig(status, message = "") {
  if (status !== 400) return false;
  return /thinking[_ ]?config/i.test(message);
}

/**
 * Whether a 400 is Gemini refusing `mediaResolution` as a field it doesn't recognise.
 *
 * The same safety net as `isUnsupportedThinkingConfig`, for the same reason: which models
 * accept the field is guessed from the version number, and a wrong guess must cost one
 * model rather than the whole chain. Paired with `mediaResolutionRefused`, which stops the
 * next request re-buying the same 400.
 */
export function isUnsupportedMediaResolution(status, message = "") {
  if (status !== 400) return false;
  return /media[_ ]?resolution/i.test(message);
}

/**
 * Whether a failure means "this request is too big for this model".
 *
 * Worth separating from an ordinary 400 for two reasons. The models in the chain do not
 * all have the same context window, so the next one down genuinely might accept what this
 * one refused — that is a real fall-through, not a hopeful one. And when none of them
 * accept it, the user needs to be told something they can act on ("this conversation got
 * too long") rather than handed Gemini's token arithmetic, which reads like a bug.
 */
export function isContextLimitFailure(status, message = "") {
  if (status !== 400 && status !== 413) return false;
  return /token count|too many tokens|context length|input is too long|exceeds? the maximum|request (?:payload|entity) (?:size|too large)/i.test(
    message,
  );
}

/**
 * How long the server wants us to wait, in milliseconds, or null if it didn't say.
 *
 * Two places carry it and neither is guaranteed: the standard `Retry-After` header, and
 * the `RetryInfo` detail Gemini puts in a 429 body as `"retryDelay": "27s"`. Both are read
 * because which one shows up varies with where the limit was enforced — an edge rate limit
 * sets the header, a project quota sets the body.
 */
export function retryAfterMs(response, body = "") {
  const header = response?.headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(String(header).trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
    const date = Date.parse(String(header).trim());
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), MAX_COOLDOWN_MS);
  }

  // Matched against the raw body rather than a parsed one: `retryDelay` sits inside
  // `error.details[]`, whose shape is a union we'd have to walk to reach one string.
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(String(body ?? ""));
  if (match) return Math.min(Number(match[1]) * 1000, MAX_COOLDOWN_MS);

  return null;
}

/** Longest upstream error text we'll relay. Some of it reaches the browser verbatim. */
const MAX_ERROR_CHARS = 500;

/** Pull a human-readable message out of an error body without assuming a shape. */
export function errorMessage(body, status) {
  try {
    const parsed = JSON.parse(body);
    // Capped like the raw-body case below: a structured error is not automatically a
    // short one — Gemini's 400s can echo a large slice of the request back.
    if (parsed?.error?.message) return String(parsed.error.message).slice(0, MAX_ERROR_CHARS);
    if (typeof parsed?.message === "string") return parsed.message.slice(0, MAX_ERROR_CHARS);
  } catch {
    // Not JSON; fall through to the raw body.
  }
  const text = String(body || "").slice(0, MAX_ERROR_CHARS);
  return text || `HTTP ${status}`;
}

/**
 * Whether a failure is really "that key is no good", whatever status it arrived under.
 *
 * Gemini answers a bad key with **HTTP 400 / `API_KEY_INVALID`**, not 401 — verified
 * against the live endpoint on 2026-07-27. Keying the check on the status alone
 * therefore misses the single most likely misconfiguration, and misses it twice over:
 * the operator gets a bare "API key not valid" with no hint of where the key is
 * configured, and the response takes the generic branch below, which relays the
 * upstream body to the browser verbatim — exactly what the auth branch exists to
 * prevent, since these bodies are the ones that can quote the key back.
 */
export function isInvalidKeyFailure(status, message = "") {
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  return /api[\s_-]?key[\s_-]?(?:is\s+)?(?:not\s+valid|invalid)|api_key_invalid/i.test(message);
}

/**
 * Map an upstream status onto something the browser can act on, without ever leaking
 * the upstream body verbatim for auth failures (it can echo key fragments).
 */
function describeFailure(status, message, model) {
  // The old form also tested `status === 403 && !shouldFallThrough(status, message)`,
  // which could never hold: `shouldFallThrough` returns true for 403 unconditionally.
  // A 403 walks the chain and arrives here as the stored `lastError`, where the
  // message-based check above is what actually recognises it.
  if (isInvalidKeyFailure(status, message)) {
    return new GeminiError(
      "Gemini rejected the API key. Check GEMINI_API_KEY in web/.env.local, and that the key is enabled for the Generative Language API.",
      { status: 502, model },
    );
  }
  if (isContextLimitFailure(status, message)) {
    return new GeminiError(
      "This conversation is too long for the models available. Start a new chat to carry on.",
      // Not retryable: the request that was refused is the one that would be sent again.
      { status: 413, model },
    );
  }
  // Reached only once *every* model in the chain has refused — a single model out of
  // quota falls through to the next one, so the wording is about the chain, not the model.
  if (isQuotaFailure(status, message)) {
    return new GeminiError("Every available Gemini model is rate-limited. Try again shortly.", {
      status: 429,
      model,
      retryable: true,
    });
  }
  // Reached only once every model in the chain has been full, and after the retry sweep —
  // so the wording is about all of them, and about it not being the reader's doing. The
  // old text ("Gemini is having trouble") described the same state as a fault, which sent
  // people looking at their key and their code for a condition neither one caused.
  if (isOverloadedFailure(status, message)) {
    const error = new GeminiError(
      "Every Gemini model is busy right now — Google is turning requests away, which usually clears within a minute. Nothing is wrong with your key or this app. Try again shortly.",
      { status: 503, model, retryable: true },
    );
    error.overloaded = true;
    return error;
  }
  if (status >= 500) {
    return new GeminiError(`Gemini is having trouble (HTTP ${status}). Try again shortly.`, {
      status: 502,
      model,
      retryable: true,
    });
  }
  return new GeminiError(message, { status: 502, model });
}

/**
 * Extract an 11-character YouTube video ID from a URL, or null.
 *
 * Mirrors `YouTubeExtractor.videoID(from:)` in Sources/SeerCore/Extractors/YouTubeExtractor.swift:
 * same formats handled (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`, `/v/`),
 * same 11-character base64url shape check.
 */
export function youTubeVideoID(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  if (!isYouTubeHost(url.hostname)) return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  // Matched as a domain, not a substring, so `youtu.be.youtube.com` isn't mistaken for a
  // short link and read for a video ID off its first path segment.
  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    return segments[0] && isValidVideoID(segments[0]) ? segments[0] : null;
  }

  const queryID = url.searchParams.get("v");
  if (queryID && isValidVideoID(queryID)) return queryID;

  const videoPathPrefixes = new Set(["shorts", "embed", "live", "v"]);
  if (segments.length > 1 && videoPathPrefixes.has(segments[0].toLowerCase())) {
    return isValidVideoID(segments[1]) ? segments[1] : null;
  }

  return null;
}

function isValidVideoID(candidate) {
  return /^[A-Za-z0-9_-]{11}$/.test(candidate);
}

/**
 * Mirrors `Platform.detect(from:)`'s YouTube branch: strips a leading `www.`/`m.`/etc.
 * subdomain so `m.youtube.com` and `youtube.com` agree, and accepts regional subdomains.
 */
function isYouTubeHost(hostname) {
  const bare = hostname.toLowerCase().replace(/^(www|m|mobile|vm|vt)\./, "");
  return (
    bare === "youtube.com" ||
    bare === "youtu.be" ||
    bare === "youtube-nocookie.com" ||
    bare.endsWith(".youtube.com")
  );
}

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;

/** Every distinct YouTube video ID mentioned anywhere in a message, in first-seen order. */
export function findYouTubeVideoIDs(text) {
  const found = [];
  const seen = new Set();
  for (const match of String(text).matchAll(URL_PATTERN)) {
    const id = youTubeVideoID(match[0]);
    if (id && !seen.has(id)) {
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}

function canonicalYouTubeURL(videoID) {
  return `https://www.youtube.com/watch?v=${videoID}`;
}

/**
 * The platforms whose videos arrive as bytes rather than as a URL Gemini will fetch.
 *
 * Both entries are the same shape on purpose: a link finder, a resolver that turns a link
 * into `{videoID, mediaURL, …}`, and a downloader. Everything below this line treats a
 * clip as a clip — the difference between reading TikTok's embed state and running
 * Instagram's shortcode query lives entirely in lib/tiktok.js and lib/instagram.js.
 *
 * YouTube is deliberately absent: Gemini fetches a watch URL itself, so a YouTube link
 * costs us a string rather than a download. See `toGeminiContents`.
 */
export const CLIP_PROVIDERS = [
  {
    platform: "TikTok",
    find: findTikTokLinks,
    matches: isTikTokLink,
    resolve: resolveTikTokVideo,
    download: downloadTikTokMedia,
    // TikTok's oEmbed carries no video (see lib/tiktok.js), only a title, author and
    // thumbnail — but that's still worth handing the model when the real download fails.
    // Instagram has no equivalent: its oEmbed needs a Meta App Review token we don't have.
    oEmbed: fetchTikTokOEmbed,
  },
  {
    platform: "Instagram",
    find: findInstagramLinks,
    matches: isInstagramLink,
    resolve: resolveInstagramVideo,
    download: downloadInstagramMedia,
  },
];

/** Same shape `findTikTokLinks`/`findInstagramLinks` scan with, kept in step by hand. */
const CLIP_URL_PATTERN = /https?:\/\/[^\s<>"]+/g;

/**
 * Every clip link in a piece of text, tagged with the platform that claimed it.
 *
 * True first-seen order — the order the links actually appear in the message, across every
 * platform at once — deduplicated by URL text so the same link is never offered twice even
 * if two providers' patterns could both match it.
 *
 * This used to call each provider's own `find(text)` in turn and concatenate the results,
 * which reads as first-seen but isn't: every TikTok link in a message sorted ahead of every
 * Instagram link regardless of which was actually pasted first, because the *providers*
 * were visited in order, not the *text*. That mattered downstream — `resolveClipParts`
 * enforces `MAX_CLIP_ATTACHMENTS` in the order this function returns, so whichever platform
 * lost the provider-ordering lottery was the one told "only the first N videos… are
 * fetched", regardless of what the user actually typed first.
 *
 * So this scans the raw text once, in the same shape each provider's own finder does
 * (`CLIP_URL_PATTERN`, then trim the trailing punctuation prose leaves on a URL — "watch
 * this: <url>." — same as `findTikTokLinks`/`findInstagramLinks`), and asks each provider
 * in turn whether *that one candidate* is theirs. A link is unambiguous by host, so which
 * provider is asked first only matters when none of them claim it.
 */
export function findClipLinks(text, providers = CLIP_PROVIDERS) {
  const found = [];
  const seen = new Set();
  for (const match of String(text).matchAll(CLIP_URL_PATTERN)) {
    const candidate = match[0].replace(/[.,;:!?)\]]+$/, "");
    if (seen.has(candidate)) continue;
    const provider = providers.find((p) => p.matches(candidate));
    if (!provider) continue;
    seen.add(candidate);
    found.push({ link: candidate, provider });
  }
  return found;
}

/**
 * How many clips one request will fetch, however many are pasted.
 *
 * Unlike a YouTube link — which costs us a URL string and lets Gemini do the fetching —
 * every TikTok or reel costs a download, a base64 copy and, past the inline ceiling, an
 * upload. Ten links in one message is ten of those. A cap keeps a single paste from
 * becoming a bandwidth and quota event; links past it get a note rather than silence.
 *
 * Counted across platforms, not per platform: the cost being capped is bytes moved in one
 * request, and Gemini does not care which app they came from.
 */
export const MAX_CLIP_ATTACHMENTS = 2;

/** Captions are user-authored and can run long; this is context, not the payload. */
const MAX_CAPTION_CHARS = 500;

/**
 * Resolve every clip link in the conversation to a Gemini part.
 *
 * Kept separate from `toGeminiContents` on purpose. That function is pure, synchronous
 * and covers the rule that actually costs money (attach each video exactly once); this
 * one does the network work. Splitting them means the expensive, order-sensitive logic
 * stays testable without a single stubbed fetch, and the I/O stays testable without
 * reasoning about turn structure.
 *
 * Nothing here throws for a video it couldn't get. A private, deleted or region-blocked
 * post is a normal thing to paste, and failing the whole message over it would take the
 * rest of the conversation down with it — so the failure is recorded and surfaces as a
 * note in the prompt, letting the model say *why* it can't discuss the clip.
 *
 * `resolveImpl` and `downloadImpl` override every provider's own pair, which is how tests
 * stub the network; left unset, each link is handled by the platform that claimed it.
 *
 * @returns `{attachments, cleanup}` — `attachments` maps each link to either a Gemini
 *   part or an `error` string; `cleanup` removes anything uploaded to the Files API and
 *   must be awaited once the request is done.
 */
export async function resolveClipParts(
  messages,
  {
    apiKey,
    fetchImpl = fetch,
    signal,
    inlineByteLimit = INLINE_BYTE_LIMIT,
    maxAttachments = MAX_CLIP_ATTACHMENTS,
    providers = CLIP_PROVIDERS,
    resolveImpl = null,
    downloadImpl = null,
    uploadImpl = uploadFile,
    deleteImpl = deleteFile,
    // Off by default so the test suite stays instant; the API routes opt in. See
    // `jitterDelay` in lib/tiktok.js for why this exists at all.
    jitter = false,
    sleepImpl,
  } = {},
) {
  const attachments = new Map();
  const uploads = [];
  // Together rather than one after another. This is awaited in `streamChat`'s `finally`,
  // which runs *before* the last frames of the turn reach the reader — so a serial sweep
  // put a DELETE round trip per uploaded clip between the final token of an answer and the
  // sources printed under it, for housekeeping nobody is waiting on.
  const cleanup = async () => {
    await Promise.all(uploads.splice(0).map((file) => deleteImpl(file, { apiKey, fetchImpl })));
  };

  // Assistant turns are excluded for the same reason they carry no media below: a model
  // turn quoting the user's link back is not a request to go and fetch it.
  const links = [];
  const seenLink = new Set();
  for (const message of messages) {
    if (message?.role === "assistant") continue;
    for (const found of findClipLinks(String(message?.content ?? ""), providers)) {
      if (seenLink.has(found.link)) continue;
      seenLink.add(found.link);
      links.push(found);
    }
  }
  if (links.length === 0) return { attachments, cleanup, providers };

  // Resolving is metadata only — following a share link's redirect, reading an embed page
  // or running Instagram's post query — not the download itself, so every link is resolved
  // at once rather than one after another. With the usual two-link paste this halves the
  // wait before either download can even start.
  const resolutions = await Promise.all(
    links.map(async ({ link, provider }) => {
      try {
        const resolve = resolveImpl ?? provider.resolve;
        return { link, provider, resolved: await resolve(link, { fetchImpl, signal, jitter, sleepImpl }) };
      } catch (error) {
        return { link, provider, error: error?.message || "the video could not be fetched" };
      }
    }),
  );

  // Which distinct videos are worth downloading, decided in link order now that every
  // link's video ID is known. A share link and the canonical URL it redirects to are the
  // same video — caught here rather than by URL, because that equality is only knowable
  // after the redirect has been followed — so this is also where the cap is enforced,
  // against distinct videos rather than distinct links. Keyed by platform as well as ID,
  // since two platforms' ID spaces are unrelated and only look alike.
  const byVideoID = new Map();
  const toDownload = [];
  for (const { link, provider, resolved, error } of resolutions) {
    if (error) {
      attachments.set(link, { platform: provider.platform, error });
      continue;
    }
    const key = `${provider.platform}:${resolved.videoID}`;
    const existing = byVideoID.get(key);
    if (existing) {
      attachments.set(link, existing);
      continue;
    }
    if (byVideoID.size >= maxAttachments) {
      attachments.set(link, {
        platform: provider.platform,
        error: `only the first ${maxAttachments} ${provider.platform} video${
          maxAttachments === 1 ? "" : "s"
        } in a message are fetched`,
      });
      continue;
    }
    const entry = { videoID: key, platform: provider.platform, provider, resolved };
    byVideoID.set(key, entry);
    attachments.set(link, entry);
    toDownload.push(entry);
  }

  if (signal?.aborted || toDownload.length === 0) return { attachments, cleanup, providers };

  // The downloads (and any upload past the inline limit) run together too — this is the
  // slow part of attaching a clip, and the part most worth overlapping. A failure is
  // recorded on the entry itself, which every link sharing that video already points at,
  // so a duplicate link never re-attempts a download its twin just watched fail.
  await Promise.all(
    toDownload.map(async (entry) => {
      try {
        const download = downloadImpl ?? entry.provider.download;
        const { bytes, mimeType } = await download(entry.resolved, { fetchImpl, signal, jitter, sleepImpl });
        if (bytes.length <= inlineByteLimit) {
          entry.part = { inline_data: { mime_type: mimeType, data: bytes.toString("base64") } };
        } else {
          const file = await uploadImpl(bytes, mimeType, { apiKey, fetchImpl, signal });
          uploads.push(file);
          entry.part = { file_data: { file_uri: file.uri, mime_type: file.mimeType } };
        }
        // Bytes live only in `bytes`/the upload above; nothing here writes them anywhere
        // durable, so once this closure returns there's nothing left to clean up but the
        // Files API upload `cleanup()` already tracks.
      } catch (error) {
        if (signal?.aborted) return;
        entry.error = error?.message || "the video could not be fetched";

        // The signed CDN URL from the embed page is short-lived and sometimes already
        // dead by the time we get here, or the CDN host has moved. Rather than lose the
        // clip entirely, fall back to whatever public metadata the platform's oEmbed
        // still hands an anonymous request.
        const oEmbed = entry.provider.oEmbed;
        if (!oEmbed) return;
        try {
          const meta = await oEmbed(entry.resolved.sourceURL, { fetchImpl, signal, jitter, sleepImpl });
          if (meta) {
            entry.metadataOnly = meta;
            delete entry.error;
          }
        } catch {
          // Best-effort: the download error already recorded above stands.
        }
      }
    }),
  );

  return { attachments, cleanup, providers };
}

/**
 * What the platform told us about a clip, as a line of prompt context.
 *
 * The caption is worth passing on its own account: on short-form political content it is
 * frequently *the* claim, while the video is B-roll. Marked as the caption rather than
 * folded into the user's text, so the model can attribute it — the same distinction
 * `DirectMediaExtractor.mergeOnScreenText` draws on the Swift side.
 */
function describeClip(resolved, platform) {
  if (!resolved) return null;
  const facts = [];
  if (resolved.authorName) facts.push(`posted by ${resolved.authorName}`);
  if (resolved.duration) facts.push(`${Math.round(resolved.duration)}s`);

  const header = `[Attached: the ${platform} video from ${resolved.sourceURL}${
    facts.length ? ` — ${facts.join(", ")}` : ""
  }.]`;
  if (!resolved.caption) return header;

  const caption = resolved.caption.slice(0, MAX_CAPTION_CHARS);
  return `${header}\n[Its caption reads: ${caption}]`;
}

/**
 * The note for a clip that couldn't be downloaded but has an oEmbed fallback — see the
 * `oEmbed` catch in `resolveClipParts`. No video part goes with this: it's text standing
 * in for a clip the model can't watch, not a description of one it can.
 */
function describeOEmbedFallback(meta, platform, link) {
  const facts = [];
  if (meta.authorName) facts.push(`posted by ${meta.authorName}`);
  const header = `[The ${platform} video at ${link} could not be downloaded, but its public ` +
    `listing says${facts.length ? ` (${facts.join(", ")})` : ""}:]`;
  const title = meta.title ? `[Title/caption: ${meta.title.slice(0, MAX_CAPTION_CHARS)}]` : null;
  return title ? `${header}\n${title}` : header;
}

/**
 * `[{role: "user"|"assistant", content: "..."}]` → Gemini's `contents` shape.
 *
 * A YouTube link in a *user* turn becomes a `file_data` part, so Gemini fetches and
 * watches the video itself — the same trick as the native-ingestion path in
 * GeminiVideoClient.swift, just without a dedicated transcription prompt.
 *
 * A TikTok or Instagram link becomes the clip itself, because Gemini will not go and
 * fetch one. The bytes are obtained beforehand by `resolveClipParts`, whose result is
 * passed in as `clips`; without it, those links are left as plain text and this function
 * stays pure.
 *
 * Two rules about which turns get media, both of which cost real money to get wrong:
 *
 * - **Each video is attached once**, at its first mention. It stays in context for the
 *   rest of the conversation, so re-attaching it on a later turn — which the user does
 *   simply by quoting the link again, or which happens on every turn of a long thread
 *   about one video — makes Gemini ingest the same video several times in a single
 *   request and bills for each. For an attached clip the bill is larger still: the bytes
 *   are in the request body, so a re-attach re-uploads the whole thing.
 * - **Never on an assistant turn.** A `model` turn is a record of what Gemini said, not
 *   an input to fetch; the API does not accept media there, and an assistant that quotes
 *   the user's link back would otherwise re-attach the video on every subsequent request.
 */
export function toGeminiContents(messages, { clips, attachVideos = true } = {}) {
  const attachedVideos = new Set();
  const attachedClips = new Set();
  const attachments = clips?.attachments ?? new Map();

  return messages.map((message) => {
    const isUser = message.role !== "assistant";
    const text = String(message.content ?? "");
    const parts = [];
    const notes = [];

    if (isUser) {
      for (const id of findYouTubeVideoIDs(text)) {
        if (attachedVideos.has(id)) continue;
        attachedVideos.add(id);
        // `attachVideos: false` is the repair round, which is a rewrite of an answer the
        // model can already see. Re-attaching would make Gemini fetch and watch the whole
        // video a second time to correct a citation — tens of seconds, and the single
        // largest avoidable cost in a turn, since the round is billed and timed like the
        // first one for no new information. The note replaces it so the model knows the
        // clip is not missing, only already seen.
        if (!attachVideos) {
          notes.push(
            `[The video at ${canonicalYouTubeURL(id)} was watched earlier in this turn. ` +
              `Work from what you already wrote about it.]`,
          );
          continue;
        }
        parts.push({ file_data: { file_uri: canonicalYouTubeURL(id) } });
      }

      // The same provider list the links were resolved with, so a caller that narrowed or
      // replaced it doesn't end up scanning for links its resolver never went and got.
      for (const { link, provider } of findClipLinks(text, clips?.providers ?? CLIP_PROVIDERS)) {
        const entry = attachments.get(link);
        if (!entry) continue;
        const platform = entry.platform ?? provider.platform;
        if (entry.error) {
          // Most reasons are already written as sentences; don't punctuate them twice.
          const reason = entry.error.replace(/\.\s*$/, "");
          notes.push(`[The ${platform} video at ${link} could not be attached: ${reason}.]`);
          continue;
        }
        if (attachedClips.has(entry.videoID)) continue;
        attachedClips.add(entry.videoID);
        if (entry.metadataOnly) {
          // The download failed and there's no oEmbed part to attach — the model gets a
          // caption and creator instead of a video it can watch.
          notes.push(describeOEmbedFallback(entry.metadataOnly, platform, link));
          continue;
        }
        parts.push(entry.part);
        const context = describeClip(entry.resolved, platform);
        if (context) notes.push(context);
      }
    }

    // Notes ride in the same text part rather than a separate one: Gemini concatenates
    // adjacent text parts anyway, and one part keeps the turn's shape unchanged for
    // every message that has nothing to annotate.
    parts.push({ text: notes.length > 0 ? `${text}\n\n${notes.join("\n")}` : text });
    return { role: isUser ? "user" : "model", parts };
  });
}

/**
 * The caller's abort signal, plus a timeout we can re-arm, as one signal to hand `fetch`.
 *
 * Kept as a small class rather than `AbortSignal.any([...AbortSignal.timeout()])` because
 * the idle timeout has to be *reset* on every chunk that arrives — a stream making steady
 * progress must never trip it — and because the two abort causes need telling apart: a
 * user closing the tab is a silent return, a stall is an error worth reporting.
 */
class StreamDeadline {
  constructor(callerSignal) {
    this.controller = new AbortController();
    this.callerSignal = callerSignal;
    this.timedOut = false;
    this.timer = null;

    if (callerSignal?.aborted) {
      this.controller.abort();
    } else if (callerSignal) {
      this.forward = () => this.controller.abort();
      callerSignal.addEventListener("abort", this.forward, { once: true });
    }
  }

  get signal() {
    return this.controller.signal;
  }

  /** True when the abort came from the caller rather than from a timeout. */
  get callerAborted() {
    return Boolean(this.callerSignal?.aborted);
  }

  /** (Re)start the clock. Called before the fetch and again on every chunk received. */
  arm(ms) {
    this.clear();
    if (!(ms > 0)) return;
    // Deliberately not `unref`'d. This timer is the only thing that ends a stalled
    // request, so it has to keep the event loop alive until it fires or is cleared —
    // and `clear()` runs on every exit path, so it can never outlive the request.
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, ms);
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose() {
    this.clear();
    if (this.forward) this.callerSignal.removeEventListener("abort", this.forward);
  }
}

/** Turn one `data:` line into the frames it implies. Throws on a refusal or early stop. */
function* framesFromLine(line) {
  if (!line.startsWith("data:")) return;

  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;

  let frame;
  try {
    frame = JSON.parse(payload);
  } catch {
    return; // A partial or non-JSON frame is not worth failing the stream over.
  }

  const blockReason = frame?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new GeminiError(`Gemini declined to answer (${blockReason}).`, { status: 502 });
  }

  const candidate = frame?.candidates?.[0];
  for (const part of candidate?.content?.parts ?? []) {
    // Thinking models attach an opaque `thoughtSignature` to the parts they produce, and
    // it has to travel back with the part it came on when that turn is replayed to the
    // model — see the note on `partsFrom` below for what dropping it costs. Carried on
    // every frame type, because which parts get one is the model's business, not ours.
    const signature = part.thoughtSignature ?? part.thought_signature;

    const hasText = typeof part.text === "string" && part.text.length > 0;
    const call = part.functionCall ?? part.function_call;

    // `signature` and `thought` are attached only when present, so the common frame — a
    // plain token from a model that isn't thinking — keeps the shape every consumer of
    // this stream already expects.
    if (hasText || (signature && !call?.name)) {
      const delta = { type: "delta", text: hasText ? part.text : "" };
      if (signature) delta.signature = signature;
      // `thought: true` marks a thinking summary rather than the answer. It still has to
      // be echoed back, but showing it to the reader as if it were the reply would put
      // the model's musings in the middle of a fact-check.
      if (part.thought === true) delta.thought = true;
      yield delta;
    }

    // A tool call arrives as a whole part, not a token at a time; `args` is already an
    // object here (Gemini sends structured arguments, not a JSON string like some APIs).
    if (call?.name) {
      const frame = { type: "function_call", call: { name: call.name, args: call.args ?? {} } };
      if (signature) frame.signature = signature;
      yield frame;
    }
  }

  const finish = candidate?.finishReason;
  // Hitting the output cap is not an error — the tokens that arrived are real and worth
  // keeping — but it is not a finished answer either, and it used to pass through here
  // indistinguishable from one. That silence is the expensive kind: a fact-check cut off
  // mid-sentence reads as a completed verdict, and the sentence it was cut off in is
  // frequently the one carrying the citation. Announced so the turn can be labelled
  // instead of quietly shipped as whole.
  if (finish === "MAX_TOKENS") {
    // Gemini reports where the tokens actually went on the frame that carries the finish
    // reason — `thoughtsTokenCount` against `candidatesTokenCount` is the real breakdown
    // between reasoning and the visible reply, in place of guessing at one from outside.
    // Worth keeping precisely because `thinkingBudgetTokens` is a guess about how the two
    // trade off; this is how that guess gets checked against what actually happened.
    const usage = frame?.usageMetadata;
    yield {
      type: "truncated",
      reason: "max_output_tokens",
      ...(usage
        ? {
            thoughtsTokens: usage.thoughtsTokenCount ?? 0,
            answerTokens: usage.candidatesTokenCount ?? 0,
            totalTokens: usage.totalTokenCount ?? null,
          }
        : {}),
    };
    return;
  }
  if (finish && finish !== "STOP") {
    throw new GeminiError(`Gemini stopped early (${finish}).`, { status: 502 });
  }
}

async function* parseSSE(body, deadline, idleTimeoutMs) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    if (deadline.signal.aborted) return;
    // Progress is being made — push the stall deadline back.
    deadline.arm(idleTimeoutMs);
    buffer += decoder.decode(chunk, { stream: true });

    // SSE frames are separated by a blank line, but Gemini emits one `data:` line per
    // frame, so splitting on newlines is enough and avoids buffering a whole frame.
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      yield* framesFromLine(line);
    }
  }

  // Flush whatever the decoder was holding and handle a last line that arrived without
  // its terminating newline — otherwise the final chunk of an answer is silently lost.
  buffer += decoder.decode();
  if (!deadline.signal.aborted) yield* framesFromLine(buffer.trim());
}

/**
 * How many rounds of tool calls one message may take before the model is made to answer.
 *
 * A *round* is one model call plus every tool call it asked for in that call. The searches
 * within a round run at once, so a round costs about one search, not one per claim — which
 * is what makes three rounds enough for a multi-claim video: everything worth looking up in
 * the first, a follow-up for the queries that landed badly in the second, the answer in the
 * third. The ceiling is on rounds rather than searches because rounds are what costs time:
 * each one re-sends the whole conversation, video included, and waits for a model that has
 * to read it again before it can say anything.
 */
export const MAX_TOOL_ROUNDS = 3;

/**
 * What the model is told when its tool budget is spent and it asked to search anyway.
 *
 * Withdrawing the declaration is usually enough — see the note at the call site — but
 * "usually" leaves a turn that ends with a tool call nobody will run and no answer in it,
 * which reaches the reader as sources with nothing underneath them. So the request is made
 * explicitly, in the conversation, where the model cannot miss it.
 */
const ANSWER_NOW =
  "You have used your search budget for this turn and the web_search tool is no longer " +
  "available. Do not ask for it again. Write your answer now, using only the sources " +
  "already retrieved above, and say plainly which parts you could not check.";

/**
 * Extra passes down the chain when every model in it was full, and the first wait between
 * them (doubling after that: 0.8s, then 1.6s).
 *
 * Two is chosen against the shape of the failure rather than by taste. A 503 sweep that
 * finds *every* model full is usually a capacity spike measured in seconds, so a couple of
 * short waits catches most of them; past that it is an outage, and more passes add failed
 * requests to a service already struggling while the user waits for a worse outcome. The
 * cost of getting it wrong is bounded — about 2.4 seconds — and it is only spent when the
 * alternative was failing the request outright.
 */
export const OVERLOAD_SWEEPS = 2;
export const OVERLOAD_BACKOFF_MS = 800;

/**
 * How long the answering round's output is held back before it starts reaching the reader,
 * in milliseconds — or 0, the default, to send every token as it arrives with no delay at
 * all. An operator setting, not a default: see `ANSWER_HOLD_MS` in `web/.env.example`.
 *
 * What this buys: right now, once the model has streamed even one token of the final
 * answer, that round cannot fail over to another model — a mid-stream stop is unrecoverable
 * by the time it happens, because the reader has already seen the start of an answer no
 * other model can now continue. And a mid-stream stop is not a rare shape of failure here.
 * Gemini ends a turn on `RECITATION` or `SAFETY` without warning, and this app's own design
 * makes that more likely than in an ordinary chat: `find_in_page` returns page passages
 * *verbatim* for the model to quote, and quoting a source closely is indistinguishable, to
 * a recitation filter, from reciting one.
 *
 * Turned on, the answering round's frames — the `model` announcement and every `delta` —
 * are buffered rather than yielded, for as long as `answerHoldMs` since the first one
 * arrived. If the stream fails inside that window, nothing has reached the reader yet, so
 * `walkChain` treats it exactly like a model that failed before answering at all: the
 * buffer is dropped and the next model in the chain is tried, in silence. Past the window
 * — or once the answer finishes, however short it turns out to be — everything held is
 * flushed at once and every frame after that goes straight through, unbuffered, same as
 * today. A failure after the window is unrecoverable exactly as it is now; the setting
 * only widens the recoverable window, it does not remove the seam.
 *
 * **Not every mid-stream failure is retried, even inside the window.** An idle timeout —
 * the model going silent rather than stopping outright — is excluded and stays exactly as
 * terminal as it is today, because of a property of `StreamDeadline` this feature does not
 * change: one deadline is shared across the whole message turn, its `AbortController` is
 * one-shot, and once the idle timer fires it, every later fetch on that same deadline —
 * including the next model this feature would otherwise try — is handed an
 * already-aborted signal and answers with nothing rather than a real attempt. Only a
 * stream that ends on its own account — RECITATION, SAFETY, a malformed frame — is safe to
 * retry, because nothing about the shared deadline needed it to fail.
 *
 * Deliberately scoped to the answering round alone — see the call site in `streamChat` —
 * not the earlier tool-calling rounds. Those rounds' own output is UI preamble the app
 * already discourages the model from writing at length, so there is little to protect and
 * delaying it would only add latency before the first search is dispatched, which is the
 * wait this app works hardest elsewhere to cut down.
 *
 * The cost of turning it on is exactly `answerHoldMs` added to the wait before the first
 * token of the answer appears, on every turn, whether or not that turn was ever going to
 * fail. That is a real, guaranteed delay paid to insure against a failure that — outside
 * heavy `find_in_page` use — is not the common case, which is why this defaults to off:
 * making that trade is an operator's call to make deliberately, not a default to absorb
 * silently into every request.
 */
export const DEFAULT_ANSWER_HOLD_MS = 0;

/**
 * The model's own turn, reassembled from the stream so it can be sent back verbatim.
 *
 * Verbatim is the whole point, and the reason this is a class rather than a string join.
 * Thinking models attach an opaque `thoughtSignature` to the parts they emit — most
 * importantly to `functionCall` parts — and the next request has to carry each signature
 * back **on the part it arrived on**. Rebuilding a call from just its name and arguments
 * silently drops it, and Gemini answers that with a warning and degraded tool use: the
 * model is being asked to continue a line of reasoning whose thread it can no longer pick
 * up. It is exactly the kind of failure this codebase keeps running into — nothing
 * errors, the answers just get worse.
 *
 * So parts are accumulated in arrival order, and a part is only merged into the one
 * before it when both are plain text with no signature between them. Anything carrying a
 * signature stays its own part, in its own place.
 */
class ModelTurn {
  constructor() {
    this._parts = [];
  }

  addText(text, signature, thought = false) {
    if (!text && !signature) return;
    const last = this._parts.at(-1);
    // Merge only into an open text part: one with no signature of its own, and on the
    // same side of the thinking/answer divide.
    const mergeable =
      last && typeof last.text === "string" && !last.thoughtSignature && Boolean(last.thought) === Boolean(thought);
    if (mergeable) {
      last.text += text;
      if (signature) last.thoughtSignature = signature;
      return;
    }
    const part = { text };
    if (thought) part.thought = true;
    if (signature) part.thoughtSignature = signature;
    this._parts.push(part);
  }

  addCall(call, signature) {
    const part = { functionCall: { name: call.name, args: call.args } };
    if (signature) part.thoughtSignature = signature;
    this._parts.push(part);
  }

  /** The parts, minus any that ended up empty and unsigned. */
  parts() {
    return this._parts.filter((part) => part.functionCall || part.text || part.thoughtSignature);
  }

  /**
   * The same, minus the tool calls — what the turn *said*, without what it asked for.
   *
   * Used for the one round where the calls are deliberately not run: replaying a
   * `functionCall` into a request that declares no tools invites a 400, and a call nobody
   * answered would sit in the history as a question the model is still waiting on.
   */
  spokenParts() {
    return this.parts().filter((part) => !part.functionCall);
  }
}

/**
 * Stream a chat completion, walking the model chain until one answers.
 *
 * Yields `{type: "model", model}` once a model accepts, then `{type: "delta", text}`
 * for each token chunk. Throws `GeminiError` on failure.
 *
 * When `tools` and `toolRunner` are supplied the model may call out mid-answer: a
 * `functionCall` part suspends the stream, `toolRunner` executes it, the result is
 * appended to the conversation and the model is called again with it. That loop runs up
 * to `maxToolRounds` times and is what lets the model search the web before answering.
 * `toolRunner(call, {signal})` returns `{response, frame}` — `response` goes back to the
 * model as the `functionResponse` payload, and `frame`, if present, is yielded to the
 * consumer so the UI can show what was searched.
 *
 * Every call a round asks for is dispatched at once and awaited in call order, and the
 * round announces itself first with `{type: "tool_start", calls}` so the consumer can show
 * what is in flight rather than only what has landed.
 */
export async function* streamChat({
  apiKey,
  messages,
  system,
  models = DEFAULT_MODEL_CHAIN,
  temperature = 0.7,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  // 0 or null opts out — sent as "don't include the field" rather than "thinkingBudget: 0",
  // since 0 has its own meaning to Gemini (disable thinking) that not every model may
  // accept, and this app has no live confirmation either way.
  thinkingBudgetTokens = DEFAULT_THINKING_BUDGET_TOKENS,
  toolRoundThinkingBudgetTokens = DEFAULT_TOOL_ROUND_THINKING_BUDGET_TOKENS,
  mediaResolution = null,
  signal,
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
  attachMedia = true,
  clipOptions = {},
  tools = null,
  toolRunner = null,
  maxToolRounds = MAX_TOOL_ROUNDS,
  health = modelHealth,
  budgetPressure = 0,
  overloadSweeps = OVERLOAD_SWEEPS,
  answerHoldMs = DEFAULT_ANSWER_HOLD_MS,
  sleep,
}) {
  const deadline = new StreamDeadline(signal);
  let clips = null;

  try {
    // Clips are fetched before the first model call, not per model: the bytes are the same
    // whichever model answers, and re-downloading them on each fall-through would turn one
    // slow link into four.
    if (attachMedia) {
      // Announced before it starts, because it is the longest silence in the request and
      // the one the user has least reason to expect: resolving a post, downloading a clip
      // and uploading it can run for tens of seconds before a single token exists to show
      // for it. Unreported, that is indistinguishable from the app having hung.
      if (
        messages.some(
          (m) => m?.role !== "assistant" && findClipLinks(String(m?.content ?? "")).length > 0,
        )
      ) {
        yield { type: "stage", stage: "attaching" };
      }
      clips = await resolveClipParts(messages, {
        apiKey,
        fetchImpl,
        signal,
        ...clipOptions,
      });
    }
    if (deadline.callerAborted) return;

    const contents = toGeminiContents(messages, { clips, attachVideos: attachMedia });
    // Whether the model has a video to watch. It changes what the wait *is* — Gemini
    // fetching and watching a clip before its first token is a different thing to report
    // than a model composing a sentence — and the reader is owed the difference.
    const media = contents.some((turn) =>
      turn.parts.some((part) => part.file_data || part.inline_data),
    );
    const useTools = Boolean(tools?.length && toolRunner);
    let announced = null;
    // Whether the model has already been told, in so many words, that its tools are gone.
    // Once is a nudge; twice would be a loop, and a loop here is unbounded model calls.
    let nudged = false;

    for (let round = 0; ; round += 1) {
      const requestBody = {
        contents,
        // camelCase per the REST reference. Checked against the live endpoint on
        // 2026-07-28: it accepts `maxOutputTokens` and `max_output_tokens` alike — the
        // protobuf JSON parser takes both the proto field name and its JSON name, which is
        // why the snake_case spelling in GeminiWire.swift is equally valid. A name it
        // genuinely doesn't know is rejected outright ("Unknown name ..."), not ignored, so
        // a typo here fails loudly rather than quietly dropping the cap.
        generationConfig: { temperature, maxOutputTokens },
      };
      if (system) {
        requestBody.systemInstruction = { parts: [{ text: system }] };
      }
      // Past the budget the tools are withdrawn rather than merely refused. A model handed
      // a tool it is told not to use will often try anyway; a model with no tool declared
      // answers with what it has, which is the outcome the budget exists to force.
      const toolsThisRound = useTools && round < maxToolRounds;
      if (toolsThisRound) requestBody.tools = tools;

      // A round that can still search is a round deciding *what* to look up; the round
      // that can't is the one writing the verdict. They get different reasoning budgets —
      // see `DEFAULT_TOOL_ROUND_THINKING_BUDGET_TOKENS`. Never above the caller's cap.
      const roundThinkingBudget =
        toolsThisRound && toolRoundThinkingBudgetTokens > 0
          ? Math.min(thinkingBudgetTokens, toolRoundThinkingBudgetTokens)
          : thinkingBudgetTokens;

      const calls = [];
      const turn = new ModelTurn();
      let thinkingAnnounced = false;

      for await (const frame of streamRound({
        requestBody,
        models,
        apiKey,
        fetchImpl,
        deadline,
        requestTimeoutMs,
        idleTimeoutMs,
        health,
        budgetPressure,
        round,
        media,
        thinkingBudgetTokens: roundThinkingBudget,
        mediaResolution: media ? mediaResolution : null,
        overloadSweeps,
        // Only the round that has no more tools to call is writing the verdict — see
        // `DEFAULT_ANSWER_HOLD_MS`. A tool round's own frames are never held: there is
        // little in them worth protecting, and holding them would add latency in front of
        // the searches instead of the answer.
        answerHoldMs: toolsThisRound ? 0 : answerHoldMs,
        // Only forwarded when the caller supplied one, so `streamRound` keeps its own
        // default rather than being handed `undefined` and losing it.
        ...(sleep ? { sleep } : {}),
      })) {
        if (frame.type === "function_call") {
          calls.push(frame.call);
          turn.addCall(frame.call, frame.signature);
          continue;
        }
        if (frame.type === "model") {
          // The chain is walked afresh each round, but the consumer only cares when the
          // answer changes hands — re-announcing the same model every round would make
          // the UI badge flicker for no reason. Keyed on the reason as well as the model,
          // so a round that lands on the same model for a *different* reason — quota now
          // rather than budget a moment ago — still updates what the badge says.
          const key = `${frame.model} ${frame.reason ?? ""}`;
          if (key === announced) continue;
          announced = key;
        }
        if (frame.type === "delta") {
          turn.addText(frame.text, frame.signature, frame.thought);
          // A thinking summary is part of the turn but not part of the answer — it is
          // withheld rather than shown, since the model's musings in the middle of a
          // fact-check read as findings. But withholding it silently means a model that
          // thinks for thirty seconds before its first search looks like a model doing
          // nothing, so the *fact* of it is reported even though the content is not.
          if (frame.thought || frame.text.length === 0) {
            if (frame.thought && !thinkingAnnounced) {
              thinkingAnnounced = true;
              yield { type: "stage", stage: "thinking", round };
            }
            continue;
          }
        }
        yield frame;
      }

      // A call with nothing to run it is not answerable — treat the turn as finished
      // rather than crashing on a runner that isn't there.
      if (calls.length === 0 || !useTools) return;
      if (deadline.callerAborted) return;

      // The budget is spent, the declaration was withdrawn, and the model asked anyway.
      // Running the call would restart a loop that has no ceiling of its own — every round
      // past this one is a further model call the user is waiting through, and the turn
      // ends with searches and no answer. So the calls are dropped, the request is put in
      // words once, and if that round asks again the turn ends with whatever it has.
      if (!toolsThisRound) {
        if (nudged) return;
        nudged = true;
        const spoken = turn.spokenParts();
        if (spoken.length > 0) contents.push({ role: "model", parts: spoken });
        contents.push({ role: "user", parts: [{ text: ANSWER_NOW }] });
        continue;
      }

      contents.push({ role: "model", parts: turn.parts() });

      // The searches a round asked for are announced before any of them has finished, so
      // the UI can say what is being looked up while it is being looked up rather than
      // after. Without this the reader watches a blank screen for the length of the
      // slowest search and then sees every chip appear at once.
      yield { type: "tool_start", calls: calls.map(({ name, args }) => ({ name, args })) };

      // Dispatched together, not one after another. The model is told it may ask for every
      // search it needs in a single round precisely so they can overlap here: four claims
      // now cost one search's worth of waiting rather than four. Results are still consumed
      // in call order, so the numbering in the ledger doesn't depend on which search won.
      const running = calls.map((call) => {
        const pending = Promise.resolve(toolRunner(call, { signal }));
        // A sibling failing first must not turn the rest of the round into unhandled
        // rejections; the real handling is the `await` below, which still throws.
        pending.catch(() => {});
        return pending;
      });

      const responseParts = [];
      for (const [index, call] of calls.entries()) {
        const { response, frame } = await running[index];
        if (frame) yield frame;
        responseParts.push({ functionResponse: { name: call.name, response } });
      }
      // Function results go back under `user`. Gemini's `Content.role` only accepts
      // `user` and `model`; the results are an input to the next turn, so they are the
      // user's side of it.
      contents.push({ role: "user", parts: responseParts });
    }
  } finally {
    deadline.dispose();
    // Runs on every exit — including the consumer abandoning the generator, which calls
    // `.return()` and lands here. Anything we put in the project's Files quota comes back
    // out, whether or not the answer arrived.
    await clips?.cleanup();
  }
}

/**
 * One request/response round: walk the model chain until one accepts, then stream it.
 *
 * Split out of `streamChat` when tool calling arrived, because a round is now something
 * that happens several times per message and the fall-through logic has to be identical
 * on each. The `deadline` is shared and owned by the caller — it spans the whole message.
 *
 * The chain is re-planned per round rather than once per message, on purpose: a round can
 * exhaust a model's quota, and the next round of the same answer should not then walk into
 * the 429 the previous one just learned about.
 */
async function* streamRound({
  requestBody,
  models,
  apiKey,
  fetchImpl,
  deadline,
  requestTimeoutMs,
  idleTimeoutMs,
  health,
  budgetPressure,
  round = 0,
  media = false,
  thinkingBudgetTokens = 0,
  mediaResolution = null,
  overloadSweeps = OVERLOAD_SWEEPS,
  answerHoldMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let lastError = null;
  // Set by `walkChain` so the loop below can tell its three endings apart: a model
  // answered, the caller went away, or the chain ran out.
  let answered = false;
  let abandoned = false;
  // Whether the pass that just finished found *every* model full, as opposed to hitting
  // some other failure. Only the first is worth waiting on.
  let allFull = false;

  // Finding every model full is a real state and usually a brief one: it is Google's
  // capacity in this second, not a fact about the key or the request. So the remedy is to
  // wait a moment and ask again, which is what the user would do by hand and what the old
  // behaviour — fail the whole turn on the first 503 — made them do by hand.
  //
  // Bounded by a fixed number of passes: past that it is an outage rather than a spike,
  // and more passes add failed requests to a service already struggling.
  for (let sweep = 0; ; sweep += 1) {
    allFull = false;
    yield* walkChain();
    if (answered || abandoned) return;
    if (!allFull || sweep >= overloadSweeps) break;

    const waitMs = OVERLOAD_BACKOFF_MS * 2 ** sweep;
    yield { type: "stage", stage: "busy", waitMs, attempt: sweep + 1 };
    await sleep(waitMs);
    if (deadline.callerAborted) return;
    // No need to clear what the pass just learned: `planChain` falls back to the whole
    // chain when every model in it is cooled, which is exactly the state we are in.
  }

  throw (
    lastError ??
    new GeminiError("No model in the chain was available for this API key.", { status: 502 })
  );

  /** One pass down the chain. Sets `answered` once a model has streamed its reply. */
  async function* walkChain() {
  const plan = planChain({ models, health, budgetPressure });
  // What this pass ran into, which is what decides whether another pass is worth making.
  let sawOverload = false;
  let sawOther = false;
  // Why we're not on the preferred model. Seeded from the plan — which knows about quota
  // learned on earlier requests and about budget pressure — and overwritten by anything we
  // learn the hard way while walking the chain below.
  let reason = plan.reason;
  let detail = plan.detail;
  let remainingMs = plan.skipped.find((s) => s.model === plan.preferred)?.remainingMs;

  // Indexed rather than `for…of` so one case can retry the *same* model — see the
  // `mediaResolution` branch below, which fixes the request rather than moving on from it.
  for (let index = 0; index < plan.models.length; index += 1) {
    const model = plan.models[index];
    if (deadline.callerAborted) return void (abandoned = true);
    const url = `${ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    // The gap between here and the first token is the longest unexplained pause in the
    // app — a model that has to fetch and watch a video before it says anything takes
    // tens of seconds, and there is deliberately no header deadline, so nothing else
    // marks the time. Reported per attempt, so walking the chain is visible too.
    yield { type: "stage", stage: "waiting", model, round, media };

    // Support for the field varies per model in the chain, so it is set (or removed)
    // freshly for whichever model this attempt is about to call — mutated in place on the
    // shared `requestBody` rather than cloned, since only one attempt is ever in flight
    // and the object is rebuilt from scratch at the top of every round anyway.
    if (thinkingBudgetTokens > 0 && supportsThinkingBudget(model)) {
      requestBody.generationConfig.thinkingConfig = { thinkingBudget: thinkingBudgetTokens };
    } else {
      delete requestBody.generationConfig.thinkingConfig;
    }

    // Same per-attempt treatment, for the same reason — and additionally dropped for a
    // model already caught refusing the field, so a wrong guess is paid for once.
    if (
      mediaResolution &&
      supportsThinkingBudget(model) &&
      !mediaResolutionRefused.has(model)
    ) {
      requestBody.generationConfig.mediaResolution = mediaResolution;
    } else {
      delete requestBody.generationConfig.mediaResolution;
    }

    let response;
    // No-ops unless a caller asked for a header deadline; there is no default one.
    deadline.arm(requestTimeoutMs);
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header rather than a `?key=` query param: query strings land in proxy and
          // server access logs, headers generally don't.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: deadline.signal,
      });
    } catch (error) {
      // The caller giving up is not a failure to report — it's what they asked for.
      if (deadline.callerAborted) return void (abandoned = true);
      if (deadline.timedOut) {
        throw new GeminiError(
          `Gemini did not respond within ${Math.round(requestTimeoutMs / 1000)}s. Try again shortly.`,
          { status: 504, model, retryable: true },
        );
      }
      throw new GeminiError(`Could not reach Gemini: ${error.message}`, {
        status: 502,
        model,
        retryable: true,
      });
    } finally {
      deadline.clear();
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = errorMessage(text, response.status);

      if (isQuotaFailure(response.status, message)) {
        // Remembered, so the *next* request skips this model instead of re-buying this
        // same 429. The cooldown is the server's own number where it gave one.
        const cooldownMs = retryAfterMs(response, text);
        const entry = health.markExhausted(model, { reason: REASONS.quota, detail: message, cooldownMs });
        reason = REASONS.quota;
        detail = message;
        remainingMs = entry.until - Date.now();
      } else if (isOverloadedFailure(response.status, message)) {
        // Remembered like a quota, on a much shorter clock: capacity comes back in
        // seconds, and a model held out of the chain after it recovered is an answer
        // quietly taken on a worse model for no reason.
        const cooldownMs = retryAfterMs(response, text) ?? OVERLOAD_COOLDOWN_MS;
        const entry = health.markExhausted(model, {
          reason: REASONS.overloaded,
          detail: message,
          cooldownMs,
        });
        reason = REASONS.overloaded;
        detail = message;
        remainingMs = entry.until - Date.now();
      } else if (isContextLimitFailure(response.status, message)) {
        reason = REASONS.context;
        detail = message;
      } else if (response.status === 404 || response.status === 403) {
        reason = REASONS.unavailable;
        detail = message;
      }

      // The one failure this app can repair by itself. `mediaResolution` is an optional
      // speed setting, not part of what was asked for, so a model refusing it is not a
      // reason to give up on that model — and *is* a reason to expect the next model in
      // the chain to refuse it too, which makes falling through the wrong move: the
      // operator would enable the setting and watch the whole chain fail. So the refusal
      // is remembered, the field is dropped, and the same model is asked again. The
      // memory is what makes this terminate: the second attempt cannot carry the field,
      // so it cannot be refused for this reason twice.
      if (isUnsupportedMediaResolution(response.status, message)) {
        const firstRefusal = !mediaResolutionRefused.has(model);
        mediaResolutionRefused.add(model);
        if (firstRefusal) {
          lastError = describeFailure(response.status, message, model);
          index -= 1;
          continue;
        }
      }

      if (isOverloadedFailure(response.status, message)) sawOverload = true;
      else sawOther = true;

      if (shouldFallThrough(response.status, message)) {
        lastError = describeFailure(response.status, message, model);
        continue;
      }
      throw describeFailure(response.status, message, model);
    }

    if (!response.body) {
      throw new GeminiError("Gemini returned an empty response body.", { status: 502, model });
    }

    // It answered, so whatever we believed about its quota is out of date.
    health.markHealthy(model);

    const degraded = model !== plan.preferred;
    const modelFrame = {
      type: "model",
      model,
      preferred: plan.preferred,
      degraded,
      reason: degraded ? (reason ?? REASONS.unavailable) : null,
      ...(degraded
        ? describeDegradation({
            reason: reason ?? REASONS.unavailable,
            preferred: plan.preferred,
            model,
            remainingMs,
            detail,
          })
        : { label: "", note: "" }),
    };

    // `answerHoldMs` — see its doc comment for what this buys and why it defaults to off.
    // Disabled, `flushed` starts true and every frame below is yielded exactly as it always
    // was: the model frame, then each delta as it arrives, with no buffering at all.
    const holdEnabled = answerHoldMs > 0;
    let held = [];
    let flushed = !holdEnabled;
    const windowStart = Date.now();

    if (flushed) yield modelFrame;
    else held.push(modelFrame);

    // The stall clock starts here and is pushed back by every chunk that arrives, so
    // a long answer is fine and a dead connection is not.
    deadline.arm(idleTimeoutMs);
    try {
      for await (const frame of parseSSE(response.body, deadline, idleTimeoutMs)) {
        if (flushed) {
          yield frame;
          continue;
        }
        held.push(frame);
        if (Date.now() - windowStart >= answerHoldMs) {
          flushed = true;
          yield* held;
          held = [];
        }
      }
    } catch (error) {
      if (deadline.callerAborted) return void (abandoned = true);
      // Checked before the unflushed fallback below, and deliberately excluded from it:
      // `deadline` is one `StreamDeadline` shared across the whole message turn (every
      // round, every model in every round's chain — see `streamChat`), and its
      // `AbortController` is one-shot. Once the idle timer fires and aborts it, that
      // abortedness is permanent for the rest of the turn: the *next* model's fetch is
      // handed the same already-aborted `deadline.signal`, and `parseSSE`'s first check
      // (`if (deadline.signal.aborted) return;`) then ends its stream having yielded
      // nothing at all — a silent, contentless "success" rather than a real answer. So an
      // idle timeout stays exactly as terminal as it always was, held or not; only a
      // stream that ends on its own account (RECITATION, SAFETY, a malformed frame) is
      // safe to retry silently, because nothing about the shared deadline needed it to
      // fail in the first place.
      if (deadline.timedOut) {
        throw new GeminiError(
          `Gemini stopped sending data for ${Math.round(idleTimeoutMs / 1000)}s. Try again shortly.`,
          { status: 504, model, retryable: true },
        );
      }
      if (!flushed) {
        // Nothing in `held` has reached the reader — no model badge, no token of the
        // answer, nothing — so silently trying the next model in the chain costs a few
        // seconds and nothing else. This is the case `answerHoldMs` exists for: Gemini
        // ending a stream on RECITATION or SAFETY, which it does without warning and
        // often within the first line, because the answer is built out of verbatim quotes
        // `find_in_page` was asked to return. Not an overload, so it must not be counted
        // as one — see `allFull` below.
        sawOther = true;
        lastError = error;
        continue;
      }
      throw error;
    }
    // A short answer can finish before ever crossing the hold window — nothing failed,
    // there was just never enough of it to trip the threshold. Whatever is still held gets
    // shown now rather than lost.
    if (!flushed) {
      yield* held;
      held = [];
    }
    // The stream is over, so the stall clock has nothing left to measure — and what comes
    // next is the tool round, which is *meant* to take seconds with no bytes arriving.
    // Left armed, the last chunk's deadline goes on running underneath the searches and
    // aborts the shared controller mid-turn: the sources arrive, the answer never does,
    // and nothing anywhere reports an error. Re-armed by the next round's own fetch.
    deadline.clear();
    answered = true;
    return;
  }

  // Every model refused. Whether that is worth waiting out is decided by *how* they
  // refused: all of them full is a moment to sit through, anything else is not.
  allFull = sawOverload && !sawOther;
}
}
