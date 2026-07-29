// POST /api/chat — the only place the Gemini key is ever read.
//
// The browser sends conversation text and gets tokens back. It never sees, and cannot
// ask for, the credential. Written against raw Node request/response objects so the
// same file runs under `node server.js` locally and as a Vercel Node function.

import { modelChainFromEnv, GeminiError } from "../lib/gemini.js";
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
    // Refuse an oversized body before buffering it all.
    if (size > 1_000_000) throw new GuardError("Request body too large.", 413);
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
  let usage = { pressure: 0 };
  try {
    usage = authorize(req, limits) ?? usage;
    messages = validateMessages(await readBody(req), limits);
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

  try {
    for await (const frame of verifiedChat({
      apiKey,
      messages,
      system: SYSTEM_PROMPT,
      models: modelChainFromEnv(),
      maxOutputTokens: limits.maxOutputTokens,
      // How close this client is to its daily cap. Near it, the chain starts one model
      // lower — see `planChain`. Zero when no limit is in force, which leaves the chain
      // exactly as it was.
      budgetPressure: usage.pressure ?? 0,
      signal: controller.signal,
    })) {
      send(frame);
    }
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
