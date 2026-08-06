// Device classification for the library UI.
//
// Two different questions get asked of a browser, and conflating them is what makes
// "mobile detection" go wrong:
//
//   1. *How much room is there?*  — answered by width, and it changes as the window is
//      resized. This is what picks the layout, and the CSS in index.html owns it via
//      media queries. A desktop window dragged narrow genuinely wants the phone layout.
//   2. *What is the user pointing with?* — answered by pointer capability, and it does
//      not change with width. This is what picks the affordances: hover-reveal controls
//      are a lie on a touchscreen, and 28px tap targets are a lie on a thumb.
//
// So this module reports both, separately, and never lets one stand in for the other.
// `kind` is width-led with the user-agent only allowed to *narrow* it (a phone held in
// landscape is still a phone; an iPad at 1180px must not be handed the hover UI), and
// `touch` is capability-only.
//
// Sniffing the UA string is a last resort, not the first move: it is the one signal a
// browser is free to lie about, and it is the one that rots. It is used here only for
// the two things capability queries cannot express — telling a large phone from a small
// tablet, and recognising an iPad, which since iPadOS 13 reports itself as a Macintosh
// and is distinguishable only by the fact that Macs do not have ten touch points.
//
// Kept dependency-free and free of DOM access at module scope so it can be unit-tested
// in node (test-device.js) with plain objects standing in for `window`. It lives in
// public/ rather than lib/ because only public/ is served to the browser; that is the
// same reason app.js re-implements a few small server-side helpers instead of importing
// them.

/** Below this, one column and a drawer. Mirrors the `--phone` breakpoint in index.html. */
export const PHONE_MAX_WIDTH = 700;

/** Above this, the two-pane desktop layout. Between the two, a tablet: split layout,
 *  touch-sized controls. Mirrors `--tablet` in index.html. */
export const TABLET_MAX_WIDTH = 1024;

const PHONE_UA = /iPhone|iPod|Windows Phone|BlackBerry|BB10|\bIEMobile\b|Opera Mini/i;
const TABLET_UA = /iPad|Android(?!.*\bMobile\b)|Tablet|PlayBook|Silk/i;
// Android's convention: phones carry "Mobile" in the token, tablets omit it. The
// negative lookahead above is that rule; this is the positive half of it.
const ANDROID_PHONE_UA = /Android.*\bMobile\b/i;

/**
 * @param {object} signals
 * @param {string} [signals.userAgent]      navigator.userAgent
 * @param {number} [signals.width]          window.innerWidth; 0/absent means "unknown"
 * @param {boolean|null} [signals.coarsePointer]  matchMedia("(pointer: coarse)").matches
 * @param {boolean|null} [signals.hover]    matchMedia("(hover: hover)").matches
 * @param {number} [signals.maxTouchPoints] navigator.maxTouchPoints
 * @returns {{kind: "phone"|"tablet"|"desktop", touch: boolean, width: number}}
 */
export function classifyDevice(signals = {}) {
  const {
    userAgent = "",
    width = 0,
    coarsePointer = null,
    hover = null,
    maxTouchPoints = 0,
  } = signals;

  const ua = uaKind(userAgent, maxTouchPoints);
  const touch = isTouch({ coarsePointer, hover, maxTouchPoints, ua });

  // With no width to go on (a non-browser caller, or a headless probe) the UA is all
  // there is. Absent that too, assume desktop: it is the layout that degrades most
  // gracefully if wrong, since it is the one the markup is authored in.
  if (!width) return { kind: ua ?? "desktop", touch, width: 0 };

  let kind = width <= PHONE_MAX_WIDTH ? "phone" : width <= TABLET_MAX_WIDTH ? "tablet" : "desktop";

  // The UA may only narrow the width's verdict, never widen it. A phone reporting an
  // unexpectedly wide viewport (desktop-mode request, a browser lying about its width)
  // is still a phone. But a desktop window at 500px is genuinely phone-shaped, and no
  // UA check should talk it back out of the compact layout.
  if (ua === "phone") kind = "phone";
  else if (ua === "tablet" && kind === "desktop") kind = "tablet";

  return { kind, touch, width };
}

/** True when the primary input is a finger — the signal that gates hover-only
 *  affordances and tap-target sizing, independent of how wide the window is. */
function isTouch({ coarsePointer, hover, maxTouchPoints, ua }) {
  if (coarsePointer === true) return true;
  if (hover === false) return true; // no hover at all: a touchscreen, or a TV remote
  if (maxTouchPoints > 0) return true;
  return ua === "phone" || ua === "tablet";
}

/** What the user-agent string claims, or null when it says nothing useful. Deliberately
 *  returns null rather than guessing "desktop" so the caller can tell "the UA says this
 *  is a desktop" apart from "the UA said nothing". */
function uaKind(userAgent, maxTouchPoints) {
  if (!userAgent) return null;
  if (PHONE_UA.test(userAgent) || ANDROID_PHONE_UA.test(userAgent)) return "phone";
  if (TABLET_UA.test(userAgent)) return "tablet";
  // iPadOS 13+ ships the desktop Safari UA verbatim. Touch points are what still give it
  // away: a Mac trackpad reports 0, an iPad reports 5.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "tablet";
  return null;
}

/** Reads the live signals off a real window. Split from `classifyDevice` so the decision
 *  itself stays testable without a DOM. */
export function readSignals(win) {
  const nav = win.navigator ?? {};
  return {
    userAgent: nav.userAgent ?? "",
    width: win.innerWidth || 0,
    coarsePointer: matches(win, "(pointer: coarse)"),
    hover: matches(win, "(hover: hover)"),
    maxTouchPoints: nav.maxTouchPoints ?? 0,
  };
}

function matches(win, query) {
  if (typeof win.matchMedia !== "function") return null;
  try {
    return win.matchMedia(query).matches;
  } catch {
    return null;
  }
}

/**
 * Classifies `win` now, then re-classifies whenever the answer could have changed, and
 * calls `onChange` only when it actually did.
 *
 * Listening to `resize` is what makes this a *responsive* classification rather than a
 * one-shot sniff at load: rotating a phone, splitting a tablet's screen, or dragging a
 * desktop window narrow all have to move the UI, and none of them reload the page. The
 * pointer media query is watched too, for a tablet that gains a keyboard mid-session.
 *
 * @returns {() => void} unsubscribe
 */
export function watchDevice(win, onChange) {
  let current = classifyDevice(readSignals(win));
  onChange(current, null);

  const reevaluate = () => {
    const next = classifyDevice(readSignals(win));
    if (next.kind === current.kind && next.touch === current.touch) return;
    const previous = current;
    current = next;
    onChange(next, previous);
  };

  win.addEventListener("resize", reevaluate);
  win.addEventListener("orientationchange", reevaluate);

  const pointerQuery =
    typeof win.matchMedia === "function" ? win.matchMedia("(pointer: coarse)") : null;
  pointerQuery?.addEventListener?.("change", reevaluate);

  return () => {
    win.removeEventListener("resize", reevaluate);
    win.removeEventListener("orientationchange", reevaluate);
    pointerQuery?.removeEventListener?.("change", reevaluate);
  };
}
