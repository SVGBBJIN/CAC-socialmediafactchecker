// Web search — the only source of external fact in this app.
//
// Four keyed providers and one keyless fallback, all normalised to the same result shape.
// Which one runs is decided by which key is present, so deploying with a Brave key is the
// whole of the configuration; nothing in the calling code changes.
//
// One rule holds across every provider and is enforced here rather than trusted: **a
// result without a resolvable absolute URL is discarded.** The citation layer downstream
// can only be as honest as its inputs — a "source" the reader cannot open is not a source,
// and letting one through would put an uncheckable citation in a fact-check.

import { SEARCH_QUERY_SCHEMA, validateSearchQuery } from "./search-schema.js";

/** Longest one search may take before we give up on it. */
export const SEARCH_TIMEOUT_MS = 15_000;

/** Snippets are display text, not the payload — long ones are mostly boilerplate. */
const MAX_SNIPPET_CHARS = 400;
const MAX_TITLE_CHARS = 200;

export class SearchError extends Error {
  constructor(message, { retryable = false, provider } = {}) {
    super(message);
    this.name = "SearchError";
    this.retryable = retryable;
    this.provider = provider;
  }
}

/**
 * Which provider to use, from the environment.
 *
 * Order is by result quality, not preference: a keyed API returns structured results with
 * publication dates and a stable contract. The keyless DuckDuckGo path is a scrape of a
 * page never promised to stay the same, and is here so the app is *useful* with no setup —
 * not because it is equivalent. `SEARCH_PROVIDER` overrides the order when more than one
 * key is present.
 */
export function providerFromEnv(env = process.env) {
  const forced = (env.SEARCH_PROVIDER || "").trim().toLowerCase();
  const candidates = [
    { name: "brave", key: env.BRAVE_SEARCH_API_KEY },
    { name: "tavily", key: env.TAVILY_API_KEY },
    { name: "serper", key: env.SERPER_API_KEY },
    { name: "google", key: env.GOOGLE_CSE_KEY, extra: env.GOOGLE_CSE_CX },
    { name: "duckduckgo", key: "keyless" },
  ];

  if (forced) {
    const chosen = candidates.find((c) => c.name === forced);
    if (!chosen) {
      throw new SearchError(
        `SEARCH_PROVIDER is set to "${forced}", which is not one of: ${candidates
          .map((c) => c.name)
          .join(", ")}.`,
      );
    }
    if (!chosen.key || (chosen.name === "google" && !chosen.extra)) {
      throw new SearchError(
        `SEARCH_PROVIDER is set to "${forced}" but its API key is not configured. See web/.env.example.`,
      );
    }
    return { name: chosen.name, apiKey: chosen.key, cx: chosen.extra };
  }

  const chosen = candidates.find((c) => c.key && (c.name !== "google" || c.extra));
  return { name: chosen.name, apiKey: chosen.key, cx: chosen.extra };
}

/** Freshness in each provider's own dialect. `any` means "don't send the parameter". */
function freshnessFor(provider, freshness) {
  if (!freshness || freshness === "any") return null;
  const days = { day: 1, week: 7, month: 31, year: 365 }[freshness];
  switch (provider) {
    case "brave":
      return { day: "pd", week: "pw", month: "pm", year: "py" }[freshness];
    case "google":
      return `d${days}`; // dateRestrict: d1 / d7 / d31 / d365
    case "tavily":
      return days;
    case "serper":
      return { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[freshness];
    case "duckduckgo":
      return { day: "d", week: "w", month: "m", year: "y" }[freshness];
    default:
      return null;
  }
}

/** `site:` is expressed the same way by every engine here, so it rides in the query text. */
function queryText({ query, site }) {
  return site ? `${query} site:${site}` : query;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Drop anything unusable, collapse duplicates, cap the list, and number what survives. */
function normaliseResults(raw, limit) {
  const seen = new Set();
  const results = [];

  for (const item of raw) {
    const url = String(item?.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) continue; // Not openable — not a citation.
    const domain = hostOf(url);
    if (!domain) continue;

    // Same page reached twice (a provider listing both the AMP and canonical URL, say)
    // is one source, not two: numbering it twice would let one page look like agreement
    // between sources.
    const fingerprint = url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const title = clean(item.title) || domain;
    results.push({
      title: title.slice(0, MAX_TITLE_CHARS),
      url,
      domain,
      snippet: clean(item.snippet).slice(0, MAX_SNIPPET_CHARS),
      published: clean(item.published) || null,
    });

    if (results.length >= limit) break;
  }

  return results;
}

function clean(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity in named) return named[entity];
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

async function requestJSON(url, options, { provider, fetchImpl, signal }) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SearchError(`Could not reach the ${provider} search API: ${error.message}`, {
      retryable: true,
      provider,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // 401/403 is a configuration problem the operator has to fix; everything else may
    // just be a bad minute. Told apart so the model doesn't retry a dead key four times.
    const configProblem = response.status === 401 || response.status === 403;
    throw new SearchError(
      configProblem
        ? `The ${provider} search API rejected the key (HTTP ${response.status}). Check the key in web/.env.local.`
        : `The ${provider} search API returned HTTP ${response.status}. ${body.slice(0, 200)}`.trim(),
      { retryable: !configProblem, provider },
    );
  }

  return response.json();
}

const PROVIDERS = {
  async brave(query, { apiKey, fetchImpl, signal, limit }) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", queryText(query));
    url.searchParams.set("count", String(Math.min(limit * 2, 20)));
    const freshness = freshnessFor("brave", query.freshness);
    if (freshness) url.searchParams.set("freshness", freshness);

    const body = await requestJSON(
      url,
      { headers: { accept: "application/json", "x-subscription-token": apiKey } },
      { provider: "brave", fetchImpl, signal },
    );

    return (body?.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      published: r.page_age || r.age,
    }));
  },

  async google(query, { apiKey, cx, fetchImpl, signal, limit }) {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("cx", cx);
    url.searchParams.set("q", queryText(query));
    url.searchParams.set("num", String(Math.min(limit, 10)));
    const freshness = freshnessFor("google", query.freshness);
    if (freshness) url.searchParams.set("dateRestrict", freshness);

    const body = await requestJSON(url, {}, { provider: "google", fetchImpl, signal });

    return (body?.items ?? []).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
      published: r.pagemap?.metatags?.[0]?.["article:published_time"] ?? null,
    }));
  },

  async tavily(query, { apiKey, fetchImpl, signal, limit }) {
    const payload = {
      query: queryText(query),
      max_results: Math.min(limit * 2, 20),
      search_depth: "basic",
    };
    const days = freshnessFor("tavily", query.freshness);
    if (days) payload.days = days;

    const body = await requestJSON(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      },
      { provider: "tavily", fetchImpl, signal },
    );

    return (body?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      published: r.published_date ?? null,
    }));
  },

  async serper(query, { apiKey, fetchImpl, signal, limit }) {
    const payload = { q: queryText(query), num: Math.min(limit * 2, 20) };
    const tbs = freshnessFor("serper", query.freshness);
    if (tbs) payload.tbs = tbs;

    const body = await requestJSON(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(payload),
      },
      { provider: "serper", fetchImpl, signal },
    );

    return (body?.organic ?? []).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
      published: r.date ?? null,
    }));
  },

  /**
   * DuckDuckGo's HTML-only endpoint. No key, no quota, no contract.
   *
   * A GET to `lite.duckduckgo.com/lite/`, and each of those three words was arrived at
   * the hard way — measured against the live endpoint on 2026-07-28:
   *
   * - `html.duckduckgo.com/html/` answers **HTTP 202 with its own homepage**, not results.
   * - So does the *lite* endpoint when the query is POSTed as a form, which is how its own
   *   search box submits. A 202 carrying a valid-looking page is the failure mode to watch
   *   for here: nothing about it says "blocked" except that no result markup is in it.
   * - The same query as a GET returns real results.
   *
   * Parsed with regexes deliberately, since the alternative is an HTML parser dependency
   * for a page whose markup we do not control either way. If the markup moves this returns
   * nothing and says so, rather than returning nonsense.
   */
  async duckduckgo(query, { fetchImpl, signal, limit }) {
    const params = new URLSearchParams({ q: queryText(query) });
    const df = freshnessFor("duckduckgo", query.freshness);
    if (df) params.set("df", df);

    let response;
    try {
      response = await fetchImpl(`https://lite.duckduckgo.com/lite/?${params}`, {
        headers: {
          // Served a challenge page without a browser-shaped UA.
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SearchError(`Could not reach DuckDuckGo: ${error.message}`, {
        retryable: true,
        provider: "duckduckgo",
      });
    }

    if (!response.ok) {
      throw new SearchError(`DuckDuckGo returned HTTP ${response.status}.`, {
        retryable: response.status >= 500 || response.status === 429,
        provider: "duckduckgo",
      });
    }

    const html = await response.text();
    const results = [];
    const linkPattern = /<a[^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
    const hrefPattern = /href=['"]([^'"]+)['"]/i;

    // Snippets sit in their own row after each link, so they're collected separately and
    // zipped by position — the alternative is one regex spanning the whole result block,
    // which breaks the moment a result omits its snippet row.
    const snippets = [
      ...html.matchAll(/<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi),
    ].map((m) => decodeEntities(clean(m[1])));

    let index = 0;
    for (const match of html.matchAll(linkPattern)) {
      const href = match[0].match(hrefPattern)?.[1];
      results.push({
        title: decodeEntities(clean(match[1])),
        url: unwrapDuckDuckGoURL(href),
        snippet: snippets[index] ?? "",
      });
      index += 1;
      if (results.length >= limit * 2) break;
    }

    if (results.length === 0) {
      throw new SearchError(
        "DuckDuckGo returned no parseable results. It may be rate-limiting this server — " +
          "configure a search API key (see web/.env.example) for a reliable source of citations.",
        { retryable: true, provider: "duckduckgo" },
      );
    }

    return results;
  },
};

/** DDG sometimes hands back `//duckduckgo.com/l/?uddg=<encoded target>`. Unwrap it. */
export function unwrapDuckDuckGoURL(href) {
  if (!href) return "";
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  try {
    const url = new URL(absolute);
    if (/(^|\.)duckduckgo\.com$/.test(url.hostname) && url.searchParams.has("uddg")) {
      return url.searchParams.get("uddg") ?? "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Run one search.
 *
 * The argument is the *unvalidated* query object — validation happens here so that every
 * caller (the model's tool call, the CLI, a test) is held to the same schema.
 *
 * @returns `{query, claim, provider, retrievedAt, results}`. `results` may be empty: a
 *   search that finds nothing is a real answer, and the caller must be able to tell it
 *   apart from a search that failed, which throws.
 */
export async function search(
  rawQuery,
  { env = process.env, fetchImpl = fetch, signal, timeoutMs = SEARCH_TIMEOUT_MS, provider } = {},
) {
  const query = validateSearchQuery(rawQuery);
  const chosen = provider ?? providerFromEnv(env);
  const run = PROVIDERS[chosen.name];
  if (!run) throw new SearchError(`No such search provider: ${chosen.name}.`);

  const limit = query.max_results ?? SEARCH_QUERY_SCHEMA.properties.max_results.default;

  // The caller's signal and our own deadline as one signal. Without the timeout a hung
  // connection holds the whole chat request open behind it.
  const timer = new AbortController();
  const onAbort = () => timer.abort();
  if (signal?.aborted) timer.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => timer.abort(), timeoutMs);

  try {
    const raw = await run(query, {
      apiKey: chosen.apiKey,
      cx: chosen.cx,
      fetchImpl,
      signal: timer.signal,
      limit,
    });
    return {
      query: query.query,
      claim: query.claim,
      site: query.site ?? null,
      freshness: query.freshness ?? "any",
      provider: chosen.name,
      retrievedAt: new Date().toISOString(),
      results: normaliseResults(raw, limit),
    };
  } catch (error) {
    if (timer.signal.aborted && !signal?.aborted) {
      throw new SearchError(
        `The ${chosen.name} search did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        { retryable: true, provider: chosen.name },
      );
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
  }
}
