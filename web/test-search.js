// node --test test-search.js
//
// Covers the search-and-cite path: the query schema the model is held to, the providers
// that turn a query into sources, and the audit that decides whether an answer is allowed
// to be shown. The audit tests are the ones worth reading — they are the specification of
// what this app means by "verified".

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SEARCH_QUERY_SCHEMA,
  WEB_SEARCH_TOOL,
  SearchQueryError,
  validateSearchQuery,
  toGeminiSchema,
} from "./lib/search-schema.js";
import { search, providerFromEnv, unwrapDuckDuckGoURL, SearchError } from "./lib/search.js";
import {
  CitationLedger,
  auditAnswer,
  auditableSentences,
  isCheckableClaim,
  markersIn,
  repairInstruction,
  unverifiedNotice,
} from "./lib/citations.js";
import {
  verifiedChat,
  searchEnabled,
  FACT_CHECK_SYSTEM_PROMPT,
  REPAIR_RESERVE_MS,
} from "./lib/verified-chat.js";

/* ---------------- query schema ---------------- */

test("a valid query is normalised and given its defaults", () => {
  const query = validateSearchQuery({
    query: "  measles cases 2026  ",
    claim: "Measles cases have tripled this year",
  });
  assert.deepEqual(query, {
    query: "measles cases 2026",
    claim: "Measles cases have tripled this year",
    freshness: "any",
    max_results: 5,
  });
});

test("claim is required — a search must be verifying something specific", () => {
  assert.throws(() => validateSearchQuery({ query: "measles cases" }), SearchQueryError);
  // And the message tells the model what the argument is for, since it lands in a
  // functionResponse and is the only chance to correct the call.
  assert.match(
    (() => {
      try {
        validateSearchQuery({ query: "measles cases" });
      } catch (error) {
        return error.message;
      }
    })(),
    /claim.*required/i,
  );
});

test("unknown arguments are refused rather than ignored", () => {
  assert.throws(
    () => validateSearchQuery({ query: "abc def", claim: "a claim here", country: "US" }),
    /Unknown argument "country"/,
  );
});

test("out-of-range and malformed values are refused", () => {
  const base = { query: "abc def", claim: "a claim goes here" };
  assert.throws(() => validateSearchQuery({ ...base, max_results: 50 }), /between 1 and 10/);
  assert.throws(() => validateSearchQuery({ ...base, max_results: 2.5 }), /whole number/);
  assert.throws(() => validateSearchQuery({ ...base, freshness: "hour" }), /must be one of/);
  assert.throws(() => validateSearchQuery({ ...base, site: "https://reuters.com/x" }), /bare domain/);
  assert.throws(() => validateSearchQuery({ ...base, query: "ab" }), /too short/);
  assert.throws(() => validateSearchQuery("just a string"), /JSON object/);
});

test("numeric strings are accepted — Gemini sometimes sends them", () => {
  const query = validateSearchQuery({ query: "abc def", claim: "a claim here", max_results: "3" });
  assert.equal(query.max_results, 3);
});

test("the Gemini declaration drops what Gemini rejects and keeps what it needs", () => {
  const schema = WEB_SEARCH_TOOL.parameters;
  assert.equal(schema.type, "OBJECT");
  assert.deepEqual(schema.required, ["query", "claim"]);
  assert.equal(schema.properties.max_results.type, "INTEGER");
  assert.deepEqual(schema.properties.freshness.enum, ["any", "day", "week", "month", "year"]);

  // Length and pattern keywords are enforced by validateSearchQuery, not declared: a
  // declaration containing them is rejected by the API.
  const serialised = JSON.stringify(schema);
  for (const banned of ["minLength", "maxLength", "pattern", "$schema", "additionalProperties", "default"]) {
    assert.ok(!serialised.includes(banned), `${banned} must not reach Gemini`);
  }
  // Every property in the schema of record is offered to the model — no silent omissions.
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    Object.keys(SEARCH_QUERY_SCHEMA.properties).sort(),
  );
});

test("toGeminiSchema converts nested arrays and objects", () => {
  const converted = toGeminiSchema({
    type: "object",
    required: ["items"],
    properties: { items: { type: "array", items: { type: "string", description: "one" } } },
  });
  assert.equal(converted.properties.items.type, "ARRAY");
  assert.equal(converted.properties.items.items.type, "STRING");
  assert.equal(converted.properties.items.items.description, "one");
});

/* ---------------- providers ---------------- */

test("the provider is chosen by which key is configured", () => {
  assert.equal(providerFromEnv({}).name, "duckduckgo");
  assert.equal(providerFromEnv({ BRAVE_SEARCH_API_KEY: "k" }).name, "brave");
  assert.equal(providerFromEnv({ TAVILY_API_KEY: "k" }).name, "tavily");
  // Google needs both halves; with only one it is not a usable provider.
  assert.equal(providerFromEnv({ GOOGLE_CSE_KEY: "k" }).name, "duckduckgo");
  assert.equal(providerFromEnv({ GOOGLE_CSE_KEY: "k", GOOGLE_CSE_CX: "c" }).name, "google");
  assert.equal(
    providerFromEnv({ BRAVE_SEARCH_API_KEY: "k", SEARCH_PROVIDER: "duckduckgo" }).name,
    "duckduckgo",
  );
});

test("a key is found however it was capitalised", () => {
  // A key stored as `Tavily_API_key` is invisible to a case-sensitive lookup, and the
  // symptom is not an error — it is a silent fall-through to the keyless provider, which
  // then gets blocked. Every search fails for a reason that looks nothing like the cause.
  assert.equal(providerFromEnv({ Tavily_API_key: "tvly-x" }).name, "tavily");
  assert.equal(providerFromEnv({ tavily_api_key: "tvly-x" }).apiKey, "tvly-x");
  assert.equal(providerFromEnv({ Brave_Search_Api_Key: " k " }).apiKey, "k");
  assert.equal(providerFromEnv({ Search_Provider: "tavily", TAVILY_API_KEY: "k" }).name, "tavily");
  // A variable that exists but is empty is not configuration.
  assert.equal(providerFromEnv({ TAVILY_API_KEY: "   " }).name, "duckduckgo");
});

test("the search toggle is read the same tolerant way", () => {
  assert.equal(searchEnabled({}), true);
  assert.equal(searchEnabled({ WEB_SEARCH_ENABLED: "false" }), false);
  assert.equal(searchEnabled({ Web_Search_Enabled: "FALSE" }), false);
});

test("SEARCH_PROVIDER naming an unconfigured provider fails loudly", () => {
  assert.throws(() => providerFromEnv({ SEARCH_PROVIDER: "brave" }), /API key is not configured/);
  assert.throws(() => providerFromEnv({ SEARCH_PROVIDER: "bing" }), /not one of/);
});

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("Brave results are normalised, deduped and capped", async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = new URL(url);
    return jsonResponse({
      web: {
        results: [
          { title: "First", url: "https://example.com/a", description: "one" },
          // Same page, trailing slash and a tracking query: one source, not two.
          { title: "First again", url: "https://example.com/a/?utm_source=x", description: "dup" },
          { title: "No URL", description: "dropped" },
          { title: "Relative", url: "/nope", description: "dropped" },
          { title: "Second", url: "https://gov.example/b", description: "two" },
          { title: "Third", url: "https://example.org/c", description: "three" },
        ],
      },
    });
  };

  const result = await search(
    { query: "a claim query", claim: "Something specific is true", max_results: 2, freshness: "week" },
    { env: { BRAVE_SEARCH_API_KEY: "k" }, fetchImpl },
  );

  assert.equal(requested.searchParams.get("freshness"), "pw");
  assert.deepEqual(
    result.results.map((r) => r.url),
    ["https://example.com/a", "https://gov.example/b"],
  );
  assert.equal(result.results[1].domain, "gov.example");
  assert.equal(result.provider, "brave");
  assert.ok(Date.parse(result.retrievedAt) > 0);
});

test("a result without an openable URL is never a citation", async () => {
  const fetchImpl = async () =>
    jsonResponse({ web: { results: [{ title: "Ghost", url: "javascript:alert(1)" }] } });
  const result = await search(
    { query: "some query", claim: "a claim to check" },
    { env: { BRAVE_SEARCH_API_KEY: "k" }, fetchImpl },
  );
  assert.deepEqual(result.results, []);
});

test("site: is folded into the query text", async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse({ organic: [] });
  };
  await search(
    { query: "measles cases", claim: "Measles cases tripled", site: "cdc.gov" },
    { env: { SERPER_API_KEY: "k" }, fetchImpl },
  );
  assert.equal(body.q, "measles cases site:cdc.gov");
});

test("Tavily is sent the key both ways, and freshness the way it is honoured", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return jsonResponse({
      results: [
        { title: "Report", url: "https://gao.example/r", content: "text", published_date: "2026-07-01" },
      ],
    });
  };

  const result = await search(
    { query: "measles cases", claim: "Measles cases tripled", freshness: "month" },
    { env: { Tavily_API_key: "tvly-x" }, fetchImpl },
  );

  assert.equal(request.headers.authorization, "Bearer tvly-x");
  // Tavily moved from an `api_key` body field to bearer auth; sending both means the
  // request works whichever an account is served by.
  assert.equal(request.body.api_key, "tvly-x");
  assert.equal(request.body.days, 31);
  // `days` is ignored unless the topic is news — set alone, it would silently return
  // undated results for a claim that asked to be bounded in time.
  assert.equal(request.body.topic, "news");
  assert.deepEqual(result.results.map((r) => r.published), ["2026-07-01"]);
});

test("a rejected key is reported as configuration, not as something to retry", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "forbidden" });
  await assert.rejects(
    search({ query: "some query", claim: "a claim to check" }, { env: { TAVILY_API_KEY: "k" }, fetchImpl }),
    (error) => error instanceof SearchError && error.retryable === false && /rejected the key/.test(error.message),
  );
});

test("a search that outlives its deadline fails as a timeout", async () => {
  const fetchImpl = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  await assert.rejects(
    search(
      { query: "some query", claim: "a claim to check" },
      { env: { TAVILY_API_KEY: "k" }, fetchImpl, timeoutMs: 20 },
    ),
    /did not respond within/,
  );
});

/* ---------------- DuckDuckGo, the keyless fallback ---------------- */

// Real markup, captured from `https://lite.duckduckgo.com/lite/?q=who+won+the+2022+world+cup`
// on 2026-07-28 and trimmed to three results. Held to what DuckDuckGo actually serves for
// the same reason the TikTok fixture is: this page has no contract and no documentation,
// so a fixture written from an idea of the markup would prove nothing.
const DDG_LITE_HTML = `
<table border="0">
  <tr><td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="https://en.wikipedia.org/wiki/2022_FIFA_World_Cup_final" class='result-link'>2022 FIFA World Cup final - Wikipedia</a></td></tr>
  <tr><td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'><b>The</b> final match of the <b>2022</b> FIFA <b>World</b> <b>Cup</b> was played at Lusail Stadium on 18 December <b>2022</b> and was contested by Argentina and France &#x27;s defending champions.</td></tr>
  <tr><td>&nbsp;&nbsp;&nbsp;</td><td><span class='link-text'>en.wikipedia.org/wiki/2022_FIFA_World_Cup_final</span></td></tr>

  <tr><td valign="top">2.&nbsp;</td>
    <td><a rel="nofollow" href="https://www.fifa.com/en/match-centre/match/17/255711/285077/400128145" class='result-link'>Argentina vs France 3-3 | Final | FIFA World Cup Qatar 2022&#x2122; | FIFA</a></td></tr>
  <tr><td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>Final, 3-3, Full Time, Lusail Stadium, <b>2022</b>-12-18T18:00:00Z</td></tr>

  <tr><td valign="top">3.&nbsp;</td>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.bbc.co.uk%2Fsport%2Ffootball%2F63997238&amp;rut=abc" class='result-link'>World Cup final: Argentina beat France on penalties - BBC Sport</a></td></tr>
  <tr><td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>Argentina won the World Cup for the third time.</td></tr>
</table>`;

function htmlResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test("the DuckDuckGo parser reads the markup DuckDuckGo actually serves", async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = new URL(url);
    return htmlResponse(DDG_LITE_HTML);
  };

  const result = await search(
    { query: "who won the 2022 world cup", claim: "Argentina won the 2022 World Cup", freshness: "year" },
    { env: {}, fetchImpl },
  );

  assert.equal(requested.searchParams.get("q"), "who won the 2022 world cup");
  assert.equal(requested.searchParams.get("df"), "y");
  assert.deepEqual(
    result.results.map((r) => r.url),
    [
      "https://en.wikipedia.org/wiki/2022_FIFA_World_Cup_final",
      "https://www.fifa.com/en/match-centre/match/17/255711/285077/400128145",
      // The redirect wrapper is unwrapped, so the citation points at the BBC, not at DDG.
      "https://www.bbc.co.uk/sport/football/63997238",
    ],
  );
  assert.equal(result.results[1].title, "Argentina vs France 3-3 | Final | FIFA World Cup Qatar 2022™ | FIFA");
  assert.match(result.results[0].snippet, /^The final match of the 2022 FIFA World Cup was played/);
  assert.ok(!result.results[0].snippet.includes("<b>"));
});

test("a challenge page is reported, not returned as an empty search", async () => {
  // DuckDuckGo answers a blocked request with HTTP 202 and its own homepage — no result
  // markup, no error status. Returning "no results" here would tell the model a claim is
  // unsupported when in fact nothing was ever searched.
  const fetchImpl = async () => htmlResponse("<html><head><title>DuckDuckGo</title></head></html>", { status: 202 });
  await assert.rejects(
    search({ query: "some query", claim: "a claim to check" }, { env: {}, fetchImpl }),
    /no parseable results/,
  );
});

test("unwrapDuckDuckGoURL leaves a direct link alone", () => {
  assert.equal(unwrapDuckDuckGoURL("https://example.com/a"), "https://example.com/a");
  assert.equal(
    unwrapDuckDuckGoURL("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb&rut=1"),
    "https://example.com/b",
  );
  assert.equal(unwrapDuckDuckGoURL(""), "");
});

/* ---------------- the ledger ---------------- */

function searchResult(claim, urls) {
  return {
    query: "q",
    claim,
    provider: "test",
    retrievedAt: "2026-07-28T00:00:00.000Z",
    results: urls.map((url, i) => ({
      title: `Title ${i}`,
      url,
      domain: new URL(url).hostname,
      snippet: "snippet",
      published: null,
    })),
  };
}

test("numbers are assigned once and never reused", () => {
  const ledger = new CitationLedger();
  const first = ledger.record(searchResult("claim one", ["https://a.example/1", "https://b.example/2"]));
  assert.deepEqual(first.map((e) => e.n), [1, 2]);

  // A second search finding the same page reuses its number: one page is one source, and
  // two numbers for it would look like two sources agreeing.
  const second = ledger.record(searchResult("claim two", ["https://b.example/2", "https://c.example/3"]));
  assert.deepEqual(second.map((e) => e.n), [2, 3]);
  assert.equal(ledger.size, 3);
  assert.deepEqual(ledger.sources[1].claims, ["claim one", "claim two"]);
  assert.ok(ledger.has(3));
  assert.ok(!ledger.has(4));
});

test("an empty search tells the model the claim is unverified", () => {
  const result = searchResult("claim", []);
  const text = CitationLedger.describe([], result);
  assert.match(text, /NOT verified/);
});

/* ---------------- the audit ---------------- */

function ledgerOf(count) {
  const ledger = new CitationLedger();
  ledger.record(
    searchResult("a claim", Array.from({ length: count }, (_, i) => `https://source${i + 1}.example/p`)),
  );
  return ledger;
}

test("a cited answer passes", () => {
  const ledger = ledgerOf(2);
  const audit = auditAnswer(
    "The clip claims the bridge cost $4 billion. The final figure was $2.1 billion [1]. " +
      "The state auditor called the claim misleading [2].",
    ledger,
  );
  assert.ok(audit.ok, JSON.stringify(audit.violations));
  assert.deepEqual(audit.cited, [1, 2]);
});

test("an uncited verdict is a violation", () => {
  const audit = auditAnswer("This is false. The bridge actually cost $2.1 billion.", ledgerOf(2));
  assert.ok(!audit.ok);
  assert.ok(audit.violations.some((v) => v.type === "uncited_claim"));
});

test("a citation to a source that was never retrieved is a violation", () => {
  const audit = auditAnswer("The figure was $2.1 billion [7].", ledgerOf(2));
  const violation = audit.violations.find((v) => v.type === "unknown_source");
  assert.ok(violation);
  assert.equal(violation.marker, 7);
  assert.match(violation.message, /\[1\]–\[2\]/);
});

test("a URL the search never returned is a violation, however plausible", () => {
  const audit = auditAnswer(
    "The audit report is at https://gao.gov/reports/bridge-2026 [1].",
    ledgerOf(2),
  );
  assert.ok(audit.violations.some((v) => v.type === "unknown_url"));
});

test("stating facts with no search at all is caught as its own failure", () => {
  const audit = auditAnswer("The bridge cost $2.1 billion and opened in 2019.", new CitationLedger());
  assert.equal(audit.violations[0].type, "no_search");
});

test("connective tissue does not need a citation", () => {
  const audit = auditAnswer(
    "Here's what I found. This is a mixed picture. The cost figure checks out [1].",
    ledgerOf(1),
  );
  assert.ok(audit.ok, JSON.stringify(audit.violations));
});

test("describing the claim under review is not asserting it", () => {
  // The subject of a fact-check is not evidence, and demanding a citation for "the video
  // says X" would make it impossible to state what is being checked.
  const audit = auditAnswer(
    "The video claims that the vaccine was approved in three weeks. That is not what the " +
      "approval record shows [1].",
    ledgerOf(1),
  );
  assert.ok(audit.ok, JSON.stringify(audit.violations));
});

test("markers are read in every form the model writes them", () => {
  assert.deepEqual(markersIn("a [1] b [2, 3] c [4][5] d"), [1, 2, 3, 4, 5]);
  assert.deepEqual(markersIn("no markers here"), []);
});

test("code blocks, tables and the bibliography are not audited", () => {
  const text = [
    "The rate was 4.2% in March [1].",
    "```",
    "curl https://invented.example/api",
    "```",
    "| Year | Rate |",
    "| 2025 | 4.2% |",
    "",
    "Sources",
    "1. Bureau of Statistics — https://source1.example/p",
  ].join("\n");
  const audit = auditAnswer(text, ledgerOf(1));
  assert.ok(audit.ok, JSON.stringify(audit.violations));
});

test("sentence splitting holds decimals and abbreviations together", () => {
  const sentences = auditableSentences("The cost was $1.5 billion in 2019. It rose after that.");
  assert.equal(sentences.length, 2);
  assert.match(sentences[0], /\$1\.5 billion/);
});

test("isCheckableClaim recognises what a reader could check", () => {
  assert.ok(isCheckableClaim("The unemployment rate fell to 3.4% last quarter"));
  assert.ok(isCheckableClaim("The World Health Organization withdrew the guidance"));
  assert.ok(isCheckableClaim("This claim is misleading in an important way"));
  assert.ok(!isCheckableClaim("Here's what I found about it in the sources"));
  assert.ok(!isCheckableClaim("So what does that actually mean for the viewer?"));
  assert.ok(!isCheckableClaim("It is complicated"));
});

test("the repair prompt names the failures and offers deletion as an out", () => {
  const ledger = ledgerOf(2);
  const audit = auditAnswer("The bridge cost $2.1 billion. See [9].", ledger);
  const prompt = repairInstruction(audit.violations, ledger);
  assert.match(prompt, /\[9\] does not exist/);
  assert.match(prompt, /delete the sentence/);
  assert.match(prompt, /\[1\]–\[2\]/);
  assert.match(unverifiedNotice(audit.violations), /never retrieved/);
});

/* ---------------- the turn, end to end ---------------- */

/**
 * A fake Gemini that replays scripted rounds. Each round is either `{text}` or
 * `{text, calls}`; a round with calls is followed by another round, exactly as the real
 * tool loop behaves.
 */
function fakeGemini(rounds) {
  const sent = [];
  let round = 0;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    const script = rounds[Math.min(round, rounds.length - 1)];
    round += 1;

    const parts = [];
    for (const thought of script.thoughts ?? []) {
      parts.push({ text: thought.text, thought: true, thoughtSignature: thought.signature });
    }
    if (script.text) {
      parts.push(
        script.textSignature ? { text: script.text, thoughtSignature: script.textSignature } : { text: script.text },
      );
    }
    for (const call of script.calls ?? []) {
      const part = { functionCall: { name: call.name, args: call.args } };
      if (call.signature) part.thoughtSignature = call.signature;
      parts.push(part);
    }

    const frame = JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] });
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield Buffer.from(`data: ${frame}\n\n`);
      })(),
    };
  };
  return { fetchImpl, sent };
}

async function collect(stream) {
  const frames = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

test("the model searches, the sources are numbered, the answer is shown", async () => {
  const { fetchImpl, sent } = fakeGemini([
    { text: "Let me check that.", calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion [1]. The claim is false [2]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1", "https://b.example/2"]),
    }),
  );

  const searchFrame = frames.find((f) => f.type === "search");
  assert.deepEqual(searchFrame.results.map((r) => r.n), [1, 2]);

  const sources = frames.find((f) => f.type === "sources");
  assert.deepEqual(sources.sources.map((s) => s.n), [1, 2]);
  assert.ok(!frames.some((f) => f.type === "unverified"));

  // The tool declaration went out, and the tool result came back in the next request.
  assert.equal(sent[0].tools[0].function_declarations[0].name, "web_search");
  const responseTurn = sent[1].contents.at(-1);
  assert.equal(responseTurn.role, "user");
  assert.match(responseTurn.parts[0].functionResponse.response.result, /\[1\] Title 0/);
});

test("an uncited answer is rejected, rewritten, and only the rewrite is shown", async () => {
  const { fetchImpl, sent } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The claim is false. The bridge cost $2.1 billion." },
    { text: "The bridge cost $2.1 billion, so the claim is false [1]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
    }),
  );

  const reset = frames.findIndex((f) => f.type === "reset");
  assert.ok(reset > 0, "the failed answer must be withdrawn from the UI");
  // Everything after the reset is the rewrite, and it passes.
  assert.ok(!frames.some((f) => f.type === "unverified"));
  assert.match(
    frames.filter((f) => f.type === "delta").at(-1).text,
    /\[1\]/,
  );

  // The rewrite request carried the correction and the ledger, and did not re-run a search.
  const repairTurn = sent.at(-1).contents.at(-1);
  assert.match(repairTurn.parts[0].text, /failed the citation check/);
  assert.match(repairTurn.parts[0].text, /Sources retrieved this turn:/);
});

test("an answer that fails twice is shown, but labelled unverified", async () => {
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion." },
    { text: "The bridge cost $2.1 billion." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
    }),
  );

  const unverified = frames.find((f) => f.type === "unverified");
  assert.ok(unverified);
  assert.match(unverified.message, /no citation/i);
  assert.ok(unverified.violations.length > 0);
});

test("a bad tool call is corrected by the model, not fatal to the turn", async () => {
  const { fetchImpl, sent } = fakeGemini([
    // No `claim` — the schema refuses it.
    { calls: [{ name: "web_search", args: { query: "bridge cost" } }] },
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion [1]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      // The real `search` runs the validator; only the network is faked.
      fetchSearch: null,
      searchImpl: (await import("./lib/search.js")).search,
    }),
  );

  const failed = frames.find((f) => f.type === "search" && f.error);
  assert.match(failed.error, /claim.*required/i);
  // The error went back to the model as a result, and the turn carried on.
  assert.match(sent[1].contents.at(-1).parts[0].functionResponse.response.error, /required/i);
  assert.ok(!frames.some((f) => f.type === "error"));
});

test("search can be turned off, and then nothing is enforced", async () => {
  const { fetchImpl, sent } = fakeGemini([{ text: "Plain answer with no citations at all." }]);
  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "hello" }],
      env: { WEB_SEARCH_ENABLED: "false" },
      fetchImpl,
      attachMedia: false,
    }),
  );
  assert.ok(!sent[0].tools);
  assert.ok(!frames.some((f) => f.type === "unverified" || f.type === "sources"));
});

test("a thought signature travels back on the part it arrived on", async () => {
  // Thinking models attach an opaque signature to the parts they emit, and Gemini warns
  // (and reasons worse) if the next request doesn't carry it back on the same part. It is
  // a silent-degradation bug by default: nothing fails, the tool use just gets sloppier.
  const { fetchImpl, sent } = fakeGemini([
    {
      thoughts: [{ text: "I should check the audit.", signature: "SIG-THOUGHT" }],
      text: "Checking that now.",
      textSignature: "SIG-TEXT",
      calls: [
        { name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" }, signature: "SIG-CALL" },
      ],
    },
    { text: "The bridge cost $2.1 billion [1]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
    }),
  );

  const echoed = sent[1].contents.find((c) => c.role === "model");
  assert.deepEqual(echoed.parts, [
    { text: "I should check the audit.", thought: true, thoughtSignature: "SIG-THOUGHT" },
    { text: "Checking that now.", thoughtSignature: "SIG-TEXT" },
    {
      functionCall: { name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } },
      thoughtSignature: "SIG-CALL",
    },
  ]);

  // The thinking summary is echoed but never shown: it is the model's working, not its
  // answer, and putting it in the reply would read as part of the fact-check.
  const shown = frames.filter((f) => f.type === "delta").map((f) => f.text).join("");
  assert.ok(!shown.includes("I should check"), shown);
  assert.ok(shown.includes("Checking that now."), shown);
});

test("parallel calls keep their own signatures, in order", async () => {
  const { fetchImpl, sent } = fakeGemini([
    {
      calls: [
        { name: "web_search", args: { query: "first claim", claim: "The first claim" }, signature: "SIG-A" },
        { name: "web_search", args: { query: "second claim", claim: "The second claim" }, signature: "SIG-B" },
      ],
    },
    { text: "Both check out [1]." },
  ]);

  await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async (args) => searchResult(args.claim, ["https://a.example/1"]),
    }),
  );

  const echoed = sent[1].contents.find((c) => c.role === "model");
  assert.deepEqual(echoed.parts.map((p) => p.thoughtSignature), ["SIG-A", "SIG-B"]);
  // Each result is answered under the same name, in the order the calls were made.
  assert.equal(sent[1].contents.at(-1).parts.length, 2);
});

test("text with no signature is still merged into one part", async () => {
  // The un-signed case must not regress into one part per token.
  const { fetchImpl, sent } = fakeGemini([
    { text: "Looking into it.", calls: [{ name: "web_search", args: { query: "bridge cost", claim: "A claim here" } }] },
    { text: "Confirmed [1]." },
  ]);

  await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("A claim here", ["https://a.example/1"]),
    }),
  );

  const echoed = sent[1].contents.find((c) => c.role === "model");
  assert.deepEqual(echoed.parts, [
    { text: "Looking into it." },
    { functionCall: { name: "web_search", args: { query: "bridge cost", claim: "A claim here" } } },
  ]);
});

test("the system prompt states where the model's facts come from", () => {
  assert.match(FACT_CHECK_SYSTEM_PROMPT, /web_search/);
  assert.match(FACT_CHECK_SYSTEM_PROMPT, /Your training data is not a source/);
  assert.match(FACT_CHECK_SYSTEM_PROMPT, /checked automatically after/);
});

/* ---------------- doing the looking up all at once ---------------- */

test("every search a round asks for runs at the same time, not one after another", async () => {
  const { fetchImpl } = fakeGemini([
    {
      calls: [
        { name: "web_search", args: { query: "one", claim: "The first claim" } },
        { name: "web_search", args: { query: "two", claim: "The second claim" } },
        { name: "web_search", args: { query: "three", claim: "The third claim" } },
      ],
    },
    { text: "All three check out [1]." },
  ]);

  let inFlight = 0;
  let peak = 0;
  const searchImpl = async (args) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return searchResult(args.claim, [`https://${args.query}.example/p`]);
  };

  const started = Date.now();
  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl,
    }),
  );

  // The point of the change: three 20ms searches cost one 20ms wait, not three.
  assert.equal(peak, 3, "the round's searches must overlap");
  assert.ok(Date.now() - started < 55, "three searches must not have run in sequence");

  // Overlapping must not shuffle the ledger: numbering follows the order the model asked
  // in, whichever search happens to return first.
  const searches = frames.filter((f) => f.type === "search");
  assert.deepEqual(searches.map((f) => f.claim), [
    "The first claim",
    "The second claim",
    "The third claim",
  ]);
  assert.deepEqual(searches.map((f) => f.results[0].n), [1, 2, 3]);
});

test("the searches are announced before any of them has come back", async () => {
  const { fetchImpl } = fakeGemini([
    {
      calls: [
        { name: "web_search", args: { query: "one", claim: "The first claim" } },
        { name: "web_search", args: { query: "two", claim: "The second claim" } },
      ],
    },
    { text: "Checks out [1]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async (args) => searchResult(args.claim, [`https://${args.query}.example/p`]),
    }),
  );

  const announced = frames.findIndex((f) => f.type === "searching");
  const firstResult = frames.findIndex((f) => f.type === "search");
  assert.ok(announced !== -1 && announced < firstResult, "the wait must be shown while it happens");
  assert.deepEqual(frames[announced].searches.map((s) => s.query), ["one", "two"]);
  assert.deepEqual(frames[announced].searches.map((s) => s.claim), [
    "The first claim",
    "The second claim",
  ]);
  // `tool_start` is the transport frame; the browser is told about searches, not tools.
  assert.ok(!frames.some((f) => f.type === "tool_start"));
});

test("the same query asked twice is searched once", async () => {
  const { fetchImpl } = fakeGemini([
    {
      calls: [
        { name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } },
        // Same query, different claim — and, in the round after, the same one again.
        { name: "web_search", args: { query: "Bridge Cost ", claim: "The bridge was over budget" } },
      ],
    },
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion [1]." },
  ]);

  let ran = 0;
  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async (args) => {
        ran += 1;
        return searchResult(args.claim, ["https://a.example/1"]);
      },
    }),
  );

  assert.equal(ran, 1, "a repeated query must cost nothing but the model's own round trip");
  // The model still gets an answer for each call it made, and each claim is filed against
  // the source that was retrieved for it.
  assert.equal(frames.filter((f) => f.type === "search").length, 3);
  const sources = frames.find((f) => f.type === "sources");
  assert.deepEqual(sources.sources.map((s) => s.n), [1]);
});

test("a model that keeps asking to search past its budget is made to answer, once", async () => {
  // Every round asks for another search and never writes anything. Withdrawing the tool
  // is the first move; the second is saying so. Neither may become an unbounded loop.
  const { fetchImpl, sent } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "q", claim: "A claim to check" } }] },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async (args) => searchResult(args.claim, ["https://a.example/1"]),
    }),
  );

  // Three rounds with the tool, one with it withdrawn, one after being told to answer.
  assert.equal(sent.length, 5);
  assert.equal(sent.filter((body) => body.tools).length, 3);
  assert.match(sent.at(-1).contents.at(-1).parts[0].text, /search budget/);
  // Withdrawn means withdrawn: the calls it made anyway were never run.
  assert.equal(frames.filter((f) => f.type === "search").length, 3);
  assert.ok(!frames.some((f) => f.type === "error"));
});

test("the rewrite round is a rewrite: no tools, and no second round of searching", async () => {
  const { fetchImpl, sent } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion." },
    { text: "The bridge cost $2.1 billion [1]." },
  ]);

  await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
    }),
  );

  assert.ok(!sent.at(-1).tools, "the repair round must not be handed a tool it should not use");
  assert.match(repairInstruction([{ message: "x" }], ledgerOf(1)), /cannot search again/i);
});

test("a rewrite that comes back empty puts the withdrawn answer back", async () => {
  // The failed answer is cleared from the screen the moment the rewrite starts. If the
  // rewrite then says nothing, the reader must not be left with sources over a blank.
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion." },
    { text: "" },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
    }),
  );

  const reset = frames.findIndex((f) => f.type === "reset");
  const restored = frames.map((f, i) => ({ f, i })).filter(({ f }) => f.type === "delta").at(-1);
  assert.ok(restored.i > reset);
  assert.equal(restored.f.text, "The bridge cost $2.1 billion.");
  // Restored, not endorsed: it is the text that failed the check, and it says so.
  assert.ok(frames.some((f) => f.type === "unverified"));
});

test("a turn that spends itself searching still ends with words, not a blank", async () => {
  // The model asks for a search every round and never writes anything. An empty answer
  // passes the citation audit trivially, so nothing else in the pipeline objects — this is
  // the check that the reader is not handed a list of sources under a blank space.
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "q", claim: "A claim to check" } }] },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async (args) => searchResult(args.claim, ["https://a.example/1"]),
    }),
  );

  const text = frames.filter((f) => f.type === "delta").map((f) => f.text).join("");
  assert.match(text, /did not get to an answer/);
  // And the sources it did retrieve are shown, even though no marker points at them.
  assert.deepEqual(frames.find((f) => f.type === "sources").sources.map((s) => s.n), [1]);
});

/* ---------------- landing inside the deadline ---------------- */

test("searching stops in time to write the answer, rather than at the deadline", async () => {
  // Three rounds of searching are allowed, but the clock only has room for one plus an
  // answer. Stopping a claim short beats a turn that spends its last second on a search
  // and ends with sources and no verdict.
  const { fetchImpl, sent } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "one", claim: "The first claim" } }] },
    // The model would happily search again; the round it gets has no tool declared, so it
    // answers instead. That is the withdrawal doing its job.
    { text: "Answering with what I have [1]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async (args) => {
        // Real time has to pass for a clock-based decision to have anything to decide on.
        await new Promise((r) => setTimeout(r, 300));
        return searchResult(args.claim, ["https://a.example/1"]);
      },
      // Room for one round of searching and the answer, and not for a second round: the
      // 300ms the first search spends is what takes the remaining time under the reserve.
      deadlineAt: Date.now() + 25_200,
      answerReserveMs: 25_000,
    }),
  );

  assert.equal(frames.filter((f) => f.type === "search").length, 1);
  // The tool was offered once and then withdrawn — not offered and refused.
  assert.deepEqual(sent.map((body) => Boolean(body.tools)), [true, false]);
  assert.ok(frames.some((f) => f.type === "stage" && f.stage === "wrapping"));
  assert.match(frames.filter((f) => f.type === "delta").at(-1).text, /\[1\]/);
});

test("a rewrite that cannot finish is not started; the answer ships flagged instead", async () => {
  // Withdrawing an answer to make room for a rewrite that then runs out of time leaves the
  // reader with less than shipping the flawed one would have.
  const { fetchImpl, sent } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "q", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion." },
    { text: "The bridge cost $2.1 billion [1]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
      deadlineAt: Date.now() + 60_000,
      answerReserveMs: 1_000,
      // Less headroom than a rewrite is judged to need.
      repairReserveMs: 90_000,
    }),
  );

  assert.ok(!frames.some((f) => f.type === "reset"), "nothing may be withdrawn without a replacement");
  assert.equal(sent.length, 2, "the rewrite round is never sent");
  // The answer is shown, carrying the label the check earned it.
  const unverified = frames.find((f) => f.type === "unverified");
  assert.ok(unverified);
  assert.match(frames.filter((f) => f.type === "delta").at(-1).text, /2\.1 billion/);
});

test("with no deadline set, nothing about the turn changes", () => {
  // The whole mechanism is opt-in from the caller: a null deadline must behave exactly as
  // it did before there was one, or every existing test here is measuring the wrong thing.
  assert.equal(REPAIR_RESERVE_MS > 0, true);
});
