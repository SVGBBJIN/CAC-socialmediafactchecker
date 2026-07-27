// Gemini chat client.
//
// Deliberately mirrors Sources/SeerCore/Gemini/GeminiModel.swift: the same ordered
// model chain, and the same rule for when a failure means "try the next model" rather
// than "give up". Model availability is not a constant — preview IDs get retired and a
// key's tier may not be entitled to the newest model — so pinning one ID breaks in the
// field. See the comments in GeminiModel.swift for the full reasoning.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

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

/** Pull a human-readable message out of an error body without assuming a shape. */
export function errorMessage(body, status) {
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error?.message) return parsed.error.message;
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // Not JSON; fall through to the raw body.
  }
  const text = String(body || "").slice(0, 500);
  return text || `HTTP ${status}`;
}

/**
 * Map an upstream status onto something the browser can act on, without ever leaking
 * the upstream body verbatim for auth failures (it can echo key fragments).
 */
function describeFailure(status, message, model) {
  if (status === 401 || (status === 403 && !shouldFallThrough(status, message))) {
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

  if (host.includes("youtu.be")) {
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
 * A message's parts: one `file_data` part per distinct YouTube link it mentions, so
 * Gemini fetches and watches the video itself — same trick as the native-ingestion path
 * in GeminiVideoClient.swift, just without a dedicated transcription prompt — plus the
 * text part.
 */
function partsFor(content) {
  const text = String(content ?? "");
  const parts = findYouTubeVideoIDs(text).map((id) => ({
    file_data: { file_uri: canonicalYouTubeURL(id) },
  }));
  parts.push({ text });
  return parts;
}

/** `[{role: "user"|"assistant", content: "..."}]` → Gemini's `contents` shape. */
export function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: partsFor(m.content),
  }));
}

async function* parseSSE(body, signal) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    if (signal?.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });

    // SSE frames are separated by a blank line, but Gemini emits one `data:` line per
    // frame, so splitting on newlines is enough and avoids buffering a whole frame.
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let frame;
      try {
        frame = JSON.parse(payload);
      } catch {
        continue; // A partial or non-JSON frame is not worth failing the stream over.
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
  }
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
  signal,
  fetchImpl = fetch,
}) {
  const requestBody = {
    contents: toGeminiContents(messages),
    generationConfig: { temperature },
  };
  if (system) {
    requestBody.systemInstruction = { parts: [{ text: system }] };
  }

  let lastError = null;

  for (const model of models) {
    const url = `${ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    let response;
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
        signal,
      });
    } catch (error) {
      if (signal?.aborted) return;
      throw new GeminiError(`Could not reach Gemini: ${error.message}`, {
        status: 502,
        model,
        retryable: true,
      });
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
    yield* parseSSE(response.body, signal);
    return;
  }

  throw (
    lastError ??
    new GeminiError("No model in the chain was available for this API key.", { status: 502 })
  );
}
