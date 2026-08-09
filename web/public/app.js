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
import {
  TIMESTAMP_MARKER,
  parseClock,
  formatClock,
  plainTimestamps,
  timeline,
  activeAt,
} from "./timestamps.js";
import { VERDICTS, splitVerdict, splitClaims, claimDiff, aggregateVerdictKey } from "./claims.js";

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

const el = {
  linkInput: document.getElementById("linkInput"),
  checkBtn: document.getElementById("checkBtn"),
  newCheckBtn: document.getElementById("newCheckBtn"),
  libList: document.getElementById("libList"),
  searchInput: document.getElementById("searchInput"),
  claimsPane: document.getElementById("claimsPane"),
  videoTitle: document.getElementById("videoTitle"),
  videoLink: document.getElementById("videoLink"),
  videoThumb: document.getElementById("videoThumb"),
  videoPlaceholder: document.getElementById("videoPlaceholder"),
  videoPlayer: document.getElementById("videoPlayer"),
  videoEmbed: document.getElementById("videoEmbed"),
  videoImages: document.getElementById("videoImages"),
  videoControls: document.getElementById("videoControls"),
  playBtn: document.getElementById("playBtn"),
  muteBtn: document.getElementById("muteBtn"),
  fullscreenBtn: document.getElementById("fullscreenBtn"),
  videoTimeline: document.getElementById("videoTimeline"),
  timelineTrack: document.getElementById("timelineTrack"),
  timelineProgress: document.getElementById("timelineProgress"),
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
  sidebarCollapseBtn: document.getElementById("sidebarCollapseBtn"),
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

// The free-standing conversation shown while nothing is selected — no video, no verdict,
// just a normal back-and-forth. It exists so the composer works like a chatbot before any
// link has ever been checked, not only after: a pasted link is intercepted by the regex in
// confirmAndRunCheck/normalizeLink and starts a real check instead of landing here. Not
// persisted, same as pendingFollowup above — a reload starts the conversation over.
let chatThread = []; // { question, answer, sources, incomplete }
let pendingChat = null; // { question, error? }

/* ---------------------------------------------------------------- settings */

const SETTINGS_KEY = "seer.settings.v1";
const DEFAULT_SETTINGS = {
  reducedMotion: false,
  highContrast: false,
  fontSize: "normal", // "normal" | "large"
  systemPrompt: "", // appended to every outgoing message, see withCustomInstructions
  sidebarCollapsed: false, // the library rail, toggled by sidebarCollapseBtn
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
  setAttrIf(root, "data-sidebar", settings.sidebarCollapsed, "collapsed");
  if (el.sidebarCollapseBtn) {
    const label = settings.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
    el.sidebarCollapseBtn.setAttribute("aria-label", label);
    el.sidebarCollapseBtn.setAttribute("aria-expanded", String(!settings.sidebarCollapsed));
    el.sidebarCollapseBtn.title = label;
  }
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
/**
 * Verification already in flight (or just finished) for a URL, so the Check button doesn't
 * pay for it a second time.
 *
 * Everything `verifyLinkViewable` does is work the user has committed to the moment they
 * paste a link: the probe follows the redirects, and on TikTok/Instagram the resolve is the
 * *same* embed-page fetch and parse the check itself would run. It is also a second or
 * three of dead air between the click and anything appearing on screen, because none of it
 * can start until the click happens.
 *
 * So it starts on the paste instead. `warmLink` kicks off exactly the call the click was
 * going to make and files the promise here; the click then awaits a request that has had a
 * head start rather than issuing its own. Because it is the *promise* that is cached, a
 * paste followed immediately by a click makes one request between them, not two — the same
 * count as before this existed. The only request this adds is for a link that is pasted and
 * then never checked.
 *
 * ## Two things come back from a warm-up, and they go stale at completely different rates
 *
 * The **verdict** — is this a link this app can check, and where did it land — does not
 * really expire. A TikTok URL that resolved a minute ago is the same URL now, and the worst
 * case if the post vanished in between is that the check reports it, which is what a check
 * is for.
 *
 * The **hint** does. It carries CDN URLs signed for a short window, and `runCheck`'s own
 * `@param hint` note is unambiguous about the consequence: a hint older than that is "one
 * failed download and a re-resolve — slower than simply resolving. Seconds old is the only
 * age at which this is worth anything." A stale hint is not a wasted optimisation, it is a
 * *negative* one — the download attempt 403s, `fetchClipMedia` re-resolves, and the turn has
 * paid a whole extra CDN round trip to end up exactly where it would have started.
 *
 * Holding both to one lifetime is what makes this dangerous, and it is the mistake this
 * originally shipped with: a single 45s TTL meant the ordinary paste → read the page → click
 * flow handed the server a hint that was almost certainly expired, and made the common case
 * slower than having no warm-up at all. So they are separated. The verdict is reused for as
 * long as it is plausibly about the same link; the hint is dropped the moment it is old
 * enough to be a liability, and the check then resolves server-side exactly as it did before
 * any of this existed. Dropping it costs one resolve. Keeping it costs a failed download
 * *and* that same resolve.
 */
const WARM_TTL_MS = 5 * 60 * 1000;
const HINT_MAX_AGE_MS = 8_000;
const warmedLinks = new Map(); // url → { startedAt, settledAt, pending }

function warmedEntry(url) {
  const warm = warmedLinks.get(url);
  if (!warm) return null;
  if (Date.now() - warm.startedAt > WARM_TTL_MS) {
    warmedLinks.delete(url);
    return null;
  }
  return warm;
}

/**
 * A warm verdict with its hint kept only if the hint is still worth having.
 *
 * Aged from when the resolve *finished*, not when it was kicked off: the signed URLs inside
 * it were minted at the far end of that request, so a slow resolve produces a hint that is
 * already younger than its own start time would suggest.
 */
function usableWarmResult(warm, result) {
  if (!result?.hint) return result;
  const mintedAt = warm.settledAt ?? warm.startedAt;
  if (Date.now() - mintedAt <= HINT_MAX_AGE_MS) return result;
  const { hint, ...withoutHint } = result;
  return withoutHint;
}

/**
 * Start verifying a link the moment it looks like one, before anything is clicked.
 *
 * Deliberately silent: it reports nothing, changes nothing on screen, and swallows its own
 * failures. A warm-up that surfaced a dead link would be putting a dialog in front of
 * someone mid-paste, and one that surfaced an error would be worse — the click re-reads the
 * same rejected promise and reports it in the one place that is allowed to.
 */
function warmLink(url) {
  if (!url || warmedEntry(url)) return;
  // One at a time. A reader editing a URL by hand would otherwise leave a warm entry per
  // keystroke-that-parsed, each holding a resolve nobody is going to use.
  warmedLinks.clear();
  const warm = { startedAt: Date.now(), settledAt: null, pending: null };
  warm.pending = verifyLinkViewable(url).then((result) => {
    warm.settledAt = Date.now();
    return result;
  });
  warm.pending.catch(() => {});
  warmedLinks.set(url, warm);
}

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
  // Whatever `warmLink` started when this was pasted — see there for why reusing the promise
  // rather than the result is what keeps the request count the same, and why the hint that
  // comes back with it is aged separately from the verdict. A rejected warm-up is not a
  // cached failure: it is discarded and the verification is run again here, where its outcome
  // has somewhere to go.
  const warm = warmedEntry(url);
  let result;
  try {
    result = warm ? usableWarmResult(warm, await warm.pending) : await verifyLinkViewable(url);
  } catch {
    result = await verifyLinkViewable(url);
  } finally {
    // Spent either way: a warm entry is worth exactly one check.
    warmedLinks.delete(url);
  }
  const target = result.url ?? url;
  if (result.ok) {
    // Verification just resolved this post; hand that along so the check doesn't repeat it.
    runCheck(target, undefined, result.hint);
    return;
  }
  if (result.notALink && !hasExplicitScheme(raw)) {
    const question = raw.trim();
    if (question) {
      if (entry) runFollowup(entry, question);
      else runChat(question);
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

/**
 * `[t=0:12]` and `[t=1:05-1:20]` as buttons that seek the video pane to that moment.
 *
 * `seekable` is what the pane can actually do with a click, decided once per card by
 * `renderResultCard`: a TikTok/Instagram MP4 or a YouTube embed can be seeked, an article
 * has nothing to seek. When it can't, the marker still renders — the model observed
 * something at that moment and saying so is useful even with no player — it just renders as
 * the plain clock `plainTimestamps` writes rather than as a control that would do nothing.
 *
 * `data-start`/`data-end` are the raw seconds, kept on the element because the playback
 * highlight reads its windows straight back off the DOM (see `refreshTimeline`) rather than
 * threading ids through the markup.
 */
function linkTimestamps(html, seekable) {
  return html.replace(TIMESTAMP_MARKER, (raw, start, end) => {
    const from = parseClock(start);
    if (from == null) return raw;
    const to = end == null ? null : parseClock(end);
    const label = to != null && to > from ? `${formatClock(from)}–${formatClock(to)}` : formatClock(from);
    if (!seekable) return `<span class="ts-chip static">${label}</span>`;
    const endAttr = to != null && to > from ? ` data-end="${to}"` : "";
    return (
      `<button type="button" class="ts-chip" data-seek="${from}" data-start="${from}"${endAttr}` +
      ` title="Play the video from ${formatClock(from)}" aria-label="Play the video from ${formatClock(from)}">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>` +
      `${label}</button>`
    );
  });
}

/** Inline spans within one line: code, bold, italic, then timestamp and citation markers.
 * Order matters — bold is matched before italic so a `**bold**` pair never leaves a stray
 * `*` for the italic pass to misfire on, and the two marker passes run last since `[n]` and
 * `[t=…]` can sit inside any of the above. The marker passes can't collide with each other:
 * one matches digits alone, the other only a `t=` clock. */
function renderInline(text, sources, seekable) {
  return linkCitations(
    linkTimestamps(
      escapeHTML(text)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>"),
      seekable,
    ),
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
function renderBlock(text, sources, seekable) {
  const lines = text.split("\n");
  const html = [];
  let list = null; // { tag: "ul" | "ol", items: string[] }
  let para = [];

  const flushPara = () => {
    if (para.length === 0) return;
    html.push(renderInline(para.join("\n"), sources, seekable).replace(/\n/g, "<br>"));
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(
      `<${list.tag}>${list.items.map((item) => `<li>${renderInline(item, sources, seekable)}</li>`).join("")}</${list.tag}>`,
    );
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
      html.push(`<h4>${renderInline(header[1], sources, seekable)}</h4>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      html.push(`<blockquote>${renderInline(quote[1], sources, seekable)}</blockquote>`);
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

function renderMarkdown(text, sources, seekable = false) {
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
      return renderBlock(plain, sources, seekable);
    })
    .join("");
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
  // The bar's own creep never reaches 100% on its own (see createProgressTicker) — this is
  // the one moment that's actually true, so it fills the rest of the way in step with the
  // checkmark sealing rather than just vanishing with the card underneath it.
  runProgress.finish();
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

/* ---------------------------------------------------------------- perceived-latency helpers
 *
 * Two tricks that don't shorten a single request but change how long a wait *reads* as: a
 * stage label that crossfades instead of jump-cutting, and a progress bar that keeps
 * creeping forward between those labels instead of sitting on a bare spinner for however
 * many seconds one stage actually takes. See the `.stage-text` / `.mini-progress` comments
 * in index.html for the reasoning; this is just the timers behind them.
 */

/** Crossfades a status span's text instead of replacing it in place. A no-op if the node
 * isn't on screen (its card has already been swapped out) or the text hasn't actually
 * changed (skips a pointless flash on a re-render that repeats the same stage). */
function setStatusText(id, text) {
  const node = document.getElementById(id);
  if (!node || node.textContent === text) return;
  if (prefersReducedMotion()) {
    node.textContent = text;
    return;
  }
  node.style.opacity = "0";
  window.setTimeout(() => {
    // The node may have been unmounted, or replaced by a fresh render, mid-fade.
    if (document.getElementById(id) !== node) return;
    node.textContent = text;
    node.style.opacity = "1";
  }, 160);
}

// Rough floors a known stage implies, so a real milestone always reads as at least this much
// progress even if the elapsed-time curve below hasn't caught up to it yet.
const STAGE_PROGRESS_FLOOR = { attaching: 10, reading: 15, waiting: 30, thinking: 55, busy: 40, rewriting: 75 };

/**
 * One eased, stage-aware progress bar. `runCheck`, `runFollowup` and `runChat` each get
 * their own instance (and their own `<div id="…ProgressBar">` in the markup) since each
 * drives a different part of the UI, even though only one of them is ever actually running
 * at a time (see `inFlight`).
 */
function createProgressTicker(barId) {
  let start = 0;
  let floor = 0;
  let timer = null;
  // The source of truth for "how far along is this bar", independent of the DOM — the
  // loading grid rebuilds its markup from scratch every time a new claim is discovered
  // (see renderClaimSkeletons), which would otherwise read back a fresh 0%-width node and
  // make the bar visibly snap backward on every claim found.
  let lastPct = 0;

  function paint(pct) {
    lastPct = pct;
    const node = document.getElementById(barId);
    if (node) node.style.width = `${pct}%`;
  }

  return {
    start() {
      start = performance.now();
      floor = 0;
      paint(0);
      if (timer) clearInterval(timer);
      timer = null;
      if (prefersReducedMotion()) return; // stays put rather than creeping on its own
      timer = setInterval(() => {
        const elapsedSeconds = (performance.now() - start) / 1000;
        // Decays toward 92%, deliberately never arriving there unassisted — a check that
        // runs long still reads as "still going", not stalled at a false-complete bar.
        const eased = 92 * (1 - Math.exp(-elapsedSeconds / 4.5));
        paint(Math.max(eased, floor));
      }, 200);
    },
    /** Pulls the floor forward on a known stage name (from STAGE_PROGRESS_FLOOR) or a raw
     * percentage — whichever the bar is already past wins, so this only ever moves it ahead. */
    bump(stageOrPercent) {
      const next = typeof stageOrPercent === "number" ? stageOrPercent : STAGE_PROGRESS_FLOOR[stageOrPercent];
      if (next == null) return;
      floor = Math.max(floor, next);
      paint(Math.max(floor, lastPct));
    },
    finish() {
      if (timer) { clearInterval(timer); timer = null; }
      paint(100);
    },
    /** Re-applies the last known width to whatever node currently owns this id — a plain
     * `paint(lastPct)` rather than a fresh computation, so a markup rebuild mid-run (the
     * loading grid growing a new skeleton box) doesn't cost the bar its progress. */
    resync() {
      paint(lastPct);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

const runProgress = createProgressTicker("runProgressBar");
const followupProgress = createProgressTicker("followupProgressBar");
const chatProgress = createProgressTicker("chatProgressBar");

/* ---------------------------------------------------------------- claim grid */
/*
 * The claims pane used to be one card, or several stacked vertically with a scrollbar to
 * reach the later ones. It's a grid now — every claim on screen at once, sized to the
 * pane's own height instead of its own content's, on the theory that "around four claims"
 * (the common case for a short-form post) should just fit. `.claim-pane` gets its own
 * `overflow-y: auto` in CSS for the rare box whose content — usually the last one, which
 * carries the sources/thread footer — is taller than its cell: that box scrolls in place
 * rather than the grid growing a row to fit it or the pane growing a scrollbar of its own.
 */

/** Column count for a given claim count — tuned around "about four" fitting as a 2×2
 * grid, one column above that for a single claim (nothing to arrange), and one column
 * wider again past six so a long list doesn't turn into a single sliver-thin row. */
function claimGridColumns(count) {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

/** Whether the last item should span the full row width — only the specific case of a
 * 2-column grid with an odd count, where the last claim would otherwise sit alone against
 * a bare gap beside it. Left alone (a normal trailing gap) for the 3-column case, since
 * spanning a partial remainder there gets visually uneven fast and six-plus claims is
 * already the overflow case, not the one this layout is tuned for. */
function claimGridSpanLast(count, cols) {
  return cols === 2 && count > 1 && count % 2 === 1;
}

/** Stamps (or clears) the grid layout on the claims pane itself. `null` is every other view
 * the pane renders — the empty state, an error card, the free-standing chat thread, a
 * whole-answer check with no `[[claim: …]]` markers — none of which are a set of same-shape
 * boxes to arrange. `"grid-loading"` adds a full-width first row for the status strip
 * (`claimGridStatusHTML`) that `"grid"` (the finished result) has no use for. */
function setClaimsGridMode(mode, cols) {
  el.claimsPane.classList.toggle("claim-grid", mode === "grid" || mode === "grid-loading");
  el.claimsPane.classList.toggle("claim-grid-loading", mode === "grid-loading");
  if (cols) el.claimsPane.style.setProperty("--claim-cols", cols);
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

/** The un-started state: nothing selected, video pane blank. The claims pane isn't
 * necessarily blank — it shows `chatThread` if a conversation is already under way. */
function renderEmptyState() {
  el.videoTitle.textContent = "Paste a link below to start a check.";
  el.videoLink.href = "#";
  el.videoLink.textContent = "";
  // `.empty` (visibility: hidden), not the `hidden` attribute — nothing to open yet, but
  // its box still needs to hold the line's worth of height it always does, or that's one
  // more way the space around the video pane's placeholder changes size. See the CSS.
  el.videoLink.classList.add("empty");
  clearVideoMedia();
  renderChatPane();
  refreshTimeline();
}

/** One chat turn's markup, the same shape as an entry's follow-up thread item — see
 * `threadHTML` — but with no `entry` behind it. */
function chatThreadHTML(newestIndex) {
  return chatThread
    .map((c, index) => {
      const animate = index === newestIndex;
      return `
        <div class="thread-item">
          <div class="thread-q">${escapeHTML(c.question)}</div>
          <div ${revealAttrs("thread-a claim-text", animate)}>${renderMarkdown(c.answer, c.sources)}</div>
          ${incompleteHTML(c.incomplete, animate)}
          ${sourcePillsHTML(c.sources, animate)}
        </div>`;
    })
    .join("");
}

/**
 * The claims pane while nothing is selected: past chat turns, plus one in flight or
 * freshly failed, or — with no conversation yet — the original placeholder now widened to
 * mention that a plain question works too.
 */
function renderChatPane({ newest = -1 } = {}) {
  const settled = chatThreadHTML(newest);
  const pending = pendingChat
    ? `
      <div class="thread-item">
        <div class="thread-q">${escapeHTML(pendingChat.question)}</div>
        ${
          pendingChat.error
            ? `<div class="thread-error">${escapeHTML(pendingChat.error)}</div>`
            : `<div class="thread-pending"><span class="thread-spinner"></span><span id="chatStatus" class="stage-text">Thinking…</span></div>
               <div class="mini-progress"><div class="mini-progress-bar" id="chatProgressBar"></div></div>`
        }
      </div>`
    : "";

  setClaimsGridMode(null);
  if (!settled && !pending) {
    el.claimsPane.innerHTML = `<div class="claim-card"><p class="claim-text in">Paste a link below and press Check — a TikTok, YouTube or Instagram post, or any article or web page — or just ask a question.</p></div>`;
    return;
  }
  el.claimsPane.innerHTML = `<div class="claim-card"><div class="thread chat-thread">${settled}${pending}</div></div>`;
  // Each answer's own markup carries `data-reveal` (see chatThreadHTML/revealAttrs) rather
  // than a baked-in `.in` class, same as renderResultCard's — so it needs the same call to
  // actually fade in instead of sitting at the `opacity: 0` `.claim-text`/`.thread-a` starts
  // at.
  revealIn(el.claimsPane);
}

/**
 * A conversational turn with no link involved — no video, no verdict, just an answer.
 * Mirrors `runFollowup`'s shape (history replay, pending/settled bookkeeping) but against
 * `chatThread` rather than an entry's `followups`, since there is no entry: this is what
 * "just ask a question" does before any link has ever been checked.
 */
async function runChat(question) {
  if (inFlight) return;

  pendingChat = { question, error: null };
  el.linkInput.value = "";
  const image = pendingImage;
  clearPendingImage();
  renderChatPane();
  chatProgress.start();
  updateComposerMode();

  const controller = new AbortController();
  inFlight = controller;
  el.checkBtn.disabled = true;
  el.newCheckBtn.disabled = true;
  let settled = false;

  try {
    const message = { role: "user", content: withCustomInstructions(question), ...imagePayload(image) };
    const history = chatThread.flatMap((c) => [
      { role: "user", content: c.question },
      { role: "assistant", content: c.answer },
    ]);
    const { answer, sources, incomplete } = await streamChat([...history, message], {
      signal: controller.signal,
      onStage: (frame) => {
        setStatusText("chatStatus", stageText(frame));
        chatProgress.bump(frame?.stage);
      },
    });
    chatProgress.finish();
    chatThread.push({ question, answer, sources, incomplete });
    settled = true;
  } catch (error) {
    if (error.name === "AbortError") {
      pendingChat = null;
      return;
    }
    // Left as the pending item, with its error — not pushed into `chatThread`, since a
    // turn with no real answer would corrupt the history the next question replays.
    pendingChat = { question, error: error.message };
  } finally {
    chatProgress.stop();
    if (settled) pendingChat = null;
    inFlight = null;
    el.checkBtn.disabled = false;
    el.newCheckBtn.disabled = false;
    if (!selectedId) renderChatPane({ newest: settled ? chatThread.length - 1 : -1 });
    updateComposerMode();
  }
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
  chatThread = [];
  pendingChat = null;
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
  // A seek asked for against the media being torn down here has nothing left to land on,
  // and the chip it lit belongs to a card that may already have been replaced.
  pendingSeek = null;
  setPlayerChromeVisible(false);
  syncPlayhead();
}

/**
 * The custom mute/fullscreen buttons and the claim timeline both answer to the same
 * `<video>` element, so both come and go together — visible only for a direct MP4
 * (TikTok/Instagram), hidden for the YouTube embed (draws its own chrome; its clock isn't
 * readable from this page either, see `syncPlayhead`), an image carousel (nothing to
 * play), and the empty/placeholder state.
 */
function setPlayerChromeVisible(visible) {
  el.videoControls.hidden = !visible;
  el.videoTimeline.hidden = !visible;
  if (!visible) {
    el.timelineTrack.querySelectorAll(".video-timeline-mark").forEach((node) => node.remove());
    el.timelineProgress.style.width = "0%";
  }
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
  setPlayerChromeVisible(true);
  // Muted is the element's own starting attribute and this button's assumed starting
  // state (see the CSS) — a new entry's video should never inherit "unmuted" from
  // whatever the reader last clicked on a different check.
  el.videoPlayer.muted = true;
  el.muteBtn.classList.remove("unmuted");
  el.muteBtn.setAttribute("aria-pressed", "false");
  el.muteBtn.setAttribute("aria-label", "Unmute");
  el.muteBtn.title = "Unmute";
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
  //
  // `enablejsapi=1` is what lets a claim's timestamp chip seek this embed: it opens the
  // `postMessage` command channel `seekVideoTo` uses. It does not load any YouTube script
  // into this page — the API surface it enables lives inside the iframe, which is the whole
  // reason the chips can drive the embed without a third-party script tag on every check.
  el.videoEmbed.src = `https://www.youtube-nocookie.com/embed/${videoID}?rel=0&enablejsapi=1`;
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
    const { mediaURL, images, width, height, caption, authorName } = await response.json();
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
    applyPostTitle(entry, titleFromMetadata(caption, authorName), token);
  } catch {
    // Network hiccup or the passphrase dialog intercepting — the rest of the pane (title,
    // link, and the fact-check itself) doesn't depend on this succeeding.
  }
}

/** How much of a caption reads as a title rather than a wall of text — long enough to be
 * a real sentence, short enough not to dominate a pane that also has an analysis to show. */
const MAX_TITLE_CHARS = 140;

/**
 * What the post is actually called, so the pane can stop naming it by the link that was
 * pasted the moment the resolve gives us something better.
 *
 * The caption's first non-blank line, not the whole thing: TikTok and Instagram captions
 * commonly run a sentence into a paragraph of hashtags on the next line, and a heading
 * that included those would read as noise, not a title. Falls back to the creator's handle
 * when there's no caption at all (plenty of posts have none), and to `null` — meaning
 * "nothing better than the URL" — only when neither is available, which leaves
 * `entry.title` exactly as `runCheck` set it.
 */
function titleFromMetadata(caption, authorName) {
  const firstLine = caption
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) return truncate(firstLine, MAX_TITLE_CHARS);
  return authorName ? `A post by @${authorName}` : null;
}

/** Swaps a checked entry's title for the one its own metadata gave it, everywhere the old
 * one (the pasted URL) was showing: the pane heading, the "open original" link, and the
 * library row. A no-op when the resolve had nothing better, or when the pane has since
 * moved on to a different entry. */
function applyPostTitle(entry, title, token) {
  if (!title || title === entry.title) return;
  entry.title = title;
  persistLibrary();
  renderLibrary(el.searchInput.value);
  if (token === videoPaneToken) renderVideoTitle(entry);
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

/** The heading and the "open original" link both read off `entry.title` — the platform
 * pill used to carry the "what is this" job on its own; now that it's gone (see
 * renderVideoPane), the title is the only label the pane gives the post, so both places
 * that show one show the same text. */
function renderVideoTitle(entry) {
  el.videoTitle.textContent = entry.title;
  el.videoLink.href = entry.url;
  el.videoLink.textContent = `${truncate(entry.title, 60)} ↗`;
  el.videoLink.classList.remove("empty");
}

function renderVideoPane(entry) {
  renderVideoTitle(entry);
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

/* ------------------------------------------------- timestamps ⟷ the video pane */

// The claim chips currently on screen, as playback windows sorted by start — the output of
// `timeline`, with each item carrying the chip element it came from. Rebuilt from the DOM
// every time the card is re-rendered, because a re-render replaces every node and any
// element held from before it is a reference to something no longer in the document.
let claimWindows = [];
// The window whose chip is lit right now, so `timeupdate` — which fires several times a
// second — only touches the DOM when the answer actually changes.
let activeWindow = null;
// A seek asked for before the media could accept one. Setting `currentTime` on an element
// that hasn't loaded metadata yet is either ignored or an InvalidStateError depending on
// the engine, and the click that asked for it is exactly the click most likely to land
// early: the reader hit a chip the moment the answer appeared, while the CDN is still
// being resolved. Applied by the `loadedmetadata` handler instead.
let pendingSeek = null;

/** Whether a chip clicked in this entry's answer has anywhere to seek to. */
function seekableEntry(entry) {
  return Boolean(entry && SUPPORTED_PLATFORMS.has(entry.platform));
}

/**
 * Re-read the claim chips out of the card and rebuild the playback windows.
 *
 * The DOM is the source of truth here rather than a parallel array built at render time:
 * the chips are written by `linkTimestamps` from inside a string of markup, they appear in
 * the analysis *and* in every follow-up, and reading them back is the one way to be sure
 * the windows and the elements can't drift apart.
 */
function refreshTimeline() {
  const chips = [...el.claimsPane.querySelectorAll(".ts-chip[data-start]")];
  claimWindows = timeline(
    chips.map((node) => ({
      node,
      start: Number(node.dataset.start),
      end: node.dataset.end ? Number(node.dataset.end) : null,
    })),
  );
  activeWindow = null;
  renderTimelineTrack();
  syncPlayhead();
}

/**
 * The yellow bands on the scrubber, one per claim window — the same `claimWindows`
 * `refreshTimeline` just rebuilt from the in-text `[t=…]` chips, laid out on the track by
 * fraction of `duration` instead of by fraction of the answer's text. Needs a real,
 * finite `duration` to place anything on a 0–100% scale, which for a freshly-resolved clip
 * isn't known yet — `loadedmetadata` calls this again once it is.
 */
function renderTimelineTrack() {
  el.timelineTrack.querySelectorAll(".video-timeline-mark").forEach((node) => node.remove());
  const duration = el.videoPlayer.duration;
  if (el.videoTimeline.hidden || !Number.isFinite(duration) || duration <= 0) return;

  for (const window of claimWindows) {
    const mark = document.createElement("div");
    mark.className = "video-timeline-mark";
    const left = Math.min(100, (window.from / duration) * 100);
    const width = Math.max(0.6, ((Math.min(window.to, duration) - window.from) / duration) * 100);
    mark.style.left = `${left}%`;
    mark.style.width = `${width}%`;
    // Carries the same node the in-text chip highlighting already tracks, so a claim
    // lighting up moves both the chip in the answer and its band on the scrubber from one
    // `activeWindow` assignment in `syncPlayhead` — never two sources of "which claim".
    window.trackNode = mark;
    el.timelineTrack.appendChild(mark);
  }
}

/**
 * Light up the claim the video is currently on — its chip in the answer text and its band
 * on the scrubber, both — and only that one. Also keeps the scrubber's progress fill
 * moving; called on every `timeupdate`, so this is the one place both live.
 *
 * Direct MP4 only. A YouTube post plays inside an `<iframe>` whose current time this page
 * cannot read without loading YouTube's own player script, and that is a third-party script
 * on every check for one highlight — the chips there still seek (`seekTo` via postMessage),
 * they just don't light up on their own, and the scrubber doesn't appear at all (see
 * `setPlayerChromeVisible`).
 */
function syncPlayhead() {
  const playing = !el.videoPlayer.hidden && el.videoPlayer.src;
  const duration = el.videoPlayer.duration;
  if (playing && Number.isFinite(duration) && duration > 0) {
    const percent = Math.min(100, (el.videoPlayer.currentTime / duration) * 100);
    el.timelineProgress.style.width = `${percent}%`;
    el.timelineTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
  }

  const next = playing ? activeAt(claimWindows, el.videoPlayer.currentTime) : null;
  if (next === activeWindow) return;
  activeWindow?.node.classList.remove("playing");
  activeWindow?.trackNode?.classList.remove("playing");
  next?.node.classList.add("playing");
  next?.trackNode?.classList.add("playing");
  activeWindow = next;
}

/**
 * Send the video pane to a moment in the post.
 *
 * The two players answer to different things and neither is optional: TikTok and Instagram
 * are a plain MP4 in our own `<video>`, and YouTube is an embed that only takes commands
 * over `postMessage`. A photo carousel and an article have no clock at all, so the chips
 * were never rendered as buttons for them — this only ever runs for a post that has one.
 */
function seekVideoTo(seconds) {
  const target = Math.max(0, Number(seconds) || 0);

  if (!el.videoPlayer.hidden && el.videoPlayer.src) {
    // `duration` is NaN until metadata lands, which is the same moment `readyState` stops
    // being 0 — so the clamp and the deferral are the same condition seen twice.
    if (el.videoPlayer.readyState === 0 || !Number.isFinite(el.videoPlayer.duration)) {
      pendingSeek = target;
      return true;
    }
    applySeek(target);
    return true;
  }

  if (!el.videoEmbed.hidden && el.videoEmbed.src && el.videoEmbed.src !== "about:blank") {
    // The embed is loaded with `enablejsapi=1` (see `showYouTubeEmbed`), which is what makes
    // this command channel exist. Origin-targeted rather than `*`: this is a seek, not a
    // secret, but there is no reason to broadcast it to whatever else might be listening.
    el.videoEmbed.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func: "seekTo", args: [target, true] }),
      "https://www.youtube-nocookie.com",
    );
    el.videoEmbed.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func: "playVideo", args: [] }),
      "https://www.youtube-nocookie.com",
    );
    return true;
  }

  return false;
}

function applySeek(seconds) {
  const duration = el.videoPlayer.duration;
  // A model that timestamps past the end of the clip (it happens — it is reading its own
  // sense of the video's length, not a clock) would otherwise seek to the end and stop.
  // Landing just inside the last second at least plays something.
  el.videoPlayer.currentTime = Number.isFinite(duration) ? Math.min(seconds, Math.max(0, duration - 0.1)) : seconds;
  el.videoPlayer.play().catch(() => {}); // Same as autoplay: a refusal is not an error here.
  syncPlayhead();
}

/**
 * Bring the player into view before it starts playing at the moment that was asked for.
 *
 * On the phone layout the video is a full-bleed backdrop behind a bottom sheet (see the CSS)
 * and a chip tapped low in a long answer can be scrolled well past it — seeking a player
 * that is off screen looks like the tap did nothing at all.
 */
function revealPlayer() {
  el.videoThumb.scrollIntoView({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "nearest",
  });
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
  setClaimsGridMode(null);
  el.claimsPane.innerHTML = `
    <div class="claim-card">
      <div class="card-loading">
        ${irisMarkup()}
        <div class="status-text stage-text" id="runStatus">Sending to the model…</div>
        <div class="source-counter" id="runCounter">&nbsp;</div>
        <div class="mini-progress wide"><div class="mini-progress-bar" id="runProgressBar"></div></div>
        <div class="live-sources" id="runSources"></div>
      </div>
    </div>`;
  refreshTimeline();
  runProgress.start();
}

/**
 * The sources retrieved so far, on screen while they are still being read.
 *
 * The longest silence in a check is between the last search landing and the first token of
 * the answer — the model is reading everything it just retrieved, which on a multi-claim
 * video is most of the wait. The server sends the ledger as it fills for exactly this
 * reason (`provisional` in lib/verified-chat.js): the reader can spend that stretch reading
 * the sources rather than watching a spinner, and a check that is visibly accumulating
 * named, clickable evidence reads as working in a way a source *count* does not.
 *
 * Capped, because this is a status strip and not the bibliography: past a handful the row
 * wraps into a block that pushes the spinner and the progress bar up the card every time a
 * search lands. The finished card lists all of them.
 *
 * Appends rather than redrawing, and that is not a micro-optimisation: the ledger only ever
 * grows, so a redraw would replay every pill's arrival animation on every update and turn a
 * row that should tick along one source at a time into one that flashes whole. Only the
 * pills that are actually new animate.
 */
const LIVE_SOURCE_LIMIT = 6;
function renderLiveSources(sources) {
  const node = document.getElementById("runSources");
  if (!node) return;
  // Always last, so it is pulled off before counting what is already drawn and put back
  // after — otherwise it would be counted as a source and the next real pill would replace it.
  node.querySelector(".source-pill.more")?.remove();

  const shown = sources.slice(0, LIVE_SOURCE_LIMIT);
  for (const s of shown.slice(node.childElementCount)) {
    node.insertAdjacentHTML(
      "beforeend",
      `<a class="source-pill" href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(s.title ?? s.domain)}">${escapeHTML(s.domain)}</a>`,
    );
  }

  const rest = sources.length - shown.length;
  if (rest > 0) {
    node.insertAdjacentHTML("beforeend", `<span class="source-pill more">+${rest}</span>`);
  }
}

/** The status strip `renderClaimSkeletons` puts above the growing grid of skeleton boxes —
 * the same `#runStatus`/`#runCounter`/`#runProgressBar` ids `renderRunningCard` uses, so
 * `setStatusText`/`runProgress` keep working across the swap from one loading view to the
 * other without either of them needing to know it happened. */
function claimGridStatusHTML(stage) {
  return `
    <div class="claim-grid-status">
      <div class="status-text stage-text" id="runStatus">${escapeHTML(stage.text)}</div>
      <div class="source-counter" id="runCounter">${stage.searchCount ? `Source ${stage.searchCount}` : "&nbsp;"}</div>
      <div class="mini-progress wide"><div class="mini-progress-bar" id="runProgressBar"></div></div>
    </div>`;
  // No `#runSources` here on purpose. The live source row belongs to the wait *before* the
  // first claim appears, where the card is otherwise empty and the reader has nothing to do
  // — see `renderLiveSources`. Once the grid exists there is real text arriving in it, each
  // claim carrying its own citations, and a second copy of the same links in a strip above
  // would push the boxes around every time a search landed. `renderLiveSources` is a no-op
  // from here on, since the node it looks for is gone.
}

/** The body of a claim box that is still being written: a shimmer standing in for the
 * analysis and verdict still to come, in the same shape `settledBodyHTML` renders once
 * they're real. */
const SKELETON_BODY_HTML = `
      <div class="claim-body skeleton-body" aria-hidden="true">
        <span class="skeleton-line"></span>
        <span class="skeleton-line"></span>
        <span class="skeleton-line short"></span>
      </div>`;

/** The body of a claim whose `VERDICT:` line has arrived — the same analysis-then-badge
 * pair `claimPanesHTML` renders at the end, minus the footer, which belongs to the finished
 * card rather than to a claim that merely happens to be last so far. `sources` is whatever
 * the stream has sent by now (see the `provisional` frames in lib/verified-chat.js), which
 * is what lets a `[3]` written mid-stream be a live link where it stands rather than inert
 * text waiting for the turn to end.
 *
 * `animate` is false when a *later* claim's marker forced the whole grid to be redrawn: this
 * box's text was already on screen and already read, and replaying its entrance every time a
 * sibling appears is the re-animation `revealAttrs` exists to avoid. Only the box that has
 * genuinely just settled fades in. */
function settledBodyHTML(claim, sources, seekable, animate = true) {
  return `
      <div ${revealAttrs("claim-body claim-text", animate)}>${renderMarkdown(claim.text, sources, seekable)}</div>
      ${badgeHTML(claim.verdictKey, animate)}`;
}

/** The position label on a claim box. Shared by the loading grid and the finished card so
 * a box that settles mid-stream doesn't relabel itself when the final render lands. */
function claimEyebrowText(index, total) {
  return total > 1 ? `Claim ${index + 1} of ${total}` : "Claim checked";
}

/** One box in the loading grid: title always real (lifted straight off the `[[claim: …]]`
 * marker that streamed in), body either settled or shimmering. */
function loadingClaimHTML(claim, index, total, spanFull, sources, seekable) {
  const done = Boolean(claim.verdictKey);
  return `
    <div class="claim-card claim-pane${done ? "" : " skeleton"}"${spanFull ? ' style="grid-column:1/-1"' : ""} data-claim="${index}">
      <div class="claim-eyebrow${done ? "" : " pending"}">${
        done
          ? escapeHTML(claimEyebrowText(index, total))
          : `Claim ${index + 1} of ${total} &middot; checking&hellip;`
      }</div>
      <p class="claim-title in">${escapeHTML(claim.title)}</p>
      ${done ? settledBodyHTML(claim, sources, seekable, false) : SKELETON_BODY_HTML}
    </div>`;
}

/**
 * The loading card growing into the claim grid it's about to become, one box at a time.
 *
 * `runCheck`'s `onDelta` calls this every time `splitClaims` finds a new `[[claim: …]]`
 * marker in the text streaming in — the model writes one per claim well before the full
 * answer (and its citations) are finished. There's no separate "how many claims" signal to
 * wait for; the marker *is* the count, arriving incrementally, so the grid is built the same
 * way the finished result reads it (see `claimGridColumns`/`claimPanesHTML`), just with each
 * box showing its title over a shimmer where the analysis and verdict will land.
 *
 * Boxes that have *already* settled by the time a later marker forces this redraw keep their
 * real text rather than reverting to a shimmer — see `settleClaimPane` for the in-place
 * version that runs when no redraw is needed.
 */
function renderClaimSkeletons(claims, stage, sources, seekable) {
  const count = claims.length;
  const cols = claimGridColumns(count);
  const spanLast = claimGridSpanLast(count, cols);
  setClaimsGridMode("grid-loading", cols);
  el.claimsPane.innerHTML =
    claimGridStatusHTML(stage) +
    claims
      .map((claim, i) =>
        loadingClaimHTML(claim, i, count, i === count - 1 && spanLast, sources, seekable),
      )
      .join("");
  revealIn(el.claimsPane);
  refreshTimeline();
  runProgress.resync();
}

/**
 * One box in the loading grid dropping its shimmer for the real thing, without touching any
 * of its neighbours.
 *
 * This is the whole point of parsing claims as they stream. A four-claim check writes them
 * one after another, so the first claim's analysis and verdict are finished and sitting in
 * the buffer for the best part of a minute before the last one's are — and until now every
 * box shimmered for that whole minute and the answer arrived all at once at the end. A
 * claim whose `VERDICT:` line has landed is complete in every sense the reader cares about,
 * so it is handed over the moment that happens.
 *
 * Surgical rather than a re-render on purpose: rebuilding the grid's markup on each settle
 * would restart every sibling's shimmer, throw away the entrance transition of the box that
 * just settled, and drop the reader's scroll position inside any box tall enough to have
 * one. A no-op if the box isn't there — the reader navigated away, or the finished card has
 * already replaced the loading view.
 */
function settleClaimPane(index, claim, total, sources, seekable) {
  const pane = el.claimsPane.querySelector(`.claim-pane[data-claim="${index}"]`);
  if (!pane) return;
  const body = pane.querySelector(".claim-body");
  if (!body) return;

  body.insertAdjacentHTML("afterend", settledBodyHTML(claim, sources, seekable));
  body.remove();
  pane.classList.remove("skeleton");
  if (!prefersReducedMotion()) pane.classList.add("just-settled");
  const eyebrow = pane.querySelector(".claim-eyebrow");
  if (eyebrow) {
    eyebrow.classList.remove("pending");
    eyebrow.textContent = claimEyebrowText(index, total);
  }
  revealIn(pane);
  // The `[t=…]` chips this box just gained are seek controls like any other — read them
  // back now rather than at the end, so a settled claim's timestamps play the clip
  // immediately instead of waiting out the claims still being written.
  refreshTimeline();
}

function renderErrorCard(entry) {
  setClaimsGridMode(null);
  el.claimsPane.innerHTML = `
    <div class="claim-card">
      <div class="eyebrow">Check failed</div>
      <p class="claim-text in">${escapeHTML(entry.error || "Something went wrong.")}</p>
      <button type="button" class="retry-button" id="retryBtn">Try again</button>
    </div>`;
  refreshTimeline();
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

/** The badge markup for one verdict key, or nothing for a key with no matching verdict —
 * shared by the whole-answer badge below and each claim's own badge in the split-panes
 * layout (see `claimPanesHTML`). */
function badgeHTML(verdictKey, animate) {
  const verdict = VERDICTS[verdictKey];
  if (!verdict) return "";
  return `
    <div class="badges">
      <span ${revealAttrs(`badge verdict ${verdict.css}`, animate)}>${escapeHTML(verdict.label)}</span>
    </div>`;
}

/**
 * The whole-answer verdict badge, for a check `splitClaims` found no claim blocks in — see
 * `renderResultCard`. Nothing when the turn is incomplete and no `VERDICT:` line was parsed
 * off it — see the note in `runCheck`. A badge is the app asserting the check's finding, and
 * there is no finding to assert when the answer stopped before it got to one.
 */
function verdictHTML(entry, animate) {
  if (entry.incomplete && !entry.verdictKey) return "";
  return badgeHTML(entry.verdictKey ?? "insufficient", animate);
}

/**
 * The sources a check was run against, as a row of link pills — one per source, each just
 * its domain, linking straight out. Replaces the old collapsed "Sources (N)" list with its
 * per-source quote toggles: a citation marker in the text (`[3]`) already links to the same
 * page, so that list was a second copy of information the reader could already reach, and
 * folding it behind a toggle just meant most readers never saw it at all. A pill needs
 * neither — it's small enough to sit in the open, and there's nothing under it to expand.
 */
function sourcePillsHTML(sources, animate) {
  if (!sources?.length) return "";
  return `
    <div ${revealAttrs("source-pills", animate)} aria-label="Checked against ${sources.length} source${sources.length === 1 ? "" : "s"}">
      ${sources
        .map(
          (s) =>
            `<a class="source-pill" href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(s.title)}">${escapeHTML(s.domain)}</a>`,
        )
        .join("")}
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

/** One delegated handler for everything a reader can click inside a rendered answer: a
 * timestamp chip, or acting on the answer itself. Source pills need no handler of their
 * own here — they're plain links, opened by the browser like any other `<a>`. */
async function handleClaimsPaneClick(event) {
  const chip = event.target.closest(".ts-chip[data-seek]");
  if (chip) {
    revealPlayer();
    // A chip that can't reach a player says so on itself rather than in a status line
    // somewhere else — most often the CDN URL never resolved, so the pane is still the
    // placeholder triangle and there is nothing to seek.
    const ok = seekVideoTo(Number(chip.dataset.seek));
    chip.classList.toggle("dead", !ok);
    if (!ok) chip.title = "The video isn't loaded, so there's nothing to jump to";
    return;
  }

  const btn = event.target.closest(".action-btn");
  if (!btn) return;
  const row = btn.closest(".action-row");
  const entry = row ? findEntry(row.dataset.entryId) : null;
  if (!entry) return;
  const followupIndex = row.dataset.followupIndex != null ? Number(row.dataset.followupIndex) : null;
  const stored = followupIndex == null ? entry.answer : entry.followups[followupIndex]?.answer;
  if (stored == null) return;
  // `[t=0:12]` is this app's own syntax for a control that exists on this screen and
  // nowhere else. Copied or shared, it should read as what it means: a moment in the clip.
  const text = plainTimestamps(stored);

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
  const seekable = seekableEntry(entry);
  const settled = entry.followups
    .map((f, index) => {
      // Only the answer that just landed animates; the ones above it are already read.
      const animate = index === newestIndex;
      return `
        <div class="thread-item">
          <div class="thread-q">${escapeHTML(f.question)}</div>
          <div ${revealAttrs("thread-a claim-text", animate)}>${renderMarkdown(f.answer, f.sources, seekable)}</div>
          ${incompleteHTML(f.incomplete, animate)}
          ${actionRowHTML(entry.id, index)}
          ${sourcePillsHTML(f.sources, animate)}
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
              : `<div class="thread-pending"><span class="thread-spinner"></span><span id="followupStatus" class="stage-text">Asking…</span></div>
                 <div class="mini-progress"><div class="mini-progress-bar" id="followupProgressBar"></div></div>`
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
/**
 * One `.claim-card` per claim `entry.claims` holds, instead of the single card every
 * answer used to be — see `splitClaims`. The parts of the check that aren't per-claim data
 * (the incomplete notice, copy/share/like, the sources ledger, the follow-up thread) aren't
 * given a card of their own; they're appended to the last claim's pane, the same place
 * they'd read as "the end of the analysis" when there was only one card to put them in.
 */
function claimPanesHTML(entry, animate, newestFollowup) {
  const { claims } = entry;
  const cols = claimGridColumns(claims.length);
  const spanLast = claimGridSpanLast(claims.length, cols);
  return claims
    .map((claim, index) => {
      const isLast = index === claims.length - 1;
      const eyebrow = claimEyebrowText(index, claims.length);
      const footer = isLast
        ? `${incompleteHTML(entry.incomplete, animate)}
           ${actionRowHTML(entry.id, null)}
           ${sourcePillsHTML(entry.sources, animate)}
           ${threadHTML(entry, newestFollowup)}`
        : "";
      // The last box spans the full row when it would otherwise sit alone against a bare
      // gap beside it — see `claimGridSpanLast`. It's also, not coincidentally, the one
      // carrying the footer above, so the extra width goes to the box that needs it most.
      const spanFull = isLast && spanLast;
      return `
        <div class="claim-card claim-pane"${spanFull ? ' style="grid-column:1/-1"' : ""}>
          <div class="claim-eyebrow">${escapeHTML(eyebrow)}</div>
          <p ${revealAttrs("claim-title", animate)}>${escapeHTML(claim.title)}</p>
          <div ${revealAttrs("claim-text", animate)}>${renderMarkdown(claim.text, entry.sources, seekableEntry(entry))}</div>
          ${badgeHTML(claim.verdictKey, animate)}
          ${footer}
        </div>`;
    })
    .join("");
}

function renderResultCard(entry, { animateAnalysis = true, newestFollowup = -1 } = {}) {
  if (entry.claims) {
    setClaimsGridMode("grid", claimGridColumns(entry.claims.length));
    el.claimsPane.innerHTML = claimPanesHTML(entry, animateAnalysis, newestFollowup);
  } else {
    setClaimsGridMode(null);
    el.claimsPane.innerHTML = `
    <div class="claim-card">
      <div class="eyebrow">Analysis</div>
      <div ${revealAttrs("claim-text", animateAnalysis)}>${renderMarkdown(entry.answer, entry.sources, seekableEntry(entry))}</div>
      ${incompleteHTML(entry.incomplete, animateAnalysis)}
      ${verdictHTML(entry, animateAnalysis)}
      ${actionRowHTML(entry.id, null)}
      ${sourcePillsHTML(entry.sources, animateAnalysis)}
      ${threadHTML(entry, newestFollowup)}
    </div>`;
  }
  revealIn(el.claimsPane);
  // After the markup, not before: the windows are read back off the chips this render just
  // wrote, and the ones from the previous render point at nodes that no longer exist.
  refreshTimeline();
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
async function streamChat(messages, { signal, onStage, onSearchCount, onDelta, onSources, clipHints } = {}) {
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
  // The ledger as the provisional frames have built it up so far. Separate from `sources`,
  // which stays empty until the final frame says what the answer actually cited.
  let live = [];
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
      else if (frame.type === "delta") {
        answer += frame.text;
        onDelta?.(answer);
      } else if (frame.type === "break") {
        answer += "\n\n";
      } else if (frame.type === "answer") {
        answer = frame.text;
        onDelta?.(answer);
      } else if (frame.type === "search") onSearchCount?.(++searchCount);
      else if (frame.type === "truncated") truncated = true;
      else if (frame.type === "sources") {
        // Provisional frames are the ledger mid-turn: everything retrieved so far, before
        // the answer has said which of it was worth citing. They are not what the finished
        // entry is stored with — the last, unflagged frame narrows and renumbers to what was
        // actually cited, and that is the one that wins here — but they *are* what makes a
        // marker a link while the answer is still being written, which is the whole reason
        // the server sends them early (see `sourcesFrame` in lib/verified-chat.js).
        //
        // They arrive as a difference rather than a fresh copy of the ledger, so they are
        // accumulated here: `added` are rows not seen yet, `quotes` attach a page's own
        // words to a row already held. Rebuilding the array rather than mutating in place
        // keeps every reader of `liveSources` looking at one immutable snapshot.
        if (frame.provisional) {
          if (frame.added?.length) live = live.concat(frame.added);
          if (frame.quotes?.length) {
            const patches = new Map(frame.quotes.map((q) => [q.n, q.quote]));
            live = live.map((row) => (patches.has(row.n) ? { ...row, quote: patches.get(row.n) } : row));
          }
          onSources?.(live);
        } else {
          sources = frame.sources;
          live = frame.sources ?? [];
          onSources?.(live);
        }
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
  const isVideo = SUPPORTED_PLATFORMS.has(platformFor(url));
  const subject = isVideo ? "video" : "page";
  // Asked for only when there is a player to seek. On an article the marker would be a
  // timestamp of nothing — the model has no clock to read, so inviting one is inviting an
  // invented one.
  const timestamps = isVideo
    ? "Mark each claim with when it happens in the video, as `[t=M:SS]` (or `[t=M:SS-M:SS]` " +
      "for a stretch) written immediately after the claim. Use the video's own clock, and " +
      "only for moments you actually observed — no guesses.\n\n"
    : "";
  return withCustomInstructions(
    `Fact-check this ${subject}: ${url}\n\n` +
      "List the distinct factual claims it makes and check each one, using the CLAIM " +
      `STRUCTURE from the system prompt — one \`[[claim: …]]\` block per claim, each ` +
      `ending in its own VERDICT line. ${timestamps}`,
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

  // What the loading view currently shows, kept outside the callbacks below so
  // `onDelta` — which rebuilds the whole loading view from scratch the moment a new claim
  // is discovered (see renderClaimSkeletons) — can carry the stage label and source count
  // forward into the rebuilt markup instead of them resetting to their initial text.
  const stage = { text: "Sending to the model…", searchCount: 0 };
  let drawn = [];
  // The ledger as the stream has it so far. The server sends it as the searches land
  // (`provisional: true`) precisely so a marker can be a link before the turn ends — see
  // `sourcesFrame` in lib/verified-chat.js — and a claim that settles mid-stream is exactly
  // the consumer that needs it.
  let liveSources = [];
  const seekable = seekableEntry(entry);

  try {
    const message = { role: "user", content: prompt, ...imagePayload(image) };
    const { answer, sources, incomplete } = await streamChat([message], {
      signal: controller.signal,
      clipHints: hint ? { [url]: hint } : null,
      onStage: (frame) => {
        stage.text = stageText(frame);
        setStatusText("runStatus", stage.text);
        runProgress.bump(frame?.stage);
      },
      onSearchCount: (n) => {
        stage.searchCount = n;
        const counter = document.getElementById("runCounter");
        if (counter) counter.textContent = `Source ${n}`;
        // A growing source count is real, visible progress even between named stages —
        // nudge the bar rather than let it sit on the last stage's floor while sources
        // keep arriving.
        runProgress.bump(Math.min(35 + n * 5, 70));
      },
      onSources: (rows) => {
        liveSources = rows;
        renderLiveSources(rows);
      },
      // The model writes one `[[claim: …]]` marker per claim as it drafts the answer, and
      // closes each one with its own `VERDICT:` line before opening the next — there's no
      // separate "how many claims" or "this one is done" signal to wait for, those two
      // markers *are* both, arriving incrementally. So the loading view tracks the answer
      // twice over: the single card grows into a grid of skeleton boxes as markers appear,
      // and each box hands over its shimmer for the real analysis, citations and verdict
      // the moment that claim's verdict line lands — which on a four-claim check is most of
      // a minute before the last one's does. See `claimDiff`, `renderClaimSkeletons` and
      // `settleClaimPane`.
      onDelta: (text) => {
        if (selectedId !== id) return; // navigated away — nothing to rebuild
        const claims = splitClaims(text) ?? [];
        const { rebuild, settled } = claimDiff(drawn, claims);
        if (!rebuild && settled.length === 0) return;
        drawn = claims;
        if (rebuild) {
          renderClaimSkeletons(claims, stage, liveSources, seekable);
        } else {
          for (const index of settled) {
            settleClaimPane(index, claims[index], claims.length, liveSources, seekable);
          }
        }
        // Claims finishing is the most concrete progress this turn produces. The elapsed-time
        // curve knows nothing about it, so the settled fraction pulls the bar along itself.
        const done = claims.filter((claim) => claim.verdictKey).length;
        if (done > 0) runProgress.bump(70 + Math.round((done / claims.length) * 25));
      },
    });

    const { text, verdictKey } = splitVerdict(answer);
    const claims = splitClaims(answer);
    entry.status = "done";
    entry.rawAnswer = answer; // kept whole, VERDICT line(s) included — history needs it verbatim
    entry.answer = text;
    entry.claims = claims; // null (render as one card, see renderResultCard), or one block per claim
    entry.sources = sources;
    entry.incomplete = incomplete;
    // A cut-off answer never reaches its VERDICT line, and the `?? "insufficient"` fallback
    // would then stamp it "Insufficient evidence" — a finding, in the app's own voice, that
    // the model never made and the reader has no way to tell from one it did. Left null when
    // the turn is known to be incomplete; the notice above the card says what happened
    // instead, which is the true answer to "why is there no verdict". Same reasoning for the
    // aggregate: see `aggregateVerdictKey`.
    entry.verdictKey = claims
      ? aggregateVerdictKey(claims) ?? (incomplete ? null : "insufficient")
      : verdictKey ?? (incomplete ? null : "insufficient");
    persistLibrary();
    renderLibrary(el.searchInput.value);
    if (selectedId === id) {
      await resolveIris();
      // The wait above can outlast the user's patience for this entry — they may have
      // already clicked to a different check. Re-check rather than trust the guard above.
      if (selectedId === id) {
        // The finished card still has to be built — the loading grid has no footer, no
        // sources row and no follow-up thread, and the text it painted predates citation
        // cleanup. But when every claim already settled on screen, the reader has been
        // reading this text for the last half-minute, so it is swapped in place rather than
        // faded in from nothing. Re-running the entrance on text that is already there and
        // already read is the flash `revealAttrs` exists to prevent, and it would land at
        // the one moment the check looks finished.
        const alreadyOnScreen =
          Array.isArray(claims) &&
          claims.length > 0 &&
          claims.length === drawn.length &&
          drawn.every((claim) => claim.verdictKey);
        renderResultCard(entry, { animateAnalysis: !alreadyOnScreen });
      }
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    entry.status = "error";
    entry.error = error.message;
    persistLibrary();
    renderLibrary(el.searchInput.value);
    if (selectedId === id) renderErrorCard(entry);
  } finally {
    // Guaranteed cleanup, not just the success path's: `resolveIris` (which calls
    // `runProgress.finish()`) only runs when this entry is still selected, so a check the
    // reader navigated away from mid-flight would otherwise leave the ticker running against
    // a bar that's no longer on screen.
    runProgress.stop();
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
  followupProgress.start();
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
        setStatusText("followupStatus", stageText(frame));
        followupProgress.bump(frame?.stage);
      },
    });
    followupProgress.finish();

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
    followupProgress.stop();
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
function setCheckBtnLabel(label) {
  // The button is icon-only at every width (CSS); the text lives on in the visually-hidden
  // span so "Ask" vs. "Check" still reaches a screen reader.
  el.checkBtn.querySelector(".check-btn-label").textContent = label;
  el.checkBtn.setAttribute("aria-label", label);
  // A mouse hovering an icon-only button (imageBtn/micBtn get this from a static `title`
  // in the markup; this one has to stay live) deserves the same tooltip a touch/VO user
  // gets from aria-label.
  el.checkBtn.setAttribute("title", label);
}

function updateComposerMode() {
  const entry = selectedDoneEntry();
  const asking = looksLikeFollowup(el.linkInput.value);
  setCheckBtnLabel(asking ? "Ask" : "Check");
  if (!entry) {
    el.linkInput.placeholder = asking
      ? "Ask a question…"
      : "Paste a video or article link, or just ask a question…";
    return;
  }
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
  const url = normalizeLink(raw);
  if (url) {
    confirmAndRunCheck(url, { entry, raw });
    return;
  }
  // Not link-shaped: an ordinary chat turn, on the selected check if there is one open,
  // otherwise the free-standing conversation (see runChat).
  const question = raw.trim();
  if (!question) return;
  if (entry) runFollowup(entry, question);
  else runChat(question);
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

el.sidebarCollapseBtn?.addEventListener("click", () => {
  settings.sidebarCollapsed = !settings.sidebarCollapsed;
  persistSettings();
  applySettings();
});

el.linkInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    el.checkBtn.click();
  }
});

/**
 * Start verifying a link as soon as the composer holds one, so the Check button doesn't have
 * to wait for it — see `warmLink`.
 *
 * Debounced, and not lightly: someone typing a URL by hand passes through a dozen strings
 * that parse as links and are none of them the one they meant, and each one that got through
 * would spend a `/api/resolve-media` call — which shares `/api/chat`'s rate-limit window, not
 * the looser one `/api/probe-link` gives itself. Burning a reader's fact-check allowance on
 * prefixes of a URL they are still typing would be a self-inflicted 429, and a 429 is the
 * slowest thing this app can do. Hence a long idle window rather than a twitchy one; the
 * paste listener below is what actually covers the common case.
 */
let warmTimer = null;
el.linkInput.addEventListener("input", () => {
  updateComposerMode();
  if (warmTimer) clearTimeout(warmTimer);
  // Nothing to warm while a turn is running: the button is disabled, so there is no click
  // coming that this could get ahead of.
  if (inFlight) return;
  const url = normalizeLink(el.linkInput.value);
  if (!url) return;
  warmTimer = setTimeout(() => warmLink(url), 700);
});

// A paste needs no debounce and is the case this is actually for: the string arrived whole,
// it is not going to be edited into a different link a keystroke later, and the click is
// usually the very next thing that happens — often inside the debounce window above, which
// would otherwise mean the commonest path never got warmed at all. Deferred by a turn
// because the value isn't in the field yet when this fires.
el.linkInput.addEventListener("paste", () => {
  setTimeout(() => {
    if (inFlight) return;
    const url = normalizeLink(el.linkInput.value);
    if (url) warmLink(url);
  }, 0);
});
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
  // `duration` — what the timeline's bands are laid out against — is only known from this
  // point on; see `renderTimelineTrack`'s doc comment.
  renderTimelineTrack();
  // A chip clicked while the CDN was still resolving. Now there is a clock to seek on.
  if (pendingSeek != null) {
    const target = pendingSeek;
    pendingSeek = null;
    applySeek(target);
  }
});

// Which claim the clip is on, tracked as it plays. `timeupdate` fires roughly 4–66 times a
// second depending on the engine; `syncPlayhead` compares against the window already lit and
// returns without touching the DOM unless it has genuinely changed.
el.videoPlayer.addEventListener("timeupdate", syncPlayhead);
// Seeking with the native controls, and the end of the clip, both move the playhead
// somewhere `timeupdate` may not report before the reader notices the stale highlight.
el.videoPlayer.addEventListener("seeked", syncPlayhead);
el.videoPlayer.addEventListener("ended", syncPlayhead);

// The play/pause button. Toggles the element directly rather than tracking state of its
// own — the `play`/`pause` listeners below are what actually keep the icon and label
// right, from this click or any other way playback starts or stops.
el.playBtn.addEventListener("click", () => {
  if (el.videoPlayer.paused) el.videoPlayer.play().catch(() => {});
  else el.videoPlayer.pause();
});

// A tap anywhere else on the video does the same thing — the button is there for
// discoverability and for a screen reader, not because the video itself shouldn't work
// the way every short-form player's does. Excludes the control buttons themselves (they're
// inside `.video-thumb` too, so this handler would otherwise fire a second time on top of
// theirs) and anywhere there's no direct MP4 loaded to toggle in the first place.
el.videoThumb.addEventListener("click", (event) => {
  if (el.videoControls.hidden || event.target.closest(".video-controls")) return;
  if (el.videoPlayer.paused) el.videoPlayer.play().catch(() => {});
  else el.videoPlayer.pause();
});

// The single source of truth for the play/pause icon and label — set from the element's
// own state, not assumed at whichever click asked for it, so it's still right when
// autoplay is silently refused or playback stops some way neither handler above covers.
el.videoPlayer.addEventListener("play", () => {
  el.playBtn.classList.add("playing");
  el.playBtn.setAttribute("aria-pressed", "true");
  el.playBtn.setAttribute("aria-label", "Pause");
  el.playBtn.title = "Pause";
});
el.videoPlayer.addEventListener("pause", () => {
  el.playBtn.classList.remove("playing");
  el.playBtn.setAttribute("aria-pressed", "false");
  el.playBtn.setAttribute("aria-label", "Play");
  el.playBtn.title = "Play";
});

// The unmute button. Muted is where every clip starts (autoplay only works muted, and a
// reader who wants sound asks for it) — see `showVideoElement` for where that gets reset
// on every new entry, so this toggle never inherits "on" from a previous check.
el.muteBtn.addEventListener("click", () => {
  const unmuted = el.videoPlayer.muted;
  el.videoPlayer.muted = !unmuted;
  el.muteBtn.classList.toggle("unmuted", unmuted);
  el.muteBtn.setAttribute("aria-pressed", String(unmuted));
  const label = unmuted ? "Mute" : "Unmute";
  el.muteBtn.setAttribute("aria-label", label);
  el.muteBtn.title = label;
});

// Fullscreens `.video-thumb` rather than the bare `<video>`, so the custom controls and
// the timeline stay on screen and usable — the browser's native video fullscreen would
// take just the element itself, chrome and all, out of the page.
el.fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else el.videoThumb.requestFullscreen?.().catch(() => {}); // Refused (no gesture, disabled) — the button just does nothing.
});

// The class/label answer to `fullscreenElement` rather than being set at the click above,
// so they're also right when fullscreen ends some other way — Esc, the system's own exit
// gesture — that this page gets no click for.
document.addEventListener("fullscreenchange", () => {
  const active = document.fullscreenElement === el.videoThumb;
  el.fullscreenBtn.classList.toggle("fs-active", active);
  const label = active ? "Exit fullscreen" : "Fullscreen";
  el.fullscreenBtn.setAttribute("aria-label", label);
  el.fullscreenBtn.title = label;
});

/** Where a click (or a tap, or an arrow key) on the track lands, in seconds. */
function timelineSeekTarget(clientX) {
  const duration = el.videoPlayer.duration;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const rect = el.timelineTrack.getBoundingClientRect();
  if (!rect.width) return null;
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return fraction * duration;
}

el.timelineTrack.addEventListener("click", (event) => {
  const target = timelineSeekTarget(event.clientX);
  if (target != null) seekVideoTo(target);
});

// A slider in everything but name — see the `role="slider"` set alongside `tabindex` on
// the element itself — so the usual left/right (and up/down, for a vertical-video reader
// used to a volume-style control) step it, Home/End jump to the ends.
el.timelineTrack.addEventListener("keydown", (event) => {
  const duration = el.videoPlayer.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const step = 5;
  let target = null;
  if (event.key === "ArrowRight" || event.key === "ArrowUp") target = el.videoPlayer.currentTime + step;
  else if (event.key === "ArrowLeft" || event.key === "ArrowDown") target = el.videoPlayer.currentTime - step;
  else if (event.key === "Home") target = 0;
  else if (event.key === "End") target = duration;
  if (target == null) return;
  event.preventDefault();
  seekVideoTo(Math.min(duration, Math.max(0, target)));
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
