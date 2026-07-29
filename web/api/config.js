// GET /api/config — what the front end needs to render itself correctly.
//
// Booleans only. Never echo the key, its length, or a fragment of it: "is it set" is
// all the browser needs to tell the difference between "ask for a passphrase" and
// "tell the operator their key is missing".

import { config } from "../lib/guard.js";
import { modelChainFromEnv } from "../lib/gemini.js";
import { healthSnapshot } from "../lib/degradation.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET" });
    return res.end(JSON.stringify({ error: "Use GET." }));
  }

  const limits = config();
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(
    JSON.stringify({
      requiresPassword: Boolean(limits.password),
      apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
      maxInputChars: limits.maxInputChars,
      // The server drops everything older than this anyway (see `validateMessages`), so
      // telling the client lets it stop uploading history that would just be thrown away
      // on arrival — the cost of a long, video-heavy thread otherwise paid on every turn.
      maxTurns: limits.maxTurns,
      // Model names, not credentials — the same thing the badge already shows once an
      // answer arrives. Sent on load so a reader who opens the page mid-outage sees the
      // degradation immediately, rather than finding out by sending a message.
      //
      // Only meaningful where this process is the one that serves /api/chat: on Vercel the
      // two routes are separate functions with separate memory, so this reports the config
      // instance's view and the badge corrects itself from the stream. Same caveat as the
      // rate limiter in guard.js, and it fails the same safe way — silence, never a
      // degradation claimed that isn't happening.
      health: healthSnapshot({ models: modelChainFromEnv() }),
    }),
  );
}
