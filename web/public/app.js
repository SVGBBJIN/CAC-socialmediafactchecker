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

import { watchDevice } from "./device.js";

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
  videoImages: document.getElementById("videoImages"),
  passDialog: document.getElementById("passphrase-dialog"),
  passForm: document.getElementById("passphrase-form"),
  passInput: document.getElementById("passphrase-input"),
  linkConfirmDialog: document.getElementById("link-confirm-dialog"),
  linkConfirmForm: document.getElementById("link-confirm-form"),
  linkConfirmTitle: document.getElementById("link-confirm-title"),
  linkConfirmBody: document.getElementById("link-confirm-body"),
  linkConfirmCancel: document.getElementById("link-confirm-cancel"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsDialog: document.getElementById("settings-dialog"),
  settingsForm: document.getElementById("settings-form"),
  settingReducedMotion: document.getElementById("setting-reduced-motion"),
  settingHighContrast: document.getElementById("setting-high-contrast"),
  settingFontSize: document.getElementById("setting-font-size"),
  settingShowQuotes: document.getElementById("setting-show-quotes"),
  settingSystemPrompt: document.getElementById("setting-system-prompt"),
  searchStatus: document.getElementById("searchStatus"),
  imageBtn: document.getElementById("imageBtn"),
  imageInput: document.getElementById("imageInput"),
  imageChip: document.getElementById("imageChip"),
  imageChipThumb: document.getElementById("imageChipThumb"),
  imageChipName: document.getElementById("imageChipName"),
  imageChipRemove: document.getElementById("imageChipRemove"),
  micBtn: document.getElementById("micBtn"),
  sidebar: document.getElementById("sidebar"),
  drawerToggle: document.getElementById("drawerToggle"),
  drawerScrim: document.getElementById("drawerScrim"),
  topbarSettingsBtn: document.getElementById("topbarSettingsBtn"),
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
let pendingConfirmUrl = null; // url waiting on the link-confirm dialog's "Check anyway"

/* ---------------------------------------------------------------- settings */

const SETTINGS_KEY = "seer.settings.v1";
const DEFAULT_SETTINGS = {
  reducedMotion: false,
  highContrast: false,
  fontSize: "normal", // "normal" | "large"
  showQuotes: true, // gates the per-source "Show quote" toggle in sourcesHTML
  systemPrompt: "", // appended to every outgoing message, see withCustomInstructions
};

function loadSettings() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    parsed = {};
  }
  return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort, same as the library and feedback stores.
  }
}

let settings = loadSettings();
let serverConfig = null; // last /api/config response, so the settings dialog can show search status

/** Stamps the accessibility settings onto the root element so the CSS in index.html can
 * key off them. Called once at startup and again on every settings change. */
function applySettings() {
  const root = document.documentElement;
  setAttrIf(root, "data-motion", settings.reducedMotion, "reduced");
  setAttrIf(root, "data-contrast", settings.highContrast, "high");
  setAttrIf(root, "data-font-size", settings.fontSize === "large", "large");
}

function setAttrIf(node, name, condition, value) {
  if (condition) node.setAttribute(name, value);
  else node.removeAttribute(name);
}

/** The custom system-prompt text, appended to an outgoing message. Kept separate from
 * what's stored/displayed as the question so the thread still shows what the user typed,
 * not what was actually sent underneath it. */
function withCustomInstructions(text) {
  const instructions = settings.systemPrompt.trim();
  return instructions
    ? `${text}\n\n[The user has set custom instructions for you to follow throughout this conversation: ${instructions}]`
    : text;
}

/* ---------------------------------------------------------------- device + drawer */

// The layout itself is CSS's job — the media queries in index.html already re-run on
// rotate and resize without any help from here. What JS owns is the part a media query
// cannot express: stamping the *capability* (touch vs. mouse) onto the root element, and
// running the drawer, which is a stateful control rather than a style.
//
// See public/device.js for why width and pointer are kept as separate signals.

let device = { kind: "desktop", touch: false, width: 0 };

/** Publishes the current classification to CSS and re-syncs anything that depends on it. */
function applyDevice(next) {
  const previousKind = device.kind;
  device = next;

  const root = document.documentElement;
  root.setAttribute("data-device", next.kind);
  root.setAttribute("data-pointer", next.touch ? "coarse" : "fine");

  // Growing out of the phone layout — rotating to landscape, un-splitting a tablet,
  // widening a window — turns the drawer back into a permanent column. Leaving
  // `data-drawer="open"` set would then hold a scrim over a perfectly normal sidebar.
  if (next.kind !== "phone" && previousKind === "phone") closeDrawer({ restoreFocus: false });
  syncDrawerInert();
}

function isDrawerOpen() {
  return document.documentElement.getAttribute("data-drawer") === "open";
}

function openDrawer() {
  if (device.kind !== "phone") return;
  document.documentElement.setAttribute("data-drawer", "open");
  el.drawerToggle.setAttribute("aria-expanded", "true");
  el.drawerToggle.setAttribute("aria-label", "Close library");
  syncDrawerInert();
  // Focus has to move into the drawer for a keyboard user, but on a touchscreen landing
  // on the search field summons the on-screen keyboard over the very list the user just
  // opened to browse. The "New check" button is the first control either way.
  if (device.touch) el.newCheckBtn.focus();
  else el.searchInput.focus();
}

function closeDrawer({ restoreFocus = true } = {}) {
  if (!isDrawerOpen()) return;
  // Focus has to leave before the drawer becomes inert, or it lands on <body> and the
  // next Tab restarts from the top of the document.
  if (restoreFocus) el.drawerToggle.focus();
  else if (el.sidebar.contains(document.activeElement)) document.activeElement.blur();

  document.documentElement.removeAttribute("data-drawer");
  el.drawerToggle.setAttribute("aria-expanded", "false");
  el.drawerToggle.setAttribute("aria-label", "Open library");
  syncDrawerInert();
}

/** A closed off-canvas drawer is still in the DOM and still focusable without this —
 *  tabbing from the composer would walk invisibly through the whole library. `inert` is
 *  the belt to the CSS `visibility: hidden` braces, and covers assistive tech too. */
function syncDrawerInert() {
  el.sidebar.inert = device.kind === "phone" && !isDrawerOpen();
}

/* ---------------------------------------------------------------- feedback (like/dislike) */

const FEEDBACK_KEY = "seer.feedback.v1";

function loadFeedback() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FEEDBACK_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistFeedback() {
  try {
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(feedback));
  } catch {
    // Best-effort — losing a thumbs-up on a full/disabled store isn't worth surfacing.
  }
}

let feedback = loadFeedback();

/** One answer's key into `feedback` — the main analysis, or one specific follow-up. */
function feedbackKey(entryId, followupIndex) {
  return followupIndex == null ? entryId : `${entryId}::f${followupIndex}`;
}

/* ---------------------------------------------------------------- image attachment */

// Long enough to keep detail Gemini can actually use, short enough that the base64 body
// stays well under guard.js's `maxImageBase64Bytes`. A phone photo is easily 12MB raw;
// re-encoding client-side is what makes attaching one affordable at all.
const MAX_IMAGE_DIMENSION = 1600;
const IMAGE_JPEG_QUALITY = 0.82;

let pendingImage = null; // { mimeType, data (base64, no prefix), previewURL, name }

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read that file."));
    reader.readAsDataURL(blob);
  });
}

/** Downscales and re-encodes an uploaded image client-side, so what leaves the browser is
 * a bounded JPEG rather than whatever a phone camera produced. */
async function processImageFile(file) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Couldn't read that image.");
  });
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", IMAGE_JPEG_QUALITY));
  if (!blob) throw new Error("Couldn't process that image.");
  const dataURL = await blobToDataURL(blob);
  const base64 = dataURL.slice(dataURL.indexOf(",") + 1);
  return { mimeType: "image/jpeg", data: base64, previewURL: dataURL, name: file.name };
}

function showImageChip(image) {
  el.imageChipThumb.src = image.previewURL;
  el.imageChipThumb.alt = image.name;
  el.imageChipName.textContent = image.name;
  el.imageChip.hidden = false;
}

function clearPendingImage() {
  pendingImage = null;
  el.imageChip.hidden = true;
  el.imageChipThumb.removeAttribute("src");
}

/** `{ image: {...} }` for a message about to be sent, or `{}` — spread onto the message
 * object so a turn with no attachment looks exactly like it did before this existed. */
function imagePayload(image) {
  return image ? { image: { mimeType: image.mimeType, data: image.data } } : {};
}

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

const SUPPORTED_PLATFORMS = new Set(["TikTok", "YouTube", "Instagram"]);

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
 * Whether the user typed a scheme, rather than us inferring one.
 *
 * This is the difference between evidence and a guess. "https://…" is someone saying
 * "this is a link"; a bare "hi.there" is only the regex saying so, and when the probe
 * finds nothing at that name, the regex is what should give way.
 */
function hasExplicitScheme(raw) {
  return /^https?:\/\//i.test(raw.trim());
}

/**
 * Anything that isn't a recognizable link is a follow-up question — "hi", "what about the
 * second claim?", etc. Pasting an actual URL always starts a new check even while a result
 * is on screen — the one case that must never be ambiguous.
 */
function looksLikeFollowup(raw) {
  return raw.trim().length > 0 && !looksLikeLink(raw);
}

/**
 * Ping the link through the server and report what's really there.
 *
 * Returns `null` — meaning "no answer, fall back to the URL's shape" — for any failure of
 * the probe itself: an old deployment without the route, a rate limit, a network blip.
 * A link that genuinely doesn't work comes back as a 200 with `reachable: false`, so the
 * two cases never get confused.
 */
async function pingLink(url) {
  try {
    const response = await fetch("/api/probe-link", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ url }),
    });
    if (!response.ok) return null;
    const probe = await response.json();
    return typeof probe?.reachable === "boolean" ? probe : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort check that a link is something this app can actually check, before spending
 * a full (expensive) fact-check run on it.
 *
 * "Actually check" now means two different things, because there are two kinds of link. On
 * the three video platforms it means a post whose media can be pulled; on every other host
 * it means a page whose text can be read (lib/article.js does the reading, server-side).
 * Both go through this function, and what a link *is* decides which question gets asked.
 *
 * Two paths, split on whether the host already names a platform.
 *
 * When it does, the platform's own resolver decides, alone: it is the code that has to
 * work for the check to produce anything, and on these three platforms it is the *only*
 * thing that can tell a live post from a deleted one — see the note below on why a status
 * code cannot. The host regex picks which resolver to start, which it is entitled to do
 * because a link is unambiguous by host.
 *
 * When it doesn't, the ping takes over entirely (see `verifyByRedirect`): following the
 * redirects is the only way a shortener or a share wrapper ever names its platform, and
 * a name that resolves to nothing is how intake tells a link from a sentence.
 *
 * Verification only ever calls infrastructure that's already safe to hit: /api/probe-link
 * reads headers and never a body, and /api/resolve-media is host-allowlisted to TikTok/
 * Instagram's CDNs (see api/resolve-media.js and lib/link-probe.js) — neither is a
 * "fetch whatever host the user pasted and hand back what it said" path, which is what
 * would make this an SSRF-shaped proxy. A supported platform that fails to confirm, or a
 * page the ping couldn't establish anything about, falls back to asking the user rather
 * than either silently blocking them or guessing it'll work.
 */
async function verifyLinkViewable(url) {
  const platform = platformFor(url);

  // An unrecognised host is the one case with nothing to run the ping *against*: until the
  // redirects have been followed there is no resolver to start. It is also the case where
  // the ping decides the outcome rather than merely raising confidence in it — a shortener
  // or a share wrapper only names its platform once it has been followed, and for a link
  // that turns out to be a page, what the ping saw is the whole of what intake knows.
  if (!SUPPORTED_PLATFORMS.has(platform)) return verifyByRedirect(url, platform);

  // The host already names the platform, so the resolver runs alone — no ping, not even
  // alongside. Measured, not assumed: all three platforms answer 200 for a post that does
  // not exist. They are single-page apps, so the server hands back the same shell either
  // way and "this video is unavailable" is rendered client-side from JS. A deleted
  // YouTube video, a nonexistent TikTok ID and a live reel are indistinguishable to
  // anything reading status codes.
  //
  // Which means a ping on this path cannot come back dead, cannot beat the resolver to an
  // answer, and cannot change the one it gives — it is a second request to the same
  // platform for information it already declined to put in the response line. Racing it
  // would be free in wall-clock and still wrong: the resolver is the only code that can
  // tell these two cases apart, because parsing the embed is the only thing that does.
  return verifyOnPlatform(url, platform);
}

/**
 * What the ping found when there's nothing at the other end.
 *
 * `notALink` is the narrow claim: only a name that doesn't resolve means the string was
 * never a link. A 404 or a timeout is a real host, so those still ask the user rather than
 * quietly rewriting their paste into a chat message.
 */
function deadLinkResult(url, probe, platform) {
  return {
    ok: false,
    url,
    platform: probe.platform ?? platform,
    reason: probe.reason ?? "Couldn't reach that link.",
    notALink: probe.kind === "dns",
  };
}

/**
 * Classify a link whose host names no platform, by following it.
 *
 * Serial by necessity — the redirects are what produce the platform, so there is nothing
 * to parallelise. The wait is paid by links whose host names no platform, and it buys them
 * two different things: a share wrapper gets routed to the resolver it was hiding, and a
 * plain page gets confirmed as one before a run is spent on it.
 */
async function verifyByRedirect(url, platform) {
  const probe = await pingLink(url);

  // No ping and no recognisable host: shape is all that's left, and it has nothing good to
  // say. Exactly the answer intake gave before any of this existed.
  if (!probe) return verifyOnPlatform(url, platform);
  if (!probe.reachable) return deadLinkResult(url, probe, platform);

  // Where it *landed*, not what was pasted.
  const resolved = probe.canonicalURL || probe.finalURL || url;
  const landed = probe.platform ?? platformFor(resolved);
  return { ...(await verifyOnPlatform(resolved, landed, probe)), url: resolved };
}

/**
 * Content types a pasted link can be *checked* as a page.
 *
 * The server reads the page with the same extractor `find_in_page` uses, and that extractor
 * takes HTML and plain text and nothing else — a PDF or an MP4 comes back as bytes with no
 * prose in them. Refusing those here, where the probe has already told us the type, is what
 * turns "the check produced nothing and we don't know why" into a sentence naming the file
 * type before a run is spent on it.
 *
 * A missing content-type is treated as readable: some servers omit it on a HEAD, and the
 * server-side fetch checks the type again on the response it actually reads.
 */
const READABLE_TYPE = /^(?:text\/html|text\/plain|application\/xhtml\+xml)/i;

function readablePage(probe) {
  const type = probe?.contentType;
  return !type || READABLE_TYPE.test(type);
}

/**
 * Ask the platform itself whether this link is a post we can pull media from.
 *
 * YouTube is answered from the URL alone — a valid video ID is all Gemini needs, since it
 * fetches the video itself. TikTok and Instagram go to /api/resolve-media, which runs the
 * same resolve the fact-check will run: an embed page for one, a post query for the other.
 * That is what makes this authoritative rather than advisory: it is not a cheaper proxy
 * for the real work, it is the same work.
 *
 * Which is why the result travels onward instead of being thrown away. /api/chat used to
 * resolve the clip a second time, because the clip cache it consults lives in
 * lib/gemini.js's module scope and a separate Vercel function cannot reach it. Rather than
 * a shared store, the resolve rides along with the check as `hint` — the browser is the
 * one thing both functions talk to. It is a hint and not an instruction: /api/chat vets it
 * and discards it on any failure. See lib/resolve-hint.js.
 *
 * Runs on the probe's resolved URL when there was a probe, and on the raw paste when the
 * host named its platform outright.
 */
async function verifyOnPlatform(url, platform, probe = null) {
  if (platform === "YouTube") {
    return youTubeVideoID(url)
      ? { ok: true, url, platform }
      : { ok: false, url, platform, reason: "That doesn't look like a valid YouTube video link." };
  }

  if (platform === "TikTok" || platform === "Instagram") {
    try {
      const response = await fetch("/api/resolve-media", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ url }),
      });
      if (!response.ok) {
        return {
          ok: false,
          url,
          platform,
          reason: `Couldn't confirm this is a playable ${platform} video (it may still work).`,
        };
      }
      // A photo-mode TikTok or an Instagram carousel resolves to images rather than a
      // playable URL. That is a post the fact-check handles fine — the stills go to the
      // model the same way a clip does — so warning that it isn't "a playable video" would
      // be talking the user out of a link that works.
      const { mediaURL, images, hint } = await response.json();
      return mediaURL || images?.length
        ? { ok: true, url, platform, hint }
        : {
            ok: false,
            url,
            platform,
            reason: `Couldn't confirm this is a playable ${platform} post (it may still work).`,
          };
    } catch {
      return { ok: false, url, platform, reason: "Couldn't reach the server to confirm this link." };
    }
  }

  // Everything else is a page, and a page is now something this app checks rather than
  // something it turns away. The server fetches it, pulls its text out and hands that to
  // the model as the material under examination — see lib/article.js — so an article, a
  // blog post or a press release gets the same treatment a video does.
  //
  // The ping is what makes that a decision rather than a hope: it has already followed the
  // redirects and seen what answered, so a live HTML page starts a check, a PDF or a media
  // file is named as such before a run is spent on it, and a link with no ping behind it
  // still asks first — that is the case where nothing has been established at all.
  if (!probe) {
    return {
      ok: false,
      url,
      platform,
      reason: "Couldn't check whether there's a readable page at this link.",
    };
  }
  if (!readablePage(probe)) {
    const type = String(probe.contentType).split(";")[0];
    return {
      ok: false,
      url,
      platform,
      reason: `That link is ${type}, not a page — there's no text on it to check.`,
    };
  }
  return { ok: true, url, platform, kind: "page" };
}

function showLinkConfirm(url, result) {
  pendingConfirmUrl = url;
  // "Not a supported link" is no longer what an unrecognised host means — a page is
  // checkable now, so reaching this dialog with one means the ping found something wrong
  // with *that* link rather than with its platform.
  el.linkConfirmTitle.textContent = SUPPORTED_PLATFORMS.has(result.platform)
    ? `Couldn't confirm this ${result.platform} link`
    : "Couldn't read this link";
  el.linkConfirmBody.textContent = result.reason;
  el.linkConfirmDialog.showModal();
}

/**
 * Verifies the link is actually viewable before committing to a run; if it isn't (or
 * can't be confirmed), asks first instead of burning a check on a dead link.
 *
 * `entry` and `raw` are what let a failed ping undo the regex's guess. If the URL regex
 * was the only reason this string was treated as a link — no scheme typed — and the ping
 * found no such name, then it was a sentence, and it goes to the open chat instead of
 * putting a dialog in front of someone who was only asking a question.
 */
async function confirmAndRunCheck(url, { entry = null, raw = "" } = {}) {
  const result = await verifyLinkViewable(url);
  const target = result.url ?? url;
  if (result.ok) {
    // Verification just resolved this post; hand that along so the check doesn't repeat it.
    runCheck(target, undefined, result.hint);
    return;
  }
  if (result.notALink && !hasExplicitScheme(raw)) {
    const question = raw.trim();
    if (entry && question) {
      runFollowup(entry, question);
      return;
    }
  }
  showLinkConfirm(target, result);
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

/** Inline spans within one line: code, bold, italic, then citation markers. Order matters
 * — bold is matched before italic so a `**bold**` pair never leaves a stray `*` for the
 * italic pass to misfire on, and citations run last since `[n]` can sit inside any of the
 * above. */
function renderInline(text, sources) {
  return linkCitations(
    escapeHTML(text)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>"),
    sources,
  );
}

/**
 * One non-code segment of an answer, as block-level HTML.
 *
 * The model is asked (see citations.js's `describe`) to format multi-part claims as
 * bullets with bold labels, but until now nothing on the way to the screen understood a
 * `- ` line as a list item — it became one plain-text line with a literal dash, indistinct
 * from the sentence above and below it. This turns consecutive `-`/`*`/`1.` lines into a
 * real `<ul>`/`<ol>`, `#`-prefixed lines into a small heading, and `> ` lines into a
 * blockquote, while leaving ordinary prose exactly as it rendered before.
 */
function renderBlock(text, sources) {
  const lines = text.split("\n");
  const html = [];
  let list = null; // { tag: "ul" | "ol", items: string[] }
  let para = [];

  const flushPara = () => {
    if (para.length === 0) return;
    html.push(renderInline(para.join("\n"), sources).replace(/\n/g, "<br>"));
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.tag}>${list.items.map((item) => `<li>${renderInline(item, sources)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };

  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet ?? numbered)[1]);
      continue;
    }
    flushList();

    const header = /^#{1,4}\s+(.*)$/.exec(line);
    if (header) {
      flushPara();
      html.push(`<h4>${renderInline(header[1], sources)}</h4>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      html.push(`<blockquote>${renderInline(quote[1], sources)}</blockquote>`);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return html.join("");
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
      return renderBlock(plain, sources);
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
/** OS-level and in-app reduced-motion both mean "skip it" — matches how `applySettings`
 * treats them as one signal via `[data-motion="reduced"]`, just read here as a boolean
 * instead of a CSS selector, since this gates a `setTimeout` rather than a transition. */
function prefersReducedMotion() {
  return settings.reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Morphs the running check's loading iris into its resolved checkmark before the card
 * beneath it is replaced by the answer.
 *
 * The `.iris-wrap.resolved` styling has existed since the loading view was built, but
 * nothing ever applied the class — every check jumped straight from spinner to answer
 * with no beat marking the moment it actually landed. A no-op if the running card isn't
 * on screen any more (the user navigated away, or reduced motion skips the pause).
 */
async function resolveIris() {
  const iris = el.claimsPane.querySelector(".iris-wrap");
  if (!iris) return;
  iris.classList.add("resolved");
  if (prefersReducedMotion()) return;
  await new Promise((resolve) => setTimeout(resolve, 380));
}

function revealIn(root) {
  const targets = root.querySelectorAll("[data-reveal]");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      targets.forEach((node) => node.classList.add("in"));
    });
  });
}

/**
 * The class/attribute pair for a block that fades or stamps itself in.
 *
 * `renderResultCard` rebuilds the whole card from scratch — it is the only way a new
 * follow-up gets onto the screen — so every re-render used to hand `revealIn` the
 * analysis text, the verdict badge, the sources and every previously settled follow-up,
 * all freshly marked `data-reveal`. The result was that asking a second question replayed
 * the entrance of everything already on screen: the text re-faded, the badge re-stamped,
 * the sources re-expanded. Content that has already been read should just be there, so it
 * is emitted with `in` already on it and no `data-reveal` for `revealIn` to find.
 */
function revealAttrs(classes, animate) {
  return animate ? `class="${classes}" data-reveal` : `class="${classes} in"`;
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
    // A focusable `<li>` with a click handler is a button to a mouse and nothing at all
    // to a screen reader: it announces as a list item, gives no hint that it does
    // something, and never says which check is currently open.
    item.setAttribute("role", "button");
    if (entry.id === selectedId) item.setAttribute("aria-current", "true");

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
      // Space as well as Enter: anything announcing itself as a button is expected to
      // answer both, and Space is the one most screen-reader users reach for. The
      // preventDefault stops it scrolling the sidebar at the same time.
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectEntry(entry.id);
      }
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
  // Picking a check is the whole reason the drawer was opened, so it has done its job.
  // No-op above phone width, where the sidebar is a permanent column.
  closeDrawer({ restoreFocus: false });
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
  el.claimsPane.innerHTML = `<div class="claim-card"><p class="claim-text in">Paste a link below and press Check — a TikTok, YouTube or Instagram post, or any article or web page.</p></div>`;
}

/**
 * Deselects whatever's open so the entry bar falls back to "Check" — the explicit escape
 * hatch from follow-up mode. Without it, starting a new check while a result is on
 * screen only works by remembering the no-space rule; this makes it a single click that
 * needs no rule at all.
 */
function startNewCheck() {
  if (inFlight) return; // Same guard as switching library items mid-run.
  // "New check" lives inside the drawer on a phone, and it hands focus to the composer
  // behind it — so the drawer has to be out of the way before that focus call lands.
  closeDrawer({ restoreFocus: false });
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
  // Explicitly `about:blank` rather than `""`. Current engines resolve an empty `src` to
  // about:blank too, so this is not a behaviour change today — it just says the intended
  // destination outright instead of relying on how the empty string gets resolved against
  // the document's base URL, which is the part that has moved between engines.
  el.videoEmbed.src = "about:blank";
  el.videoEmbed.hidden = true;
  el.videoImages.replaceChildren();
  el.videoImages.hidden = true;
  el.videoThumb.querySelector(".image-count")?.remove();
  el.videoPlaceholder.hidden = false;
  setVideoAspect(DEFAULT_VIDEO_ASPECT);
}

/**
 * A photo-mode TikTok or an Instagram carousel: the slides, in post order.
 *
 * Built with `createElement` rather than an HTML string. Every other list in this file goes
 * through `escapeHTML`, and these URLs come from a third party's JSON — setting `.src` on a
 * real element can't be talked into being markup no matter what the URL contains, which is
 * one less thing to have got right.
 */
function showImageSet(media) {
  el.videoPlaceholder.hidden = true;
  const first = media.images[0];
  if (first?.width && first?.height) setVideoAspect(`${first.width} / ${first.height}`);

  el.videoImages.replaceChildren(
    ...media.images.map((image, index) => {
      const img = document.createElement("img");
      img.src = image.url;
      img.alt = `Slide ${index + 1} of ${media.images.length}`;
      img.loading = index === 0 ? "eager" : "lazy";
      // A CDN that refuses one slide shouldn't leave a broken-image icon in the strip.
      img.addEventListener("error", () => img.remove(), { once: true });
      return img;
    }),
  );
  el.videoImages.classList.toggle("single", media.images.length === 1);
  el.videoImages.hidden = false;

  if (media.images.length > 1) {
    const count = document.createElement("span");
    count.className = "image-count";
    count.textContent = `${media.images.length} images`;
    el.videoThumb.appendChild(count);
  }
}

/** One pane, two kinds of post. Which one is decided by what the resolver came back with. */
function showResolvedMedia(media) {
  if (media.kind === "images") showImageSet(media);
  else showVideoElement(media);
}

function showVideoElement(media) {
  el.videoPlaceholder.hidden = true;
  // The platform's own reported width/height, if the API returned one — corrected below by
  // `loadedmetadata` against what the browser actually decoded, which is authoritative
  // even when the API's numbers are missing or wrong.
  if (media.width && media.height) setVideoAspect(`${media.width} / ${media.height}`);
  el.videoPlayer.src = media.mediaURL;
  // Set here *and* re-applied on `loadedmetadata` below. Loading a new resource resets
  // playbackRate to the element's defaultPlaybackRate, so assigning it in the same tick as
  // `src` — before the media has loaded — is assigning it to something about to be thrown
  // away, and the pane silently plays at 1×.
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
  if (cached?.kind === "direct" || cached?.kind === "images") {
    if (token === videoPaneToken) showResolvedMedia(cached);
    return;
  }
  try {
    const response = await fetch("/api/resolve-media", {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({ url: entry.url }),
    });
    if (!response.ok) return; // Placeholder icon stands in — a dead CDN link isn't fatal to the check.
    const { mediaURL, images, width, height } = await response.json();
    // A photo post has no single URL to play; it has a list of stills. Either way the
    // fact-check itself already has what it needs — this pane is only the picture of it.
    const media = images?.length
      ? { kind: "images", images, width, height }
      : mediaURL
        ? { kind: "direct", mediaURL, width, height }
        : null;
    if (!media) return;
    mediaCache.set(entry.id, media);
    if (token === videoPaneToken) showResolvedMedia(media);
  } catch {
    // Network hiccup or the passphrase dialog intercepting — the rest of the pane (title,
    // link, and the fact-check itself) doesn't depend on this succeeding.
  }
}

/**
 * The two shapes the pane's placeholder takes: a play triangle, and a sheet of paper.
 *
 * A page has no media to load, so the placeholder is the whole of what that pane will ever
 * show — and a play button over an article promises a video that is never coming. One
 * attribute swap is the cheapest honest answer.
 */
const PLAY_GLYPH = "M8 5v14l11-7z";
const PAGE_GLYPH = "M14 2H7a1 1 0 00-1 1v18a1 1 0 001 1h10a1 1 0 001-1V6zm-1 5V3l5 5h-4a1 1 0 01-1-1z";

function renderVideoPane(entry) {
  el.videoChip.textContent = entry.platform;
  el.videoTitle.textContent = entry.title;
  el.videoLink.href = entry.url;
  el.videoPlaceholder
    .querySelector("path")
    ?.setAttribute("d", SUPPORTED_PLATFORMS.has(entry.platform) ? PLAY_GLYPH : PAGE_GLYPH);

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
function incompleteHTML(incomplete, animate) {
  if (!incomplete) return "";
  return `
    <div ${revealAttrs(`notice ${escapeHTML(incomplete.kind)}`, animate)}>
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
function verdictHTML(entry, animate) {
  if (entry.incomplete && !entry.verdictKey) return "";
  const verdict = VERDICTS[entry.verdictKey] ?? VERDICTS.insufficient;
  return `
    <div class="badges">
      <span ${revealAttrs(`badge verdict ${verdict.css}`, animate)}>${escapeHTML(verdict.label)}</span>
    </div>`;
}

/**
 * One source row, with the exact passage a citation rests on when there is one.
 *
 * `s.quote` is the best passage `find_in_page` pulled off that source (see `sourceRows`
 * in verified-chat.js) — it already reaches the browser today, just unrendered. Gated by
 * the settings-panel toggle: off means the row looks exactly as it always has, on means a
 * "Show quote" control appears per source, collapsed by default so a long thread doesn't
 * turn into a wall of blockquotes.
 */
function sourceItemHTML(s) {
  const quoteToggle =
    settings.showQuotes && s.quote
      ? `<button type="button" class="source-quote-toggle" data-quote-toggle>Show quote</button>
         <blockquote class="source-quote" hidden>&ldquo;${escapeHTML(s.quote)}&rdquo;</blockquote>`
      : "";
  return `
    <div class="source-item">
      <div class="source-row">
        <span><a class="citation" href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.title)}</a></span>
        <span>${escapeHTML(s.domain)}</span>
      </div>
      ${quoteToggle}
    </div>`;
}

function sourcesHTML(sources, animate) {
  if (!sources?.length) return "";
  return `
    <div ${revealAttrs("sources", animate)}>
      <div class="sources-body">
        <div class="sources-label">Checked against ${sources.length} source${sources.length === 1 ? "" : "s"}</div>
        ${sources.map(sourceItemHTML).join("")}
      </div>
    </div>`;
}

/**
 * Copy / share / like / dislike for one answer — the main analysis when `followupIndex` is
 * null, otherwise that follow-up. The row carries just enough in its dataset for the
 * delegated click handler on `claimsPane` to look the real text back up in `library`
 * rather than baking it into the HTML, where a long answer with quotes in it would be
 * awkward to embed safely.
 */
function actionRowHTML(entryId, followupIndex) {
  const liked = feedback[feedbackKey(entryId, followupIndex)];
  const followupAttr = followupIndex == null ? "" : ` data-followup-index="${followupIndex}"`;
  return `
    <div class="action-row" data-entry-id="${escapeHTML(entryId)}"${followupAttr}>
      <button type="button" class="action-btn" data-action="copy" aria-label="Copy answer" title="Copy">
        <svg viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V6a2 2 0 012-2h9" stroke="currentColor" stroke-width="1.6"/></svg>
      </button>
      <button type="button" class="action-btn" data-action="share" aria-label="Share answer" title="Share">
        <svg viewBox="0 0 24 24" fill="none"><circle cx="18" cy="5" r="2.3" stroke="currentColor" stroke-width="1.5"/><circle cx="6" cy="12" r="2.3" stroke="currentColor" stroke-width="1.5"/><circle cx="18" cy="19" r="2.3" stroke="currentColor" stroke-width="1.5"/><path d="M8.1 10.7l7.8-4.4M8.1 13.3l7.8 4.4" stroke="currentColor" stroke-width="1.5"/></svg>
      </button>
      <button type="button" class="action-btn like" data-action="like" aria-pressed="${liked === "like"}" aria-label="Good response" title="Good response">
        <svg viewBox="0 0 24 24" fill="none"><path d="M7 10v10H4V10h3zm3 10h7.4a2 2 0 001.94-1.52l1.4-5.6A2 2 0 0017.8 10H14l.6-4.2A1.8 1.8 0 0012.86 4L10 9v11z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="action-btn dislike" data-action="dislike" aria-pressed="${liked === "dislike"}" aria-label="Bad response" title="Bad response">
        <svg viewBox="0 0 24 24" fill="none" style="transform:rotate(180deg)"><path d="M7 10v10H4V10h3zm3 10h7.4a2 2 0 001.94-1.52l1.4-5.6A2 2 0 0017.8 10H14l.6-4.2A1.8 1.8 0 0012.86 4L10 9v11z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      </button>
      <span class="action-feedback"></span>
    </div>`;
}

function flashActionFeedback(row, message) {
  const span = row.querySelector(".action-feedback");
  if (!span) return;
  span.textContent = message;
  span.classList.toggle("show", Boolean(message));
  clearTimeout(row._feedbackTimer);
  if (message) row._feedbackTimer = setTimeout(() => span.classList.remove("show"), 1800);
}

/** One delegated handler for everything a reader can click inside a rendered answer:
 * expanding a citation quote, or acting on the answer itself. */
async function handleClaimsPaneClick(event) {
  const quoteToggle = event.target.closest("[data-quote-toggle]");
  if (quoteToggle) {
    const quote = quoteToggle.nextElementSibling;
    const show = quote.hidden;
    quote.hidden = !show;
    quoteToggle.textContent = show ? "Hide quote" : "Show quote";
    return;
  }

  const btn = event.target.closest(".action-btn");
  if (!btn) return;
  const row = btn.closest(".action-row");
  const entry = row ? findEntry(row.dataset.entryId) : null;
  if (!entry) return;
  const followupIndex = row.dataset.followupIndex != null ? Number(row.dataset.followupIndex) : null;
  const text = followupIndex == null ? entry.answer : entry.followups[followupIndex]?.answer;
  if (text == null) return;

  const action = btn.dataset.action;
  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(text);
      flashActionFeedback(row, "Copied");
    } catch {
      flashActionFeedback(row, "Couldn't copy");
    }
    return;
  }
  if (action === "share") {
    if (navigator.share) {
      try {
        await navigator.share({ title: "Seer fact-check", text, url: entry.url });
      } catch {
        // AbortError from the user cancelling the share sheet isn't a failure worth reporting.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text}\n\n${entry.url}`);
      flashActionFeedback(row, "Copied to share");
    } catch {
      flashActionFeedback(row, "Couldn't share");
    }
    return;
  }
  if (action === "like" || action === "dislike") {
    const key = feedbackKey(entry.id, followupIndex);
    feedback[key] = feedback[key] === action ? undefined : action; // click again to un-set
    if (!feedback[key]) delete feedback[key];
    persistFeedback();
    row.querySelector('[data-action="like"]').setAttribute("aria-pressed", String(feedback[key] === "like"));
    row.querySelector('[data-action="dislike"]').setAttribute("aria-pressed", String(feedback[key] === "dislike"));
    flashActionFeedback(row, feedback[key] ? "Thanks for the feedback" : "");
  }
}

/** Past follow-ups, plus one in flight or freshly failed, as a thread under the analysis. */
function threadHTML(entry, newestIndex) {
  const settled = entry.followups
    .map((f, index) => {
      // Only the answer that just landed animates; the ones above it are already read.
      const animate = index === newestIndex;
      return `
        <div class="thread-item">
          <div class="thread-q">${escapeHTML(f.question)}</div>
          <div ${revealAttrs("thread-a claim-text", animate)}>${renderMarkdown(f.answer, f.sources)}</div>
          ${incompleteHTML(f.incomplete, animate)}
          ${actionRowHTML(entry.id, index)}
          ${sourcesHTML(f.sources, animate)}
        </div>`;
    })
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

/**
 * @param animateAnalysis whether the top half of the card — the analysis text, its
 *   notice, the verdict badge and the sources — is arriving for the first time. False on
 *   every re-render of a card already on screen (a settled follow-up, a quote-visibility
 *   change), where replaying its entrance is the app appearing to re-run a check it
 *   didn't.
 * @param newestFollowup index of a follow-up that has just landed and should animate in,
 *   or -1 for none.
 */
function renderResultCard(entry, { animateAnalysis = true, newestFollowup = -1 } = {}) {
  el.claimsPane.innerHTML = `
    <div class="claim-card">
      <div class="eyebrow">Analysis</div>
      <div ${revealAttrs("claim-text", animateAnalysis)}>${renderMarkdown(entry.answer, entry.sources)}</div>
      ${incompleteHTML(entry.incomplete, animateAnalysis)}
      ${verdictHTML(entry, animateAnalysis)}
      ${actionRowHTML(entry.id, null)}
      ${sourcesHTML(entry.sources, animateAnalysis)}
      ${threadHTML(entry, newestFollowup)}
    </div>`;
  revealIn(el.claimsPane);
}

/* ---------------------------------------------------------------- streaming */

function stageText(frame) {
  switch (frame?.stage) {
    case "attaching":
      return "Fetching the video";
    case "reading":
      return "Reading the page";
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
async function streamChat(messages, { signal, onStage, onSearchCount, clipHints } = {}) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify(clipHints ? { messages, clipHints } : { messages }),
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

/**
 * The check itself, worded for what was actually pasted.
 *
 * "This video" is a lie about an article, and a small one with a real cost: the model is
 * told elsewhere that a video link is attached for it to watch, so a prompt calling a news
 * page a video invites it to apologise for not being able to see one. The page's text is
 * quoted into the request server-side (lib/article.js), so what changes here is only the
 * noun — the job, and the verdict line the app parses, are the same either way.
 */
function composeCheckPrompt(url) {
  const subject = SUPPORTED_PLATFORMS.has(platformFor(url)) ? "video" : "page";
  return withCustomInstructions(
    `Fact-check this ${subject}: ${url}\n\n` +
      "List the distinct factual claims it makes, check each one, and explain what the evidence " +
      "shows. Finish with exactly one line of the form `VERDICT: <Contradicted|Disputed|Corroborated" +
      "|Insufficient evidence>` summarizing the main claim — no other text on that line.",
  );
}

/** The conversation an entry represents so far: the original check, then every follow-up
 * that's already settled — what a new follow-up continues, not restarts. */
function historyFor(entry) {
  const history = [
    { role: "user", content: entry.prompt },
    // `rawAnswer` (the answer with its VERDICT line still on) is what history wants, but
    // entries written before that field existed only have `answer`. Without the fallback
    // those replay as `content: undefined`, which is not a string the request body can
    // carry — the first follow-up on any pre-existing check failed on the server's own
    // message validation.
    { role: "assistant", content: entry.rawAnswer ?? entry.answer ?? "" },
  ];
  for (const f of entry.followups) {
    history.push({ role: "user", content: f.question }, { role: "assistant", content: f.answer });
  }
  return history;
}

/* ---------------------------------------------------------------- the two turns */

/**
 * @param hint the resolve verification already did for this exact link, if it did one.
 *   Deliberately not stored on the entry and not replayed on follow-ups: the URLs inside
 *   it are signed and short-lived, so a hint kept past the moment it was made is one
 *   failed download and a re-resolve — slower than simply resolving. Seconds old is the
 *   only age at which this is worth anything.
 */
async function runCheck(url, existingId, hint) {
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

  const image = pendingImage;
  clearPendingImage();

  const controller = new AbortController();
  inFlight = controller;
  el.checkBtn.disabled = true;
  el.newCheckBtn.disabled = true;

  try {
    const message = { role: "user", content: prompt, ...imagePayload(image) };
    const { answer, sources, incomplete } = await streamChat([message], {
      signal: controller.signal,
      clipHints: hint ? { [url]: hint } : null,
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
    if (selectedId === id) {
      await resolveIris();
      // The wait above can outlast the user's patience for this entry — they may have
      // already clicked to a different check. Re-check rather than trust the guard above.
      if (selectedId === id) renderResultCard(entry);
    }
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
  const image = pendingImage;
  clearPendingImage();
  renderResultCard(entry, { animateAnalysis: false });
  updateComposerMode();

  const controller = new AbortController();
  inFlight = controller;
  el.checkBtn.disabled = true;
  el.newCheckBtn.disabled = true;
  let settled = false;

  try {
    const message = { role: "user", content: withCustomInstructions(question), ...imagePayload(image) };
    const { answer, sources, incomplete } = await streamChat([...historyFor(entry), message], {
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
    if (selectedId === entry.id) {
      renderResultCard(entry, {
        animateAnalysis: false,
        newestFollowup: settled ? entry.followups.length - 1 : -1,
      });
    }
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
    el.linkInput.placeholder = "Paste a video or article link…";
    return;
  }
  const asking = looksLikeFollowup(el.linkInput.value);
  el.checkBtn.textContent = asking ? "Ask" : "Check";
  el.linkInput.placeholder = asking
    ? "Ask a follow-up…"
    : `Ask a follow-up about "${truncate(entry.title, 44)}", or paste a new link…`;
}

/* ---------------------------------------------------------------- config + gating */

/** The settings dialog's read-only "Search" section — whether the server has a provider
 * configured, since that's what decides whether answers come back cited at all. */
function renderSearchStatus() {
  if (!el.searchStatus) return;
  if (!serverConfig) {
    el.searchStatus.innerHTML = `<span class="dot muted"></span><span>Checking…</span>`;
    return;
  }
  const search = serverConfig.search;
  if (search?.enabled) {
    el.searchStatus.innerHTML = `<span class="dot good"></span><span>On — via ${escapeHTML(search.provider)}</span>`;
  } else {
    el.searchStatus.innerHTML = `<span class="dot warn"></span><span>Off — answers won't be cited</span>`;
  }
}

async function loadServerConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    serverConfig = config;
    renderSearchStatus();
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
    renderSearchStatus();
  }
}

/* ---------------------------------------------------------------- settings dialog */

function updateFontSizeButtons() {
  el.settingFontSize.querySelectorAll("button[data-value]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === settings.fontSize);
  });
}

function openSettingsDialog() {
  el.settingReducedMotion.checked = settings.reducedMotion;
  el.settingHighContrast.checked = settings.highContrast;
  el.settingShowQuotes.checked = settings.showQuotes;
  el.settingSystemPrompt.value = settings.systemPrompt;
  updateFontSizeButtons();
  renderSearchStatus();
  el.settingsDialog.showModal();
}

/* ---------------------------------------------------------------- speech-to-text */

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let recognizing = false;

function setListening(on) {
  recognizing = on;
  el.micBtn.classList.toggle("listening", on);
  el.micBtn.setAttribute("aria-pressed", String(on));
}

/** Wires up the mic button if the browser has a speech-recognition API, otherwise hides
 * it — a button that silently does nothing is worse than no button. */
function initSpeechToText() {
  if (!SpeechRecognitionImpl) {
    el.micBtn.hidden = true;
    return;
  }
  recognizer = new SpeechRecognitionImpl();
  recognizer.lang = navigator.language || "en-US";
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;
  recognizer.addEventListener("result", (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript ?? "")
      .join(" ")
      .trim();
    if (!transcript) return;
    el.linkInput.value = el.linkInput.value ? `${el.linkInput.value} ${transcript}` : transcript;
    updateComposerMode();
  });
  recognizer.addEventListener("end", () => setListening(false));
  recognizer.addEventListener("error", () => setListening(false));

  el.micBtn.addEventListener("click", () => {
    if (recognizing) {
      recognizer.stop();
      return;
    }
    try {
      recognizer.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  });
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
  if (url) confirmAndRunCheck(url, { entry, raw });
});

el.linkConfirmForm.addEventListener("submit", () => {
  if (pendingConfirmUrl) runCheck(pendingConfirmUrl);
  pendingConfirmUrl = null;
});

el.linkConfirmCancel.addEventListener("click", () => {
  el.linkConfirmDialog.close();
});

// Esc dismisses a <dialog> without going through either button, so the Cancel handler
// alone left `pendingConfirmUrl` set. One `close` listener covers every way the dialog
// can go away, including Cancel — and it runs after `submit`, so "Check anyway" has
// already consumed the URL by the time this clears it.
el.linkConfirmDialog.addEventListener("close", () => {
  pendingConfirmUrl = null;
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
  // See `showVideoElement`: the rate set alongside `src` is reset by the load this event
  // marks the end of, so this is the assignment that actually sticks.
  el.videoPlayer.playbackRate = VIDEO_PLAYBACK_RATE;
});

el.passForm.addEventListener("submit", () => {
  const value = el.passInput.value.trim();
  if (value) sessionStorage.setItem(PASSPHRASE_KEY, value);
  el.passInput.value = "";
});

el.claimsPane.addEventListener("click", handleClaimsPaneClick);

el.drawerToggle.addEventListener("click", () => {
  if (isDrawerOpen()) closeDrawer();
  else openDrawer();
});
el.drawerScrim.addEventListener("click", () => closeDrawer());

document.addEventListener("keydown", (event) => {
  // Escape closes the drawer, the same way it closes the <dialog>s. Dialogs handle their
  // own Escape natively and stop here only because an open one is not the drawer.
  if (event.key === "Escape" && isDrawerOpen()) {
    event.preventDefault();
    closeDrawer();
  }
});

el.settingsBtn.addEventListener("click", openSettingsDialog);
// The phone top bar's copy of the settings button — same dialog, and it closes the
// drawer first so the sheet doesn't open behind a scrim.
el.topbarSettingsBtn.addEventListener("click", () => {
  closeDrawer({ restoreFocus: false });
  openSettingsDialog();
});
el.settingReducedMotion.addEventListener("change", () => {
  settings.reducedMotion = el.settingReducedMotion.checked;
  persistSettings();
  applySettings();
});
el.settingHighContrast.addEventListener("change", () => {
  settings.highContrast = el.settingHighContrast.checked;
  persistSettings();
  applySettings();
});
el.settingFontSize.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-value]");
  if (!btn) return;
  settings.fontSize = btn.dataset.value;
  persistSettings();
  applySettings();
  updateFontSizeButtons();
});
el.settingShowQuotes.addEventListener("change", () => {
  settings.showQuotes = el.settingShowQuotes.checked;
  persistSettings();
  // Re-render whatever's on screen so the toggle takes effect immediately, not on the
  // next navigation.
  const entry = selectedId ? findEntry(selectedId) : null;
  if (entry?.status === "done") renderResultCard(entry, { animateAnalysis: false });
});
el.settingsForm.addEventListener("submit", () => {
  settings.systemPrompt = el.settingSystemPrompt.value.slice(0, 1000);
  persistSettings();
});

el.imageBtn.addEventListener("click", () => el.imageInput.click());
el.imageInput.addEventListener("change", async () => {
  const file = el.imageInput.files?.[0];
  el.imageInput.value = ""; // lets the same file be picked again later
  if (!file || !file.type.startsWith("image/")) return;
  try {
    pendingImage = await processImageFile(file);
    showImageChip(pendingImage);
  } catch {
    clearPendingImage();
  }
});
el.imageChipRemove.addEventListener("click", clearPendingImage);

applySettings();
// Classifies now and re-classifies on rotate/resize/pointer change, calling back only
// when the answer actually changes — see watchDevice in device.js.
watchDevice(window, applyDevice);
initSpeechToText();

renderLibrary();
// `selectedId` comes from `library[0]`, so it names a real entry — but only as long as
// the parse that produced `library` behaved. A truncated or hand-edited localStorage blob
// yields entries without ids, and then every branch here was skipped and the claims pane
// was left literally empty: no card, no placeholder, no way to tell a broken read from a
// blank app. Falling through to the empty state makes that case say something.
const startupEntry = selectedId ? findEntry(selectedId) : null;
if (startupEntry) {
  renderVideoPane(startupEntry);
  if (startupEntry.status === "done") renderResultCard(startupEntry);
  else if (startupEntry.status === "error") renderErrorCard(startupEntry);
} else {
  selectedId = null;
  renderEmptyState();
}
updateComposerMode();
loadServerConfig();
// Focusing the composer on load saves a click on desktop. On a touchscreen it costs one
// instead: the keyboard covers half the screen before the user has decided to type.
if (!device.touch) el.linkInput.focus();
