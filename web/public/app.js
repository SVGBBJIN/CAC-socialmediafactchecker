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

// How much faster than real time the video pane plays back. There's no server-side
// transcode in this pipeline (no ffmpeg step anywhere in the repo) — the cheap, correct
// substitute for "a sped up version of the video" is the browser's own playbackRate on
// the same MP4 the fact-check itself watches, not a second encoded file to keep in sync.
const VIDEO_PLAYBACK_RATE = 1.5;

// Mirrors `youTubeVideoID` in web/lib/gemini.js. Kept separate rather than shared: that
// module is server-only (it also drives the Gemini attachment path), and duplicating this
// one small regex-based parser is cheaper than wiring a shared module across the boundary.
function youTubeVideoID(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile|vm|vt)\./, "");
  const isYouTube =
    host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com" || host.endsWith(".youtube.com");
  if (!isYouTube) return null;

  const isValidID = (id) => /^[A-Za-z0-9_-]{11}$/.test(id);
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "youtu.be") return segments[0] && isValidID(segments[0]) ? segments[0] : null;

  const queryID = url.searchParams.get("v");
  if (queryID && isValidID(queryID)) return queryID;

  const videoPathPrefixes = new Set(["shorts", "embed", "live", "v"]);
  if (segments.length > 1 && videoPathPrefixes.has(segments[0].toLowerCase())) {
    return isValidID(segments[1]) ? segments[1] : null;
  }
  return null;
}

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
  newCheckBtn: document.getElementById("newCheckBtn"),
  libList: document.getElementById("libList"),
  searchInput: document.getElementById("searchInput"),
  claimsPane: document.getElementById("claimsPane"),
  videoChip: document.getElementById("videoChip"),
  videoTitle: document.getElementById("videoTitle"),
  videoLink: document.getElementById("videoLink"),
  videoThumb: document.getElementById("videoThumb"),
  videoPlaceholder: document.getElementById("videoPlaceholder"),
  videoPlayer: document.getElementById("videoPlayer"),
  videoEmbed: document.getElementById("videoEmbed"),
  passDialog: document.getElementById("passphrase-dialog"),
  passForm: document.getElementById("passphrase-form"),
  passInput: document.getElementById("passphrase-input"),
};

let library = loadLibrary();
let selectedId = library[0]?.id ?? null;
let inFlight = null;
// Resolved video-pane media, keyed by entry id: { kind: "direct"|"youtube", mediaURL,
// videoID }. In-memory only — a TikTok or Instagram CDN URL is signed and short-lived (see
// lib/tiktok.js and lib/instagram.js), so caching it in localStorage would just persist a
// URL that 404s on the next visit. Re-resolved each time an entry is (re)selected instead.
const mediaCache = new Map();
// Bumped every time the video pane switches entries, so a slow /api/resolve-media
// response for an entry the user has since navigated away from can't land in the pane
// after the fact.
let videoPaneToken = 0;
// A follow-up in flight (or one that just failed), keyed to the entry it belongs to.
// Not persisted: a reload finds the thread as it was after the last *finished* turn,
// same as the chat UI drops an in-progress bubble on refresh.
let pendingFollowup = null; // { entryId, question, error? }

/* ---------------------------------------------------------------- storage */

function loadLibrary() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  // A `running` entry only means anything while the `runCheck` that set it is still
  // alive, and that call dies with the page. Left as `running` across a reload, an entry
  // is stuck for good: no request is coming back to finish it, `selectedDoneEntry()`
  // returns null so there is no follow-up path either, and there is no retry button —
  // that exists only on the error card. So any entry still `running` when the library is
  // read back in was interrupted, not merely slow, and is reported as such: this is what
  // gives it a retry button and an honest status instead of a permanent "Checking…".
  let reaped = false;
  for (const entry of parsed) {
    if (entry?.status === "running") {
      entry.status = "error";
      entry.error = "This check was interrupted — the page was closed or reloaded before it finished.";
      reaped = true;
    }
  }
  if (reaped) {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(parsed));
    } catch {
      // Best-effort — the array returned below is already fixed either way.
    }
  }
  return parsed;
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

// Requires an actual domain shape (a label, a dot, a letters-only TLD), not just "no
// whitespace" — otherwise a plain word like "hi" reads as a bare hostname and gets a
// scheme bolted on in normalizeLink, turning a greeting into a fake fact-check target.
const BARE_DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i;

function looksLikeLink(raw) {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return /^https?:\/\//i.test(trimmed) || BARE_DOMAIN_PATTERN.test(trimmed);
}

function normalizeLink(raw) {
  if (!looksLikeLink(raw)) return null;
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Anything that isn't a recognizable link is a follow-up question — "hi", "what about the
 * second claim?", etc. Pasting an actual URL always starts a new check even while a result
 * is on screen — the one case that must never be ambiguous.
 */
function looksLikeFollowup(raw) {
  return raw.trim().length > 0 && !looksLikeLink(raw);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* ---------------------------------------- markdown + citations */

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
  // Same reasoning as `verdictHTML`: an incomplete turn that never reached a verdict must
  // not be filed in the library under one. "Unclassified" would be a truthful label and a
  // useless one — it reads as a property of the claim rather than of the check.
  if (entry.incomplete && !entry.verdictKey) return entry.incomplete.label;
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

/** The un-started state: nothing selected, video pane and claims pane both blank. */
function renderEmptyState() {
  el.videoChip.textContent = "No link yet";
  el.videoTitle.textContent = "Paste a link below to start a check.";
  el.videoLink.href = "#";
  clearVideoMedia();
  el.claimsPane.innerHTML = `<div class="claim-card"><p class="claim-text in">Paste a TikTok, YouTube, or Instagram link below and press Check.</p></div>`;
}

/**
 * Deselects whatever's open so the entry bar falls back to "Check" — the explicit escape
 * hatch from follow-up mode. Without it, starting a new check while a result is on
 * screen only works by remembering the no-space rule; this makes it a single click that
 * needs no rule at all.
 */
function startNewCheck() {
  if (inFlight) return; // Same guard as switching library items mid-run.
  selectedId = null;
  pendingFollowup = null;
  el.linkInput.value = "";
  renderLibrary(el.searchInput.value);
  renderEmptyState();
  updateComposerMode();
  el.linkInput.focus();
}

/* ---------------------------------------------------------------- video pane */

// Fallback while a video's real dimensions are still unknown (before the resolver's
// response lands, or before the <video> element has decoded enough to know its own
// size). Most short-form content is vertical, so this is the least-wrong guess, but
// `setVideoAspect` below always overrides it with the real ratio as soon as one is known.
const DEFAULT_VIDEO_ASPECT = "9 / 16";

/** Resizes the pane itself to the video's ratio, so nothing gets cropped or letterboxed
 * once the real size is known — object-fit: contain (see the CSS) only has to cover the
 * brief gap before that happens. */
function setVideoAspect(ratio) {
  el.videoThumb.style.aspectRatio = ratio || DEFAULT_VIDEO_ASPECT;
}

/** Back to the play-icon placeholder — no video element holding stale media or playing. */
function clearVideoMedia() {
  el.videoPlayer.pause();
  el.videoPlayer.removeAttribute("src");
  el.videoPlayer.load();
  el.videoPlayer.hidden = true;
  el.videoEmbed.src = "";
  el.videoEmbed.hidden = true;
  el.videoPlaceholder.hidden = false;
  setVideoAspect(DEFAULT_VIDEO_ASPECT);
}

function showVideoElement(media) {
  el.videoPlaceholder.hidden = true;
  // The platform's own reported width/height, if the API returned one — corrected below by
  // `loadedmetadata` against what the browser actually decoded, which is authoritative
  // even when the API's numbers are missing or wrong.
  if (media.width && media.height) setVideoAspect(`${media.width} / ${media.height}`);
  el.videoPlayer.src = media.mediaURL;
  el.videoPlayer.playbackRate = VIDEO_PLAYBACK_RATE;
  el.videoPlayer.hidden = false;
  el.videoPlayer.play().catch(() => {}); // Autoplay can be refused; controls stay visible either way.
}

/** Shorts are vertical, everything else on YouTube is 16:9 — there's no dimension field
 * to read the way TikTok's embed state has one, so the URL shape is the only signal. */
function youTubeAspectRatio(urlString) {
  try {
    return new URL(urlString).pathname.toLowerCase().includes("/shorts/") ? "9 / 16" : "16 / 9";
  } catch {
    return "16 / 9";
  }
}

function showYouTubeEmbed(videoID, aspect) {
  el.videoPlaceholder.hidden = true;
  setVideoAspect(aspect);
  // youtube-nocookie.com: this is a fact-check tool, not a place that should be dropping
  // YouTube's regular tracking cookies on every pasted link.
  el.videoEmbed.src = `https://www.youtube-nocookie.com/embed/${videoID}?rel=0`;
  el.videoEmbed.hidden = false;
}

/**
 * TikTok and Instagram both arrive as a plain MP4 on a signed CDN URL — neither has an
 * embed that plays for a logged-out visitor — so one loader covers both. The server does
 * the resolving; see api/resolve-media.js.
 */
async function loadDirectMedia(entry, token) {
  const cached = mediaCache.get(entry.id);
  if (cached?.kind === "direct") {
    if (token === videoPaneToken) showVideoElement(cached);
    return;
  }
  try {
    const response = await fetch("/api/resolve-media", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ url: entry.url }),
    });
    if (!response.ok) return; // Placeholder icon stands in — a dead CDN link isn't fatal to the check.
    const { mediaURL, width, height } = await response.json();
    if (!mediaURL) return;
    const media = { kind: "direct", mediaURL, width, height };
    mediaCache.set(entry.id, media);
    if (token === videoPaneToken) showVideoElement(media);
  } catch {
    // Network hiccup or the passphrase dialog intercepting — the rest of the pane (title,
    // link, and the fact-check itself) doesn't depend on this succeeding.
  }
}

function renderVideoPane(entry) {
  el.videoChip.textContent = entry.platform;
  el.videoTitle.textContent = entry.title;
  el.videoLink.href = entry.url;

  const token = ++videoPaneToken;
  clearVideoMedia();

  if (entry.platform === "TikTok" || entry.platform === "Instagram") {
    loadDirectMedia(entry, token);
    return;
  }

  const videoID = youTubeVideoID(entry.url);
  if (entry.platform === "YouTube" && videoID) {
    const aspect = youTubeAspectRatio(entry.url);
    mediaCache.set(entry.id, { kind: "youtube", videoID, aspect });
    showYouTubeEmbed(videoID, aspect);
  }
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

/**
 * The band saying an answer is less than a whole one.
 *
 * Sits between the text and the verdict because that is the order the two are read in: what
 * it says, then how much of it there is, then what it concluded — and on an incomplete turn
 * the third one is usually missing, which this is the explanation for.
 */
function incompleteHTML(incomplete) {
  if (!incomplete) return "";
  return `
    <div class="notice ${escapeHTML(incomplete.kind)}" data-reveal>
      <span class="notice-label">${escapeHTML(incomplete.label)}</span>
      <span>${escapeHTML(incomplete.text)}</span>
    </div>`;
}

/**
 * The verdict badge, or nothing.
 *
 * Nothing when the turn is incomplete and no `VERDICT:` line was parsed off it — see the
 * note in `runCheck`. A badge is the app asserting the check's finding, and there is no
 * finding to assert when the answer stopped before it got to one.
 */
function verdictHTML(entry) {
  if (entry.incomplete && !entry.verdictKey) return "";
  const verdict = VERDICTS[entry.verdictKey] ?? VERDICTS.insufficient;
  return `
    <div class="badges">
      <span class="badge verdict ${verdict.css}" data-reveal>${escapeHTML(verdict.label)}</span>
    </div>`;
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
          ${incompleteHTML(f.incomplete)}
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
  el.claimsPane.innerHTML = `
    <div class="claim-card">
      <div class="eyebrow">Analysis</div>
      <div class="claim-text" data-reveal>${renderMarkdown(entry.answer, entry.sources)}</div>
      ${incompleteHTML(entry.incomplete)}
      ${verdictHTML(entry)}
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

/**
 * Posts one turn to /api/chat and collects it into `{ answer, sources, incomplete }`.
 * Shared by a fresh check and a follow-up — both are just different message histories over
 * the same stream contract.
 *
 * ## An answer that arrived damaged is still an answer
 *
 * Two frames say a turn finished in a state the reader has to be told about, and both used
 * to be dropped here.
 *
 * `truncated` means the model hit its output cap mid-sentence. `lib/gemini.js` emits it
 * precisely because a cut-off fact-check "reads as a completed verdict, and the sentence it
 * was cut off in is frequently the one carrying the citation" — so the one place that fact
 * can reach a person is the one place it was being thrown away.
 *
 * `error` after text has already streamed is a stream that died part-way — Gemini ending
 * its turn on RECITATION or SAFETY, which it does without warning. The server does real
 * work for this case: `verified-chat.js` *holds* the failure, finishes the turn, sends the
 * cleaned citations and the sources, and only then re-throws, so the surviving text stays
 * checkable. Throwing on the frame unwound this function before it could return any of
 * that, and the reader got a bare error card — the app discarding the evidence trail the
 * server had just gone out of its way to preserve. So the error is recorded, the read
 * stops, and whatever arrived is returned with it.
 *
 * An error with *no* text before it is unchanged: there is nothing to preserve, so it
 * throws and the caller reports it as the whole outcome of the turn.
 */
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
  let truncated = false;
  let failure = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
      else if (frame.type === "truncated") truncated = true;
      else if (frame.type === "sources") {
        if (!frame.provisional) sources = frame.sources;
      } else if (frame.type === "error") failure = frame.message;
    }

    // The server sends `error` last and then closes, so there is nothing after it worth
    // reading. Cancelling rather than draining releases the connection now.
    if (failure) {
      await reader.cancel().catch(() => {});
      break;
    }
  }

  if (!answer.trim()) {
    throw new Error(failure ?? "The connection closed before an answer arrived.");
  }

  return { answer, sources, incomplete: incompleteFrom({ truncated, failure }) };
}

/**
 * Why an answer is less than a whole one, or null if it is whole.
 *
 * A single shape for the two ways a turn can arrive damaged, because the reader needs the
 * same thing from both: the text above is not all of what was coming, and the sources under
 * it are everything that was retrieved rather than everything that was cited.
 */
function incompleteFrom({ truncated, failure }) {
  if (failure) {
    // Most upstream messages are already written as sentences; don't punctuate them twice.
    const reason = String(failure).trim().replace(/[.!?]+$/, "");
    return {
      kind: "interrupted",
      label: "Interrupted",
      text: `The model stopped part-way through this answer: ${reason}. What you can see is what arrived — the sources below are everything the check retrieved.`,
    };
  }
  if (truncated) {
    return {
      kind: "truncated",
      label: "Cut short",
      text: "This answer ran into the model's output limit and stops mid-way, so the last point it was making — and any citation on it — is missing. The sources below are everything the check retrieved.",
    };
  }
  return null;
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
  el.newCheckBtn.disabled = true;

  try {
    const { answer, sources, incomplete } = await streamChat([{ role: "user", content: prompt }], {
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
    entry.incomplete = incomplete;
    // A cut-off answer never reaches its VERDICT line, and the `?? "insufficient"` fallback
    // would then stamp it "Insufficient evidence" — a finding, in the app's own voice, that
    // the model never made and the reader has no way to tell from one it did. Left null when
    // the turn is known to be incomplete; the notice above the card says what happened
    // instead, which is the true answer to "why is there no verdict".
    entry.verdictKey = verdictKey ?? (incomplete ? null : "insufficient");
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
    el.newCheckBtn.disabled = false;
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
  el.newCheckBtn.disabled = true;
  let settled = false;

  try {
    const { answer, sources, incomplete } = await streamChat([...historyFor(entry), { role: "user", content: question }], {
      signal: controller.signal,
      onStage: (frame) => {
        const status = document.getElementById("followupStatus");
        if (status) status.textContent = stageText(frame);
      },
    });

    // Kept in the thread even when it came back damaged. A partial answer is text the model
    // genuinely wrote, so replaying it as history is honest — and it carries its own notice,
    // so the next turn is not built on prose the reader was never told was cut off.
    entry.followups.push({ question, answer, sources, incomplete });
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
    el.newCheckBtn.disabled = false;
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

el.newCheckBtn.addEventListener("click", startNewCheck);

el.linkInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    el.checkBtn.click();
  }
});

el.linkInput.addEventListener("input", updateComposerMode);
el.searchInput.addEventListener("input", () => renderLibrary(el.searchInput.value));

// Fires once the browser has actually decoded the video's dimensions — overrides
// whatever `setVideoAspect` guessed from the API/URL with the real ratio, so the pane
// never stays letterboxed or cropped once playback is possible.
el.videoPlayer.addEventListener("loadedmetadata", () => {
  if (el.videoPlayer.videoWidth && el.videoPlayer.videoHeight) {
    setVideoAspect(`${el.videoPlayer.videoWidth} / ${el.videoPlayer.videoHeight}`);
  }
});

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
  renderEmptyState();
}
updateComposerMode();
loadServerConfig();
el.linkInput.focus();
