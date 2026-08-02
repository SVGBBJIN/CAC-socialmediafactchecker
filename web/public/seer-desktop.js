// Library UI. Same /api/chat and /api/config the chat front end uses — no separate
// backend, no verdict schema. A link pasted here becomes a fact-check user turn exactly
// like a pasted link in the chat UI: the server detects it and attaches the video itself
// (see gemini.js's URL_PATTERN scan), so this file's job is presentation, not extraction.
//
// There is no per-claim verdict from the server — `verified-chat.js` returns one narrated,
// cited answer, not a claims array. Rather than fabricate badges from unstructured prose,
// the outgoing message asks the model to end its answer with one machine-readable line
// (`VERDICT: …`), which is parsed off and rendered as the badge, then stripped from what's
// shown. Everything else in the card — the analysis text, the sources — is exactly what the
// chat UI would have shown, just laid out for one link instead of a conversation.
//
// A finished check isn't a dead end: the same entry bar doubles as a follow-up composer
// once a result is on screen. Sending a follow-up replays the original prompt and answer
// as history (`historyFor`) so the model is continuing one conversation, not starting cold
// — exactly what the chat UI already does across turns, just anchored to one link instead
// of scrolling.

const LIBRARY_KEY = "seer.library.v1";
const PASSPHRASE_KEY = "seer.chat.pass"; // shared with the chat UI on purpose

const VERDICTS = {
  contradicted: { label: "Contradicted", css: "bad" },
  disputed: { label: "Disputed", css: "warn" },
  corroborated: { label: "Corroborated", css: "good" },
  insufficient: { label: "Insufficient evidence", css: "muted" },
};

const VERDICT_LINE = /\n?VERDICT:\s*(contradicted|disputed|corroborated|insufficient(?:\s+evidence)?)\.?\s*$/i;

const el = {
  linkInput: document.getElementById("linkInput"),
  checkBtn: document.getElementById("checkBtn"),
  libList: document.getElementById("libList"),
  searchInput: document.getElementById("searchInput"),
  claimsPane: document.getElementById("claimsPane"),
  videoChip: document.getElementById("videoChip"),
  videoTitle: document.getElementById("videoTitle"),
  videoLink: document.getElementById("videoLink"),
  passDialog: document.getElementById("passphrase-dialog"),
  passForm: document.getElementById("passphrase-form"),
  passInput: document.getElementById("passphrase-input"),
};

let library = loadLibrary();
let selectedId = library[0]?.id ?? null;
let inFlight = null;
// A follow-up in flight (or one that just failed), keyed to the entry it belongs to.
// Not persisted: a reload finds the thread as it was after the last *finished* turn,
// same as the chat UI drops an in-progress bubble on refresh.
let pendingFollowup = null; // { entryId, question, error? }

/* ---------------------------------------------------------------- storage */

function loadLibrary() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistLibrary() {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  } catch {
    // Full or disabled storage just means history won't survive a reload — not fatal.
  }
}

function findEntry(id) {
  return library.find((entry) => entry.id === id) ?? null;
}

/** The selected entry, but only once it has something a follow-up can build on. */
function selectedDoneEntry() {
  const entry = selectedId ? findEntry(selectedId) : null;
  return entry?.status === "done" ? entry : null;
}

/* ---------------------------------------------------------- link + text helpers */

function platformFor(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "TikTok";
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "YouTube";
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "Instagram";
    return host;
  } catch {
    return "Link";
  }
}

function normalizeLink(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * A bare link never has whitespace in it; a follow-up question almost always does
 * ("what about the second claim?"). Cheap, and it means pasting a new URL always starts
 * a new check even while a result is on screen — the one case that must never be
 * ambiguous.
 */
function looksLikeFollowup(raw) {
  return /\s/.test(raw.trim());
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* ---------------------------------------- markdown + citations (same rules as the chat UI) */

function escapeHTML(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkCitations(html, sources) {
  if (!sources?.length) return html;
  const byNumber = new Map(sources.map((s) => [String(s.n), s]));
  return html.replace(/\[(\d+)\]/g, (match, number) => {
    const source = byNumber.get(number);
    if (!source) return match;
    return `<a class="citation" href="${escapeHTML(source.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(source.title)}">[${number}]</a>`;
  });
}

function renderMarkdown(text, sources) {
  const segments = text.split(/```/);
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        const body = segment.replace(/^[a-zA-Z0-9-]*\n/, "").replace(/\n$/, "");
        return `<pre><code>${escapeHTML(body)}</code></pre>`;
      }
      let plain = segment;
      if (index > 0) plain = plain.replace(/^\n+/, "");
      if (index < segments.length - 1) plain = plain.replace(/\n+$/, "");
      return linkCitations(
        escapeHTML(plain)
          .replace(/`([^`\n]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\n/g, "<br>"),
        sources,
      );
    })
    .join("");
}

/** Pulls the trailing `VERDICT: …` line the initial prompt asks for off the answer text. */
function splitVerdict(answer) {
  const match = answer.match(VERDICT_LINE);
  if (!match) return { text: answer, verdictKey: null };
  const key = match[1].toLowerCase().replace(/\s+evidence$/, "");
  return { text: answer.slice(0, match.index).trimEnd(), verdictKey: VERDICTS[key] ? key : null };
}

/**
 * Turns on the `.in` transitions a beat after the markup lands, instead of baking the
 * class into the HTML string. Baked-in means the element's first paint *is* its final
 * state — there's no "before" for the transition to run from, so nothing animates.
 * Two rAFs: the first lands after the browser has laid the new nodes out, the second
 * after it has committed that layout — the gap a transition needs to actually fire.
 */
function revealIn(root) {
  const targets = root.querySelectorAll("[data-reveal]");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      targets.forEach((node) => node.classList.add("in"));
    });
  });
}

/* ---------------------------------------------------------------- sidebar */

function renderLibrary(filter = "") {
  el.libList.replaceChildren();
  const needle = filter.trim().toLowerCase();
  const visible = needle ? library.filter((e) => e.title.toLowerCase().includes(needle)) : library;

  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "lib-empty";
    empty.textContent = library.length === 0 ? "No checks yet — paste a link below." : "No matches.";
    el.libList.append(empty);
    return;
  }

  for (const entry of visible) {
    const item = document.createElement("li");
    item.className = `lib-item${entry.id === selectedId ? " active" : ""}`;
    item.tabIndex = 0;

    const thumb = document.createElement("div");
    thumb.className = "lib-thumb";

    const meta = document.createElement("div");
    meta.className = "lib-meta";
    const title = document.createElement("div");
    title.className = "lib-title";
    title.textContent = entry.title;
    const sub = document.createElement("div");
    sub.className = "lib-sub";
    const dot = document.createElement("span");
    dot.className = `dot ${dotClassFor(entry)}`;
    sub.append(dot, document.createTextNode(`${entry.platform} · ${statusLabel(entry)}`));
    meta.append(title, sub);

    item.append(thumb, meta);
    item.addEventListener("click", () => selectEntry(entry.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter") selectEntry(entry.id);
    });
    el.libList.append(item);
  }
}

function dotClassFor(entry) {
  if (entry.status === "running") return "warn";
  if (entry.status === "error") return "muted";
  return VERDICTS[entry.verdictKey]?.css ?? "muted";
}

function statusLabel(entry) {
  if (entry.status === "running") return "Checking…";
  if (entry.status === "error") return "Failed";
  return VERDICTS[entry.verdictKey]?.label ?? "Unclassified";
}

function selectEntry(id) {
  if (inFlight) return; // Don't let a click yank the pane out from under a running turn.
  selectedId = id;
  pendingFollowup = null;
  renderLibrary(el.searchInput.value);
  const entry = findEntry(id);
  if (entry) renderVideoPane(entry);
  if (entry?.status === "done") renderResultCard(entry);
  else if (entry?.status === "error") renderErrorCard(entry);
  updateComposerMode();
}

/* ---------------------------------------------------------------- video pane */

function renderVideoPane(entry) {
  el.videoChip.textContent = entry.platform;
  el.videoTitle.textContent = entry.title;
  el.videoLink.href = entry.url;
}

/* ---------------------------------------------------------------- claim card */

function irisMarkup() {
  return `
    <div class="iris-wrap">
      <svg viewBox="0 0 100 100">
        <g>
          <rect class="blade" style="--rot:0deg"   x="46" y="10" width="8" height="34" rx="4"/>
          <rect class="blade" style="--rot:60deg"  x="46" y="10" width="8" height="34" rx="4"/>
          <rect class="blade" style="--rot:120deg" x="46" y="10" width="8" height="34" rx="4"/>
          <rect class="blade" style="--rot:180deg" x="46" y="10" width="8" height="34" rx="4"/>
          <rect class="blade" style="--rot:240deg" x="46" y="10" width="8" height="34" rx="4"/>
          <rect class="blade" style="--rot:300deg" x="46" y="10" width="8" height="34" rx="4"/>
        </g>
        <path class="seal-check" d="M32 52 L44 64 L70 36" stroke="var(--good)" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>`;
}

function renderRunningCard() {
  el.claimsPane.innerHTML = `
    <div class="claim-card">
      <div class="card-loading">
        ${irisMarkup()}
        <div class="status-text" id="runStatus">Sending to the model…</div>
        <div class="source-counter" id="runCounter">&nbsp;</div>
      </div>
    </div>`;
}

function renderErrorCard(entry) {
  el.claimsPane.innerHTML = `
    <div class="claim-card">
      <div class="eyebrow">Check failed</div>
      <p class="claim-text in">${escapeHTML(entry.error || "Something went wrong.")}</p>
      <button type="button" class="retry-button" id="retryBtn">Try again</button>
    </div>`;
  document.getElementById("retryBtn")?.addEventListener("click", () => runCheck(entry.url, entry.id));
}

function sourcesHTML(sources) {
  if (!sources?.length) return "";
  return `
    <div class="sources" data-reveal>
      <div class="sources-label">Checked against ${sources.length} source${sources.length === 1 ? "" : "s"}</div>
      ${sources
        .map(
          (s) =>
            `<div class="source-item"><span><a class="citation" href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.title)}</a></span><span>${escapeHTML(s.domain)}</span></div>`,
        )
        .join("")}
    </div>`;
}

/** Past follow-ups, plus one in flight or freshly failed, as a thread under the analysis. */
function threadHTML(entry) {
  const settled = entry.followups
    .map(
      (f) => `
        <div class="thread-item">
          <div class="thread-q">${escapeHTML(f.question)}</div>
          <div class="thread-a claim-text" data-reveal>${renderMarkdown(f.answer, f.sources)}</div>
          ${sourcesHTML(f.sources)}
        </div>`,
    )
    .join("");

  const pending =
    pendingFollowup?.entryId === entry.id
      ? `
        <div class="thread-item">
          <div class="thread-q">${escapeHTML(pendingFollowup.question)}</div>
          ${
            pendingFollowup.error
              ? `<div class="thread-error">${escapeHTML(pendingFollowup.error)}</div>`
              : `<div class="thread-pending"><span class="thread-spinner"></span><span id="followupStatus">Asking…</span></div>`
          }
        </div>`
      : "";

  if (!settled && !pending) return "";
  return `<div class="thread">${settled}${pending}</div>`;
}

function renderResultCard(entry) {
  const verdict = VERDICTS[entry.verdictKey] ?? VERDICTS.insufficient;
  el.claimsPane.innerHTML = `
    <div class="claim-card">
      <div class="eyebrow">Analysis</div>
      <div class="claim-text" data-reveal>${renderMarkdown(entry.answer, entry.sources)}</div>
      <div class="badges">
        <span class="badge verdict ${verdict.css}" data-reveal>${escapeHTML(verdict.label)}</span>
      </div>
      ${sourcesHTML(entry.sources)}
      ${threadHTML(entry)}
    </div>`;
  revealIn(el.claimsPane);
}

/* ---------------------------------------------------------------- streaming */

function stageText(frame) {
  switch (frame?.stage) {
    case "attaching":
      return "Fetching the video";
    case "waiting":
      if (frame.media) return "Watching the video";
      return frame.round > 0 ? "Reading the sources" : "Asking the model";
    case "thinking":
      return frame.round > 0 ? "Working through the sources" : "Working out what to check";
    case "busy":
      return "Every Gemini model is busy — waiting a moment and trying again";
    case "rewriting":
      return "Rewriting — the first answer failed the citation check";
    default:
      return "Working";
  }
}

function requestHeaders() {
  const headers = { "content-type": "application/json" };
  const passphrase = sessionStorage.getItem(PASSPHRASE_KEY);
  if (passphrase) headers["x-app-password"] = passphrase;
  return headers;
}

/** Posts one turn to /api/chat and collects it into `{ answer, sources }`. Shared by a
 * fresh check and a follow-up — both are just different message histories over the same
 * stream contract. */
async function streamChat(messages, { signal, onStage, onSearchCount } = {}) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ messages }),
    signal,
  });

  if (response.status === 401) {
    sessionStorage.removeItem(PASSPHRASE_KEY);
    el.passDialog.showModal();
    throw new Error("This library is password-protected. Unlock it and try again.");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `Request failed (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error("The server sent an empty response.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let sources = [];
  let searchCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (!answer) throw new Error("The connection closed before an answer arrived.");
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (!raw.startsWith("data:")) continue;

      let frame;
      try {
        frame = JSON.parse(raw.slice(5).trim());
      } catch {
        continue;
      }

      if (frame.type === "stage") onStage?.(frame);
      else if (frame.type === "delta") answer += frame.text;
      else if (frame.type === "break") answer += "\n\n";
      else if (frame.type === "answer") answer = frame.text;
      else if (frame.type === "search") onSearchCount?.(++searchCount);
      else if (frame.type === "sources") {
        if (!frame.provisional) sources = frame.sources;
      } else if (frame.type === "error") throw new Error(frame.message);
    }
  }

  return { answer, sources };
}

function composeCheckPrompt(url) {
  return (
    `Fact-check this video: ${url}\n\n` +
    "List the distinct factual claims it makes, check each one, and explain what the evidence " +
    "shows. Finish with exactly one line of the form `VERDICT: <Contradicted|Disputed|Corroborated" +
    "|Insufficient evidence>` summarizing the main claim — no other text on that line."
  );
}

/** The conversation an entry represents so far: the original check, then every follow-up
 * that's already settled — what a new follow-up continues, not restarts. */
function historyFor(entry) {
  const history = [
    { role: "user", content: entry.prompt },
    { role: "assistant", content: entry.rawAnswer },
  ];
  for (const f of entry.followups) {
    history.push({ role: "user", content: f.question }, { role: "assistant", content: f.answer });
  }
  return history;
}

/* ---------------------------------------------------------------- the two turns */

async function runCheck(url, existingId) {
  if (inFlight) return;

  const id = existingId ?? crypto.randomUUID();
  const prompt = composeCheckPrompt(url);
  let entry = findEntry(id);
  if (!entry) {
    entry = { id, url, platform: platformFor(url), title: url, createdAt: Date.now(), status: "running", prompt, followups: [] };
    library.unshift(entry);
  } else {
    entry.status = "running";
    entry.error = undefined;
    entry.prompt = prompt;
    entry.followups = [];
  }
  selectedId = id;
  pendingFollowup = null;
  persistLibrary();
  renderLibrary(el.searchInput.value);
  renderVideoPane(entry);
  renderRunningCard();
  updateComposerMode();

  const controller = new AbortController();
  inFlight = controller;
  el.checkBtn.disabled = true;

  try {
    const { answer, sources } = await streamChat([{ role: "user", content: prompt }], {
      signal: controller.signal,
      onStage: (frame) => {
        const status = document.getElementById("runStatus");
        if (status) status.textContent = stageText(frame);
      },
      onSearchCount: (n) => {
        const counter = document.getElementById("runCounter");
        if (counter) counter.textContent = `Source ${n}`;
      },
    });

    const { text, verdictKey } = splitVerdict(answer);
    entry.status = "done";
    entry.rawAnswer = answer; // kept whole, VERDICT line included — history needs it verbatim
    entry.answer = text;
    entry.sources = sources;
    entry.verdictKey = verdictKey ?? "insufficient";
    persistLibrary();
    renderLibrary(el.searchInput.value);
    if (selectedId === id) renderResultCard(entry);
  } catch (error) {
    if (error.name === "AbortError") return;
    entry.status = "error";
    entry.error = error.message;
    persistLibrary();
    renderLibrary(el.searchInput.value);
    if (selectedId === id) renderErrorCard(entry);
  } finally {
    inFlight = null;
    el.checkBtn.disabled = false;
    updateComposerMode();
  }
}

async function runFollowup(entry, question) {
  if (inFlight) return;

  pendingFollowup = { entryId: entry.id, question, error: null };
  el.linkInput.value = "";
  renderResultCard(entry);
  updateComposerMode();

  const controller = new AbortController();
  inFlight = controller;
  el.checkBtn.disabled = true;
  let settled = false;

  try {
    const { answer, sources } = await streamChat([...historyFor(entry), { role: "user", content: question }], {
      signal: controller.signal,
      onStage: (frame) => {
        const status = document.getElementById("followupStatus");
        if (status) status.textContent = stageText(frame);
      },
    });

    entry.followups.push({ question, answer, sources });
    persistLibrary();
    renderLibrary(el.searchInput.value);
    settled = true;
  } catch (error) {
    if (error.name === "AbortError") {
      pendingFollowup = null;
      return;
    }
    // Left as the pending item, with its error — not pushed into `followups`, since a
    // turn with no real answer would corrupt the history the next follow-up replays.
    pendingFollowup = { entryId: entry.id, question, error: error.message };
  } finally {
    if (settled) pendingFollowup = null;
    inFlight = null;
    el.checkBtn.disabled = false;
    if (selectedId === entry.id) renderResultCard(entry);
    updateComposerMode();
  }
}

/* ---------------------------------------------------------------- entry-bar mode */

/**
 * The entry bar is either "start a new check" or "continue this one" — never both at
 * once, and which one it is has to be legible before the reader presses anything. Button
 * label and placeholder track it live as they type, so the switch never lands as a
 * surprise on submit.
 */
function updateComposerMode() {
  const entry = selectedDoneEntry();
  if (!entry) {
    el.checkBtn.textContent = "Check";
    el.linkInput.placeholder = "Paste a TikTok, YouTube, or Instagram link…";
    return;
  }
  const asking = looksLikeFollowup(el.linkInput.value);
  el.checkBtn.textContent = asking ? "Ask" : "Check";
  el.linkInput.placeholder = asking
    ? "Ask a follow-up…"
    : `Ask a follow-up about "${truncate(entry.title, 44)}", or paste a new link…`;
}

/* ---------------------------------------------------------------- config + gating */

async function loadServerConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    if (!config.apiKeyConfigured) {
      el.checkBtn.disabled = true;
      el.linkInput.placeholder = "Server has no GEMINI_API_KEY — see web/README.md";
      return;
    }
    if (config.requiresPassword && !sessionStorage.getItem(PASSPHRASE_KEY)) {
      el.passDialog.showModal();
    }
  } catch {
    el.checkBtn.disabled = true;
    el.linkInput.placeholder = "Server unreachable";
  }
}

/* ---------------------------------------------------------------- wiring */

el.checkBtn.addEventListener("click", () => {
  const entry = selectedDoneEntry();
  const raw = el.linkInput.value;
  if (entry && looksLikeFollowup(raw)) {
    const question = raw.trim();
    if (question) runFollowup(entry, question);
    return;
  }
  const url = normalizeLink(raw);
  if (url) runCheck(url);
});

el.linkInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    el.checkBtn.click();
  }
});

el.linkInput.addEventListener("input", updateComposerMode);
el.searchInput.addEventListener("input", () => renderLibrary(el.searchInput.value));

el.passForm.addEventListener("submit", () => {
  const value = el.passInput.value.trim();
  if (value) sessionStorage.setItem(PASSPHRASE_KEY, value);
  el.passInput.value = "";
});

renderLibrary();
if (selectedId) {
  const entry = findEntry(selectedId);
  if (entry) {
    renderVideoPane(entry);
    if (entry.status === "done") renderResultCard(entry);
    else if (entry.status === "error") renderErrorCard(entry);
  }
} else {
  el.claimsPane.innerHTML = `<div class="claim-card"><p class="claim-text in">Paste a TikTok, YouTube, or Instagram link below and press Check.</p></div>`;
}
updateComposerMode();
loadServerConfig();
el.linkInput.focus();
