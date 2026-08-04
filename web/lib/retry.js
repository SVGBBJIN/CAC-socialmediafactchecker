// Retrying the platform fetches that fail for reasons that pass.
//
// Mirrors Sources/SeerCore/Networking/RetryPolicy.swift: exponential backoff with full
// jitter, a ceiling per delay, and a ceiling on the whole operation. Read that file for
// the reasoning behind full jitter; the short version is that share sheets cluster — a
// user pastes three links at once, or a whole cohort hits the same rate limit — and
// unjittered retries just reconverge on the same instant.
//
// ## Why this exists at all
//
// `TikTokError` and `InstagramError` have carried a `retryable` flag since they were
// written, and it was set carefully: a 429 from Instagram's GraphQL endpoint, a 5xx from
// TikTok's embed host and a socket that died mid-download were all marked as "try again",
// and told apart from "this link will never work". Nothing ever tried again. The flag was
// read exactly once, to decide whether `resolveClipParts` should mention the failure — so
// the single most common failure on both platforms (an anonymous request throttled from a
// datacenter IP) cost the user their video on the first refusal.
//
// ## What it deliberately does not do
//
// It does not retry a *decision*. A private post, a photo carousel, a deleted video and a
// rotated `doc_id` are answers, and asking again changes nothing but the bill. Only errors
// that say `retryable` are repeated, which keeps the judgement about what is transient
// where it belongs: next to the status code that produced it.

/** Retries after the first attempt, per step. Three total calls at the default. */
export const DEFAULT_RETRIES = 2;

/** First backoff, doubled per retry. */
export const DEFAULT_BASE_DELAY_MS = 400;

/** Ceiling on any single backoff, before jitter. */
export const DEFAULT_MAX_DELAY_MS = 4_000;

/**
 * Ceiling on a whole retried step, backoffs included.
 *
 * Retrying is only worth doing while somebody is still waiting for the answer. This is
 * what stops three attempts at a 60-second download from becoming a three-minute silence:
 * once the elapsed time plus the next backoff would pass this, the last error is thrown
 * rather than slept on.
 */
export const DEFAULT_BUDGET_MS = 45_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Errors that said so themselves. Anything else is a decision, not a hiccup. */
const defaultIsRetryable = (error) => error?.retryable === true;

/**
 * The backoff before retry number `attempt` (1-based), with full jitter.
 *
 * Full jitter — a uniform draw from `[0, capped]` rather than the capped value itself —
 * is the same choice `RetryPolicy.delay(forAttempt:)` makes, and `randomness` is injectable
 * for the same reason: a backoff schedule that can't be asserted on is a backoff schedule
 * nobody notices has stopped backing off.
 */
export function backoffDelay(
  attempt,
  { baseMs = DEFAULT_BASE_DELAY_MS, maxMs = DEFAULT_MAX_DELAY_MS, randomness = Math.random() } = {},
) {
  if (attempt <= 0) return 0;
  const capped = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  return Math.round(capped * Math.max(0, Math.min(1, randomness)));
}

/**
 * `Retry-After` as milliseconds, in either spelling the header allows.
 *
 * Both platforms send it on a 429, and a server that has said how long to wait knows
 * better than our backoff curve does. Returns null for a missing, unparseable or absurd
 * value — a header asking us to wait an hour is not something to honour inside a request
 * somebody is watching, so the caller caps it against its own budget.
 */
export function retryAfterMs(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return null;

  const seconds = Number(String(raw).trim());
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;

  const at = Date.parse(String(raw));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - Date.now());
}

/**
 * Run `operation`, repeating it while it fails in a way that says to.
 *
 * `operation` is handed `{ attempt, remainingMs }`. `attempt` is 0-based, so a caller can
 * tell a first try from a repeat — which is what lets the Instagram path re-seed its
 * session on the second go rather than replaying a request with a token that has already
 * been refused. `remainingMs` is what is left of `budgetMs`, so a step with its own
 * per-attempt deadline can shrink it to fit: without that, three attempts at a 60-second
 * download can run for three minutes inside a 75-second budget, because the budget is only
 * ever consulted between attempts.
 *
 * An abort is never a retry: a caller that has gone away is not waiting for a better
 * answer, and the signal is checked both before an attempt and after a failure so a
 * cancelled request stops inside the backoff rather than at the end of it.
 *
 * @param retryAfterMs pulled off `error.retryAfterMs` when the thrower knew — see
 *   `retryAfterMs` above. Server guidance replaces the computed backoff rather than adding
 *   to it, and is still held to `budgetMs`.
 */
export async function withRetry(
  operation,
  {
    retries = DEFAULT_RETRIES,
    baseMs = DEFAULT_BASE_DELAY_MS,
    maxMs = DEFAULT_MAX_DELAY_MS,
    budgetMs = DEFAULT_BUDGET_MS,
    signal,
    sleepImpl = defaultSleep,
    isRetryable = defaultIsRetryable,
    randomness,
    // Called before each backoff, with `{ attempt, delayMs, error }`. Used by the tests,
    // and the seam a caller would log through.
    onRetry,
  } = {},
) {
  const startedAt = Date.now();

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation({
        attempt,
        remainingMs: Math.max(0, budgetMs - (Date.now() - startedAt)),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt >= retries || !isRetryable(error)) throw error;

      const hinted = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null;
      const delayMs =
        hinted ?? backoffDelay(attempt + 1, { baseMs, maxMs, ...(randomness === undefined ? {} : { randomness }) });

      // Out of budget is a reason to stop, not a reason to sleep and then stop.
      if (Date.now() - startedAt + delayMs > budgetMs) throw error;

      onRetry?.({ attempt, delayMs, error });
      await sleepImpl(delayMs);
      if (signal?.aborted) throw error;
    }
  }
}
