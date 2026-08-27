// What /api/config tells the browser about the account backend — a URL and a publishable
// key, never a secret. Split out of api/config.js so it has its own test seam, the same
// reason describeSearchConfig-style helpers elsewhere in api/ are one function each.

/**
 * `{ url, anonKey }`, or `null` when either half is unset — accounts are an optional
 * feature of this deploy, not a requirement, and the client's job is to fall back to
 * local-only history (what it already does today) rather than error.
 */
export function supabaseConfigFromEnv(env = process.env) {
  const url = (env.SUPABASE_URL || "").trim();
  const anonKey = (env.SUPABASE_ANON_KEY || "").trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
