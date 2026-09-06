// Accounts + cloud chat history, backed by Supabase (see /api/config's `supabase` field,
// lib/supabase-config.js, and supabase/migrations/ for the schema and the row-level
// security this relies on for isolating one account's chats from another's).
//
// Optional end to end. With `SUPABASE_URL`/`SUPABASE_ANON_KEY` unset server-side,
// `configure` below is never called with a real config, `client` stays null, and every
// export here becomes a no-op or an empty result — the library behaves exactly as it did
// before this file existed: local-only, in this browser's localStorage.

import { emailRedirectUrl, readCallbackParams } from "./auth-callback.js";

let client = null;
let user = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(user);
}

/** Call once, after `/api/config` resolves — pass its `supabase` field verbatim. */
export async function configure(supabaseConfig) {
  if (!supabaseConfig?.url || !supabaseConfig?.anonKey) return;
  // esm.sh, not a local dependency — web/ ships with no bundler and no node_modules (see
  // web/package.json's description), and this is the one client-side import that reaches
  // outside the repo. It's the trade the account feature makes for that: everything else
  // here is stdlib-only, same as the rest of web/.
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  client = createClient(supabaseConfig.url, supabaseConfig.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const { data } = await client.auth.getSession();
  user = data?.session?.user ?? null;
  // Fires for every kind of session change — sign-in, sign-out, and a silent token
  // refresh — so `notify()` on it is what keeps `getUser()` and the header UI correct
  // without this module polling anything.
  client.auth.onAuthStateChange((_event, session) => {
    user = session?.user ?? null;
    notify();
  });
  notify();
}

/** Whether this deploy has accounts turned on at all (see `configure` above). */
export function isConfigured() {
  return client !== null;
}

export function getUser() {
  return user;
}

/** @returns unsubscribe function */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function requireClient() {
  if (!client) throw new Error("Accounts aren't set up on this deploy.");
  return client;
}

/**
 * Throws only on a real Supabase error. `{ confirmed: false }` is the expected outcome
 * when this project requires email confirmation before a session starts — the caller's
 * job, not an error to report as one.
 */
export async function signUp(email, password) {
  // Without `emailRedirectTo`, the confirmation email points at the Supabase project's
  // Site URL — which is whatever it was set to when the project was created, i.e.
  // http://localhost:3000 on every project nobody has changed it on. Sending the origin
  // the person is actually signing up on fixes that per environment, and the page it
  // names (public/auth/confirm.html) is a real screen rather than the app's 404.
  const emailRedirectTo = emailRedirectUrl(globalThis.location?.origin ?? "");
  const { data, error } = await requireClient().auth.signUp({
    email,
    password,
    // Omitted rather than sent as null when the origin isn't http(s): Supabase then falls
    // back to the project's Site URL, which is the old behaviour, not a new failure.
    ...(emailRedirectTo ? { options: { emailRedirectTo } } : {}),
  });
  if (error) throw error;
  return { confirmed: Boolean(data.session) };
}

/**
 * Finishes the confirmation link's job on public/auth/confirm.html, and returns whether
 * the browser ends up with a session.
 *
 * Most of the work is supabase-js's: `configure` above creates the client with
 * `detectSessionInUrl` at its default, so an implicit-flow `#access_token=…` and a PKCE
 * `?code=…` are both consumed during `createClient` and are already a session by the time
 * this runs. What's left is the one form it does not consume on its own — a `token_hash`
 * + `type` pair, which is what a project using the "confirm signup" email template's
 * `{{ .TokenHash }}` sends — so that is verified here explicitly.
 *
 * Never throws: the page's job is to say what happened, and a thrown error there is a
 * blank screen. A failed verify just means no session, which `describeOutcome` reads the
 * same way as any other unconfirmed arrival.
 */
export async function completeEmailConfirmation(href) {
  if (!client) return false;
  const params = readCallbackParams(href);
  if (params.tokenHash && params.type) {
    try {
      const { error } = await client.auth.verifyOtp({
        token_hash: params.tokenHash,
        type: params.type,
      });
      if (error) console.warn("Confirmation failed:", error.message);
    } catch (error) {
      console.warn("Confirmation failed:", error?.message || error);
    }
  }
  const { data } = await client.auth.getSession();
  user = data?.session?.user ?? null;
  notify();
  return Boolean(data?.session);
}

export async function signIn(email, password) {
  const { error } = await requireClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut() {
  if (!client) return;
  await client.auth.signOut();
}

/**
 * Every conversation the signed-in user has, newest first, as client library entries —
 * the shape `data` was upserted with in `pushLibrary` below, which is app.js's own
 * localStorage entry shape. The row's own `id`/`title`/`url`/… columns exist for the
 * database (search, foreign keys, RLS) and are not re-read here; `data` is what a
 * library entry actually needs.
 */
export async function pullLibrary() {
  if (!client || !user) return [];
  const { data, error } = await client
    .from("conversations")
    .select("id, data")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({ ...row.data, id: row.data?.id ?? row.id }));
}

/**
 * Upserts the whole library in one round trip. Fire-and-forget by design — a failed push
 * just means this device's *next* save (any of the call sites around `persistLibrary` in
 * app.js) tries again with the current state, the same tolerance `persistLibrary` already
 * has for a full localStorage. Never throws; logs and returns instead.
 */
export async function pushLibrary(library) {
  if (!client || !user || library.length === 0) return;
  const rows = library.map((entry) => ({
    id: entry.id,
    user_id: user.id,
    title: entry.title || entry.url || "",
    url: entry.url ?? null,
    platform: entry.platform ?? null,
    status: entry.status ?? "done",
    data: entry,
  }));
  const { error } = await client.from("conversations").upsert(rows);
  if (error) console.warn("Cloud sync failed:", error.message);
}

/**
 * Removes one conversation from this account's cloud history.
 *
 * `pushLibrary`'s upsert is not enough on its own: dropping a row out of the array it's
 * given only stops that row from being *re-upserted* going forward, it never deletes what
 * is already there. Row-level security scopes the delete to rows this user owns, same as
 * every other query here, but the `user_id` match below is not just defense in depth — it
 * is what keeps a delete fired the instant after a sign-out (`user` already null) from
 * silently doing nothing instead of throwing.
 *
 * Fire-and-forget like `pushLibrary`: the local delete (`deleteEntry` in app.js) already
 * happened by the time this is called, and a failed cloud delete just means the row comes
 * back on this account's next `pullLibrary` — annoying, not data loss, since the entry's
 * own content is unchanged either way.
 */
export async function deleteConversation(id) {
  if (!client || !user) return;
  const { error } = await client.from("conversations").delete().eq("id", id).eq("user_id", user.id);
  if (error) console.warn("Cloud delete failed:", error.message);
}
