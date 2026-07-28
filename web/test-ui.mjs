// Browser tests for the front end.  node test-ui.mjs
//
// NOT part of `npm test`, and deliberately not a dependency of this package: the app
// ships with none, and that stays true. Playwright has to be installed separately
// (`npm install --no-save playwright`) — this exits with instructions if it isn't.
//
// What it covers is the half `test.js` structurally cannot: app.js only runs in a
// browser, so retry behaviour, streaming, and render batching have no other way to be
// checked than by driving a real page. The chat endpoint is stubbed so failures are
// scripted rather than waited for; everything else is the real server code.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveStaticPath, contentType } from "./lib/static.js";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "playwright is not installed. It is intentionally not a dependency of this package.\n" +
      "  npm install --no-save playwright\n" +
      "then re-run: node test-ui.mjs",
  );
  process.exit(2);
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const PORT = Number(process.env.UI_TEST_PORT) || 3210;

/** Scripted responses for /api/chat, one per call; the last repeats. */
let script = [];
let callIndex = 0;
let requestBodies = [];

const server = createServer(async (req, res) => {
  if (req.url === "/api/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({ requiresPassword: false, apiKeyConfigured: true, maxInputChars: 8000 }),
    );
  }

  if (req.url === "/api/chat") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBodies.push(JSON.parse(Buffer.concat(chunks).toString()));

    const step = script[callIndex] ?? script.at(-1);
    callIndex += 1;

    if (step.httpError) {
      res.writeHead(step.httpError, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: step.message }));
    }

    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    for (const frame of step.frames) {
      // A real delay, not just write-ordering: without it every frame lands in the same
      // browser task and a test asserting on a mid-stream frame (e.g. a status label
      // that a later delta hides) can never observe it — the client processes the whole
      // burst before Playwright's next poll. Defaults to 0, so every other script here
      // that doesn't set it behaves exactly as before.
      if (frame.delayMs) await new Promise((resolve) => setTimeout(resolve, frame.delayMs));
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    return res.end();
  }

  // The real resolver, not a copy of it.
  const path = resolveStaticPath(new URL(req.url, "http://localhost").pathname, PUBLIC_DIR);
  if (path === null) return res.writeHead(403).end("Forbidden");
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": contentType(path) });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const browser = await chromium.launch({ executablePath: CHROME });
const results = [];

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
}

function scriptedAs(steps) {
  script = steps;
  callIndex = 0;
  requestBodies = [];
}

async function withPage(run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => check("no uncaught page error", false, String(error)));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(
    () => document.getElementById("status-text").textContent !== "Connecting…",
  );
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

async function send(page, text) {
  await page.fill("#input", text);
  await page.press("#input", "Enter");
}

const RETRYABLE_ERROR = { frames: [{ type: "error", message: "Overloaded.", retryable: true }] };

/* ---------------- retry affordance ---------------- */

scriptedAs([RETRYABLE_ERROR]);
await withPage(async (page) => {
  await send(page, "first question");
  await page.waitForSelector(".message.error");
  const count = await page.locator(".retry-button").count();
  check("a retryable error offers Try again", count === 1, `count=${count}`);
});

scriptedAs([{ frames: [{ type: "error", message: "Blocked.", retryable: false }] }]);
await withPage(async (page) => {
  await send(page, "first question");
  await page.waitForSelector(".message.error");
  const count = await page.locator(".retry-button").count();
  check("a non-retryable error does not", count === 0, `count=${count}`);
});

for (const [status, expected] of [
  [429, 1],
  [400, 0],
  [401, 0],
]) {
  scriptedAs([{ httpError: status, message: `HTTP ${status}` }]);
  await withPage(async (page) => {
    await send(page, "first question");
    await page.waitForSelector(".message.error");
    const count = await page.locator(".retry-button").count();
    check(`HTTP ${status} offers ${expected} retry button(s)`, count === expected, `count=${count}`);
  });
}

/* ---------------- retry replays the turn ---------------- */

scriptedAs([
  RETRYABLE_ERROR,
  { frames: [{ type: "delta", text: "recovered answer" }, { type: "done" }] },
]);
await withPage(async (page) => {
  await send(page, "first question");
  await page.waitForSelector(".retry-button");
  await page.click(".retry-button");
  await page.waitForSelector(".message.assistant .body:has-text('recovered answer')");

  const errors = await page.locator(".message.error").count();
  check("a successful retry clears the error", errors === 0, `errors=${errors}`);

  const users = await page.locator(".message.user").count();
  check("retry does not duplicate the user turn on screen", users === 1, `users=${users}`);

  const resent = requestBodies[1].messages;
  const userTurns = resent.filter((m) => m.role === "user");
  check(
    "retry resends the original question, once",
    userTurns.length === 1 && userTurns[0].content === "first question",
    JSON.stringify(resent),
  );
  check(
    "the error bubble is never sent upstream as context",
    !JSON.stringify(resent).includes("Overloaded"),
    JSON.stringify(resent),
  );
});

scriptedAs([
  {
    frames: [
      { type: "delta", text: "half an ans" },
      { type: "error", message: "died mid-stream", retryable: true },
    ],
  },
  { frames: [{ type: "delta", text: "full answer" }, { type: "done" }] },
]);
await withPage(async (page) => {
  await send(page, "first question");
  await page.waitForSelector(".retry-button");
  await page.click(".retry-button");
  await page.waitForSelector(".message.assistant .body:has-text('full answer')");

  const shown = await page.locator("#messages").innerText();
  check("retry discards the partial answer", !shown.includes("half an ans"), shown.slice(0, 160));
  check(
    "the partial answer is not replayed as history",
    !JSON.stringify(requestBodies[1].messages).includes("half an ans"),
    JSON.stringify(requestBodies[1].messages),
  );
});

/* ---------------- retry cannot eat later turns ---------------- */

scriptedAs([
  RETRYABLE_ERROR,
  { frames: [{ type: "delta", text: "second answer" }, { type: "done" }] },
]);
await withPage(async (page) => {
  await send(page, "first question");
  await page.waitForSelector(".message.error");
  await send(page, "second question");
  await page.waitForSelector(".message.assistant .body:has-text('second answer')");

  // Retry rebuilds the conversation from the failed turn onward, so a button still
  // sitting on a superseded error would delete everything that came after it.
  const stale = await page.locator(".retry-button").count();
  check("no retry button survives on a superseded error", stale === 0, `count=${stale}`);
});

/* ---------------- streaming ---------------- */

scriptedAs([
  {
    frames: [
      { type: "delta", text: "alpha " },
      { type: "delta", text: "beta " },
      { type: "delta", text: "gamma" },
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await send(page, "first question");
  await page.waitForSelector(".message.assistant .body:has-text('alpha beta gamma')");
  const text = (await page.locator(".message.assistant .body").last().innerText()).trim();
  check("every delta lands in the final render", text === "alpha beta gamma", text);
});

scriptedAs([{ frames: [{ type: "delta", text: "**bold** and `code`" }, { type: "done" }] }]);
await withPage(async (page) => {
  await send(page, "first question");
  await page.waitForSelector(".message.assistant .body strong");
  const html = await page.locator(".message.assistant .body").last().innerHTML();
  check(
    "markdown survives the batched final flush",
    html.includes("<strong>bold</strong>") && html.includes("<code>code</code>"),
    html,
  );
});

scriptedAs([
  {
    frames: [
      { type: "status", stage: "resolving" },
      { type: "status", stage: "fetchingMedia", delayMs: 150 },
      { type: "status", stage: "analysing", delayMs: 150 },
      { type: "delta", text: "it's about a cat", delayMs: 150 },
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await send(page, "https://www.tiktok.com/@u/video/1234567890123456789");
  await page.waitForSelector(".stage:not([hidden]):has-text('Fetching the video')");
  check("a status frame shows a stage label before any text arrives", true);

  await page.waitForSelector(".message.assistant .body:has-text(\"it's about a cat\")");
  const stageHidden = await page.locator(".stage").last().isHidden();
  check("the stage indicator hides once the answer starts streaming", stageHidden);
});

// Renders are batched per animation frame rather than per token. Without that, a long
// answer costs one full re-parse and DOM replacement per delta.
const DELTAS = 300;
scriptedAs([
  {
    frames: [
      ...Array.from({ length: DELTAS }, (_, i) => ({ type: "delta", text: `token${i} ` })),
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await page.addInitScript(() => {
    window.__htmlWrites = 0;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    Object.defineProperty(Element.prototype, "innerHTML", {
      ...descriptor,
      set(value) {
        if (this.classList?.contains("body")) window.__htmlWrites += 1;
        descriptor.set.call(this, value);
      },
    });
  });
  await page.reload();
  await page.waitForFunction(
    () => document.getElementById("status-text").textContent !== "Connecting…",
  );

  await send(page, "first question");
  await page.waitForSelector(`.message.assistant .body:has-text('token${DELTAS - 1}')`, {
    timeout: 20000,
  });

  const writes = await page.evaluate(() => window.__htmlWrites);
  const words = (await page.locator(".message.assistant .body").last().innerText()).trim().split(/\s+/);

  check(`all ${DELTAS} tokens present`, words.length === DELTAS, `got ${words.length}`);
  check(
    `renders are batched (${writes} writes for ${DELTAS} deltas)`,
    writes < DELTAS / 4,
    `writes=${writes}`,
  );
});

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? "ok  " : "FAIL"}  ${r.name}${r.pass ? "" : `\n        ${r.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
