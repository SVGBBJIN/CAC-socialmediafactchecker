// The URL half of email confirmation (public/auth-callback.js). Pure, so it runs in Node
// with no browser and no Supabase — same arrangement as test-claims.js and
// test-timestamps.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIRM_PATH,
  describeOutcome,
  emailRedirectUrl,
  isBareVisit,
  readCallbackParams,
} from "./public/auth-callback.js";

test("emailRedirectUrl points at the confirmation page on the origin given", () => {
  assert.equal(emailRedirectUrl("https://trase.app"), "https://trase.app/auth/confirm.html");
  assert.equal(emailRedirectUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000/auth/confirm.html");
  // A preview deploy confirms back to itself — the whole reason the origin isn't a constant.
  assert.equal(
    emailRedirectUrl("https://trase-git-branch.vercel.app"),
    "https://trase-git-branch.vercel.app/auth/confirm.html",
  );
});

test("emailRedirectUrl refuses anything that isn't an http(s) origin", () => {
  // Callers pass the result straight to signUp, which omits the option when it's null —
  // so "no answer" has to mean null, never a half-built URL.
  for (const origin of ["", null, undefined, "not a url", "file:///tmp", "javascript:alert(1)"]) {
    assert.equal(emailRedirectUrl(origin), null, `expected null for ${String(origin)}`);
  }
});

test("emailRedirectUrl's default path is the one the page is served at", () => {
  assert.equal(CONFIRM_PATH, "/auth/confirm.html");
  assert.equal(emailRedirectUrl("https://x.dev", "/elsewhere.html"), "https://x.dev/elsewhere.html");
});

test("readCallbackParams reads the fragment, where the implicit flow puts the session", () => {
  const params = readCallbackParams(
    "https://trase.app/auth/confirm.html#access_token=abc&refresh_token=def&type=signup",
  );
  assert.equal(params.hasSessionTokens, true);
  assert.equal(params.type, "signup");
  assert.equal(params.error, null);
});

test("readCallbackParams reads the query too", () => {
  const params = readCallbackParams(
    "https://trase.app/auth/confirm.html?token_hash=pkce_123&type=email",
  );
  assert.equal(params.tokenHash, "pkce_123");
  assert.equal(params.type, "email");
  assert.equal(params.hasSessionTokens, false);
});

test("readCallbackParams finds an error in either half", () => {
  const inHash = readCallbackParams(
    "https://trase.app/auth/confirm.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
  );
  assert.equal(inHash.error, "access_denied");
  assert.match(inHash.errorDescription, /expired/);

  const inQuery = readCallbackParams("https://trase.app/auth/confirm.html?error=server_error");
  assert.equal(inQuery.error, "server_error");
});

test("readCallbackParams survives a URL it can't parse", () => {
  const params = readCallbackParams("not-a-url");
  assert.equal(params.error, null);
  assert.equal(params.hasSessionTokens, false);
  assert.equal(isBareVisit(params), true);
});

test("a session in hand reads as confirmed and signed in", () => {
  const params = readCallbackParams("https://trase.app/auth/confirm.html#access_token=abc");
  const outcome = describeOutcome(params, { hasSession: true });
  assert.equal(outcome.status, "confirmed");
  assert.equal(outcome.signedIn, true);
});

test("a clicked link with no session still reads as confirmed, just not signed in", () => {
  // A project that confirms the address without starting a session — the address *is*
  // confirmed, and reporting a failure there would send someone to sign up twice.
  const params = readCallbackParams("https://trase.app/auth/confirm.html?token_hash=t&type=signup");
  const outcome = describeOutcome(params, { hasSession: false });
  assert.equal(outcome.status, "confirmed");
  assert.equal(outcome.signedIn, false);
  assert.match(outcome.message, /sign in/i);
});

test("an expired link says so rather than blaming the sign-up", () => {
  const params = readCallbackParams(
    "https://trase.app/auth/confirm.html#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
  );
  const outcome = describeOutcome(params, { hasSession: false });
  assert.equal(outcome.status, "expired");
  assert.equal(outcome.signedIn, false);
  assert.match(outcome.title, /expired/i);
});

test("an error keeps Supabase's own description, decoded and punctuated", () => {
  const params = readCallbackParams(
    "https://trase.app/auth/confirm.html#error=server_error&error_description=Database+error+saving+new+user",
  );
  const outcome = describeOutcome(params, { hasSession: false });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.message, "Database error saving new user.");
});

test("an error wins over a session that somehow also arrived", () => {
  const params = readCallbackParams(
    "https://trase.app/auth/confirm.html#error=access_denied&access_token=abc",
  );
  assert.equal(describeOutcome(params, { hasSession: true }).status, "error");
});

test("someone who just opens the page is told there's nothing to confirm", () => {
  const params = readCallbackParams("https://trase.app/auth/confirm.html");
  assert.equal(isBareVisit(params), true);
  const outcome = describeOutcome(params, { hasSession: false });
  assert.equal(outcome.status, "bare");
  assert.equal(outcome.signedIn, false);
});

test("a bare visit by someone already signed in is a welcome, not a dead end", () => {
  const params = readCallbackParams("https://trase.app/auth/confirm.html");
  const outcome = describeOutcome(params, { hasSession: true });
  assert.equal(outcome.status, "confirmed");
  assert.equal(outcome.signedIn, true);
});
