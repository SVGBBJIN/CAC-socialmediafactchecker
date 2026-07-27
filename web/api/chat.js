// POST /api/chat — the only place the Gemini key is ever read.
//
// The browser sends conversation text and gets tokens back. It never sees, and cannot
// ask for, the credential. Written against raw Node request/response objects so the
// same file runs under `node server.js` locally and as a Vercel Node function.

import { streamChat, modelChainFromEnv, GeminiError } from "../lib/gemini.js";
import { authorize, config, validateMessages, GuardError } from "../lib/guard.js";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful assistant. Be direct and concise. Use markdown for structure when it helps. " +
    "When the user shares a YouTube link, it is attached as video for you to watch directly — " +
    "don't say you can't access it. Transcribe or quote the specific claims made before " +
    "evaluating them.";

async function readBody(req) {
  // Vercel parses JSON bodies for you; a bare Node server does not.
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
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
  try {
    authorize(req, limits);
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

  const send = (frame) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  };

  try {
    for await (const frame of streamChat({
      apiKey,
      messages,
      system: SYSTEM_PROMPT,
      models: modelChainFromEnv(),
      signal: controller.signal,
    })) {
      send(frame);
    }
    send({ type: "done" });
  } catch (error) {
    if (controller.signal.aborted) return;
    const message =
      error instanceof GeminiError ? error.message : "Something went wrong talking to Gemini.";
    if (!(error instanceof GeminiError)) console.error("[chat]", error);
    send({ type: "error", message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}
