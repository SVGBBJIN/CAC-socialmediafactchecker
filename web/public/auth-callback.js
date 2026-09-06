// The URL half of email confirmation: where Supabase should send someone after they click
// the link in a signup email, and how to read what it sends back.
//
// Pure — no `window`, no DOM, no Supabase client — for the same reason claims.js,
// timestamps.js and device.js are: the parsing is the part that has to be right, and it
// can be tested in Node with no browser (see test-auth-callback.js). auth.js supplies the
// origin and does the talking; public/auth/confirm.html renders the outcome.

/**
 * Where a confirmation link lands. Supabase only redirects to a URL that matches its
 * project's Redirect URLs allowlist (Authentication → URL Configuration), so this path
 * has to be allowlisted there too — otherwise Supabase silently falls back to the
 * project's Site URL, which is exactly the localhost redirect this file exists to fix.
 */
export const CONFIRM_PATH = "/auth/confirm.html";

/**
 * The absolute URL handed to Supabase as `emailRedirectTo`. Built from the origin the
 * user actually signed up on rather than a configured constant, so a preview deploy
 * confirms back to that preview and localhost confirms back to localhost — one
 * allowlist entry per environment, no env var to forget on the next one.
 *
 * Returns null for anything that isn't an http(s) origin, which is what makes it safe to
 * pass the result straight through: `signUp` then omits the option and Supabase uses its
 * own Site URL, the behaviour this replaced.
 */
export function emailRedirectUrl(origin, path = CONFIRM_PATH) {
  if (typeof origin !== "string" || !origin) return null;
  let url;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.toString();
}

/**
 * What came back on the confirmation URL, from both halves of it: Supabase puts a session
 * in the *fragment* (`#access_token=…`, the implicit flow), and puts errors, a PKCE
 * `code`, and the `token_hash` verification form in either the fragment or the query
 * depending on the flow and the project's settings. Reading only one of the two is the
 * bug this function exists to not have.
 */
export function readCallbackParams(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return emptyParams();
  }
  const query = url.searchParams;
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const pick = (name) => query.get(name) ?? hash.get(name) ?? null;
  return {
    error: pick("error") || pick("error_code"),
    errorDescription: pick("error_description"),
    tokenHash: pick("token_hash"),
    type: pick("type"),
    code: pick("code"),
    // The implicit flow's session, already in the URL. supabase-js picks this up itself
    // (`detectSessionInUrl`), so there is nothing to *do* with it — it only tells the
    // page whether a link was clicked at all.
    hasSessionTokens: Boolean(pick("access_token")),
  };
}

function emptyParams() {
  return {
    error: null,
    errorDescription: null,
    tokenHash: null,
    type: null,
    code: null,
    hasSessionTokens: false,
  };
}

/** True when the URL carries nothing Supabase would have put there — someone typed the
 *  path in, or followed a stale bookmark. Worth its own message: "your link expired" is
 *  the wrong thing to tell a person who never clicked one. */
export function isBareVisit(params) {
  return (
    !params.error &&
    !params.tokenHash &&
    !params.code &&
    !params.hasSessionTokens
  );
}

/**
 * The screen to show, given what the URL said and whether a session actually exists
 * afterwards. One function so the page is a renderer and the decisions are testable.
 *
 * `status` is `"confirmed" | "expired" | "error" | "bare"`; `signedIn` says whether the
 * confirmation also left the browser signed in (it usually does — the link both confirms
 * the address and starts a session), which is the difference between sending someone to
 * the app and sending them back to the sign-in card.
 */
export function describeOutcome(params, { hasSession = false } = {}) {
  if (params.error) {
    const expired = /expired|invalid/i.test(`${params.error} ${params.errorDescription || ""}`);
    return {
      status: expired ? "expired" : "error",
      signedIn: false,
      title: expired ? "This link has expired." : "That link didn't work.",
      message: expired
        ? "Confirmation links are single-use and time-limited. Sign up again from Trase to get a fresh one."
        : cleanDescription(params.errorDescription) ||
          "Supabase turned down that confirmation link. Try signing in — if that fails, sign up again to get a new link.",
    };
  }
  if (hasSession) {
    return {
      status: "confirmed",
      signedIn: true,
      title: "Your email is confirmed.",
      message: "You're signed in. Taking you back to Trase…",
    };
  }
  if (isBareVisit(params)) {
    return {
      status: "bare",
      signedIn: false,
      title: "Nothing to confirm.",
      message: "Open this page from the link in your confirmation email, or head back and sign in.",
    };
  }
  // A link was clicked and no error came back, but no session exists — the usual cause is
  // a project set to confirm the address without starting a session. The address is
  // confirmed; signing in is the next step, and saying so beats showing a failure.
  return {
    status: "confirmed",
    signedIn: false,
    title: "Your email is confirmed.",
    message: "Head back to Trase and sign in with your email and password.",
  };
}

/** Supabase sends these URL-encoded with `+` for spaces; a raw one reads like a stack
 *  trace in the middle of a sentence. */
function cleanDescription(value) {
  if (!value) return "";
  const text = value.replace(/\+/g, " ").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
