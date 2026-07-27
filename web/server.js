// Local dev server. Serves public/ and mounts the same api/ handlers Vercel would run,
// so what you test here is what deploys.
//
// Binds to 127.0.0.1 by default: with no passphrase set, the loopback interface is the
// only thing standing between your Gemini quota and the rest of the network.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import chatHandler from "./api/chat.js";
import configHandler from "./api/config.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

// Load .env.local before anything reads process.env. Precedence matches Vercel's: a
// variable already in the real environment wins over the file.
function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

const loadedEnv = [".env.local", ".env"].filter((name) => loadEnvFile(join(ROOT, name)));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(req, res) {
  const requested = new URL(req.url, "http://localhost").pathname;
  const relative = normalize(requested === "/" ? "/index.html" : requested);

  // normalize() collapses `..`, but a leading `../` survives it — reject those rather
  // than serving anything outside public/.
  if (relative.includes("..")) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  const path = join(PUBLIC_DIR, relative);
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname === "/api/chat") return await chatHandler(req, res);
    if (pathname === "/api/config") return await configHandler(req, res);
    return await serveStatic(req, res);
  } catch (error) {
    console.error("[server]", error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    if (!res.writableEnded) res.end("Internal error");
  }
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";

server.listen(port, host, () => {
  console.log(`\n  Seer chat  →  http://${host}:${port}\n`);
  console.log(`  env file   ${loadedEnv.length ? loadedEnv.join(", ") : "none found"}`);
  console.log(`  API key    ${process.env.GEMINI_API_KEY ? "loaded" : "MISSING — see web/README.md"}`);
  console.log(
    `  passphrase ${process.env.APP_PASSWORD ? "required" : "not set (fine on 127.0.0.1)"}\n`,
  );
});
