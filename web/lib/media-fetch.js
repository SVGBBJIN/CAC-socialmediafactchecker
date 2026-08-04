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

/* ---------------- Image posts ---------------- */

/**
 * How many slides of a carousel are fetched, however many it has.
 *
 * Both platforms allow up to 35. Every slide is a separate download *and* a separate image
 * the model has to read — Gemini bills each one, and a 35-slide post would cost more input
 * than the video posts this pipeline was built for. Twelve is past where a claim-carrying
 * slideshow has usually made its point, and the ones past it are named in the prompt rather
 * than silently dropped, so the model knows the post continues.
 */
export const MAX_IMAGE_SLIDES = 12;

/** Ceiling on a single slide. A photo-mode JPEG is 100-300 KB; past a few MB it isn't one. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Ceiling on the whole set, which is what actually has to fit in the request. */
export const MAX_IMAGE_SET_BYTES = 20 * 1024 * 1024;

/** How many slides are in flight at once. Enough to overlap, not enough to look like a scrape. */
const IMAGE_CONCURRENCY = 4;

/**
 * Fetch a post's image slides.
 *
 * Shared by both platforms because, unlike the video paths, there is nothing
 * platform-specific left once the URLs have been found: same allowlist check, same caps,
 * same "a slide that fails is one slide, not the post". Which URLs, which hosts are
 * allowed and which error type gets thrown are passed in, exactly as `readCapped` takes a
 * `tooLarge` factory.
 *
 * A failed slide is skipped rather than fatal. A carousel is a sequence of stills, and
 * eleven of twelve still says most of what the post says — where a video that half
 * downloads says nothing at all. Only an empty result is an error.
 *
 * @param images `[{url, width, height}]`, in slide order.
 * @param fetchOne runs one request and returns `{bytes, mimeType}` — the platform's own
 *   retrying, deadline-carrying fetch, so slides get the same treatment a clip does.
 */
export async function downloadImageSet(
  images,
  {
    fetchOne,
    allowedHosts,
    makeError,
    maxSlides = MAX_IMAGE_SLIDES,
    maxBytes = MAX_IMAGE_BYTES,
    maxSetBytes = MAX_IMAGE_SET_BYTES,
    concurrency = IMAGE_CONCURRENCY,
    signal,
  },
) {
  const wanted = images.slice(0, maxSlides);
  const results = new Array(wanted.length).fill(null);
  let setBytes = 0;

  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= wanted.length || signal?.aborted) return;
      const slide = wanted[index];

      let url;
      try {
        url = new URL(slide.url);
      } catch {
        continue;
      }
      // The same check the video path makes, for the same reason: these URLs come out of a
      // third party's JSON, so without it this would fetch whatever that JSON named.
      if (url.protocol !== "https:" || !hostAllowed(url.hostname, allowedHosts)) continue;
      // Already full. Stop paying for slides that can't be attached anyway.
      if (setBytes >= maxSetBytes) return;

      try {
        const { bytes, mimeType } = await fetchOne(url, { maxBytes });
        if (!bytes?.length) continue;
        if (setBytes + bytes.length > maxSetBytes) return;
        setBytes += bytes.length;
        results[index] = { bytes, mimeType, width: slide.width ?? null, height: slide.height ?? null };
      } catch {
        // One slide short is a worse post, not a failed one.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));

  const slides = results.filter(Boolean);
  if (slides.length === 0) {
    throw makeError("None of that post's images could be downloaded.");
  }
  return { slides, truncated: Math.max(0, images.length - slides.length) };
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
