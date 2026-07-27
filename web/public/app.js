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

function messageElement(message) {
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
    for (const message of conversation.messages) {
      el.messages.append(messageElement(message));
    }
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

async function send(text) {
  const conversation = activeConversation() ?? newConversation();
  // Remembered so the result can be filed against the conversation it belongs to even
  // if the user switches away — or deletes it — while the answer is still streaming.
  const conversationId = conversation.id;

  conversation.messages.push({ role: "user", content: text });
  if (conversation.messages.filter((m) => m.role === "user").length === 1) {
    conversation.title = titleFrom(text);
  }
  persist();
  renderSidebar();
  renderMessages();

  // Only real turns go upstream — a previous error bubble is UI, not context.
  const history = conversation.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

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

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ messages: history }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        sessionStorage.removeItem(PASSPHRASE_KEY);
        el.passDialog.showModal();
      }
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

        if (frame.type === "model") {
          el.modelBadge.textContent = frame.model;
          el.modelBadge.hidden = false;
        } else if (frame.type === "delta") {
          answer += frame.text;
          body.innerHTML = renderMarkdown(answer);
          scrollToBottom();
        } else if (frame.type === "error") {
          throw new Error(frame.message);
        }
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") failed = error.message;
  } finally {
    body.classList.remove("caret");
    inFlight = null;
    setBusy(false);
  }

  // Re-look up rather than reusing the captured object: if the conversation was deleted
  // mid-stream it is no longer in `conversations`, and appending to the detached object
  // would persist nothing while leaving the message on screen until the next render.
  const target = conversations.find((c) => c.id === conversationId);
  if (target) {
    if (answer) target.messages.push({ role: "assistant", content: answer });
    if (failed) target.messages.push({ role: "error", content: failed });
    persist();
  }

  renderMessages();
  el.input.focus();
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
