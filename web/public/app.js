// Chat front end. Holds conversations in localStorage and talks to /api/chat.
//
// Note what is absent: there is no API key here, and no code path that could obtain
// one. The server sends tokens, never credentials.

const STORAGE_KEY = "seer.chat.conversations.v1";
const ACTIVE_KEY = "seer.chat.active.v1";
const PASSPHRASE_KEY = "seer.chat.pass";

const el = {
  app: document.getElementById("app"),
  conversations: document.getElementById("conversations"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("empty-state"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  hint: document.getElementById("composer-hint"),
  title: document.getElementById("chat-title"),
  modelBadge: document.getElementById("model-badge"),
  newChat: document.getElementById("new-chat"),
  toggleSidebar: document.getElementById("toggle-sidebar"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  passDialog: document.getElementById("passphrase-dialog"),
  passForm: document.getElementById("passphrase-form"),
  passInput: document.getElementById("passphrase-input"),
};

let conversations = load();
let activeId = localStorage.getItem(ACTIVE_KEY);
let inFlight = null;
let serverConfig = { requiresPassword: false, apiKeyConfigured: true, maxInputChars: 8000, maxTurns: 20 };
// What the pill shows: the last `model` frame, or the server's degradation snapshot from
// /api/config before any answer has arrived. Held here rather than read back off the DOM
// so re-rendering the message list can't lose it.
let modelState = null;

/* ---------------- storage ---------------- */

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  } catch (error) {
    // Quota is the realistic failure. Say so rather than silently losing history.
    setHint("Couldn't save history to this browser — it may be full.", true);
  }
}

function activeConversation() {
  return conversations.find((c) => c.id === activeId) ?? null;
}

function newConversation() {
  const conversation = {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [],
    createdAt: Date.now(),
  };
  conversations.unshift(conversation);
  activeId = conversation.id;
  persist();
  return conversation;
}

function titleFrom(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 42 ? `${flat.slice(0, 42)}…` : flat || "New chat";
}

/* ---------------- rendering ---------------- */

function escapeHTML(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal markdown: fenced code, inline code, bold. Everything is HTML-escaped first
 * and the only tags introduced afterwards are ones this function writes, so model
 * output cannot inject markup.
 */
function renderMarkdown(text, sources) {
  // Odd segments are the insides of ``` fences; leave those untouched.
  const segments = text.split(/```/);
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        // Drop the language tag line, and the newline the closing fence sits on.
        const body = segment.replace(/^[a-zA-Z0-9-]*\n/, "").replace(/\n$/, "");
        return `<pre><code>${escapeHTML(body)}</code></pre>`;
      }
      // The container is `white-space: pre-wrap`, so newlines butting up against a
      // <pre> would render on top of its own margins as a blank gap. The block breaks
      // the line by itself; strip the redundant ones.
      let plain = segment;
      if (index > 0) plain = plain.replace(/^\n+/, "");
      if (index < segments.length - 1) plain = plain.replace(/\n+$/, "");
      return linkCitations(
        escapeHTML(plain)
          .replace(/`([^`\n]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>"),
        sources,
      );
    })
    .join("");
}

/**
 * Turn `[3]` into a link to source 3.
 *
 * A marker the reader cannot follow is only marginally better than no marker: the whole
 * point of the citation rule is that a claim can be checked, and "can be checked" means
 * one click, not scrolling to a list and matching a number by eye. Markers with no
 * matching source are left as plain text, and should never arrive — the server deletes a
 * marker naming a source it never retrieved before the answer is sent. This is the
 * belt-and-braces for that: linking one somewhere plausible would be worse than showing it
 * inert.
 *
 * Runs on already-escaped HTML and only ever inserts a URL that came from the server's
 * ledger, escaped again here.
 */
function linkCitations(html, sources) {
  if (!sources?.length) return html;
  const byNumber = new Map(sources.map((s) => [String(s.n), s]));
  return html.replace(/\[(\d+)\]/g, (match, number) => {
    const source = byNumber.get(number);
    if (!source) return match;
    return `<a class="citation" href="${escapeHTML(source.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(source.title)}">[${number}]</a>`;
  });
}

/**
 * The model pill.
 *
 * It exists to answer one question — *what actually produced this answer* — and until now
 * it only answered half of it. The chain steps down when the preferred model is out of
 * quota or the day's budget is nearly spent, and a badge that reads `gemini-2.0-flash`
 * with no explanation looks like a misconfiguration rather than a system working as
 * designed. Degradation is a state worth seeing: it is temporary, it changes how much the
 * answer is worth trusting, and it recovers on its own, so the reader wants to know both
 * that it happened and roughly when it will stop.
 *
 * `state` is the server's `model` frame, or the `health` block from /api/config.
 */
function renderModelBadge(state) {
  if (!state?.model) {
    el.modelBadge.hidden = true;
    return;
  }
  el.modelBadge.hidden = false;
  el.modelBadge.textContent = state.degraded && state.label
    ? `${state.model} · ${state.label}`
    : state.model;
  el.modelBadge.classList.toggle("degraded", Boolean(state.degraded));
  // The note names both models and the recovery time; the pill has room for neither.
  el.modelBadge.title = state.note || `Answering on ${state.model}.`;
}

/**
 * What the server says it is doing right now, in the reader's words.
 *
 * Every one of these is a phase that produces no text: fetching a clip, waiting on a model
 * that has to watch it, a model thinking before it searches. They are most of the wait on
 * a video, and until they were reported the bubble simply sat empty through all of them —
 * which looks exactly like a request that has died, and gives no way to tell the two apart.
 */
function stageText(stage) {
  switch (stage?.stage) {
    case "attaching":
      return "Fetching the video";
    case "waiting":
      if (stage.media) return "Watching the video";
      return stage.round > 0 ? "Reading the sources" : "Asking the model";
    case "thinking":
      return stage.round > 0 ? "Working through the sources" : "Working out what to check";
    case "busy":
      // Named as Google's problem, not the app's. A reader who thinks they broke something
      // starts checking their key; one who knows the service is full just waits.
      return "Every Gemini model is busy — waiting a moment and trying again";
    case "rewriting":
      return "Rewriting — the first answer failed the citation check";
    default:
      return "Working";
  }
}

/**
 * The status line, with a clock.
 *
 * The elapsed count is the part that earns its place: "Watching the video" alone is
 * reassuring for five seconds and ambiguous at forty. With a number next to it the reader
 * can see the difference between slow and stuck, and decide whether to wait or press Stop.
 */
function statusElement() {
  const wrap = document.createElement("div");
  wrap.className = "stage";
  const label = document.createElement("span");
  label.className = "stage-label";
  const clock = document.createElement("span");
  clock.className = "stage-clock";
  wrap.append(label, clock);

  const startedAt = Date.now();
  let text = "Working";
  const paint = () => {
    label.textContent = `${text}…`;
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    clock.textContent = seconds >= 3 ? `${seconds}s` : "";
  };
  paint();
  const timer = setInterval(paint, 1000);

  return {
    element: wrap,
    /** Name the current step, and show the line if text had hidden it. */
    set(next) {
      text = next;
      wrap.hidden = false;
      paint();
    },
    /**
     * Stand down while the answer is arriving.
     *
     * Hidden rather than removed: an answer can be followed by another silent phase — the
     * citation check sending it back for a rewrite — and the line has to be able to come
     * back without losing the clock, which is measuring the whole request.
     */
    hide() {
      wrap.hidden = true;
    },
    /** Seconds the request has been running — what an unexplained ending gets measured in. */
    elapsed() {
      return Math.round((Date.now() - startedAt) / 1000);
    },
    stop() {
      clearInterval(timer);
      wrap.remove();
    },
  };
}

/** The banner an answer earns by running into the output-token cap. */
function truncatedElement() {
  const wrap = document.createElement("div");
  wrap.className = "truncated";
  wrap.textContent =
    "This answer hit the reply-length limit and stops mid-thought. Ask for the rest, or for a shorter version.";
  return wrap;
}

/**
 * The searches, as chips above the answer.
 *
 * `pending` are searches the server has dispatched but not yet heard back from. They are
 * shown because they are the wait: a fact-check runs several searches at once and then
 * spends seconds reading the results, and without them the reader watches an empty bubble
 * and concludes the app has hung. A chip that says what is being looked up turns the same
 * seconds into visible progress.
 */
function searchListElement(searches, pending = [], pendingReads = []) {
  const wrap = document.createElement("div");
  wrap.className = "searches";
  for (const item of searches) {
    const chip = document.createElement("div");
    if (item.type === "find") {
      // A read is a different act from a search and is labelled as one. It is also the step
      // that most needs saying out loud: opening a page and scanning it is the slowest thing
      // the server does, and an unlabelled pause there is indistinguishable from a hang.
      chip.className = item.error ? "search-chip failed" : "search-chip read";
      chip.textContent = item.error
        ? `Couldn’t read ${item.domain || item.url} — ${item.error}`
        : item.matches > 0
          ? `Read ${item.domain || item.url} · ${item.matches} passage${item.matches === 1 ? "" : "s"} on “${item.find}”`
          : `Read ${item.domain || item.url} · nothing on “${item.find}”`;
      if (item.claim) chip.title = `Checking: ${item.claim}`;
      wrap.append(chip);
      continue;
    }
    chip.className = item.error ? "search-chip failed" : "search-chip";
    chip.textContent = item.error
      ? `Search failed: ${item.query || "(invalid query)"} — ${item.error}`
      : `Searched “${item.query}” · ${item.results.length} source${
          item.results.length === 1 ? "" : "s"
        }`;
    if (item.claim) chip.title = `Checking: ${item.claim}`;
    wrap.append(chip);
  }
  for (const item of pending) {
    const chip = document.createElement("div");
    chip.className = "search-chip pending";
    chip.textContent = `Searching “${item.query}”…`;
    if (item.claim) chip.title = `Checking: ${item.claim}`;
    wrap.append(chip);
  }
  for (const item of pendingReads) {
    const chip = document.createElement("div");
    chip.className = "search-chip pending read";
    chip.textContent = `Reading ${domainOf(item.url)} for “${item.find}”…`;
    if (item.claim) chip.title = `Checking: ${item.claim}`;
    wrap.append(chip);
  }
  return wrap;
}

/** Host of a URL, for a chip that has no room for the whole thing. */
function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The links, listed out.
 *
 * This used to print under every answer, and it no longer does. Every `[3]` in the answer is
 * now a link to source 3 where it stands — see `linkCitations` — so a numbered list
 * underneath repeats the entire evidence trail in the one form nobody reads, and its length
 * is what made a two-source answer look like a literature review. The links themselves are
 * still kept for every answer, stored with the message and used to resolve the markers; what
 * changed is that printing them is now conditional.
 *
 * Two conditions, and each is a case where the inline links cannot do the job alone:
 *
 * - `provisional` — the list sent while the searches are still landing. There is no answer
 *   yet, so there are no inline markers to be links, and this is the reader's only view of
 *   the evidence during the longest silence in the turn.
 * - `fallback` — the server says the finished answer's own links are not enough: it cited
 *   nothing, or it was cut off, or it failed the citation check. Whenever the reader is
 *   being asked to check something themselves, they get everything that was retrieved.
 */
function sourceListElement(sources, { provisional = false, fallback = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = provisional ? "sources provisional" : "sources";

  const heading = document.createElement("div");
  heading.className = "sources-heading";
  heading.textContent = provisional
    ? `Sources found (${sources.length}) — retrieved by the app; reading them now`
    : fallback
      ? `Every source retrieved (${sources.length}) — listed in full because the answer above does not link them all`
      : `Sources (${sources.length}) — retrieved by the app, not written by the model`;
  wrap.append(heading);

  const list = document.createElement("ol");
  for (const source of sources) {
    const item = document.createElement("li");
    item.value = source.n;
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title;
    const domain = document.createElement("span");
    domain.className = "source-domain";
    domain.textContent = ` ${source.domain}`;
    item.append(link, domain);
    // The passage the page reader pulled off this page, when there is one. It is the
    // sentence the citation actually rests on, and showing it is the difference between a
    // list of domain names and a list the reader can judge without opening anything.
    if (source.quote) {
      const quote = document.createElement("div");
      quote.className = "source-quote";
      quote.textContent = `“${source.quote}”`;
      item.append(quote);
    }
    list.append(item);
  }
  wrap.append(list);
  return wrap;
}

/**
 * @param conversationId - Passed only for the conversation's *final* message, which is
 *   the only one a retry can safely rebuild. Omitted for the in-progress bubble
 *   streamAnswer builds before the answer has a home to retry into.
 */
function messageElement(message, conversationId) {
  const wrap = document.createElement("div");
  wrap.className = `message ${message.role}`;

  const who = document.createElement("div");
  who.className = "who";
  who.textContent =
    message.role === "user" ? "You" : message.role === "error" ? "Error" : "Assistant";

  const body = document.createElement("div");
  body.className = "body";
  if (message.role === "assistant") {
    body.innerHTML = renderMarkdown(message.content, message.sources);
  } else {
    body.textContent = message.content;
  }

  wrap.append(who);
  // The evidence trail is part of the message, so it is stored with it and re-rendered
  // from history — an answer whose sources vanished on reload would be unauditable the
  // moment the page refreshed.
  if (message.searches?.length) wrap.append(searchListElement(message.searches));
  wrap.append(body);
  // The links are stored with every answer and used above to resolve its markers; the list
  // is printed only when the server said the inline links could not carry the evidence on
  // their own. See `sourceListElement`.
  if (message.sources?.length && message.sourcesFallback) {
    wrap.append(sourceListElement(message.sources, { fallback: true }));
  }
  if (message.truncated) wrap.append(truncatedElement());

  // `retryable` distinguishes "Gemini is overloaded, try again" from "that request was
  // malformed and will fail identically" — retrying the latter just burns another round
  // trip to reproduce the same error.
  if (message.role === "error" && message.retryable && conversationId) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "retry-button";
    retryButton.textContent = "Try again";
    retryButton.addEventListener("click", () => retry(conversationId, message.restorePoint));
    wrap.append(retryButton);
  }

  return wrap;
}

function renderMessages() {
  const conversation = activeConversation();
  el.messages.replaceChildren();

  if (!conversation || conversation.messages.length === 0) {
    el.messages.append(el.emptyState);
    el.emptyState.hidden = false;
    // Nothing has answered yet, so there is no model to report — except a degradation,
    // which is true of the next message the user sends and is worth showing before they
    // send it.
    renderModelBadge(modelState?.degraded ? modelState : null);
  } else {
    renderModelBadge(modelState);
    el.emptyState.hidden = true;
    conversation.messages.forEach((message, index) => {
      // Only the last message gets a retry button. Retrying rebuilds the conversation
      // from the failed turn onwards, so offering it on an error further up would
      // discard every exchange that came after it — the user asked to re-run one turn,
      // not to delete the rest of the thread.
      const isLast = index === conversation.messages.length - 1;
      el.messages.append(messageElement(message, isLast ? conversation.id : undefined));
    });
  }

  el.title.textContent = conversation?.title ?? "New chat";
  scrollToBottom();
}

function renderSidebar() {
  el.conversations.replaceChildren();

  for (const conversation of conversations) {
    const row = document.createElement("div");
    row.className = `conversation${conversation.id === activeId ? " active" : ""}`;

    const open = document.createElement("button");
    open.type = "button";
    open.className = "conversation-title";
    open.textContent = conversation.title;
    open.addEventListener("click", () => selectConversation(conversation.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "conversation-delete";
    remove.textContent = "×";
    remove.title = "Delete conversation";
    remove.setAttribute("aria-label", `Delete ${conversation.title}`);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteConversation(conversation.id);
    });

    row.append(open, remove);
    el.conversations.append(row);
  }
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function setHint(text, isWarning = false) {
  el.hint.textContent = text;
  el.hint.classList.toggle("warn", isWarning);
}

function setStatus(text, state) {
  el.statusText.textContent = text;
  el.statusDot.className = `dot ${state ?? ""}`.trim();
}

function setBusy(busy) {
  el.send.hidden = busy;
  el.stop.hidden = !busy;
  el.input.disabled = false; // Stay typeable — the next message can be queued mentally.
  // A retry from an earlier failed turn while a new one is already streaming would
  // truncate the conversation out from under it — `retry()` guards against that too,
  // but disabling the button is what stops the click from looking like it did nothing.
  for (const button of el.messages.querySelectorAll(".retry-button")) {
    button.disabled = busy;
  }
}

/* ---------------- actions ---------------- */

function selectConversation(id) {
  if (inFlight) inFlight.abort();
  activeId = id;
  persist();
  renderSidebar();
  renderMessages();
  el.app.classList.remove("sidebar-open");
  el.input.focus();
}

function deleteConversation(id) {
  conversations = conversations.filter((c) => c.id !== id);
  if (activeId === id) {
    if (inFlight) inFlight.abort();
    activeId = conversations[0]?.id ?? null;
  }
  persist();
  renderSidebar();
  renderMessages();
}

function startNewChat() {
  if (inFlight) inFlight.abort();
  const existing = activeConversation();
  // Don't stack up empty "New chat" rows if the button gets pressed twice.
  if (existing && existing.messages.length === 0) {
    el.input.focus();
    return;
  }
  newConversation();
  renderSidebar();
  renderMessages();
  el.input.focus();
}

async function loadServerConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const received = await response.json();
    // Merged over the defaults rather than replacing them: a partial or unexpected
    // payload would otherwise leave `maxInputChars` undefined, and every length
    // comparison against it silently false — losing the client-side cap entirely.
    serverConfig = {
      ...serverConfig,
      ...received,
      maxInputChars:
        Number.isFinite(received?.maxInputChars) && received.maxInputChars > 0
          ? received.maxInputChars
          : serverConfig.maxInputChars,
      maxTurns:
        Number.isFinite(received?.maxTurns) && received.maxTurns > 0
          ? received.maxTurns
          : serverConfig.maxTurns,
    };
  } catch {
    setStatus("Server unreachable", "bad");
    return;
  }

  if (!serverConfig.apiKeyConfigured) {
    setStatus("No API key on server", "bad");
    setHint(
      "The server has no GEMINI_API_KEY. Copy web/.env.example to web/.env.local, add your key, and restart.",
      true,
    );
    el.send.disabled = true;
    return;
  }

  setStatus(serverConfig.requiresPassword ? "Key on server · gated" : "Key on server", "ok");

  // Only a degradation is worth showing before the first answer: naming the preferred
  // model on a fresh page would be a promise the chain hasn't made yet.
  if (serverConfig.health?.degraded) {
    modelState = serverConfig.health;
    renderModelBadge(modelState);
  }

  if (serverConfig.requiresPassword && !sessionStorage.getItem(PASSPHRASE_KEY)) {
    el.passDialog.showModal();
  }
}

function requestHeaders() {
  const headers = { "content-type": "application/json" };
  const passphrase = sessionStorage.getItem(PASSPHRASE_KEY);
  if (passphrase) headers["x-app-password"] = passphrase;
  return headers;
}

/**
 * Streams one assistant reply into `conversationId`'s existing history and appends the
 * result — an `assistant` message, an `error` message, or both if a partial answer
 * arrived before the failure.
 *
 * Shared by `send()` (a fresh user turn) and `retry()` (re-attempting one already in
 * history), so a retry replays the same history rather than appending a duplicate user
 * turn.
 */
async function streamAnswer(conversationId) {
  const conversation = conversations.find((c) => c.id === conversationId);
  if (!conversation) return;

  // Whatever this call appends from here on is exactly what `retry()` undoes before
  // its own attempt — recorded now, before anything is added, so a retry truncates
  // back to precisely "just the user's turn" and never eats history from an earlier
  // exchange.
  const restorePoint = conversation.messages.length;

  // Only real turns go upstream — a previous error bubble is UI, not context. Trimmed to
  // the server's own MAX_TURNS before it ever leaves the browser: the server drops
  // anything older on arrival regardless, so uploading it first only spends the reader's
  // bandwidth — and the wait — on a video-heavy thread's history to have it thrown away.
  const history = conversation.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }))
    .slice(-serverConfig.maxTurns);

  const bubble = messageElement({ role: "assistant", content: "" });
  const body = bubble.querySelector(".body");
  body.classList.add("caret");
  el.messages.append(bubble);
  scrollToBottom();

  const controller = new AbortController();
  inFlight = controller;
  setBusy(true);
  setHint("");

  let answer = "";
  let failed = null;
  let retryable = false;
  const searches = [];
  // Dispatched but not yet returned, in the order the server will report them.
  let pendingSearches = [];
  // Pages the server has opened but not finished scanning, shown for the same reason.
  let pendingReads = [];
  let sources = [];
  let sourcesFallback = false;
  let truncated = false;

  // Live containers for the evidence trail. Created up front and left empty so the
  // ordering — searches, answer, sources, warning — is fixed by the DOM rather than by
  // the order frames happen to arrive in.
  let searchesEl = document.createElement("div");
  searchesEl.className = "searches";
  bubble.insertBefore(searchesEl, body);
  // Above the searches, because it describes the step in progress and the searches are
  // the record of steps already taken. Shown from the moment the request is sent: the
  // silence before the first frame is exactly the silence it exists to explain.
  const status = statusElement();
  bubble.insertBefore(status.element, searchesEl);
  let sourcesEl = document.createElement("div");
  let truncatedEl = document.createElement("div");
  bubble.append(sourcesEl, truncatedEl);

  /** Swap a placeholder for freshly rendered content, keeping the handle pointing at it. */
  const replace = (element, next) => {
    element.replaceWith(next);
    return next;
  };

  // Re-parsing and re-rendering the whole answer on every delta is O(n) per token and
  // O(n^2) over a long reply, and it also blows away any text selection the reader had
  // mid-stream. Batched to at most one render per animation frame instead: `answer`
  // keeps accumulating at whatever rate deltas arrive, but the DOM only actually
  // updates as fast as the screen can show it — a fast model emitting many small
  // chunks between two frames costs one render, not many.
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      body.innerHTML = renderMarkdown(answer, sources);
      scrollToBottom();
    });
  }

  try {
    let response;
    try {
      response = await fetch("/api/chat", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ messages: history }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      // Couldn't even reach the server — a network blip, not a request Gemini itself
      // rejected. Worth another try once the network recovers.
      retryable = true;
      throw new Error(`Could not reach the server: ${error.message}`);
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        sessionStorage.removeItem(PASSPHRASE_KEY);
        el.passDialog.showModal();
      }
      // 429 is the one pre-stream failure that resolves on its own by waiting. The rest
      // — a malformed request, the wrong passphrase, no key configured server-side —
      // fail identically on a retry, so offering one would just spend a round trip to
      // reproduce the same error.
      retryable = response.status === 429;
      throw new Error(payload.error ?? `Request failed (HTTP ${response.status}).`);
    }

    if (!response.body) throw new Error("The server sent an empty response.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // The server closed without ever sending an answer or an error. That is not a
        // completed turn, and until now it was reported as one: the bubble was left empty,
        // nothing was stored, and the next render removed it — the user watched a request
        // vanish with no idea whether it failed or was still going. The usual cause is the
        // host killing the function mid-flight, so the elapsed time is quoted; on Vercel
        // it lands suspiciously close to the configured max duration.
        if (!answer) {
          retryable = true;
          throw new Error(
            `The connection closed after ${status.elapsed()}s without an answer. If this ` +
              `happens on every video, the server is being cut off before it can finish — ` +
              `raise the function timeout (Vercel: Settings → Functions → Max Duration).`,
          );
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        // Anything that isn't a `data:` line is a comment or a field we don't use —
        // the server's keep-alive pings arrive here as `: keep-alive`.
        if (!raw.startsWith("data:")) continue;

        let frame;
        try {
          frame = JSON.parse(raw.slice(5).trim());
        } catch {
          // One unreadable frame is not worth throwing away an answer in progress.
          continue;
        }

        if (frame.type === "stage") {
          status.set(stageText(frame));
          scrollToBottom();
        } else if (frame.type === "model") {
          modelState = frame;
          renderModelBadge(modelState);
        } else if (frame.type === "truncated") {
          truncated = true;
          truncatedEl = replace(truncatedEl, truncatedElement());
        } else if (frame.type === "delta") {
          answer += frame.text;
          // Text is arriving; the reader can see for themselves that it is working.
          if (frame.text) status.hide();
          scheduleRender();
        } else if (frame.type === "searching") {
          pendingSearches = frame.searches ?? [];
          pendingReads = frame.reads ?? [];
          searchesEl = replace(searchesEl, searchListElement(searches, pendingSearches, pendingReads));
          scrollToBottom();
        } else if (frame.type === "search") {
          searches.push(frame);
          // Results come back in the order the round dispatched them, so the oldest
          // outstanding chip is the one this frame just resolved.
          pendingSearches = pendingSearches.slice(1);
          searchesEl = replace(searchesEl, searchListElement(searches, pendingSearches, pendingReads));
          scrollToBottom();
        } else if (frame.type === "find") {
          // A page was read. Filed in the same trail as the searches, in the order the
          // server did the work, because that order is the story of how the answer was
          // arrived at: searched, then read the two that mattered.
          searches.push(frame);
          pendingReads = pendingReads.slice(1);
          searchesEl = replace(searchesEl, searchListElement(searches, pendingSearches, pendingReads));
          scrollToBottom();
        } else if (frame.type === "answer") {
          // The finished answer, with its citations tidied. It replaces everything streamed
          // so far rather than adding to it — the tidy-up can only run on a whole answer, so
          // it necessarily arrives after the last token of the untidied one.
          answer = frame.text;
          scheduleRender();
        } else if (frame.type === "break") {
          // The model stopped to run a tool and has started writing again. A paragraph
          // boundary, not an erasure: the search that caused it is already showing in the
          // trail above, and the text on either side of it is text the reader is entitled
          // to keep. This replaced a `reset` frame that blanked the bubble mid-reply,
          // which is what made a normal answer look like the app coming apart.
          answer += "\n\n";
          scheduleRender();
        } else if (frame.type === "sources") {
          sources = frame.sources;
          // Held whether or not the list is drawn: these rows are what turn every `[n]` in
          // the answer into a link, which is the whole point of not drawing the list.
          sourcesFallback = Boolean(frame.fallback);
          // Hide the bibliography during source lookup (while provisional: true) and only
          // show it once searching is complete with final results.
          const show = !frame.provisional && sourcesFallback;
          sourcesEl = replace(
            sourcesEl,
            show
              ? sourceListElement(sources, { provisional: frame.provisional, fallback: sourcesFallback })
              : document.createElement("div"),
          );
          // Re-render so the markers become links.
          scheduleRender();
          scrollToBottom();
        } else if (frame.type === "error") {
          // The server already classified this — a quota/5xx/timeout failure sets it,
          // a policy refusal or a malformed request doesn't.
          retryable = Boolean(frame.retryable);
          throw new Error(frame.message);
        }
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") failed = error.message;
  } finally {
    status.stop();
    // Whatever was still in flight when the stream ended is not in flight any more —
    // a "Searching…" chip left spinning under a finished answer says the app is still
    // working when it has stopped, which is the one thing the chip exists to prevent.
    if (pendingSearches.length > 0 || pendingReads.length > 0) {
      pendingSearches = [];
      pendingReads = [];
      searchesEl = replace(searchesEl, searchListElement(searches));
    }
    // Flushed synchronously rather than left to a pending rAF: the bubble has to show
    // the final `answer` the instant streaming stops, not up to one frame late.
    body.innerHTML = renderMarkdown(answer, sources);
    body.classList.remove("caret");
    inFlight = null;
    setBusy(false);
  }

  // Re-look up rather than reusing the conversation found at the top: if it was
  // deleted mid-stream it is no longer in `conversations`, and appending to the
  // detached object would persist nothing while leaving the message on screen until
  // the next render.
  const target = conversations.find((c) => c.id === conversationId);
  if (target) {
    if (answer) {
      // Stored alongside the text, so the answer keeps its evidence across a reload:
      // `searches` is what was asked, and `sources` is what came back — the rows the
      // markers in `content` point at, which is why they are stored rather than redrawn.
      target.messages.push({
        role: "assistant",
        content: answer,
        searches: searches.length ? searches : undefined,
        sources: sources.length ? sources : undefined,
        // Whether the list was printed under the answer, so a reload renders the same thing
        // rather than quietly deciding for itself.
        sourcesFallback: sourcesFallback || undefined,
        truncated: truncated || undefined,
      });
    }
    if (failed) target.messages.push({ role: "error", content: failed, retryable, restorePoint });
    persist();
  }

  renderMessages();
  el.input.focus();
}

async function send(text) {
  const conversation = activeConversation() ?? newConversation();
  const conversationId = conversation.id;

  conversation.messages.push({ role: "user", content: text });
  if (conversation.messages.filter((m) => m.role === "user").length === 1) {
    conversation.title = titleFrom(text);
  }
  persist();
  renderSidebar();
  renderMessages();

  await streamAnswer(conversationId);
}

/**
 * Re-attempts the turn that failed at `restorePoint`, replaying the same history
 * rather than appending a duplicate user message.
 */
function retry(conversationId, restorePoint) {
  if (inFlight) return; // A stream from a different turn is already in flight.
  const conversation = conversations.find((c) => c.id === conversationId);
  if (!conversation || restorePoint === undefined) return;

  // Everything from `restorePoint` on must be the failed attempt's own output — a
  // partial assistant reply, the error, or both. If anything else is there, this button
  // outlived the turn it belonged to and truncating would destroy a later exchange.
  const tail = conversation.messages.slice(restorePoint);
  if (tail.some((m) => m.role === "user")) return;

  // Drops exactly what that attempt appended, and nothing from before it —
  // `restorePoint` was recorded at its start, so the user's turn is left intact.
  conversation.messages.length = restorePoint;
  persist();
  renderMessages();
  streamAnswer(conversationId);
}

/* ---------------- wiring ---------------- */

el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (inFlight) return;

  const text = el.input.value.trim();
  if (!text) return;
  if (text.length > serverConfig.maxInputChars) {
    setHint(
      `That message is ${text.length} characters; the limit is ${serverConfig.maxInputChars}.`,
      true,
    );
    return;
  }

  el.input.value = "";
  el.input.style.height = "auto";
  send(text);
});

el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
});

el.input.addEventListener("input", () => {
  el.input.style.height = "auto";
  el.input.style.height = `${el.input.scrollHeight}px`;
});

el.stop.addEventListener("click", () => inFlight?.abort());
el.newChat.addEventListener("click", startNewChat);
el.toggleSidebar.addEventListener("click", () => {
  el.app.classList.toggle("sidebar-open");
  el.app.classList.toggle("sidebar-hidden");
});

el.passForm.addEventListener("submit", () => {
  const value = el.passInput.value.trim();
  // sessionStorage, not localStorage: closing the tab should end the session.
  if (value) sessionStorage.setItem(PASSPHRASE_KEY, value);
  el.passInput.value = "";
});

if (conversations.length === 0 || !activeConversation()) {
  newConversation();
}

renderSidebar();
renderMessages();
loadServerConfig();
el.input.focus();
