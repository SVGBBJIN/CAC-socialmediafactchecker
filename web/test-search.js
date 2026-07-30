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
import { CitationLedger, markersIn } from "./lib/citations.js";
import { verifiedChat, searchEnabled, FACT_CHECK_SYSTEM_PROMPT } from "./lib/verified-chat.js";
import { PageFindError } from "./lib/page-find.js";

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
    max_results: 3,
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

/* ---------------- the turn, end to end ---------------- */

/**
 * A fake Gemini that replays scripted rounds. Each round is either `{text}` or
 * `{text, calls}`; a round with calls is followed by another round, exactly as the real
 * tool loop behaves. `finishReason` overrides how the round ends, for the turns that stop
 * on something other than STOP.
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

    // An early finish arrives the way Gemini sends it: the text lands in one frame, and a
    // later frame carries the reason with no content of its own. Splitting them matters —
    // a reason bundled onto the same frame as the text would let a consumer that bails on
    // the reason never see the text at all, which is not the situation being modelled.
    const frames = [JSON.stringify({ candidates: [{ content: { parts } }] })];
    frames.push(
      JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: script.finishReason ?? "STOP" }] }),
    );
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        for (const frame of frames) yield Buffer.from(`data: ${frame}\n\n`);
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

/**
 * The text a reader actually ends up with, by replaying the frames the way public/app.js
 * does: `delta` appends, `reset` clears, `answer` replaces.
 *
 * Asserting on the last `delta` — which is what these tests used to do — cannot see the
 * bug this exists to catch, because every individual delta is fine. The damage is in what
 * they add up to on screen, and only a replay of the whole stream shows it. `answer` is
 * replayed here for the same reason: it is the citation cleanup's edit, so a test that
 * ignored it would be asserting on text no reader is shown.
 */
function readerSees(frames) {
  let shown = "";
  for (const frame of frames) {
    if (frame.type === "delta") shown += frame.text;
    // A paragraph boundary where the model stopped to use a tool. It adds a break; it
    // never takes anything away, which is the whole difference from the `reset` frame it
    // replaced. public/app.js does exactly this.
    if (frame.type === "break") shown += "\n\n";
    if (frame.type === "answer") shown = frame.text;
  }
  return shown;
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

/**
 * The reply the model actually writes to "hi" — the shape that used to break the app.
 *
 * Every sentence in it tripped the old sentence-level audit at least once: the
 * self-introduction on its proper noun, the offer to say whether something is accurate on
 * its verdict vocabulary, the platform list on its capitalised words. The answer streamed
 * in, was pulled off the screen, came back rewritten, and arrived under a banner saying no
 * search had been run. Nothing in this reply is a claim about the world, and no mechanism
 * left in the app has an opinion about that either way.
 */
const GREETING_REPLY = [
  "Hi there! I'm Seer, a social-media fact-checker.",
  "Send me a TikTok, YouTube, or Instagram link and I'll check the claims in it.",
  "Just share the URL and I'll tell you whether it's accurate.",
  "Supported platforms include TikTok, YouTube, and Instagram.",
  "What would you like me to check?",
].join(" ");

test("a plain greeting is answered as written, with no tool call and nothing withdrawn", async () => {
  const { fetchImpl, sent } = fakeGemini([{ text: GREETING_REPLY }]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "hi" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => {
        throw new Error("web_search should not have been called for a greeting");
      },
    }),
  );

  assert.equal(sent.length, 1, "answered in one round — no repair, no forced follow-up call");
  assert.equal(readerSees(frames), GREETING_REPLY, "shown exactly as the model wrote it");
  assert.ok(!frames.some((f) => f.type === "sources"), "no bibliography for an answer that cited nothing");

  // The frames that used to make this turn come apart. None of them exists any more, and
  // asserting on the names is the point: if either is ever reintroduced, this fails.
  assert.ok(!frames.some((f) => f.type === "reset"), "nothing is ever un-drawn");
  assert.ok(!frames.some((f) => f.type === "unverified"), "no banner about a search nobody needed");

  // On-demand means available, not withheld: the tool was still declared.
  assert.equal(sent[0].tools[0].function_declarations[0].name, "web_search");
});

test("a preamble written before the search is kept, separated from the answer", async () => {
  // The model thinks out loud, searches, then answers properly. That preamble used to be
  // erased mid-stream — text appearing and then vanishing, which is what "it cuts itself
  // off" described. It is kept now: the search sits between the two in the evidence trail,
  // and a paragraph break separates them in the prose. Nothing the reader saw is un-drawn.
  const { fetchImpl } = fakeGemini([
    {
      text: "Let me look that up. I think it was about $4 billion.",
      calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }],
    },
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

  assert.equal(
    readerSees(frames),
    "Let me look that up. I think it was about $4 billion.\n\n" +
      "The bridge cost $2.1 billion, so the claim is false [1].",
  );
  // The one thing the break has to guarantee: the two stretches never run together into
  // a single paragraph that reads as one self-contradicting sentence.
  assert.equal(frames.filter((f) => f.type === "break").length, 1);
  assert.ok(!frames.some((f) => f.type === "reset"));
});

test("a turn that ends on a search leaves no trailing blank space under the answer", async () => {
  // The break is emitted at the first token *after* the seam, not at the seam itself, so a
  // model that writes its verdict and then searches one last time does not finish with a
  // stranded blank line where the continuation never came.
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "q", claim: "A claim" } }] },
    {
      text: "The bridge cost $2.1 billion [1].",
      calls: [{ name: "web_search", args: { query: "q2", claim: "Another claim" } }],
    },
    { text: "" },
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

  assert.equal(readerSees(frames), "The bridge cost $2.1 billion [1].");
});

test("a model that writes its own paragraph break is not given a second one", async () => {
  const { fetchImpl } = fakeGemini([
    { text: "Checking that now.\n\n", calls: [{ name: "web_search", args: { query: "q", claim: "A claim" } }] },
    { text: "The bridge cost $2.1 billion [1]." },
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

  assert.equal(readerSees(frames), "Checking that now.\n\nThe bridge cost $2.1 billion [1].");
  assert.equal(frames.filter((f) => f.type === "break").length, 0);
});

test("an answer written before one last search is kept, not buried under an apology", async () => {
  // The mirror image of the test above, and the reason the withdrawn text is held rather
  // than dropped: here the pre-search text *was* the answer, and the model then spent its
  // last round searching instead of restating it. Discarding it would end the turn by
  // claiming there was no answer directly underneath the answer.
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    {
      text: "The bridge cost $2.1 billion, so the claim is false [1].",
      calls: [{ name: "web_search", args: { query: "bridge opened", claim: "The bridge opened in 2011" } }],
    },
    { text: "" },
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

  assert.equal(readerSees(frames), "The bridge cost $2.1 billion, so the claim is false [1].");
  assert.ok(
    !readerSees(frames).includes("did not get to an answer"),
    "an answer was written; the turn must not deny it",
  );
});

test("prose written alongside a refused, past-budget tool call is kept and broken", async () => {
  // The budget-exhausted path: the model writes a half-thought and asks for a search it
  // cannot have, the call is refused rather than run — so no search frame marks it — and
  // the next round writes the answer. The round boundary is the seam, and it gets a break
  // for the same reason a search does.
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "q1", claim: "A claim to check" } }] },
    { calls: [{ name: "web_search", args: { query: "q2", claim: "A claim to check" } }] },
    { calls: [{ name: "web_search", args: { query: "q3", claim: "A claim to check" } }] },
    {
      text: "I still need to confirm the second figure, so let me search again.",
      calls: [{ name: "web_search", args: { query: "q4", claim: "A claim to check" } }],
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
      searchImpl: async (args) => searchResult(args.claim, ["https://a.example/1"]),
    }),
  );

  assert.equal(
    readerSees(frames),
    "I still need to confirm the second figure, so let me search again.\n\n" +
      "The bridge cost $2.1 billion [1].",
  );
  assert.ok(!frames.some((f) => f.type === "reset"));
});

test("the bibliography is sent while the searches land, before the answer is written", async () => {
  const { fetchImpl } = fakeGemini([
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
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1", "https://b.example/2"]),
    }),
  );

  const firstSources = frames.findIndex((f) => f.type === "sources");
  const firstDelta = frames.findIndex((f) => f.type === "delta");
  assert.ok(firstSources !== -1, "a bibliography must be sent");
  assert.ok(
    firstSources < firstDelta,
    "the sources must arrive before the first token, so markers link as the answer streams",
  );
  assert.equal(frames[firstSources].provisional, true);
  // Provisional means everything retrieved, since what gets cited is not known yet.
  assert.deepEqual(frames[firstSources].sources.map((s) => s.n), [1, 2]);

  // The last one is the real bibliography: not provisional, and narrowed to what was cited.
  const last = frames.filter((f) => f.type === "sources").at(-1);
  assert.ok(!last.provisional);
  assert.deepEqual(last.sources.map((s) => s.n), [1]);
});

test("a search that turns up nothing new does not re-send the same bibliography", async () => {
  // The second call is the same query, served from the turn's cache; the third finds a page
  // the first already returned. Neither grows the ledger, so neither is worth a frame.
  const { fetchImpl } = fakeGemini([
    {
      calls: [
        { name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } },
        { name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } },
        { name: "web_search", args: { query: "bridge price", claim: "The bridge cost $4bn" } },
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
      // Every query returns the same single page.
      searchImpl: async (args) => searchResult(args.claim, ["https://a.example/1"]),
    }),
  );

  const provisional = frames.filter((f) => f.type === "sources" && f.provisional);
  assert.equal(provisional.length, 1, "one bibliography, not one per search");
  assert.deepEqual(provisional[0].sources.map((s) => s.n), [1]);
});

test("a stream that dies mid-answer keeps the text it wrote and its bibliography", async () => {
  // Gemini ends turns on RECITATION or SAFETY partway through an answer without warning.
  // The text that arrived is real and is kept — but so are its sources, which is the part
  // that used to be lost: throwing from the stream skipped the bibliography, leaving a
  // half-answer whose [1] markers pointed at nothing. The failure is still reported.
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion [1]. The claim is false", finishReason: "RECITATION" },
  ]);

  const frames = [];
  let thrown = null;
  try {
    for await (const frame of verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
    })) {
      frames.push(frame);
    }
  } catch (error) {
    thrown = error;
  }

  assert.match(readerSees(frames), /The bridge cost \$2\.1 billion \[1\]\./);
  const sources = frames.find((f) => f.type === "sources");
  assert.ok(sources, "the bibliography must survive the failure");
  assert.deepEqual(sources.sources.map((s) => s.n), [1]);
  // Still an error — the reader is owed the reason it stopped, just not at the cost of
  // everything that did arrive.
  assert.match(thrown?.message ?? "", /RECITATION/);
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
});

test("the system prompt says a greeting needs no tool call", () => {
  // The prompt is where the citation rule lives now, so it has to be honest about the
  // turns the rule does not govern. Without this the model reaches for a search on "hi".
  assert.match(FACT_CHECK_SYSTEM_PROMPT, /Not every message is a fact-check/);
  assert.match(FACT_CHECK_SYSTEM_PROMPT, /Do not search to have searched/);
});

test("the system prompt no longer threatens a rewrite that cannot happen", () => {
  // The repair round is gone. Telling the model its answer will be "rejected and you are
  // made to rewrite it" would be instructing it against a mechanism that does not exist,
  // and a stated consequence that never arrives is one the model learns to discount.
  assert.doesNotMatch(FACT_CHECK_SYSTEM_PROMPT, /rejected and you are made to rewrite/i);
  assert.doesNotMatch(FACT_CHECK_SYSTEM_PROMPT, /checked automatically after/i);
  // What replaced it is the one consequence that is real, and it is stated.
  assert.match(FACT_CHECK_SYSTEM_PROMPT, /deletes any marker/i);
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

/* ---------------- what the banners say ---------------- */

/* ---------------- reading a page, and the links that come out ---------------- */

/** A `find_in_page` stub returning one passage from whatever page it was pointed at. */
function findResult(url, find, passages) {
  return {
    url,
    find,
    title: "Title 0",
    passageCount: 12,
    semantic: true,
    passages: passages.map((text, index) => ({
      text,
      score: 0.9 - index * 0.1,
      lexical: 0.8,
      semantic: 0.9,
      phrase: false,
      matched: ["cost"],
      position: index,
    })),
  };
}

test("the model reads a page a search returned and quotes it under the same number", async () => {
  const { fetchImpl, sent } = fakeGemini([
    {
      calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }],
    },
    {
      calls: [
        {
          name: "find_in_page",
          args: {
            url: "https://a.example/1",
            find: "the final cost of the bridge",
            claim: "The bridge cost $4bn",
          },
        },
      ],
    },
    { text: "The final bill was $2.1 billion, not $4 billion [1]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
      findImpl: async (query) =>
        findResult(query.url, query.find, ["The final bill came to $2.1 billion."]),
    }),
  );

  const find = frames.find((f) => f.type === "find");
  assert.equal(find.n, 1, "reading a page reuses the page's number");
  assert.equal(find.matches, 1);
  assert.equal(find.domain, "a.example");

  // Both tools were offered, and the passage went back to the model as source [1].
  assert.deepEqual(
    sent[0].tools[0].function_declarations.map((d) => d.name),
    ["web_search", "find_in_page"],
  );
  const toolTurn = sent[2].contents.at(-1);
  assert.match(toolTurn.parts[0].functionResponse.response.result, /\[1\] passage 1/);
  assert.match(toolTurn.parts[0].functionResponse.response.result, /final bill came to \$2\.1 billion/);

  // Reading a page creates no new source, so the links are still one.
  const sources = frames.filter((f) => f.type === "sources").at(-1);
  assert.deepEqual(sources.sources.map((s) => s.n), [1]);
  // …and the passage rides along, so a fallback list can show the sentence the citation
  // rests on without the reader opening anything.
  assert.equal(sources.sources[0].quote, "The final bill came to $2.1 billion.");
});

/**
 * A Gemini stub with a page server bolted on, so a turn can be watched fetching pages
 * nobody asked for yet. Anything with a JSON body is a model call; everything else is a
 * page being opened.
 */
function geminiAndPages(rounds) {
  const { fetchImpl: gemini, sent } = fakeGemini(rounds);
  const fetched = [];
  const fetchImpl = async (url, options) => {
    // The embedding call has a body too, but it is not a round of the conversation —
    // letting it fall through to the model stub would desync the script. Declined, which
    // is a case `embedTexts` is built for: the find drops to lexical ranking and says so.
    if (String(url).includes("batchEmbedContents")) return { ok: false, status: 503 };
    if (options?.body) return gemini(url, options);
    fetched.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === "content-type" ? "text/html" : null) },
      text: async () =>
        "<html><title>Title 0</title><body>" +
        "<p>The bridge opened to traffic in the spring of 2024, two years behind schedule.</p>" +
        "<p>The final bill for the bridge came to $2.1 billion, the auditor confirmed.</p>" +
        "<p>Local councillors have asked for a review of the procurement process.</p>" +
        "</body></html>",
    };
  };
  return { fetchImpl, sent, fetched };
}

/** Let the fire-and-forget prefetches settle before asserting on them. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the top results of a search are opened while the model is still reading the snippets", async () => {
  // The two-pass shape the prompt asks for means the page a second-round `find_in_page`
  // lands on is nearly always one the first round already retrieved. Waiting to be told
  // which puts the whole page fetch in series behind a model call that was itself waiting
  // on the search — the same seconds spent twice.
  const { fetchImpl, fetched } = geminiAndPages([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The final bill was $2.1 billion [1]." },
  ]);

  await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () =>
        searchResult("The bridge cost $4bn", [
          "https://a.example/1",
          "https://b.example/2",
          "https://c.example/3",
          "https://d.example/4",
        ]),
    }),
  );
  await settle();

  // Top of the page is where a find goes, so a shallow slice buys most of the benefit —
  // and the fourth result is bandwidth spent on a page nobody was going to read.
  assert.deepEqual(fetched, ["https://a.example/1", "https://b.example/2", "https://c.example/3"]);
});

test("a page opened ahead of time is not opened again when the model asks for it", async () => {
  const { fetchImpl, fetched } = geminiAndPages([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    {
      calls: [
        {
          name: "find_in_page",
          args: {
            url: "https://a.example/1",
            find: "the final bill for the bridge",
            claim: "The bridge cost $4bn",
          },
        },
      ],
    },
    { text: "The final bill was $2.1 billion [1]." },
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
  await settle();

  // One fetch, not two: the find is served from the turn's page cache, so it costs the
  // ranking and nothing else.
  assert.deepEqual(fetched, ["https://a.example/1"]);
  const find = frames.find((f) => f.type === "find");
  assert.equal(find.n, 1);
  assert.ok(find.matches > 0, "the prefetched page was still readable when the find ran");
});

test("prefetching is bounded across a whole turn, not just per search", async () => {
  const rounds = [
    {
      calls: [
        { name: "web_search", args: { query: "a", claim: "one" } },
        { name: "web_search", args: { query: "b", claim: "two" } },
        { name: "web_search", args: { query: "c", claim: "three" } },
        { name: "web_search", args: { query: "d", claim: "four" } },
      ],
    },
    { text: "No source settles this." },
  ];
  const { fetchImpl, fetched } = geminiAndPages(rounds);

  let query = 0;
  await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => {
        query += 1;
        return searchResult(`claim ${query}`, [
          `https://q${query}.example/1`,
          `https://q${query}.example/2`,
          `https://q${query}.example/3`,
        ]);
      },
    }),
  );
  await settle();

  // Three searches' worth, then the budget is spent — a turn that searches widely must not
  // turn into a crawler on the strength of a guess about what it will read.
  assert.equal(fetched.length, 9);
});

test("a find on a page no search returned is refused, with a way forward", async () => {
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    {
      calls: [
        {
          name: "find_in_page",
          args: { url: "https://invented.example/x", find: "the cost", claim: "The bridge cost $4bn" },
        },
      ],
    },
    { text: "I could not check the cost against that page, so I am not going to say either way." },
  ]);

  let calls = 0;
  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
      findImpl: async () => {
        calls += 1;
        return findResult("x", "y", []);
      },
    }),
  );

  assert.equal(calls, 0, "the page must never be fetched — it is not a retrieved source");
  const find = frames.find((f) => f.type === "find");
  assert.match(find.error, /not a retrieved source/);
});

test("a page that will not open is reported as a limit on the source, not a failed turn", async () => {
  const { fetchImpl, sent } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    {
      calls: [
        {
          name: "find_in_page",
          args: { url: "https://a.example/1", find: "the cost", claim: "The bridge cost $4bn" },
        },
      ],
    },
    { text: "The search snippet puts the cost at $2.1 billion [1]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", ["https://a.example/1"]),
      findImpl: async () => {
        throw new PageFindError("Could not open the page: HTTP 403.");
      },
    }),
  );

  // The turn still produced an answer, and the model was told what the source can support.
  assert.match(readerSees(frames), /\$2\.1 billion \[1\]/);
  const error = sent[2].contents.at(-1).parts[0].functionResponse.response.error;
  assert.match(error, /HTTP 403/);
  assert.match(error, /source \[1\]/);
});

test("the searching frame names the reads as well as the searches", async () => {
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    {
      calls: [
        { name: "find_in_page", args: { url: "https://a.example/1", find: "the cost", claim: "The bridge cost $4bn" } },
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
      findImpl: async (query) => findResult(query.url, query.find, ["It cost $2.1 billion."]),
    }),
  );

  const announcements = frames.filter((f) => f.type === "searching");
  assert.deepEqual(announcements[0].searches.map((s) => s.query), ["bridge cost"]);
  assert.deepEqual(announcements[0].reads, []);
  assert.deepEqual(announcements[1].reads.map((r) => r.url), ["https://a.example/1"]);
});

/* ---------------- the links, inline first and listed as a fallback ---------------- */

test("a clean cited answer sends its links without asking for them to be listed", async () => {
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion [1]. It opened in 2011 [2]." },
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

  const sources = frames.filter((f) => f.type === "sources").at(-1);
  // The rows are always sent — they are what turns every `[n]` into a link — but the answer
  // links them all itself, so the list underneath is not drawn.
  assert.deepEqual(sources.sources.map((s) => s.n), [1, 2]);
  assert.equal(sources.fallback, false);
});

test("an answer that cites nothing gets every link listed instead", async () => {
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
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

  const sources = frames.filter((f) => f.type === "sources").at(-1);
  // No inline markers exist, so these pages would vanish entirely without the list.
  assert.equal(sources.fallback, true);
  assert.deepEqual(sources.sources.map((s) => s.n), [1]);
});

test("a truncated answer gets every link listed, not just the ones it reached", async () => {
  // The reader is being asked to make their own judgement about a reply that stops
  // mid-thought, which is the one moment the full list beats the subset the text happens
  // to link — the sources it never got as far as citing are still what it was working from.
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion [1]. The contractor was fined", finishReason: "MAX_TOKENS" },
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

  assert.ok(frames.some((f) => f.type === "truncated"));
  const sources = frames.filter((f) => f.type === "sources").at(-1);
  assert.equal(sources.fallback, true);
  assert.deepEqual(sources.sources.map((s) => s.n), [1, 2]);
});

test("redundant citations are cleaned out of the answer the reader is shown", async () => {
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion [2][2][3], not $4 billion [3][2]." },
  ]);

  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () =>
        searchResult("The bridge cost $4bn", [
          "https://a.example/1",
          "https://b.example/2",
          "https://c.example/3",
        ]),
    }),
  );

  // Duplicates gone, and renumbered so the markers ascend from the first one read. The
  // trailing group goes entirely: this is one sentence, and both its numbers are already
  // cited a few words to the left.
  assert.equal(readerSees(frames), "The bridge cost $2.1 billion [1][2], not $4 billion.");

  const sources = frames.filter((f) => f.type === "sources").at(-1);
  assert.deepEqual(
    sources.sources.map((s) => [s.n, s.url]),
    [
      [1, "https://b.example/2"],
      [2, "https://c.example/3"],
    ],
  );
  assert.equal(sources.fallback, false, "the answer links every source it kept");
});

test("cleanup never leaves a cited sentence bare, so the audit still passes", async () => {
  // Two searches find the same page by two spellings of its URL, and the model cites both
  // numbers on both sentences. Merging them must not empty either sentence's citation.
  const { fetchImpl } = fakeGemini([
    {
      calls: [
        { name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } },
        { name: "web_search", args: { query: "bridge price", claim: "The bridge cost $4bn" } },
      ],
    },
    { text: "The bridge cost $2.1 billion [1][2]. It opened in 2011 [2][1]." },
  ]);

  const queries = ["https://a.example/story", "https://a.example/story?utm_source=x"];
  let index = 0;
  const frames = await collect(
    verifiedChat({
      apiKey: "k",
      messages: [{ role: "user", content: "Is this true?" }],
      env: {},
      fetchImpl,
      attachMedia: false,
      searchImpl: async () => searchResult("The bridge cost $4bn", [queries[index++]]),
    }),
  );

  assert.equal(readerSees(frames), "The bridge cost $2.1 billion [1]. It opened in 2011 [1].");
  assert.ok(!frames.some((f) => f.type === "unverified"));
});

test("a fabricated marker is deleted from the answer the reader is shown", async () => {
  // [9] names a source no search returned. It used to survive to the screen, described by
  // an "Unverified" banner underneath it — an unopenable citation, published with a
  // warning. Now it is simply removed, and the real marker beside it survives and is
  // renumbered with everything else.
  const { fetchImpl } = fakeGemini([
    { calls: [{ name: "web_search", args: { query: "bridge cost", claim: "The bridge cost $4bn" } }] },
    { text: "The bridge cost $2.1 billion [2]. It opened in 2011 [9]." },
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

  const shown = readerSees(frames);
  assert.ok(!shown.includes("[9]"), `the invented marker must not reach the reader: ${shown}`);
  assert.equal(shown, "The bridge cost $2.1 billion [1]. It opened in 2011.");
  assert.ok(!frames.some((f) => f.type === "unverified"));

  // The sentence that lost its only marker is simply uncited, which is what it always was;
  // the answer is not withdrawn over it, and the links still cover what it did cite.
  const sources = frames.filter((f) => f.type === "sources").at(-1);
  assert.deepEqual(sources.sources.map((s) => s.n), [1]);
});
