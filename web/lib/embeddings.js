// Embeddings, for the semantic half of the in-page find.
//
// One job: turn strings into vectors so two pieces of text can be compared by what they
// mean rather than by which words they share. That is the whole reason the find tool can
// answer "did the agency actually revise this number down" against a page that says
// "the estimate was lowered following review" and shares almost no vocabulary with the
// question.
//
// Two properties matter more than accuracy here, because this sits in the middle of a
// user-visible wait:
//
//   - **It is allowed to fail.** Every caller treats a null return as "no semantic
//     signal" and falls back to lexical scoring alone. An embedding call that 429s must
//     degrade the ranking, never the answer. Quota, a model ID that got retired, a
//     network blip — all of it is caught here and reported as absence.
//   - **It is bounded.** One batch request per page, a hard timeout, and a cap on how
//     much text goes out. A find that takes longer than the search it is refining has
//     defeated its own purpose.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Embedding models, in preference order.
 *
 * Same reasoning as the chat model chain in gemini.js: a pinned ID is a future outage,
 * because preview models get retired and a key's tier may not be entitled to the newest
 * one. If the first is unavailable the second is tried, and if both fail the caller loses
 * the semantic signal and keeps the lexical one.
 */
export const EMBEDDING_MODELS = ["gemini-embedding-001", "text-embedding-004"];

/** Longest one batch may take. Short on purpose: this is a refinement, not the answer. */
export const EMBEDDING_TIMEOUT_MS = 10_000;

/** Vector width to ask for. Smaller is faster to compare and plenty for ranking passages. */
const OUTPUT_DIMENSIONALITY = 768;

/** How many texts go in one batch, and how much of each. Both are quota, not correctness. */
const MAX_BATCH = 100;
const MAX_CHARS_PER_TEXT = 2_000;

/**
 * How long a model that just refused is passed over, in milliseconds.
 *
 * The chain is walked from the top on every call, so a key with no entitlement to
 * `gemini-embedding-001` — or a preview ID that has been retired — used to buy the same
 * refusal on every find, ahead of the model that was going to answer. That is a whole
 * failed round trip on the critical path, and at the far end of it the 10-second timeout
 * rather than a prompt 404, since a request that hangs is the expensive way to fail.
 *
 * So a refusal is remembered, the same way `lib/degradation.js` remembers one from the chat
 * chain, and briefly: a minute is long enough to skip the refusals in one turn and short
 * enough that a quota blip does not quietly pin the deployment to the second-choice model
 * for the rest of the process's life. Nothing is ever excluded outright — when every model
 * is cooling the original order is used, because a stale note about one model is not a
 * reason to skip the semantic half altogether.
 */
export const EMBEDDING_COOLDOWN_MS = 60_000;

/** model → when it may be preferred again. Module-scoped; only ever holds model IDs. */
const cooling = new Map();

/** Test seam, and the escape hatch if a deployment ever wants the memory cleared. */
export function resetEmbeddingHealth() {
  cooling.clear();
}

/** The chain, models that just refused moved to the back rather than dropped. */
function byHealth(models, now) {
  const ready = models.filter((model) => (cooling.get(model) ?? 0) <= now);
  return ready.length > 0 ? [...ready, ...models.filter((m) => !ready.includes(m))] : models;
}

/**
 * Embed a batch of texts.
 *
 * `onModel` is called with the model that answered, so a caller holding vectors across
 * calls can pin later batches to the same embedding space — see `PassageVectors` in
 * lib/page-find.js. Cosines between two models' vectors are meaningless.
 *
 * @returns an array of vectors parallel to `texts`, or `null` if no model could be
 *   reached. Never throws for an upstream failure — the caller's job is ranking, and
 *   ranking without this is degraded, not broken.
 */
export async function embedTexts(
  texts,
  {
    apiKey,
    fetchImpl = fetch,
    signal,
    models = EMBEDDING_MODELS,
    timeoutMs = EMBEDDING_TIMEOUT_MS,
    onModel,
    now = () => Date.now(),
  } = {},
) {
  if (!apiKey || texts.length === 0) return null;
  if (texts.length > MAX_BATCH) return null;

  const payloadTexts = texts.map((text) => String(text ?? "").slice(0, MAX_CHARS_PER_TEXT));

  for (const model of byHealth(models, now())) {
    const vectors = await requestBatch(model, payloadTexts, { apiKey, fetchImpl, signal, timeoutMs });
    if (vectors) {
      cooling.delete(model);
      onModel?.(model);
      return vectors;
    }
    // The caller went away — stop walking the chain rather than spending another request
    // on an answer nobody is waiting for, and don't blame the model for it.
    if (signal?.aborted) return null;
    cooling.set(model, now() + EMBEDDING_COOLDOWN_MS);
  }
  return null;
}

async function requestBatch(model, texts, { apiKey, fetchImpl, signal, timeoutMs }) {
  const requests = texts.map((text) => ({
    model: `models/${model}`,
    content: { parts: [{ text }] },
    // Ranking passages against a query is retrieval, and the models are trained with
    // asymmetric task types. Everything here is scored in one space, so one type for all
    // of it: `SEMANTIC_SIMILARITY` compares symmetrically, which is what a query-versus-
    // passage cosine needs when both sides go through the same call.
    taskType: "SEMANTIC_SIMILARITY",
    ...(model.startsWith("gemini-embedding") ? { outputDimensionality: OUTPUT_DIMENSIONALITY } : {}),
  }));

  const timer = new AbortController();
  const onAbort = () => timer.abort();
  if (signal?.aborted) timer.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => timer.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${ENDPOINT}/${model}:batchEmbedContents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ requests }),
      signal: timer.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const vectors = (body?.embeddings ?? []).map((e) => e?.values).filter(Array.isArray);
    // A short batch cannot be zipped back onto the texts by position, and guessing which
    // passage lost its vector would silently mis-rank the page. Discard the lot.
    if (vectors.length !== texts.length) return null;
    return vectors.map((values) => normalise(values));
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Unit-length copy of a vector, so similarity is a dot product. Zero vectors pass through. */
export function normalise(values) {
  let sum = 0;
  for (const value of values) sum += value * value;
  const length = Math.sqrt(sum);
  if (!length || !Number.isFinite(length)) return values.map(() => 0);
  return values.map((value) => value / length);
}

/**
 * Cosine similarity of two vectors that `normalise` has already been applied to, mapped
 * from [-1, 1] onto [0, 1] so it can be blended with the lexical score.
 */
export function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, (dot + 1) / 2));
}
