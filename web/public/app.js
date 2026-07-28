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
let serverConfig = { requiresPassword: false, apiKeyConfigured: true, maxInputChars: 8000 };

// Mirrors the stage names `resolveTikTokParts` and `streamChat` emit in web/lib/gemini.js.
const STAGE_LABELS = {
  resolving: "Resolving the video link…",
  fetchingMedia: "Fetching the video…",
  uploading: "Uploading the video for analysis…",
  analysing: "Watching the video…",
};

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
function renderMarkdown(text) {
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
      return escapeHTML(plain)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    })
    .join("");
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
    body.innerHTML = renderMarkdown(message.content);
  } else {
    body.textContent = message.content;
  }

  wrap.append(who, body);

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
    el.modelBadge.hidden = true;
  } else {
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

  // Only real turns go upstream — a previous error bubble is UI, not context.
  const history = conversation.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  const bubble = messageElement({ role: "assistant", content: "" });
  const body = bubble.querySelector(".body");
  body.classList.add("caret");

  // Shown while a pasted video is still being resolved/fetched/watched — the one part
  // of a turn that can go tens of seconds with nothing to stream, and so the one part
  // that reads as broken without something on screen saying otherwise.
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.hidden = true;
  bubble.insertBefore(stage, body);

  el.messages.append(bubble);
  scrollToBottom();

  const controller = new AbortController();
  inFlight = controller;
  setBusy(true);
  setHint("");

  let answer = "";
  let failed = null;
  let retryable = false;

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
      body.innerHTML = renderMarkdown(answer);
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
      if (done) break;
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

        if (frame.type === "status") {
          stage.textContent = STAGE_LABELS[frame.stage] ?? frame.stage;
          stage.hidden = false;
        } else if (frame.type === "model") {
          el.modelBadge.textContent = frame.model;
          el.modelBadge.hidden = false;
        } else if (frame.type === "delta") {
          stage.hidden = true;
          answer += frame.text;
          scheduleRender();
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
    // Flushed synchronously rather than left to a pending rAF: the bubble has to show
    // the final `answer` the instant streaming stops, not up to one frame late.
    body.innerHTML = renderMarkdown(answer);
    body.classList.remove("caret");
    stage.hidden = true;
    inFlight = null;
    setBusy(false);
  }

  // Re-look up rather than reusing the conversation found at the top: if it was
  // deleted mid-stream it is no longer in `conversations`, and appending to the
  // detached object would persist nothing while leaving the message on screen until
  // the next render.
  const target = conversations.find((c) => c.id === conversationId);
  if (target) {
    if (answer) target.messages.push({ role: "assistant", content: answer });
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
