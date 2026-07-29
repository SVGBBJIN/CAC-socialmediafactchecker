// Local dev server. Serves public/ and mounts the same api/ handlers Vercel would run,
// so what you test here is what deploys.
//
// Binds to 127.0.0.1 by default: with no passphrase set, the loopback interface is the
// only thing standing between your Gemini quota and the rest of the network.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import chatHandler from "./api/chat.js";
import configHandler from "./api/config.js";
import { resolveStaticPath, contentType } from "./lib/static.js";
import { providerFromEnv } from "./lib/search.js";
import { searchEnabled } from "./lib/verified-chat.js";

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

async function serveStatic(req, res) {
  const requested = new URL(req.url, "http://localhost").pathname;
  const path = resolveStaticPath(requested, PUBLIC_DIR);

  if (path === null) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": contentType(path),
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

function describeSearch() {
  if (!searchEnabled()) return "DISABLED (WEB_SEARCH_ENABLED=false) — answers will be uncited";
  try {
    const { name } = providerFromEnv();
    return name === "duckduckgo"
      ? "duckduckgo — keyless fallback, blocked often. Set a key: see web/.env.example"
      : `${name} (key loaded)`;
  } catch (error) {
    return `misconfigured — ${error.message}`;
  }
}

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";

server.listen(port, host, () => {
  console.log(`\n  Seer chat  →  http://${host}:${port}\n`);
  console.log(`  env file   ${loadedEnv.length ? loadedEnv.join(", ") : "none found"}`);
  console.log(`  API key    ${process.env.GEMINI_API_KEY ? "loaded" : "MISSING — see web/README.md"}`);
  console.log(
    `  passphrase ${process.env.APP_PASSWORD ? "required" : "not set (fine on 127.0.0.1)"}`,
  );
  // Printed because the failure it prevents is a silent one: a key under a name or a
  // casing this app doesn't read leaves the app quietly on the keyless fallback, which
  // then gets blocked, and every search fails for a reason that looks nothing like
  // "your key wasn't picked up".
  console.log(`  search     ${describeSearch()}\n`);
});
