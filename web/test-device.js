// Unit tests for public/device.js. No DOM and no network, per the convention in
// CLAUDE.md — `window` is a plain object here, which is the whole reason `classifyDevice`
// takes a signals bag instead of reading globals itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyDevice,
  readSignals,
  watchDevice,
  PHONE_MAX_WIDTH,
  TABLET_MAX_WIDTH,
} from "./public/device.js";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const IPAD =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WINDOWS_TOUCH =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ---------------------------------------------------------------- width drives layout */

test("width alone picks the layout when nothing else is known", () => {
  assert.equal(classifyDevice({ width: 390 }).kind, "phone");
  assert.equal(classifyDevice({ width: 834 }).kind, "tablet");
  assert.equal(classifyDevice({ width: 1440 }).kind, "desktop");
});

test("breakpoints are inclusive at their upper edge", () => {
  assert.equal(classifyDevice({ width: PHONE_MAX_WIDTH }).kind, "phone");
  assert.equal(classifyDevice({ width: PHONE_MAX_WIDTH + 1 }).kind, "tablet");
  assert.equal(classifyDevice({ width: TABLET_MAX_WIDTH }).kind, "tablet");
  assert.equal(classifyDevice({ width: TABLET_MAX_WIDTH + 1 }).kind, "desktop");
});

test("a narrowed desktop window gets the phone layout", () => {
  // The point of the width-led rule: responsive means responsive, and a UA check must
  // not talk a 500px window back out of the compact layout.
  const result = classifyDevice({ userAgent: MAC, width: 500, maxTouchPoints: 0 });
  assert.equal(result.kind, "phone");
  assert.equal(result.touch, false);
});

/* ---------------------------------------------------------------- UA may only narrow */

test("a phone reporting a wide viewport is still a phone", () => {
  // "Request desktop site" makes a phone claim a 980px viewport. Handing it the
  // two-pane hover layout on a 6" screen is exactly the bug this rule prevents.
  const result = classifyDevice({ userAgent: IPHONE, width: 980, maxTouchPoints: 5 });
  assert.equal(result.kind, "phone");
  assert.equal(result.touch, true);
});

test("a tablet at desktop width stays a tablet", () => {
  const result = classifyDevice({ userAgent: ANDROID_TABLET, width: 1280, maxTouchPoints: 5 });
  assert.equal(result.kind, "tablet");
});

test("a tablet in portrait narrows to phone rather than widening to tablet", () => {
  const result = classifyDevice({ userAgent: IPAD, width: 600, maxTouchPoints: 5 });
  assert.equal(result.kind, "phone");
});

/* ---------------------------------------------------------------- UA specifics */

test("iPadOS is recognised despite reporting the desktop Safari UA", () => {
  const ipad = classifyDevice({ userAgent: IPAD, width: 1180, maxTouchPoints: 5 });
  assert.equal(ipad.kind, "tablet");
  assert.equal(ipad.touch, true);

  // Same string, no touch points: an actual Mac, and it must not be mistaken for one.
  const mac = classifyDevice({ userAgent: IPAD, width: 1180, maxTouchPoints: 0 });
  assert.equal(mac.kind, "desktop");
  assert.equal(mac.touch, false);
});

test("Android phones and tablets are told apart by the Mobile token", () => {
  assert.equal(classifyDevice({ userAgent: ANDROID_PHONE, width: 412 }).kind, "phone");
  assert.equal(classifyDevice({ userAgent: ANDROID_TABLET, width: 900 }).kind, "tablet");
  // The token, not the width, is what separates them at an identical size.
  assert.equal(classifyDevice({ userAgent: ANDROID_PHONE, width: 900 }).kind, "phone");
  assert.equal(classifyDevice({ userAgent: ANDROID_TABLET, width: 900 }).kind, "tablet");
});

/* ---------------------------------------------------------------- touch is independent */

test("touch is capability-led, not width-led", () => {
  // A touchscreen laptop: full desktop layout, but hover-only affordances are still a
  // lie, so `touch` has to be true while `kind` stays desktop.
  //
  // Windows, not Mac, on purpose. `Macintosh` + touch points is how an iPad is
  // identified (see the iPadOS test below), and that heuristic is only sound because no
  // Mac ships a touchscreen — a Mac UA reporting fingers really is an iPad. Windows
  // touch laptops are the actual population this case covers.
  const touchLaptop = classifyDevice({
    userAgent: WINDOWS_TOUCH,
    width: 1512,
    coarsePointer: true,
    maxTouchPoints: 10,
  });
  assert.equal(touchLaptop.kind, "desktop");
  assert.equal(touchLaptop.touch, true);

  // And the converse: narrow window, mouse. Compact layout, hover still works.
  const narrowMouse = classifyDevice({
    userAgent: MAC,
    width: 420,
    coarsePointer: false,
    hover: true,
  });
  assert.equal(narrowMouse.kind, "phone");
  assert.equal(narrowMouse.touch, false);
});

test("no hover at all counts as touch", () => {
  assert.equal(classifyDevice({ width: 1200, hover: false }).touch, true);
});

test("a coarse pointer wins over a zero touch-point count", () => {
  assert.equal(classifyDevice({ width: 1200, coarsePointer: true, maxTouchPoints: 0 }).touch, true);
});

/* ---------------------------------------------------------------- degenerate input */

test("no signals at all falls back to desktop", () => {
  const result = classifyDevice();
  assert.equal(result.kind, "desktop");
  assert.equal(result.touch, false);
  assert.equal(result.width, 0);
});

test("a known UA with no width still classifies", () => {
  assert.equal(classifyDevice({ userAgent: IPHONE }).kind, "phone");
  assert.equal(classifyDevice({ userAgent: ANDROID_TABLET }).kind, "tablet");
  assert.equal(classifyDevice({ userAgent: MAC }).kind, "desktop");
});

/* ---------------------------------------------------------------- readSignals */

test("readSignals survives a window with no matchMedia", () => {
  const signals = readSignals({ navigator: { userAgent: IPHONE, maxTouchPoints: 5 }, innerWidth: 390 });
  assert.equal(signals.coarsePointer, null);
  assert.equal(signals.hover, null);
  assert.equal(signals.width, 390);
  assert.equal(classifyDevice(signals).kind, "phone");
});

test("readSignals survives a matchMedia that throws", () => {
  const signals = readSignals({
    navigator: { userAgent: MAC },
    innerWidth: 1200,
    matchMedia() {
      throw new Error("unsupported query");
    },
  });
  assert.equal(signals.coarsePointer, null);
  assert.equal(classifyDevice(signals).kind, "desktop");
});

/* ---------------------------------------------------------------- watchDevice */

function fakeWindow(initial) {
  const listeners = new Map();
  return {
    innerWidth: initial.width,
    navigator: { userAgent: initial.userAgent ?? "", maxTouchPoints: initial.maxTouchPoints ?? 0 },
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    emit(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

test("watchDevice reports once immediately, with no previous", () => {
  const win = fakeWindow({ width: 1400 });
  const calls = [];
  watchDevice(win, (next, previous) => calls.push([next.kind, previous]));
  assert.deepEqual(calls, [["desktop", null]]);
});

test("watchDevice fires on a resize that crosses a breakpoint", () => {
  const win = fakeWindow({ width: 1400 });
  const calls = [];
  watchDevice(win, (next, previous) => calls.push([next.kind, previous?.kind ?? null]));

  win.innerWidth = 500;
  win.emit("resize");
  assert.deepEqual(calls.at(-1), ["phone", "desktop"]);

  win.innerWidth = 900;
  win.emit("orientationchange");
  assert.deepEqual(calls.at(-1), ["tablet", "phone"]);
});

test("watchDevice stays quiet for a resize inside one breakpoint", () => {
  const win = fakeWindow({ width: 1400 });
  let calls = 0;
  watchDevice(win, () => calls++);
  assert.equal(calls, 1);

  win.innerWidth = 1600;
  win.emit("resize");
  win.innerWidth = 1300;
  win.emit("resize");
  assert.equal(calls, 1, "re-rendering the whole UI on every resize tick is the bug here");
});

test("watchDevice unsubscribes cleanly", () => {
  const win = fakeWindow({ width: 1400 });
  let calls = 0;
  const stop = watchDevice(win, () => calls++);
  stop();

  assert.equal(win.listenerCount("resize"), 0);
  win.innerWidth = 400;
  win.emit("resize");
  assert.equal(calls, 1);
});
