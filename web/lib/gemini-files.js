// Gemini Files API — for clips too large to ride inline.
//
// Mirrors Sources/SeerCore/Gemini/GeminiFilesClient.swift.
//
// ## Why not always inline
//
// `generateContent` accepts media inline as base64, which is one request and no state —
// much the simpler path, and what the TikTok path does by default. But the whole request
// must stay under 20 MB and base64 inflates bytes by a third, so the real ceiling is
// about 14 MB of video. A 10-second TikTok is ~3 MB; a minute of it is not. Anything past
// the threshold has to go through Files.
//
// Files also has a property worth having on the larger clips: the upload is a separate
// request from the analysis, so walking the model chain re-sends a short URI rather than
// the bytes.
//
// ## Protocol
//
// A three-step resumable upload, driven by `X-Goog-Upload-*` headers rather than a
// request body:
//
// 1. `POST /upload/v1beta/files` with `command: start` → session URL in a response header
// 2. `POST <session URL>` with `command: upload, finalize` and the bytes → file metadata
// 3. `GET /v1beta/files/<name>` until `state` leaves `PROCESSING`
//
// Step 3 is not optional for video: the API returns immediately with `state: PROCESSING`
// and referencing the file before it turns `ACTIVE` fails the generate call.
//
// Uploaded files are deleted by Google after 48 hours, which is why nothing here tries to
// cache or reuse a URI across runs.

const UPLOAD_ENDPOINT = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const FILES_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

/** How long each individual upload leg may take. */
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * How the wait for ACTIVE is paced.
 *
 * This used to be a flat two seconds per poll, which is the right number for a file that
 * takes a while and the wrong one for the file this app actually uploads. A short-form
 * clip is typically ready within a few hundred milliseconds of finalizing, and a flat
 * interval cannot find that out sooner than its own length: the fast case paid a full two
 * seconds of doing nothing, every time, on the critical path before the model had even
 * been called.
 *
 * So the first look is quick and the interval grows from there — the fast case is caught
 * almost immediately, and a genuinely slow transcode still backs off to the same lazy
 * two-second cadence instead of hammering the API. `MAX_POLL_WAIT_MS` replaces the old
 * "60 polls" ceiling, because with a varying interval a count of polls no longer describes
 * how long anything waits; the bound people care about is the clock.
 */
export const POLL_INTERVAL_MS = 250;
export const MAX_POLL_INTERVAL_MS = 2_000;
export const POLL_BACKOFF = 1.6;
export const MAX_POLL_WAIT_MS = 120_000;

export class FilesError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "FilesError";
    this.retryable = retryable;
  }
}

function headerValue(headers, name) {
  // Case-insensitive on a real `Headers`, but tests hand in plain objects.
  if (typeof headers?.get === "function") return headers.get(name);
  if (!headers) return null;
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? headers[hit] : null;
}

/**
 * Both the finalize response and the poll response carry the same object, but the former
 * nests it under `file` and the latter returns it bare.
 */
export function parseFile(payload) {
  const body = payload?.file ?? payload ?? {};
  const name = body.name ?? payload?.name;
  const uri = body.uri ?? payload?.uri;
  if (!name || !uri) {
    throw new FilesError("Gemini Files response carried no file name or URI.");
  }
  return {
    name,
    uri,
    mimeType: body.mimeType ?? "video/mp4",
    // Absent state means the file is ready; only video reports PROCESSING.
    state: body.state ?? "ACTIVE",
  };
}

async function withTimeout(url, { fetchImpl, timeoutMs, signal, ...init }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function failure(response, step) {
  const text = await response.text?.().catch(() => "") ?? "";
  return new FilesError(
    `Gemini Files ${step} failed (HTTP ${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`,
    { retryable: response.status >= 500 || response.status === 429 },
  );
}

/**
 * Upload `bytes` and return once the API reports the file usable.
 *
 * `sleep` is injected so tests don't actually wait out the polling interval.
 */
export async function uploadFile(
  bytes,
  mimeType,
  {
    apiKey,
    fetchImpl = fetch,
    signal,
    displayName = "seer-clip",
    timeoutMs = UPLOAD_TIMEOUT_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
    maxPollIntervalMs = MAX_POLL_INTERVAL_MS,
    maxPollWaitMs = MAX_POLL_WAIT_MS,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  // 1. Start a resumable session.
  const start = await withTimeout(UPLOAD_ENDPOINT, {
    fetchImpl,
    signal,
    timeoutMs,
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(bytes.length),
      "x-goog-upload-header-content-type": mimeType,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!start.ok) throw await failure(start, "start");

  const sessionURL = headerValue(start.headers, "x-goog-upload-url");
  if (!sessionURL) {
    throw new FilesError("Gemini Files did not return an upload URL.");
  }

  // 2. Send everything and close the session in the same request. Chunked resume would
  //    matter for a multi-gigabyte upload; a clip already capped at tens of megabytes is
  //    cheaper to simply retry.
  const finalize = await withTimeout(sessionURL, {
    fetchImpl,
    signal,
    timeoutMs,
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "content-length": String(bytes.length),
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
    },
    body: bytes,
  });
  if (!finalize.ok) throw await failure(finalize, "upload");

  let file = parseFile(await finalize.json());

  // 3. Wait for it to leave PROCESSING, looking soon and then progressively less often.
  const deadline = now() + maxPollWaitMs;
  let interval = pollIntervalMs;
  for (;;) {
    if (file.state.toUpperCase() === "ACTIVE") return file;
    if (file.state.toUpperCase() !== "PROCESSING") {
      throw new FilesError(`Gemini Files upload finished in state ${file.state}.`);
    }
    if (now() >= deadline) break;

    await sleep(interval);
    interval = Math.min(Math.round(interval * POLL_BACKOFF), maxPollIntervalMs);
    if (signal?.aborted) throw new FilesError("Upload abandoned.", { retryable: false });

    const polled = await withTimeout(`${FILES_ENDPOINT}/${file.name}`, {
      fetchImpl,
      signal,
      timeoutMs,
      headers: { "x-goog-api-key": apiKey },
    });
    if (!polled.ok) throw await failure(polled, "status check");
    file = parseFile(await polled.json());
  }

  throw new FilesError("Gemini never finished processing the uploaded clip.", { retryable: true });
}

/**
 * Remove a file we uploaded.
 *
 * Best-effort: Google expires these after 48 hours anyway, so a failure here is not worth
 * surfacing over a successful analysis. But a fact-check run has no reason to leave a
 * stranger's video sitting in the project's file quota once it has been read.
 */
export async function deleteFile(file, { apiKey, fetchImpl = fetch }) {
  try {
    await fetchImpl(`${FILES_ENDPOINT}/${file.name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": apiKey },
    });
  } catch {
    // Deliberately silent.
  }
}
