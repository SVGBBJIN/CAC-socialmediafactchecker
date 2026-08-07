// POST /api/chat — the only place the Gemini key is ever read.
//
// The browser sends conversation text and gets tokens back. It never sees, and cannot
// ask for, the credential. Written against raw Node request/response objects so the
// same file runs under `node server.js` locally and as a Vercel Node function.

import {
  modelChainFromEnv,
  mediaResolutionFromEnv,
  findClipLinks,
  GeminiError,
} from "../lib/gemini.js";
import { validateHints } from "../lib/resolve-hint.js";
import { browserWorkerFromEnv } from "../lib/browser-resolve.js";
import { verifiedChat, FACT_CHECK_SYSTEM_PROMPT } from "../lib/verified-chat.js";
import { authorize, config, validateMessages, GuardError } from "../lib/guard.js";

// `SYSTEM_PROMPT` still overrides, but the default is the fact-checking prompt in
// lib/verified-chat.js — the one that tells the model its facts come from `web_search`
// and that its answer is audited against what that tool returned. Overriding it replaces
// the instruction, not the enforcement: the audit runs either way.
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || FACT_CHECK_SYSTEM_PROMPT;

// How long the stream may go without writing before we send an SSE comment to keep it
// open. Proxies — Vercel's included — close a connection that has been silent too long,
// and the gap before Gemini's first token on a video it has to watch is easily a minute.
const HEARTBEAT_MS = 15_000;

async function readBody(req) {
  // Vercel parses JSON bodies for you; a bare Node server does not.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body !== "string") return req.body;
    try {
      return JSON.parse(req.body);
    } catch {
      throw new GuardError("Request body is not valid JSON.", 400);
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Refuse an oversized body before buffering it all. Raised from 1MB to fit a
    // base64-encoded image attachment (see guard.js's `maxImageBase64Bytes`) alongside
    // the text — the real per-image cap is enforced there, this is just the floor big
    // enough to let one through.
    if (size > 8_000_000) throw new GuardError("Request body too large.", 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GuardError("Request body is not valid JSON.", 400);
  }
}

function sendJSON(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJSON(res, 405, { error: "Use POST." }, { allow: "POST" });
  }

  const limits = config();

  // Fail loudly and early rather than sending an unauthenticated request upstream.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return sendJSON(res, 500, {
      error:
        "GEMINI_API_KEY is not set. Copy web/.env.example to web/.env.local and put your key there, then restart the server.",
    });
  }

  let messages;
  let clipHints = null;
  let usage = { pressure: 0 };
  try {
    usage = authorize(req, limits) ?? usage;
    const body = await readBody(req);
    messages = validateMessages(body, limits);
    // Resolves the browser already paid for during intake, offered back so the clip stage
    // can skip repeating them. Matched against the links this message actually mentions
    // and vetted field by field; anything that doesn't survive is simply resolved the
    // usual way. See lib/resolve-hint.js for why that is the only safe posture.
    clipHints = validateHints(
      body?.clipHints,
      findClipLinks(String(messages.at(-1)?.content ?? "")),
    );
  } catch (error) {
    if (error instanceof GuardError) {
      const headers = error.retryAfter ? { "retry-after": String(error.retryAfter) } : {};
      return sendJSON(res, error.status, { error: error.message }, headers);
    }
    return sendJSON(res, 400, { error: "Could not read the request." });
  }

  // Everything below streams. Once headers are out we can't change the status code, so
  // later failures are reported as an SSE `error` frame instead.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Vercel's edge buffers proxied responses without this.
    "x-accel-buffering": "no",
  });

  const controller = new AbortController();
  // If the user hits Stop or closes the tab, stop paying for tokens nobody will read.
  res.on("close", () => controller.abort());

  const started = Date.now();

  let lastWrite = Date.now();
  const send = (frame) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
    lastWrite = Date.now();
  };

  // A `:` line is an SSE comment: it keeps the connection warm and is ignored by the
  // client's frame parser, so it can't be mistaken for content.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    if (Date.now() - lastWrite < HEARTBEAT_MS) return;
    res.write(": keep-alive\n\n");
    lastWrite = Date.now();
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // Where the request got to, and when. Stages are the phases that produce no output, so
  // they are also the phases a request dies in without leaving a trace — logging them is
  // what turns "it just stopped" into a line in the host's runtime log naming the step and
  // the second it stopped on.
  const trace = (note) => console.log(`[chat] ${Math.round((Date.now() - started) / 1000)}s ${note}`);

  try {
    for await (const frame of verifiedChat({
      apiKey,
      messages,
      system: SYSTEM_PROMPT,
      models: modelChainFromEnv(),
      maxOutputTokens: limits.maxOutputTokens,
      thinkingBudgetTokens: limits.thinkingBudgetTokens,
      toolRoundThinkingBudgetTokens: limits.toolRoundThinkingBudgetTokens,
      // Off unless the operator opted in — it trades the frame detail that on-screen text
      // is read from for a much smaller video prefill. See `MEDIA_RESOLUTIONS`.
      mediaResolution: mediaResolutionFromEnv(),
      // How close this client is to its daily cap. Near it, the chain starts one model
      // lower — see `planChain`. Zero when no limit is in force, which leaves the chain
      // exactly as it was.
      budgetPressure: usage.pressure ?? 0,
      // Off unless the operator opted in via ANSWER_HOLD_MS — see its doc comment in
      // lib/guard.js and DEFAULT_ANSWER_HOLD_MS in lib/gemini.js for the trade it makes.
      answerHoldMs: limits.answerHoldMs,
      signal: controller.signal,
      // Off by default in the library, opted into here: this is process-global state
      // shared across requests on a warm instance, keeps a downloaded clip for the next
      // turn of the same conversation instead of pulling the same MP4 off the CDN again on
      // every follow-up question — see `CLIP_CACHE_TTL_MS` in lib/gemini.js — and switching
      // it on is a deployment decision made here rather than imposed on every caller.
      clipOptions: {
        cache: true,
        hints: clipHints,
        // Null unless BROWSER_WORKER_URL is set, which leaves every clip failure reported
        // exactly as it was before the worker existed. See lib/browser-resolve.js.
        browserWorker: browserWorkerFromEnv(),
      },
      // Read a pasted link that isn't a video — an article, a blog post, a press release —
      // and quote its text to the model as the material being checked. Off by default in
      // the library because it fetches a host the user named; switched on here, where the
      // deployment decision belongs, because a fact-checker that cannot open the page it
      // was given is checking a headline. lib/article.js has the vetting that makes the
      // fetch safe and the fencing that keeps the page's own words from being read as
      // instructions.
      attachPages: true,
      // Off by default in the library for the same reason the clip cache is — it is
      // process-global state a stubbed test must not be answered from — and switched on
      // here, where the deployment decision belongs. Without it a follow-up question about
      // a pasted article re-fetched that article on every turn, because the conversation
      // that mentions it is replayed on every request. See `ARTICLE_CACHE_TTL_MS`.
      articleOptions: { cache: true },
    })) {
      if (frame.type === "stage") trace(frame.stage + (frame.model ? ` (${frame.model})` : ""));
      if (frame.type === "search") trace(`search: ${frame.query || frame.error}`);
      if (frame.type === "find") {
        trace(
          frame.error
            ? `read failed: ${frame.url} — ${frame.error}`
            : `read: ${frame.url} — ${frame.matches} passage(s) for "${frame.find}"${frame.semantic ? "" : " (lexical only)"}`,
        );
      }
      if (frame.type === "truncated" && frame.totalTokens != null) {
        // What THINKING_BUDGET_TOKENS is a guess about, made concrete: if thinking is most
        // of `totalTokens`, the budget still needs to come down (or the model needs a
        // shorter question); if it's the answer, MAX_OUTPUT_TOKENS is the one to raise.
        trace(`truncated: ${frame.thoughtsTokens} thinking + ${frame.answerTokens} answer = ${frame.totalTokens}`);
      }
      send(frame);
    }

    trace("done");
    send({ type: "done" });
  } catch (error) {
    if (controller.signal.aborted) return;
    const isGemini = error instanceof GeminiError;
    if (!isGemini) console.error("[chat]", error);
    send({
      type: "error",
      message: isGemini ? error.message : "Something went wrong talking to Gemini.",
      // Lets the UI distinguish "this will fail again" from "worth another go".
      retryable: isGemini ? Boolean(error.retryable) : false,
    });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}
