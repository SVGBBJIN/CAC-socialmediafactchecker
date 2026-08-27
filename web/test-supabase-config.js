// node --test test-supabase-config.js
//
// Covers what /api/config is allowed to say about the account backend: a URL and a
// publishable key when both are set, and nothing (not a half-filled object) otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";

import { supabaseConfigFromEnv } from "./lib/supabase-config.js";

test("returns null with neither var set", () => {
  assert.equal(supabaseConfigFromEnv({}), null);
});

test("returns null with only the URL set", () => {
  assert.equal(supabaseConfigFromEnv({ SUPABASE_URL: "https://x.supabase.co" }), null);
});

test("returns null with only the key set", () => {
  assert.equal(supabaseConfigFromEnv({ SUPABASE_ANON_KEY: "abc" }), null);
});

test("returns null when either var is blank", () => {
  assert.equal(
    supabaseConfigFromEnv({ SUPABASE_URL: "  ", SUPABASE_ANON_KEY: "abc" }),
    null,
  );
});

test("returns the trimmed pair when both are set", () => {
  assert.deepEqual(
    supabaseConfigFromEnv({
      SUPABASE_URL: " https://x.supabase.co ",
      SUPABASE_ANON_KEY: " abc.def.ghi ",
    }),
    { url: "https://x.supabase.co", anonKey: "abc.def.ghi" },
  );
});
