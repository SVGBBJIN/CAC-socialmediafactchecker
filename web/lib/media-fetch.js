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

/** One fetch with a deadline, cleaned up on every exit path. */
export async function fetchWithTimeout(url, { fetchImpl, timeoutMs, signal, ...init }) {
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
 * Read a response body, refusing to buffer past `maxBytes`.
 *
 * The declared length is checked first so an absurd file is refused before the transfer
 * starts; the running total then covers a response that lied or sent no length at all.
 * Throwing out of `for await` cancels the underlying stream, so the rest of the file is
 * never pulled down — which matters in a serverless function, where the buffer is charged
 * against a fixed memory ceiling.
 *
 * @param tooLarge builds the platform's own error from a message string.
 */
export async function readCapped(response, maxBytes, tooLarge) {
  const declared = Number(response.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(
      `That clip is ${Math.round(declared / 1_048_576)} MB, over the ` +
        `${Math.round(maxBytes / 1_048_576)} MB limit.`,
    );
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength ?? chunk.length ?? 0;
    if (total > maxBytes) {
      throw tooLarge(`That clip is over the ${Math.round(maxBytes / 1_048_576)} MB limit.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
