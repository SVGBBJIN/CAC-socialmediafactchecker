// The plumbing every "fetch a clip off someone's CDN" path needs, in one place.
//
// Extracted from lib/tiktok.js when Instagram arrived and wanted the identical three
// things: a fetch with a deadline, a host allowlist, and a read that refuses to buffer
// past a ceiling. None of it is platform-specific — what *is* platform-specific is which
// hosts are allowed and which error type gets thrown, so both are passed in.
//
// The error injection is the reason `readCapped` takes a factory rather than throwing
// something generic: each platform's caller already distinguishes "this link will never
// work" from "try again" through its own error class, and a shared helper that threw a
// plain Error would erase that distinction exactly where the size check fires.

/**
 * One fetch with a deadline, cleaned up on every exit path.
 *
 * The deadline covers *getting a response*, and nothing after it — which is right for the
 * JSON and HTML fetches, whose body is a few KB that arrives with the headers, and wrong
 * for a video. Use `fetchStream` for anything whose body is the point.
 */
export async function fetchWithTimeout(url, { fetchImpl, timeoutMs, signal, ...init }) {
  const { response, release } = await fetchStream(url, { fetchImpl, timeoutMs, signal, ...init });
  release();
  return response;
}

/**
 * A fetch whose deadline stays armed while the body is read.
 *
 * `fetchWithTimeout` disarms at the headers: it clears its timer and unsubscribes from the
 * caller's signal the moment a response object exists. For a 24 KB embed page that is
 * fine. For a 40 MB MP4 it means the part that actually takes time — the transfer — ran
 * with no deadline and no cancellation at all, so a CDN that answered `200 OK` and then
 * stopped sending held the request until the platform killed the function. Both
 * downloaders take the whole file this way, which made it the longest hang in the pipeline
 * and the one nothing upstream could interrupt.
 *
 * So the timer and the abort subscription live until `release()`, which the caller must
 * invoke once the body has been read or abandoned. Aborting the controller cancels the
 * transfer in flight rather than merely rejecting the wrapper.
 *
 * @returns `{ response, release }`.
 */
export async function fetchStream(url, { fetchImpl, timeoutMs, signal, ...init }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  // Not unref'd: this timer is the only thing that will end a stalled transfer, and a
  // timer the event loop is free to skip is not a deadline. `release()` clears it on every
  // path out, so it never outlives the request it belongs to.
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { response, release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Whether a hostname is one of `allowed`, matched as a domain suffix.
 *
 * Suffix, never substring, so `tiktokcdn.com.evil.test` is not a match for
 * `tiktokcdn.com`. This is the check standing between a URL read out of a third party's
 * JSON and our process fetching whatever that JSON named.
 */
export function hostAllowed(hostname, allowed) {
  const host = String(hostname ?? "").toLowerCase();
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Longest a transfer may go without delivering a single byte.
 *
 * Distinct from the overall deadline on purpose. A large clip on a slow connection is
 * legitimately several seconds per chunk and should be allowed to finish; a socket that
 * has gone quiet is not going to recover, and waiting the full media timeout to find that
 * out is a minute of nothing. Whichever fires first ends the read.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 20_000;

/**
 * Read a response body, refusing to buffer past `maxBytes`.
 *
 * The declared length is checked first so an absurd file is refused before the transfer
 * starts; the running total then covers a response that lied or sent no length at all.
 * Throwing out of the read cancels the underlying stream, so the rest of the file is never
 * pulled down — which matters in a serverless function, where the buffer is charged
 * against a fixed memory ceiling.
 *
 * The stall guard is enforced here, on the iteration, rather than left to the fetch's
 * abort signal. Both are wired up (see `fetchStream`), and the belt is worth the braces:
 * this one holds for any body that iterates, including a stream implementation that
 * ignores its signal, and it is the one that can be tested without a live socket.
 *
 * @param tooLarge builds the platform's own error from a message string.
 */
export async function readCapped(
  response,
  maxBytes,
  tooLarge,
  { stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS, onStall } = {},
) {
  const declared = Number(response.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(
      `That clip is ${Math.round(declared / 1_048_576)} MB, over the ` +
        `${Math.round(maxBytes / 1_048_576)} MB limit.`,
    );
  }

  const iterator = response.body[Symbol.asyncIterator]
    ? response.body[Symbol.asyncIterator]()
    : response.body;

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const next = stallTimeoutMs
        ? await withStallGuard(iterator.next(), stallTimeoutMs, onStall)
        : await iterator.next();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength ?? chunk.length ?? 0;
      if (total > maxBytes) {
        throw tooLarge(`That clip is over the ${Math.round(maxBytes / 1_048_576)} MB limit.`);
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    // Ends the stream on every path out that isn't exhaustion — the size refusals above,
    // a stall, an abort — so an abandoned transfer stops rather than draining in the
    // background against a function that has already answered.
    //
    // Started but not awaited, deliberately. The case that brings us here most often is a
    // transfer that has stopped responding, and closing a source that is itself stuck can
    // hang exactly as long as reading it would have: waiting for the cancel would give the
    // stall guard back the wait it just refused. A rejection is swallowed for the same
    // reason — closing a stream that is already closed is not news.
    try {
      iterator.return?.()?.catch?.(() => {});
    } catch {
      // A synchronous throw from `return()` is no more interesting than an async one.
    }
  }
  return Buffer.concat(chunks);
}

/** A `StalledTransferError` is a transport hiccup: the platform layer marks it retryable. */
export class StalledTransferError extends Error {
  constructor(ms) {
    super(`the transfer stalled — no data for ${Math.round(ms / 1000)}s`);
    this.name = "StalledTransferError";
  }
}

async function withStallGuard(pending, stallTimeoutMs, onStall) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onStall?.();
          reject(new StalledTransferError(stallTimeoutMs));
        }, stallTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
