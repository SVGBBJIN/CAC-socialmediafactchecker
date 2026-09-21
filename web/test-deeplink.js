// `/c/<id>` — the address of one check. See public/deeplink.js.
//
// Pure, no network, no DOM — the convention in CLAUDE.md.

import test from "node:test";
import assert from "node:assert/strict";

import { checkIdFromPath, isCheckId, pathForCheck, shareURL } from "./public/deeplink.js";

const ID = "8f14e45f-ceea-467a-9e77-1c2d0f4a1b3c";

test("a check path resolves to the entry id it names", () => {
  assert.equal(checkIdFromPath(`/c/${ID}`), ID);
  // A trailing slash is the same address — browsers and link previewers add one freely.
  assert.equal(checkIdFromPath(`/c/${ID}/`), ID);
  // Case is not part of a uuid's identity, and a library entry's id is stored lower case.
  assert.equal(checkIdFromPath(`/c/${ID.toUpperCase()}`), ID);
});

test("anything that is not one check's address resolves to null", () => {
  assert.equal(checkIdFromPath("/"), null);
  assert.equal(checkIdFromPath("/auth/confirm"), null);
  // Not an id: this is some other URL, not a check that has gone missing, and the
  // difference decides whether the reader is shown a "not on this device" card.
  assert.equal(checkIdFromPath("/c/favicon.ico"), null);
  assert.equal(checkIdFromPath("/c/"), null);
  // A deeper path is not a check's address either, so it must not round-trip as one.
  assert.equal(checkIdFromPath(`/c/${ID}/sources`), null);
  assert.equal(checkIdFromPath(null), null);
});

test("an id round-trips through the path it is given", () => {
  assert.equal(checkIdFromPath(pathForCheck(ID)), ID);
  // Nothing else may be turned into a check address — that would mint a link to a page
  // the app would then have to apologise for.
  assert.equal(pathForCheck("not-an-id"), "/");
  assert.equal(pathForCheck(undefined), "/");
});

test("isCheckId accepts only a uuid", () => {
  assert.equal(isCheckId(ID), true);
  assert.equal(isCheckId(`${ID}x`), false);
  assert.equal(isCheckId(""), false);
});

test("a share URL is only ever an http(s) address", () => {
  assert.equal(shareURL("https://trase.app", ID), `https://trase.app/c/${ID}`);
  // A trailing slash on the origin must not double up in the middle of the link.
  assert.equal(shareURL("https://trase.app/", ID), `https://trase.app/c/${ID}`);
  // `file://` and `about:` are what `location.origin` reads as when the page was opened
  // from disk. A link built on one means nothing to whoever receives it, so there isn't one.
  assert.equal(shareURL("file://", ID), null);
  assert.equal(shareURL("null", ID), null);
});
