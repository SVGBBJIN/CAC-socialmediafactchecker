// GET /api/config — what the front end needs to render itself correctly.
//
// Booleans only. Never echo the key, its length, or a fragment of it: "is it set" is
// all the browser needs to tell the difference between "ask for a passphrase" and
// "tell the operator their key is missing".

import { config } from "../lib/guard.js";

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
    }),
  );
}
