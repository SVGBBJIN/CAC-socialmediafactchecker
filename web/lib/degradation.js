// When to stop asking for the best model, and how to say so.
//
// The model chain in gemini.js was built for one kind of failure: a model that isn't
// *there* — a retired preview ID, a key not entitled to the newest release. That is a
// permanent, per-key fact, so walking past it once per request is fine.
//
// Running out of quota is a different shape of problem and needs different handling on
// both counts. It is temporary, it is not knowable in advance, and — the part that
// matters — it repeats: the request that got a 429 from `gemini-3.6-flash` is followed by
// another one thirty seconds later that will get the same 429, and re-learning that fact
// from upstream every time costs a round trip per request for as long as the window lasts.
//
// So a 429 is remembered here for as long as the server says it will last, and the chain
// is planned around what is remembered before anything is sent. The result is a chain that
// steps down under pressure and steps back up on its own when the cooldown expires — no
// operator action, no restart, and no flag that someone has to remember to flip back.
//
// Storage caveat, same as the rate limiter in guard.js: this is process memory. Under
// `node server.js` it is exactly one shared registry; on Vercel it is per function
// instance, so a cold start begins with an empty one and re-learns from the first 429.
// That degrades to today's behaviour — one wasted round trip — rather than to anything
// worse, which is why it is worth having in this form rather than not having it.

/**
 * How long a model is presumed exhausted when the server doesn't say.
 *
 * Gemini's per-minute quotas refresh on a rolling minute, so a minute is the honest guess
 * when there's no `Retry-After` to go on. Erring short is deliberate: an over-long
 * cooldown keeps answering on a worse model after the good one recovered, and that failure
 * is invisible — the answers just get quietly weaker.
 */
export const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Ceiling on a cooldown, however long the server asks for.
 *
 * A daily quota exhaustion legitimately returns a `retryDelay` of many hours. Honouring it
 * verbatim would pin this process to the bottom of the chain for the rest of the day on
 * the strength of one response, including through a quota top-up. Past this point we would
 * rather spend one round trip an hour re-checking than trust a number that far ahead.
 */
export const MAX_COOLDOWN_MS = 15 * 60_000;

/**
 * The fraction of a client's daily allowance that counts as "nearly out".
 *
 * Past it, requests move one step down the chain *before* being sent. The daily cap in
 * guard.js is a message count, so the last messages of a heavy day are the ones most
 * likely to be cut off mid-conversation; spending them on a cheaper model is what keeps
 * there being any left. Below the threshold nothing changes — this is not a cost
 * optimisation, it is a way of not hitting the wall at full speed.
 */
export const BUDGET_PRESSURE_THRESHOLD = 0.8;

/** Why a model was passed over. Ordered loosely by how much the user should care. */
export const REASONS = {
  quota: "quota",
  overloaded: "overloaded",
  budget: "budget",
  context: "context",
  unavailable: "unavailable",
};

/**
 * How long an overloaded model is presumed busy when the server doesn't say.
 *
 * Much shorter than a quota cooldown, because it is a much shorter-lived condition: a 503
 * is capacity at this instant, not an allowance that has run out, and it typically clears
 * in seconds. Sitting out a full minute over one would keep answering on a worse model
 * long after the good one was free again.
 */
export const OVERLOAD_COOLDOWN_MS = 20_000;

/**
 * Which models are currently believed to be out of quota, and until when.
 *
 * A class rather than a module-level Map so tests can hold their own instance and not
 * inherit state from whatever ran before them — the same reason `resetRateLimits` exists
 * in guard.js, arrived at less painfully.
 */
export class ModelHealth {
  #cooldowns = new Map();

  /**
   * Record that `model` refused to serve, and stop offering it until the cooldown ends.
   *
   * @param cooldownMs - What the server asked for, if it said anything. Clamped into
   *   `[0, MAX_COOLDOWN_MS]`; a missing or unusable value becomes `DEFAULT_COOLDOWN_MS`.
   */
  markExhausted(model, { reason = REASONS.quota, detail = "", cooldownMs, now = Date.now() } = {}) {
    const requested = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : DEFAULT_COOLDOWN_MS;
    const until = now + Math.min(requested, MAX_COOLDOWN_MS);
    // Extend rather than shorten. Two failures in flight at once would otherwise let the
    // one carrying the smaller `Retry-After` undo the larger, and the larger is the one
    // that came from the quota that is actually exhausted.
    const existing = this.#cooldowns.get(model);
    if (existing && existing.until > until) return existing;
    const entry = { model, reason, detail, until };
    this.#cooldowns.set(model, entry);
    return entry;
  }

  /** Forget a model's cooldown. Called when it answers — it is evidently back. */
  markHealthy(model) {
    this.#cooldowns.delete(model);
  }

  /** The live cooldown for `model`, or null. Expired entries are dropped on the way past. */
  status(model, now = Date.now()) {
    const entry = this.#cooldowns.get(model);
    if (!entry) return null;
    if (entry.until <= now) {
      this.#cooldowns.delete(model);
      return null;
    }
    return { ...entry, remainingMs: entry.until - now };
  }

  isAvailable(model, now = Date.now()) {
    return this.status(model, now) === null;
  }

  clear() {
    this.#cooldowns.clear();
  }
}

/**
 * The registry the running server uses.
 *
 * Shared deliberately: what one request learns about a quota window is true for every
 * other request in that window, and that is the entire point of remembering it.
 */
export const modelHealth = new ModelHealth();

/**
 * Decide which models this request will actually try, in order.
 *
 * Cooled-down models are dropped wherever they sit in the chain, not just at the head —
 * a request that has already fallen past `3.6` shouldn't then spend a round trip on `3.5`
 * when `3.5` is the one we most recently saw a 429 from.
 *
 * Two rules keep this from ever making things worse:
 *
 * - **Never plan an empty chain.** If everything is cooling down, the whole chain is tried
 *   in its normal order. The cooldowns are a heuristic built from one response each;
 *   refusing to answer on the strength of them would turn a guess into an outage.
 * - **Budget pressure steps down exactly one place**, and only when something is left
 *   below. It is a hint that the day is nearly spent, not a reason to jump to the oldest
 *   model in the list.
 *
 * @returns `{models, preferred, degraded, reason, detail, skipped}` — `models` is what to
 *   try, `preferred` is what we'd have used with no pressure at all, and `reason` is why
 *   those differ (null when they don't).
 */
export function planChain({
  models,
  health = modelHealth,
  budgetPressure = 0,
  budgetThreshold = BUDGET_PRESSURE_THRESHOLD,
  now = Date.now(),
} = {}) {
  const chain = models?.length ? [...models] : [];
  const preferred = chain[0] ?? null;

  const skipped = [];
  const available = chain.filter((model) => {
    const status = health.status(model, now);
    if (!status) return true;
    skipped.push({ model, reason: status.reason, detail: status.detail, remainingMs: status.remainingMs });
    return false;
  });

  let planned = available.length > 0 ? available : chain;
  // Everything is cooling down: the skip list described a plan we aren't following, so
  // drop it rather than report a degradation that didn't happen.
  if (available.length === 0) skipped.length = 0;

  let reason = skipped.find((s) => s.model === preferred)?.reason ?? null;
  let detail = skipped.find((s) => s.model === preferred)?.detail ?? "";

  if (budgetPressure >= budgetThreshold && planned.length > 1) {
    skipped.push({ model: planned[0], reason: REASONS.budget, detail: "" });
    planned = planned.slice(1);
    if (!reason) reason = REASONS.budget;
  }

  const degraded = planned[0] !== preferred;
  return {
    models: planned,
    preferred,
    degraded,
    reason: degraded ? (reason ?? REASONS.unavailable) : null,
    detail: degraded ? detail : "",
    skipped,
  };
}

/** `"54s"`, `"3m"` — a wait a reader can act on, in the width a pill has. */
function humanDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * How a degradation reads in the UI.
 *
 * Two strings, because the pill has room for about fifteen characters and the reason a
 * fact-checker is answering on a weaker model is worth more than fifteen characters. The
 * short one labels the pill; the long one is its tooltip.
 *
 * Both name the model, in both directions. "Degraded" on its own invites the reader to
 * assume the worst case in the chain; saying which model actually answered, and which one
 * it replaced, is the difference between a warning and an explanation.
 */
export function describeDegradation({ reason, preferred, model, remainingMs, detail } = {}) {
  if (!reason || preferred === model) return { label: "", note: "" };

  const recovery = Number.isFinite(remainingMs) && remainingMs > 0
    ? ` Retrying ${preferred} in about ${humanDuration(remainingMs)}.`
    : "";

  switch (reason) {
    case REASONS.quota:
      return {
        label: "quota",
        note: `${preferred} is out of quota or rate-limited, so this answer came from ${model}.${recovery}`,
      };
    case REASONS.overloaded:
      return {
        label: "busy",
        note: `${preferred} was overloaded and turned the request away, so this answer came from ${model}. Nothing is wrong with your key or your usage — it is Google's capacity at that moment.${recovery}`,
      };
    case REASONS.budget:
      return {
        label: "conserving",
        note: `You are near this client's daily message limit, so ${model} is answering instead of ${preferred} to make the remaining messages go further.`,
      };
    case REASONS.context:
      return {
        label: "long chat",
        note: `This conversation is too long for ${preferred}, so ${model} answered it. Starting a new chat will bring ${preferred} back.`,
      };
    default:
      return {
        label: "fallback",
        note: `${preferred} was unavailable for this API key${detail ? ` (${detail})` : ""}, so ${model} answered instead.`,
      };
  }
}

/**
 * The registry as a snapshot for `/api/config`, so the pill can show a degradation the
 * page has not yet caused itself — a reader arriving mid-outage sees it on load rather
 * than discovering it by sending a message.
 */
export function healthSnapshot({ models, health = modelHealth, now = Date.now() } = {}) {
  const plan = planChain({ models, health, now });
  if (!plan.degraded) return { degraded: false, model: plan.models[0] ?? null, preferred: plan.preferred };

  const head = plan.skipped.find((s) => s.model === plan.preferred);
  const described = describeDegradation({
    reason: plan.reason,
    preferred: plan.preferred,
    model: plan.models[0],
    remainingMs: head?.remainingMs,
    detail: plan.detail,
  });
  return {
    degraded: true,
    model: plan.models[0] ?? null,
    preferred: plan.preferred,
    reason: plan.reason,
    ...described,
  };
}
