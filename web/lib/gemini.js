// Gemini chat client.
//
// Deliberately mirrors Sources/SeerCore/Gemini/GeminiModel.swift: the same ordered
// model chain, and the same rule for when a failure means "try the next model" rather
// than "give up". Model availability is not a constant — preview IDs get retired and a
// key's tier may not be entitled to the newest model — so pinning one ID breaks in the
// field. See the comments in GeminiModel.swift for the full reasoning.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * How long to wait for response headers from one model before giving up on it, and how
 * long the stream may sit silent afterwards.
 *
 * Both matter because there is no other ceiling: `fetch` without a signal waits
 * indefinitely, so a connection that opens and then stalls holds the request — and, on
 * Vercel, the function instance behind it — until the platform kills it. The two limits
 * are separate because they cover different things: headers come back in well under a
 * second, but the first token on a video Gemini has to watch legitimately takes a while.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

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
 * - Everything else (401 bad key, 429 quota, 5xx) is terminal here — falling through
 *   would spend the same broken credential four more times.
 */
export function shouldFallThrough(status, message = "") {
  if (status === 404 || status === 403) return true;
  if (status !== 400) return false;
  const lowered = message.toLowerCase();
  return (
    lowered.includes("not found") ||
    lowered.includes("not supported") ||
    lowered.includes("unsupported") ||
    lowered.includes("invalid model")
  );
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
  if (status === 429) {
    return new GeminiError("Gemini quota or rate limit reached. Try again shortly.", {
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
 * `[{role: "user"|"assistant", content: "..."}]` → Gemini's `contents` shape.
 *
 * A YouTube link in a *user* turn becomes a `file_data` part, so Gemini fetches and
 * watches the video itself — the same trick as the native-ingestion path in
 * GeminiVideoClient.swift, just without a dedicated transcription prompt.
 *
 * Two rules about which turns get one, both of which cost real money to get wrong:
 *
 * - **Each video is attached once**, at its first mention. It stays in context for the
 *   rest of the conversation, so re-attaching it on a later turn — which the user does
 *   simply by quoting the link again, or which happens on every turn of a long thread
 *   about one video — makes Gemini ingest the same video several times in a single
 *   request and bills for each.
 * - **Never on an assistant turn.** A `model` turn is a record of what Gemini said, not
 *   an input to fetch; the API does not accept media there, and an assistant that quotes
 *   the user's link back would otherwise re-attach the video on every subsequent request.
 */
export function toGeminiContents(messages) {
  const attached = new Set();

  return messages.map((message) => {
    const isUser = message.role !== "assistant";
    const text = String(message.content ?? "");
    const parts = [];

    if (isUser) {
      for (const id of findYouTubeVideoIDs(text)) {
        if (attached.has(id)) continue;
        attached.add(id);
        parts.push({ file_data: { file_uri: canonicalYouTubeURL(id) } });
      }
    }

    parts.push({ text });
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
    if (typeof part.text === "string" && part.text.length > 0) {
      yield { type: "delta", text: part.text };
    }
  }

  const finish = candidate?.finishReason;
  if (finish && finish !== "STOP" && finish !== "MAX_TOKENS") {
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
 * Stream a chat completion, walking the model chain until one answers.
 *
 * Yields `{type: "model", model}` once a model accepts, then `{type: "delta", text}`
 * for each token chunk. Throws `GeminiError` on failure.
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
}) {
  const requestBody = {
    contents: toGeminiContents(messages),
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

  const deadline = new StreamDeadline(signal);
  let lastError = null;

  try {
    for (const model of models) {
      if (deadline.callerAborted) return;
      const url = `${ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

      let response;
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
        if (shouldFallThrough(response.status, message)) {
          lastError = describeFailure(response.status, message, model);
          continue;
        }
        throw describeFailure(response.status, message, model);
      }

      if (!response.body) {
        throw new GeminiError("Gemini returned an empty response body.", { status: 502, model });
      }

      yield { type: "model", model };

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
      return;
    }

    throw (
      lastError ??
      new GeminiError("No model in the chain was available for this API key.", { status: 502 })
    );
  } finally {
    deadline.dispose();
  }
}
