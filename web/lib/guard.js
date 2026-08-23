// Who is allowed to spend your Gemini quota, and how fast.
//
// The key never reaches the browser — that alone stops it being copied. It does not
// stop someone who can reach the endpoint from spending the quota through it. These two
// checks close that gap: a shared passphrase decides *who*, a rate limit decides *how
// much*.

import { timingSafeEqual } from "node:crypto";

export class GuardError extends Error {
  constructor(message, status, { retryAfter } = {}) {
    super(message);
    this.name = "GuardError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function config(env = process.env) {
  return {
    password: env.APP_PASSWORD || "",
    perMinute: positiveInt(env.RATE_LIMIT_PER_MINUTE, 15),
    perDay: positiveInt(env.RATE_LIMIT_PER_DAY, 300),
    maxInputChars: positiveInt(env.MAX_INPUT_CHARS, 8000),
    maxTurns: positiveInt(env.MAX_TURNS, 20),
    // Every other cap here bounds *input*. Nothing bounded output — a single reply
    // could run until the model stopped on its own, and output tokens are the
    // expensive side of the meter. Passed through to Gemini's `maxOutputTokens`, which
    // on a thinking model covers the reasoning as well as the reply — see the note on
    // `DEFAULT_MAX_OUTPUT_TOKENS` for why that makes a small-looking number too small.
    maxOutputTokens: positiveInt(env.MAX_OUTPUT_TOKENS, 16384),
    // How much of that is reserved for reasoning, via Gemini's `thinkingConfig`, so the
    // reasoning cannot itself consume the whole reply budget. 0 turns the field off
    // entirely rather than asking Gemini to disable thinking, which not every model in
    // the chain may accept — see `DEFAULT_THINKING_BUDGET_TOKENS` in lib/gemini.js.
    thinkingBudgetTokens: nonNegativeInt(env.THINKING_BUDGET_TOKENS, 4096),
    // Base64 size cap for a client-attached image (see `validateMessages`'s `image`
    // handling). ~4.5MB of raw bytes once decoded — comfortably more than a phone photo
    // recompressed by the browser before upload (see app.js's canvas resize), and small
    // enough that one turn's image can't dominate the request the way an unbounded upload
    // would.
    maxImageBase64Bytes: positiveInt(env.MAX_IMAGE_BASE64_BYTES, 6_000_000),
    // The same cap for a round that still holds its search tools — a round deciding what
    // to look up rather than writing the verdict, and the round whose deliberation the
    // reader waits through before the first search even runs. Lower on purpose; see
    // `DEFAULT_TOOL_ROUND_THINKING_BUDGET_TOKENS` in lib/gemini.js. Never raises
    // `thinkingBudgetTokens` — the smaller of the two is what gets sent. 0 means "use the
    // same budget as the answering round".
    toolRoundThinkingBudgetTokens: nonNegativeInt(env.TOOL_ROUND_THINKING_BUDGET_TOKENS, 1024),
    // How long the final answer is held back before the reader sees any of it, so a
    // mid-stream stop (Gemini ending a turn on RECITATION or SAFETY, which it does without
    // warning) can fail over to the next model in silence instead of leaving a broken turn
    // on screen. 0, the default, means no delay and no change from today's behaviour — see
    // `DEFAULT_ANSWER_HOLD_MS` in lib/gemini.js for what turning it on costs and buys.
    answerHoldMs: nonNegativeInt(env.ANSWER_HOLD_MS, 0),
  };
}

function positiveInt(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Like `positiveInt`, but 0 is a real, meaningful value rather than "unset". */
function nonNegativeInt(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Compare without leaking the answer through how long the comparison took. */
export function passwordMatches(supplied, expected) {
  const a = Buffer.from(String(supplied ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a leak; compare
  // equal-length buffers and fold the length check into the result.
  const length = Math.max(a.length, b.length, 1);
  const padded = (buf) => {
    const out = Buffer.alloc(length);
    buf.copy(out);
    return out;
  };
  return timingSafeEqual(padded(a), padded(b)) && a.length === b.length;
}

export function clientKey(req) {
  // On Vercel the socket address is the edge proxy, so the forwarded header is the only
  // signal available. It is spoofable — treat the rate limit as a guard against casual
  // over-use and accidents, not against a determined attacker. The passphrase is what
  // actually gates access.
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

// Sliding-window counters, in memory.
//
// On Vercel this lives per function instance and resets on a cold start, so the real
// ceiling is looser than the numbers suggest. It is the right shape and the wrong
// storage for production — see web/README.md for the swap to a shared store.
const windows = new Map();

const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 5000;

export function checkRateLimit(key, limits, now = Date.now()) {
  const hits = (windows.get(key) ?? []).filter((t) => now - t < DAY);
  // Store the pruned list before any early exit. A client that keeps hitting the limit
  // takes the throwing path every time, and if that path never wrote back, its expired
  // timestamps would be re-filtered on every request and never actually dropped.
  //
  // Deleted first so the re-insert puts this key at the *end* of the map's iteration
  // order. That is what makes insertion order recency order, which is what lets the
  // eviction below be an LRU without a second structure to keep in step — the same trick
  // `clipCacheGet` in lib/gemini.js already uses.
  windows.delete(key);
  windows.set(key, hits);

  // Bound the map so a long-running server doesn't accumulate dead keys. Swept here
  // rather than after the limit checks below, because the case that grows the map
  // fastest — many distinct clients, each being refused — never reaches them.
  //
  // Eviction is by age, and *then* unconditionally by recency, because the age pass alone
  // does not bound anything. `clientKey` reads `x-forwarded-for`, which the note above it
  // says is spoofable, so a caller rotating that header mints an unbounded number of
  // distinct keys — every one of them fresh, none of them older than a day, and therefore
  // none of them removable by an expiry rule. The map then grows without limit and, worse,
  // every subsequent request re-scans all of it: measured at 20,000 keys, that scan alone
  // cost about half a millisecond per request and rises linearly, so the flood degrades
  // service for everyone else without ever tripping a limit.
  //
  // So the overflow is dropped whatever its age. The trade is real and worth stating: a
  // legitimate client evicted under a flood gets a fresh allowance, because its counters
  // went with it. That is the better failure — the counters are in-memory and already
  // reset on every cold start (see the note on `windows`), so this widens a hole that is
  // documented as wide, while closing one that lets an attacker spend the whole process's
  // CPU and memory. `APP_PASSWORD` remains the control that actually gates access.
  // Oldest first, and never this request's own key: it was just re-inserted, so it is last
  // in the order and the loop stops well before reaching it. There is no separate pass for
  // *expired* keys any more, and there does not need to be one — an entry nobody has
  // touched drifts to the front of the order and is evicted for being the oldest, which is
  // what an expiry pass was trying to approximate. Dropping it is also what keeps the
  // eviction cheap: a scan of the whole map on every request past the cap was the very cost
  // this bound exists to prevent, and it re-introduced it in the case that matters most.
  // What remains is proportional to the overflow — one entry per request, in the steady
  // state — instead of to the size of the map.
  while (windows.size > MAX_TRACKED_CLIENTS) {
    const oldest = windows.keys().next();
    if (oldest.done || oldest.value === key) break;
    windows.delete(oldest.value);
  }

  const inLastMinute = hits.filter((t) => now - t < MINUTE).length;
  if (inLastMinute >= limits.perMinute) {
    const oldest = hits.find((t) => now - t < MINUTE);
    throw new GuardError("Too many messages in a row. Give it a minute.", 429, {
      retryAfter: Math.max(1, Math.ceil((MINUTE - (now - oldest)) / 1000)),
    });
  }

  if (hits.length >= limits.perDay) {
    throw new GuardError("Daily message limit reached for this client.", 429, {
      retryAfter: Math.ceil(DAY / 1000),
    });
  }

  hits.push(now);
  return {
    remainingToday: limits.perDay - hits.length,
    // How much of the day's allowance this client has spent, 0–1. Read by the model
    // planner: past a threshold the request is answered on a cheaper model, so the last
    // messages of a heavy day still get answered instead of the good model burning
    // through what's left. Reported rather than acted on here — this function's job is
    // counting, and what to do about the count is a different decision.
    pressure: hits.length / limits.perDay,
  };
}

/** Test seam — the counters are module state, so tests need a way to start clean. */
export function resetRateLimits() {
  windows.clear();
}

/**
 * How many clients are being tracked right now. A test seam like `resetRateLimits`.
 *
 * The bound on this map is the difference between a spoofed-header flood costing an
 * attacker nothing and costing the process its memory and its per-request CPU, and a bound
 * that nothing asserts is a bound that quietly stops holding. Exported so a test can say
 * so directly rather than inferring it from a timing.
 */
export function trackedClientCount() {
  return windows.size;
}

/**
 * Validate the request body and trim it to what we're willing to send upstream.
 * Every cap here is a spend cap: unbounded history is unbounded tokens.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * The `image` field on the *last* message, validated, or `undefined`.
 *
 * Only the last message may carry one, and only that call site (the one building the
 * outgoing request) ever passes it — a mid-history message with an image would mean
 * re-sending those bytes to Gemini on every later turn of the conversation, the same
 * cost `toGeminiContents` already refuses to pay twice for a re-quoted video link. The
 * browser only ever attaches an image to the turn it was uploaded for, so this is not a
 * capability being removed, only one that was never offered.
 */
function validatedImage(raw, limits) {
  if (!raw || typeof raw !== "object") return undefined;
  const mimeType = typeof raw.mimeType === "string" ? raw.mimeType.toLowerCase() : "";
  const data = typeof raw.data === "string" ? raw.data : "";
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType) || !data) return undefined;
  if (data.length > limits.maxImageBase64Bytes) {
    throw new GuardError(
      `Attached image is too large (limit ~${Math.floor((limits.maxImageBase64Bytes * 0.75) / 1_000_000)}MB).`,
      413,
    );
  }
  return { mimeType, data };
}

export function validateMessages(body, limits) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GuardError("Request needs a non-empty `messages` array.", 400);
  }

  const cleaned = [];
  messages.forEach((message, index) => {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const content = typeof message?.content === "string" ? message.content : "";
    if (content.trim().length === 0) return;
    if (content.length > limits.maxInputChars) {
      throw new GuardError(
        `Message is too long (${content.length} characters, limit ${limits.maxInputChars}).`,
        413,
      );
    }
    const out = { role, content };
    if (role === "user" && index === messages.length - 1) {
      const image = validatedImage(message?.image, limits);
      if (image) out.image = image;
    }
    cleaned.push(out);
  });

  if (cleaned.length === 0) {
    throw new GuardError("Request needs at least one non-empty message.", 400);
  }
  if (cleaned.at(-1).role !== "user") {
    throw new GuardError("The last message must be from the user.", 400);
  }

  // Keep the most recent turns. Older context is the cheapest thing to drop.
  const trimmed = cleaned.slice(-limits.maxTurns);

  // Gemini requires `contents` to open on a `user` turn. History alternates user/
  // assistant, so cutting to an even `maxTurns` out of an odd-length conversation lands
  // the slice on an orphaned assistant reply — its own question already dropped — and a
  // request that starts on `model` fails outright rather than just losing some context.
  // Dropping it here costs nothing worth keeping: a reply with no visible question above
  // it, and the one entry `maxTurns` was already about to cut anyway.
  while (trimmed.length > 0 && trimmed[0].role !== "user") trimmed.shift();

  return trimmed;
}

/** Throws `GuardError` if the caller may not proceed. */
export function authorize(req, limits) {
  if (limits.password) {
    const supplied = req.headers["x-app-password"];
    if (!passwordMatches(supplied, limits.password)) {
      throw new GuardError("Wrong or missing passphrase.", 401);
    }
  }
  return checkRateLimit(clientKey(req), limits);
}
