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
/** Responses deliberately left open by a `hold` step, so the page sits mid-stream. */
let heldResponses = [];
/** What /api/config reports about the model chain, if anything. */
let configHealth = null;

const server = createServer(async (req, res) => {
  if (req.url === "/api/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        requiresPassword: false,
        apiKeyConfigured: true,
        maxInputChars: 8000,
        ...(configHealth ? { health: configHealth } : {}),
      }),
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
    for (const frame of step.frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    // `hold` leaves the response open, so the page stays mid-stream and the live bubble can
    // be inspected. Without it every scripted turn completes instantly, and a completed turn
    // re-renders from stored history — which is the right thing for history to show, and
    // means anything that only exists *while* streaming cannot be observed after the fact.
    if (step.hold) {
      heldResponses.push(res);
      return;
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

/** Close anything a `hold` step left open, letting the page finish its turn. */
function releaseHeld() {
  for (const res of heldResponses.splice(0)) res.end();
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

/* ---------------- the evidence trail ---------------- */

// What the server sends for a normal verified answer: a search, the answer, the ledger.
const SEARCHED = {
  frames: [
    { type: "model", model: "gemini-3.6-flash" },
    {
      type: "search",
      query: "bridge cost audit",
      claim: "The bridge cost $4bn",
      provider: "test",
      results: [
        { n: 1, title: "State audit report", url: "https://audit.example/report", domain: "audit.example" },
        { n: 2, title: "Cost overrun coverage", url: "https://news.example/story", domain: "news.example" },
      ],
    },
    { type: "delta", text: "The bridge cost $2.1 billion [1], so the claim is wrong [2]." },
    {
      type: "sources",
      sources: [
        { n: 1, title: "State audit report", url: "https://audit.example/report", domain: "audit.example" },
        { n: 2, title: "Cost overrun coverage", url: "https://news.example/story", domain: "news.example" },
      ],
    },
    { type: "done" },
  ],
};

scriptedAs([SEARCHED]);
await withPage(async (page) => {
  await send(page, "is this true?");
  await page.waitForSelector(".message.assistant .sources");

  const chip = (await page.locator(".search-chip").innerText()).trim();
  check("the search that was run is shown", /bridge cost audit/.test(chip), chip);

  const sources = await page.locator(".sources ol li").count();
  check("the bibliography lists every retrieved source", sources === 2, `count=${sources}`);

  // The marker is a link to the page it cites — a citation the reader can't follow is
  // most of the way to no citation at all.
  const href = await page.locator("a.citation").first().getAttribute("href");
  check("citation markers link to their source", href === "https://audit.example/report", String(href));

  // …and it survives a reload, or the answer becomes unauditable the moment the page
  // refreshes.
  await page.reload();
  await page.waitForSelector(".message.assistant .sources");
  const afterReload = await page.locator("a.citation").count();
  check("the evidence trail survives a reload", afterReload === 2, `count=${afterReload}`);
});

/* ---------------- the bibliography, sent before the answer ---------------- */

// The state the reader is in while the answer is still streaming: the searches have landed
// and the provisional bibliography is on screen, but the final one has not been sent. This
// is what the early frame is for — the sources are readable during the wait, and the markers
// in the text arriving are already links.
scriptedAs([
  {
    frames: [
      { type: "model", model: "gemini-3.6-flash" },
      {
        type: "search",
        query: "bridge cost audit",
        claim: "The bridge cost $4bn",
        provider: "test",
        results: [
          { n: 1, title: "State audit report", url: "https://audit.example/report", domain: "audit.example" },
          { n: 2, title: "Cost overrun coverage", url: "https://news.example/story", domain: "news.example" },
        ],
      },
      {
        type: "sources",
        provisional: true,
        sources: [
          { n: 1, title: "State audit report", url: "https://audit.example/report", domain: "audit.example" },
          { n: 2, title: "Cost overrun coverage", url: "https://news.example/story", domain: "news.example" },
        ],
      },
      { type: "delta", text: "The bridge cost $2.1 billion [1]." },
    ],
    // Left open, so the assertions below see the turn as the reader does mid-answer.
    hold: true,
  },
]);
await withPage(async (page) => {
  await send(page, "is this true?");
  await page.waitForSelector(".message.assistant .sources");

  const provisional = await page.locator(".sources.provisional").count();
  check("a bibliography sent before the answer is marked provisional", provisional === 1, `count=${provisional}`);

  const heading = (await page.locator(".sources-heading").innerText()).trim();
  check("its heading says the sources are still being read", /reading them now/i.test(heading), heading);

  // The point of sending it early: a marker in text that is still arriving already resolves.
  const href = await page.locator("a.citation").first().getAttribute("href");
  check(
    "markers link while the answer is still streaming",
    href === "https://audit.example/report",
    String(href),
  );

  releaseHeld();
});

// …and once the final bibliography arrives it replaces the provisional one rather than
// stacking a second list underneath it, narrowed to what the answer actually cited.
scriptedAs([
  {
    frames: [
      { type: "model", model: "gemini-3.6-flash" },
      {
        type: "sources",
        provisional: true,
        sources: [
          { n: 1, title: "State audit report", url: "https://audit.example/report", domain: "audit.example" },
          { n: 2, title: "Cost overrun coverage", url: "https://news.example/story", domain: "news.example" },
        ],
      },
      { type: "delta", text: "The bridge cost $2.1 billion [1]." },
      {
        type: "sources",
        sources: [
          { n: 1, title: "State audit report", url: "https://audit.example/report", domain: "audit.example" },
        ],
      },
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await send(page, "is this true?");
  await page.waitForSelector(".message.assistant .sources");

  const lists = await page.locator(".message.assistant .sources").count();
  check("the final bibliography replaces the provisional one", lists === 1, `lists=${lists}`);

  const stillProvisional = await page.locator(".sources.provisional").count();
  check("and is no longer marked provisional", stillProvisional === 0, `count=${stillProvisional}`);

  const items = await page.locator(".sources ol li").count();
  check("narrowed to what the answer cited", items === 1, `count=${items}`);
});

scriptedAs([
  {
    frames: [
      { type: "model", model: "gemini-3.6-flash" },
      { type: "delta", text: "REJECTED ANSWER with no citations." },
      { type: "reset", reason: "citation-check" },
      { type: "delta", text: "The bridge cost $2.1 billion [1]." },
      {
        type: "sources",
        sources: [{ n: 1, title: "State audit report", url: "https://audit.example/report", domain: "audit.example" }],
      },
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await send(page, "is this true?");
  await page.waitForSelector(".message.assistant .sources");
  const text = await page.locator(".message.assistant .body").last().innerText();
  check("a rejected answer is cleared from the screen", !text.includes("REJECTED"), text);
  check("the rewrite is what remains", text.includes("$2.1 billion"), text);
});

scriptedAs([
  {
    frames: [
      { type: "model", model: "gemini-3.6-flash" },
      { type: "delta", text: "The bridge cost $2.1 billion." },
      { type: "unverified", message: "Unverified: 1 statement carries no citation.", violations: [] },
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await send(page, "is this true?");
  await page.waitForSelector(".message.assistant .unverified");
  const notice = await page.locator(".unverified").innerText();
  check("an answer that failed the check is labelled", /Unverified/.test(notice), notice);
  await page.reload();
  await page.waitForSelector(".message.assistant .unverified");
  check("the label survives a reload", true);
});

scriptedAs([
  {
    frames: [
      { type: "model", model: "gemini-3.6-flash" },
      { type: "search", query: "bridge cost", error: "DuckDuckGo returned no parseable results." },
      { type: "delta", text: "I could not check that claim." },
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await send(page, "is this true?");
  await page.waitForSelector(".search-chip.failed");
  const chip = await page.locator(".search-chip.failed").innerText();
  check("a failed search is shown as failed", /no parseable results/.test(chip), chip);
});

/* ---------------- the model pill ---------------- */

scriptedAs([
  {
    frames: [
      { type: "model", model: "gemini-3.6-flash", preferred: "gemini-3.6-flash", degraded: false, reason: null, label: "", note: "" },
      { type: "delta", text: "an answer" },
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await send(page, "is this true?");
  await page.waitForSelector("#model-badge:not([hidden])");
  const text = (await page.locator("#model-badge").innerText()).trim();
  const degraded = await page.locator("#model-badge.degraded").count();
  check("the pill names the model that answered", text === "gemini-3.6-flash", text);
  check("an undegraded answer is not flagged as one", degraded === 0, `count=${degraded}`);
});

scriptedAs([
  {
    frames: [
      {
        type: "model",
        model: "gemini-3.5-flash",
        preferred: "gemini-3.6-flash",
        degraded: true,
        reason: "quota",
        label: "quota",
        note: "gemini-3.6-flash is out of quota or rate-limited, so this answer came from gemini-3.5-flash. Retrying gemini-3.6-flash in about 45s.",
      },
      { type: "delta", text: "an answer from further down the chain" },
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await send(page, "is this true?");
  await page.waitForSelector("#model-badge.degraded");
  const text = (await page.locator("#model-badge").innerText()).trim();
  const title = await page.locator("#model-badge").getAttribute("title");
  check("a degraded pill names the model that actually answered", text.startsWith("gemini-3.5-flash"), text);
  check("…and why it wasn't the preferred one", /quota/.test(text), text);
  // The pill has room for a word; the tooltip is where the reader finds out that this is
  // temporary and roughly when it ends.
  check("the tooltip names both models and the recovery", /gemini-3\.6-flash.*45s/s.test(String(title)), String(title));
});

// A reader arriving mid-outage should see it before spending a message to find out.
configHealth = {
  degraded: true,
  model: "gemini-3.5-flash",
  preferred: "gemini-3.6-flash",
  reason: "quota",
  label: "quota",
  note: "gemini-3.6-flash is out of quota or rate-limited, so this answer came from gemini-3.5-flash.",
};
scriptedAs([{ frames: [{ type: "delta", text: "x" }, { type: "done" }] }]);
await withPage(async (page) => {
  await page.waitForSelector("#model-badge.degraded");
  const text = (await page.locator("#model-badge").innerText()).trim();
  check("a degradation shows on load, before any message is sent", /gemini-3\.5-flash/.test(text), text);
});
configHealth = null;

/* ---------------- the output-token cap ---------------- */

scriptedAs([
  {
    frames: [
      { type: "model", model: "gemini-3.6-flash", degraded: false },
      { type: "delta", text: "The bridge cost $2.1 bil" },
      { type: "truncated", reason: "max_output_tokens" },
      { type: "unverified", message: "Unverified: 1 statement carries no citation.", violations: [] },
      { type: "done" },
    ],
  },
]);
await withPage(async (page) => {
  await send(page, "is this true?");
  await page.waitForSelector(".message.assistant .truncated");
  const notice = await page.locator(".truncated").innerText();
  check("an answer cut off by the token cap says so", /reply-length limit/.test(notice), notice);
  // Both notices are true at once and say different things; neither may overwrite the other.
  const unverified = await page.locator(".unverified").count();
  check("the truncation notice does not displace the citation warning", unverified === 1, `count=${unverified}`);

  await page.reload();
  await page.waitForSelector(".message.assistant .truncated");
  check("the truncation label survives a reload", true);
});

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? "ok  " : "FAIL"}  ${r.name}${r.pass ? "" : `\n        ${r.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
