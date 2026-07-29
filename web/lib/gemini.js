// Gemini chat client.
//
// Deliberately mirrors Sources/SeerCore/Gemini/GeminiModel.swift: the same ordered
// model chain, and the same rule for when a failure means "try the next model" rather
// than "give up". Model availability is not a constant — preview IDs get retired and a
// key's tier may not be entitled to the newest model — so pinning one ID breaks in the
// field. See the comments in GeminiModel.swift for the full reasoning.

import {
  findTikTokLinks,
  resolveTikTokVideo,
  downloadTikTokMedia,
  INLINE_BYTE_LIMIT,
} from "./tiktok.js";
import { uploadFile, deleteFile } from "./gemini-files.js";
import {
  modelHealth,
  planChain,
  describeDegradation,
  REASONS,
  MAX_COOLDOWN_MS,
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
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

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
 * - Everything else (401/`API_KEY_INVALID`, 5xx) is terminal here — falling through would
 *   spend the same broken credential four more times, or hammer an outage.
 */
export function shouldFallThrough(status, message = "") {
  // Checked before anything else: a bad key arrives as a 400 or 403 (see
  // `isInvalidKeyFailure`), both of which the rules below would otherwise wave through.
  if (isInvalidKeyFailure(status, message)) return false;
  if (status === 404 || status === 403) return true;
  if (isQuotaFailure(status, message)) return true;
  if (isContextLimitFailure(status, message)) return true;
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
 * How many TikTok clips one request will fetch, however many are pasted.
 *
 * Unlike a YouTube link — which costs us a URL string and lets Gemini do the fetching —
 * every TikTok costs a download, a base64 copy and, past the inline ceiling, an upload.
 * Ten links in one message is ten of those. A cap keeps a single paste from becoming a
 * bandwidth and quota event; links past it get a note rather than silence.
 */
export const MAX_TIKTOK_ATTACHMENTS = 2;

/** Captions are user-authored and can run long; this is context, not the payload. */
const MAX_CAPTION_CHARS = 500;

/**
 * Resolve every TikTok link in the conversation to a Gemini part.
 *
 * Kept separate from `toGeminiContents` on purpose. That function is pure, synchronous
 * and covers the rule that actually costs money (attach each video exactly once); this
 * one does the network work. Splitting them means the expensive, order-sensitive logic
 * stays testable without a single stubbed fetch, and the I/O stays testable without
 * reasoning about turn structure.
 *
 * Nothing here throws for a video it couldn't get. A private, deleted or region-blocked
 * TikTok is a normal thing to paste, and failing the whole message over it would take the
 * rest of the conversation down with it — so the failure is recorded and surfaces as a
 * note in the prompt, letting the model say *why* it can't discuss the clip.
 *
 * @returns `{attachments, cleanup}` — `attachments` maps each link to either a Gemini
 *   part or an `error` string; `cleanup` removes anything uploaded to the Files API and
 *   must be awaited once the request is done.
 */
export async function resolveTikTokParts(
  messages,
  {
    apiKey,
    fetchImpl = fetch,
    signal,
    inlineByteLimit = INLINE_BYTE_LIMIT,
    maxAttachments = MAX_TIKTOK_ATTACHMENTS,
    resolveImpl = resolveTikTokVideo,
    downloadImpl = downloadTikTokMedia,
    uploadImpl = uploadFile,
    deleteImpl = deleteFile,
  } = {},
) {
  const attachments = new Map();
  const uploads = [];
  const cleanup = async () => {
    for (const file of uploads.splice(0)) await deleteImpl(file, { apiKey, fetchImpl });
  };

  // Assistant turns are excluded for the same reason they carry no media below: a model
  // turn quoting the user's link back is not a request to go and fetch it.
  const links = [];
  const seenLink = new Set();
  for (const message of messages) {
    if (message?.role === "assistant") continue;
    for (const link of findTikTokLinks(String(message?.content ?? ""))) {
      if (seenLink.has(link)) continue;
      seenLink.add(link);
      links.push(link);
    }
  }
  if (links.length === 0) return { attachments, cleanup };

  const byVideoID = new Map();

  for (const link of links) {
    if (signal?.aborted) break;

    if (byVideoID.size >= maxAttachments) {
      attachments.set(link, {
        error: `only the first ${maxAttachments} TikTok video${
          maxAttachments === 1 ? "" : "s"
        } in a message are fetched`,
      });
      continue;
    }

    try {
      const resolved = await resolveImpl(link, { fetchImpl, signal });

      // A short link and the canonical URL it redirects to are the same video. Caught
      // here rather than by URL, because that equality is only knowable after the
      // redirect has been followed.
      const existing = byVideoID.get(resolved.videoID);
      if (existing) {
        attachments.set(link, existing);
        continue;
      }

      const { bytes, mimeType } = await downloadImpl(resolved, { fetchImpl, signal });

      let part;
      if (bytes.length <= inlineByteLimit) {
        part = { inline_data: { mime_type: mimeType, data: bytes.toString("base64") } };
      } else {
        const file = await uploadImpl(bytes, mimeType, { apiKey, fetchImpl, signal });
        uploads.push(file);
        part = { file_data: { file_uri: file.uri, mime_type: file.mimeType } };
      }

      const entry = { videoID: resolved.videoID, part, resolved };
      byVideoID.set(resolved.videoID, entry);
      attachments.set(link, entry);
    } catch (error) {
      if (signal?.aborted) break;
      attachments.set(link, { error: error?.message || "the video could not be fetched" });
    }
  }

  return { attachments, cleanup };
}

/**
 * What the embed page told us about a clip, as a line of prompt context.
 *
 * The caption is worth passing on its own account: on short-form political content it is
 * frequently *the* claim, while the video is B-roll. Marked as the caption rather than
 * folded into the user's text, so the model can attribute it — the same distinction
 * `DirectMediaExtractor.mergeOnScreenText` draws on the Swift side.
 */
function describeClip(resolved) {
  if (!resolved) return null;
  const facts = [];
  if (resolved.authorName) facts.push(`posted by ${resolved.authorName}`);
  if (resolved.duration) facts.push(`${Math.round(resolved.duration)}s`);

  const header = `[Attached: the TikTok video from ${resolved.sourceURL}${
    facts.length ? ` — ${facts.join(", ")}` : ""
  }.]`;
  if (!resolved.caption) return header;

  const caption = resolved.caption.slice(0, MAX_CAPTION_CHARS);
  return `${header}\n[Its caption reads: ${caption}]`;
}

/**
 * `[{role: "user"|"assistant", content: "..."}]` → Gemini's `contents` shape.
 *
 * A YouTube link in a *user* turn becomes a `file_data` part, so Gemini fetches and
 * watches the video itself — the same trick as the native-ingestion path in
 * GeminiVideoClient.swift, just without a dedicated transcription prompt.
 *
 * A TikTok link becomes the clip itself, because Gemini will not go and fetch one. The
 * bytes are obtained beforehand by `resolveTikTokParts`, whose result is passed in as
 * `tikTok`; without it, TikTok links are left as plain text and this function stays pure.
 *
 * Two rules about which turns get media, both of which cost real money to get wrong:
 *
 * - **Each video is attached once**, at its first mention. It stays in context for the
 *   rest of the conversation, so re-attaching it on a later turn — which the user does
 *   simply by quoting the link again, or which happens on every turn of a long thread
 *   about one video — makes Gemini ingest the same video several times in a single
 *   request and bills for each. For TikTok the bill is larger still: the bytes are in the
 *   request body, so a re-attach re-uploads the whole clip.
 * - **Never on an assistant turn.** A `model` turn is a record of what Gemini said, not
 *   an input to fetch; the API does not accept media there, and an assistant that quotes
 *   the user's link back would otherwise re-attach the video on every subsequent request.
 */
export function toGeminiContents(messages, { tikTok } = {}) {
  const attachedVideos = new Set();
  const attachedClips = new Set();
  const clips = tikTok?.attachments ?? new Map();

  return messages.map((message) => {
    const isUser = message.role !== "assistant";
    const text = String(message.content ?? "");
    const parts = [];
    const notes = [];

    if (isUser) {
      for (const id of findYouTubeVideoIDs(text)) {
        if (attachedVideos.has(id)) continue;
        attachedVideos.add(id);
        parts.push({ file_data: { file_uri: canonicalYouTubeURL(id) } });
      }

      for (const link of findTikTokLinks(text)) {
        const entry = clips.get(link);
        if (!entry) continue;
        if (entry.error) {
          // Most reasons are already written as sentences; don't punctuate them twice.
          const reason = entry.error.replace(/\.\s*$/, "");
          notes.push(`[The TikTok video at ${link} could not be attached: ${reason}.]`);
          continue;
        }
        if (attachedClips.has(entry.videoID)) continue;
        attachedClips.add(entry.videoID);
        parts.push(entry.part);
        const context = describeClip(entry.resolved);
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
    yield { type: "truncated", reason: "max_output_tokens" };
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
  signal,
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
  attachTikTok = true,
  tikTokOptions = {},
  tools = null,
  toolRunner = null,
  maxToolRounds = MAX_TOOL_ROUNDS,
  health = modelHealth,
  budgetPressure = 0,
}) {
  const deadline = new StreamDeadline(signal);
  let tikTok = null;

  try {
    // TikTok clips are fetched before the first model call, not per model: the bytes are
    // the same whichever model answers, and re-downloading them on each fall-through
    // would turn one slow link into four.
    if (attachTikTok) {
      tikTok = await resolveTikTokParts(messages, {
        apiKey,
        fetchImpl,
        signal,
        ...tikTokOptions,
      });
    }
    if (deadline.callerAborted) return;

    const contents = toGeminiContents(messages, { tikTok });
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

      const calls = [];
      const turn = new ModelTurn();

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
          const key = `${frame.model} ${frame.reason ?? ""}`;
          if (key === announced) continue;
          announced = key;
        }
        if (frame.type === "delta") {
          turn.addText(frame.text, frame.signature, frame.thought);
          // A thinking summary is part of the turn but not part of the answer.
          if (frame.thought || frame.text.length === 0) continue;
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
    await tikTok?.cleanup();
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
}) {
  let lastError = null;

  const plan = planChain({ models, health, budgetPressure });
  // Why we're not on the preferred model. Seeded from the plan — which knows about quota
  // learned on earlier requests and about budget pressure — and overwritten by anything we
  // learn the hard way while walking the chain below.
  let reason = plan.reason;
  let detail = plan.detail;
  let remainingMs = plan.skipped.find((s) => s.model === plan.preferred)?.remainingMs;

  for (const model of plan.models) {
    if (deadline.callerAborted) return;
    const url = `${ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

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
      if (deadline.callerAborted) return;
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
      } else if (isContextLimitFailure(response.status, message)) {
        reason = REASONS.context;
        detail = message;
      } else if (response.status === 404 || response.status === 403) {
        reason = REASONS.unavailable;
        detail = message;
      }

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
    yield {
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

    // The stall clock starts here and is pushed back by every chunk that arrives, so
    // a long answer is fine and a dead connection is not.
    deadline.arm(idleTimeoutMs);
    try {
      yield* parseSSE(response.body, deadline, idleTimeoutMs);
    } catch (error) {
      if (deadline.callerAborted) return;
      if (deadline.timedOut) {
        throw new GeminiError(
          `Gemini stopped sending data for ${Math.round(idleTimeoutMs / 1000)}s. Try again shortly.`,
          { status: 504, model, retryable: true },
        );
      }
      throw error;
    }
    // The stream is over, so the stall clock has nothing left to measure — and what comes
    // next is the tool round, which is *meant* to take seconds with no bytes arriving.
    // Left armed, the last chunk's deadline goes on running underneath the searches and
    // aborts the shared controller mid-turn: the sources arrive, the answer never does,
    // and nothing anywhere reports an error. Re-armed by the next round's own fetch.
    deadline.clear();
    return;
  }

  throw (
    lastError ??
    new GeminiError("No model in the chain was available for this API key.", { status: 502 })
  );
}
