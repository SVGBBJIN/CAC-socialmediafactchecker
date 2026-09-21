// The address of one check.
//
// Every check used to live at `/`. That is fine while you are looking at it and useless
// the moment you want to come back to it: a check could not be bookmarked, opened in a
// second tab, or sent to anyone, and the browser's own Back button had nothing to go back
// to. This module owns the one URL shape that fixes it — `/c/<id>`, where `<id>` is the
// uuid a library entry already carries (see `runCheck` in app.js, and the `conversations`
// table's primary key, which is the same value).
//
// ## Local, and honest about it
//
// A check lives in this browser's localStorage. `/c/<id>` therefore resolves for the
// person who ran it, on the device they ran it on, and nowhere else — it is a bookmark and
// a second tab, not a published page. `app.js` says so on screen when an id it cannot find
// is asked for, rather than showing an empty pane that looks like a bug.
//
// Pure and DOM-free on purpose, like `claims.js`, `timestamps.js` and `device.js` — that is
// what lets `test-deeplink.js` exercise it in Node with no browser, per the convention in
// CLAUDE.md.

/**
 * The prefix, in one place. `server.js` and the root `vercel.json` both have to route this
 * path to `index.html`, since it names no file on disk; both carry a comment pointing here.
 */
export const CHECK_PATH_PREFIX = "/c/";

/**
 * A uuid as `crypto.randomUUID` writes it, which is the only thing a library entry's id
 * has ever been. Deliberately strict: a path segment that is not one is not a check id
 * that happens to be missing, it is somebody else's URL, and telling those two apart is
 * what keeps "this check isn't on this device" from being shown for `/c/favicon.ico`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string is shaped like a library entry's id. */
export function isCheckId(value) {
  return UUID.test(String(value ?? "").trim());
}

/**
 * The check a path names, or null if it names none.
 *
 * Null covers three different things on purpose — the home page, some other page, and a
 * `/c/…` whose segment is not an id — because the caller does the same thing for all
 * three: leave the library's own idea of what is selected alone.
 */
export function checkIdFromPath(pathname) {
  const path = String(pathname ?? "");
  if (!path.startsWith(CHECK_PATH_PREFIX)) return null;
  // One segment only. `/c/<id>/anything` is not a check's address, and reading the id out
  // of it anyway would make a mistyped URL silently work and then not round-trip.
  const rest = path.slice(CHECK_PATH_PREFIX.length).replace(/\/$/, "");
  return isCheckId(rest) ? rest.toLowerCase() : null;
}

/** Where a check lives, as a root-relative path. */
export function pathForCheck(id) {
  return isCheckId(id) ? `${CHECK_PATH_PREFIX}${String(id).toLowerCase()}` : "/";
}

/**
 * A check's full address, for the clipboard and the share sheet.
 *
 * `origin` is passed in rather than read off `location` so this stays testable and so the
 * one caller that matters — the Share button — cannot accidentally produce a `file://` or
 * `about:` URL that means nothing to whoever receives it.
 */
export function shareURL(origin, id) {
  const base = String(origin ?? "");
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base.replace(/\/$/, "")}${pathForCheck(id)}`;
}
