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

/* ---------------- storage ---------------- */

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

/* ---------------- platform + link helpers ---------------- */

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

/* ---------------- markdown + citations (same rules as the chat UI) ---------------- */

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

/** Pulls the trailing `VERDICT: …` line the prompt asks for off the answer text. */
function splitVerdict(answer) {
  const match = answer.match(VERDICT_LINE);
  if (!match) return { text: answer, verdictKey: null };
  const key = match[1].toLowerCase().replace(/\s+evidence$/, "");
  return { text: answer.slice(0, match.index).trimEnd(), verdictKey: VERDICTS[key] ? key : null };
}

/* ---------------- sidebar ---------------- */

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
  if (inFlight) return; // Don't let a click yank the pane out from under a running check.
  selectedId = id;
  renderLibrary(el.searchInput.value);
  const entry = findEntry(id);
  if (entry) renderVideoPane(entry);
  if (entry?.status === "done") renderResultCard(entry);
  else if (entry?.status === "error") renderErrorCard(entry);
}

/* ---------------- video pane ---------------- */

function renderVideoPane(entry) {
  el.videoChip.textContent = entry.platform;
  el.videoTitle.textContent = entry.title;
  el.videoLink.href = entry.url;
}

/* ---------------- claim card ---------------- */

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

function renderResultCard(entry) {
  const verdict = VERDICTS[entry.verdictKey] ?? VERDICTS.insufficient;
  const sourcesHTML = entry.sources?.length
    ? `
      <div class="sources in">
        <div class="sources-label">Checked against ${entry.sources.length} source${entry.sources.length === 1 ? "" : "s"}</div>
        ${entry.sources
          .map(
            (s) =>
              `<div class="source-item"><span><a class="citation" href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.title)}</a></span><span>${escapeHTML(s.domain)}</span></div>`,
          )
          .join("")}
      </div>`
    : "";

  el.claimsPane.innerHTML = `
    <div class="claim-card">
      <div class="eyebrow">Analysis</div>
      <div class="claim-text in">${renderMarkdown(entry.answer, entry.sources)}</div>
      <div class="badges">
        <span class="badge verdict ${verdict.css} in">${escapeHTML(verdict.label)}</span>
      </div>
      ${sourcesHTML}
    </div>`;
}

/* ---------------- the run itself ---------------- */

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

async function runCheck(url, existingId) {
  if (inFlight) return;

  const id = existingId ?? crypto.randomUUID();
  let entry = findEntry(id);
  if (!entry) {
    entry = { id, url, platform: platformFor(url), title: url, createdAt: Date.now(), status: "running" };
    library.unshift(entry);
  } else {
    entry.status = "running";
    entry.error = undefined;
  }
  selectedId = id;
  persistLibrary();
  renderLibrary(el.searchInput.value);
  renderVideoPane(entry);
  renderRunningCard();

  const controller = new AbortController();
  inFlight = controller;
  el.checkBtn.disabled = true;

  const runStatus = () => document.getElementById("runStatus");
  const runCounter = () => document.getElementById("runCounter");
  let searchCount = 0;
  let answer = "";
  let sources = [];

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content:
              `Fact-check this video: ${url}\n\n` +
              "List the distinct factual claims it makes, check each one, and explain what the evidence " +
              "shows. Finish with exactly one line of the form `VERDICT: <Contradicted|Disputed|Corroborated" +
              "|Insufficient evidence>` summarizing the main claim — no other text on that line.",
          },
        ],
      }),
      signal: controller.signal,
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

        if (frame.type === "stage") {
          if (runStatus()) runStatus().textContent = stageText(frame);
        } else if (frame.type === "delta") {
          answer += frame.text;
        } else if (frame.type === "break") {
          answer += "\n\n";
        } else if (frame.type === "answer") {
          answer = frame.text;
        } else if (frame.type === "search") {
          searchCount += 1;
          if (runCounter()) runCounter().textContent = `Source ${searchCount}`;
        } else if (frame.type === "sources") {
          if (!frame.provisional) sources = frame.sources;
        } else if (frame.type === "error") {
          throw new Error(frame.message);
        }
      }
    }

    const { text, verdictKey } = splitVerdict(answer);
    entry.status = "done";
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
  }
}

/* ---------------- config + gating (same contract as the chat UI) ---------------- */

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

/* ---------------- wiring ---------------- */

el.checkBtn.addEventListener("click", () => {
  const url = normalizeLink(el.linkInput.value);
  if (!url) return;
  runCheck(url);
});

el.linkInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    el.checkBtn.click();
  }
});

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
loadServerConfig();
el.linkInput.focus();
