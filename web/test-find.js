// node --test test-find.js
//
// The in-page find, and the fuzzy matching under it. What these tests are really pinning
// down is the property the whole feature rests on: **a find must not report absence when the
// page says the thing in different words.** A fact-checker that reads "not on this page" and
// believes it has been handed the most misleading possible answer, so every fuzzy case below
// — a plural, a spelling, a formatted number, a paraphrase — is a regression that would
// otherwise be invisible.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  tokenise,
  queryTerms,
  tokenSimilarity,
  idfWeights,
  lexicalScore,
  fuzzyIndex,
  phraseHit,
} from "./lib/fuzzy.js";
import {
  htmlToText,
  extractPassages,
  fetchPage,
  rankPassages,
  findInPage,
  PageCache,
  PageFindError,
  decodeEntities,
} from "./lib/page-find.js";
import {
  normalise,
  similarity,
  embedTexts,
  resetEmbeddingHealth,
  EMBEDDING_COOLDOWN_MS,
} from "./lib/embeddings.js";
import { validateFindQuery, FindQueryError, RESEARCH_TOOLS } from "./lib/find-schema.js";
import { CitationLedger } from "./lib/citations.js";

/* ---------------- tokenising and fuzzy matching ---------------- */

test("tokenise folds case, accents and punctuation", () => {
  assert.deepEqual(tokenise("Café, THE  (Bureau's) report."), ["cafe", "the", "bureau", "s", "report"]);
});

test("tokenise keeps a thousands-separated number as one number", () => {
  // The whole point: a claim saying 1,200,000 and a page printing 1200000 are the same
  // figure, and an exact search would match neither against the other.
  assert.deepEqual(tokenise("1,200,000 doses"), ["1200000", "doses"]);
  assert.deepEqual(tokenise("4.2% of adults"), ["4.2%", "of", "adults"]);
});

test("queryTerms drops stop words and duplicates", () => {
  assert.deepEqual(queryTerms("the rate of the vaccination in the vaccination programme"), [
    "rate",
    "vaccination",
    "programme",
  ]);
});

test("tokenSimilarity scores morphology high and unrelated words low", () => {
  assert.equal(tokenSimilarity("vaccine", "vaccine"), 1);
  assert.ok(tokenSimilarity("vaccination", "vaccinations") > 0.8);
  assert.ok(tokenSimilarity("declined", "decline") > 0.8);
  assert.ok(tokenSimilarity("organisation", "organization") > 0.55);
  assert.ok(tokenSimilarity("vaccine", "senator") < 0.3);
});

test("tokenSimilarity refuses wildly different lengths outright", () => {
  assert.equal(tokenSimilarity("epidemiological", "epi"), 0);
});

/* ---------------- passage extraction ---------------- */

test("htmlToText drops scripts and styles, keeps prose, and pulls the title out", () => {
  const { title, text } = htmlToText(`
    <html><head><title>Agency revises estimate</title>
    <style>.a{color:red}</style><script>var x = "not prose";</script></head>
    <body><nav>Home About</nav><h1>Agency revises estimate</h1>
    <p>The rate fell to 4.2% in March.</p><p>Officials said the revision was routine.</p>
    <footer>© 2026</footer></body></html>`);

  assert.equal(title, "Agency revises estimate");
  assert.ok(text.includes("The rate fell to 4.2% in March."));
  assert.ok(!text.includes("not prose"));
  assert.ok(!text.includes("color:red"));
  // <nav> and <footer> are chrome, and a passage made of them would be a citation pointing
  // at a navigation bar.
  assert.ok(!text.includes("Home About"));
  assert.ok(!text.includes("© 2026"));
});

test("decodeEntities handles named, decimal and hex references", () => {
  assert.equal(decodeEntities("4.2&nbsp;%&mdash;&#8220;up&#x201d;&amp;down"), "4.2 %—“up”&down");
});

test("extractPassages glues short lines together and splits long blocks", () => {
  // A page built out of one-sentence divs — most news sites — must not become a heap of
  // fragments too small to rank or to quote.
  const short = extractPassages(
    "Coverage fell.\nThe Bureau said so.\nOfficials disagreed.\nThe review continues.\n" +
      "A spokesperson declined to comment on the finding.\n",
  );
  assert.equal(short.length, 1);

  const long = extractPassages(`${"The agency published the figure. ".repeat(80)}`);
  assert.ok(long.length > 1);
  for (const passage of long) assert.ok(passage.text.length <= 1_400);
});

test("extractPassages keeps a short paragraph that is the whole finding", () => {
  // 29 characters, and the entire fact. A floor set where the glue target is would throw
  // this away and the find would report the page as silent on a claim it settles outright.
  const passages = extractPassages("Some heading\n\nCoverage fell to 58% in 2023.\n\nRelated stories");
  assert.ok(passages.some((passage) => passage.text === "Coverage fell to 58% in 2023."));
});

test("extractPassages drops fragments too short to support a claim", () => {
  assert.deepEqual(extractPassages("Read more\n\nShare\n\nNext"), []);
});

/* ---------------- ranking ---------------- */

const PAGE = `
The Bureau of Statistics published its annual review on 14 March 2026.

Vaccine coverage among adults declined through 2023, from 62 per cent to 58 per cent, a fall the Bureau described as within the expected range for the period.

The review also covered road safety, where fatalities were unchanged from the previous year.

A spokesperson said the agency had no plans to revise the methodology used since 2019.
`;

function passagesOf(text) {
  return extractPassages(text);
}

test("lexical ranking survives morphology the words do not share exactly", async () => {
  const { passages, semantic } = await rankPassages(
    "vaccination rates fell in 2023",
    passagesOf(PAGE),
    { apiKey: null, limit: 2 },
  );

  assert.equal(semantic, false, "no key, so no semantic half");
  assert.ok(passages.length >= 1);
  // "vaccination" against "Vaccine", with only the year matching exactly. The stem rule in
  // tokenSimilarity is what keeps this above the relevance floor with the semantic half
  // switched off — which is the state every deployment without a Gemini key runs in.
  assert.match(passages[0].text, /Vaccine coverage among adults declined/);
});

test("an exact phrase beats a merely topical passage", async () => {
  const { passages } = await rankPassages("from 62 per cent to 58 per cent", passagesOf(PAGE), {
    apiKey: null,
    limit: 3,
  });
  assert.match(passages[0].text, /62 per cent to 58 per cent/);
  assert.equal(passages[0].phrase, true);
});

test("a query the page does not address comes back empty", async () => {
  const { passages } = await rankPassages("interest rate decision by the central bank", passagesOf(PAGE), {
    apiKey: null,
    limit: 4,
  });
  assert.deepEqual(passages, [], "absence must be reportable, or every page 'confirms' everything");
});

test("the semantic half blends in when embeddings are available", async () => {
  const target = "The review also covered road safety, where fatalities were unchanged";
  // A stub that scores the road-safety passage as the semantic match, whatever the words.
  const embedImpl = async (texts) =>
    texts.map((text) => normalise(text.includes(target) || text.includes("crash") ? [1, 0] : [0, 1]));

  const { passages, semantic } = await rankPassages("crash deaths", passagesOf(PAGE), {
    apiKey: "k",
    embedImpl,
    limit: 3,
  });

  assert.equal(semantic, true);
  assert.match(passages[0].text, /road safety/);
});

test("a failed embedding call degrades the ranking instead of the answer", async () => {
  const { passages, semantic } = await rankPassages("vaccine coverage decline", passagesOf(PAGE), {
    apiKey: "k",
    embedImpl: async () => null,
    limit: 2,
  });
  assert.equal(semantic, false);
  assert.ok(passages.length >= 1, "lexical scoring still ran");
});

test("a short embedding batch is discarded rather than mis-zipped", async () => {
  // One vector missing means every passage after it would be scored against the wrong
  // vector. Silently mis-ranking a page is worse than not ranking it.
  const { semantic } = await rankPassages("vaccine coverage", passagesOf(PAGE), {
    apiKey: "k",
    embedImpl: async (texts) => texts.slice(1).map(() => normalise([1, 0])),
    limit: 2,
  });
  assert.equal(semantic, false);
});

test("similarity maps onto 0..1 and survives a zero vector", () => {
  assert.equal(similarity(normalise([1, 0]), normalise([1, 0])), 1);
  assert.equal(similarity(normalise([1, 0]), normalise([-1, 0])), 0);
  assert.equal(similarity(normalise([0, 0]), normalise([1, 0])), 0.5);
  assert.equal(similarity(null, [1]), 0);
});

test("embedTexts returns null rather than throwing when the API rejects the call", async () => {
  const vectors = await embedTexts(["a"], {
    apiKey: "k",
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  assert.equal(vectors, null);
});

test("embedTexts walks the model chain and normalises what comes back", async () => {
  const tried = [];
  const vectors = await embedTexts(["a", "b"], {
    apiKey: "k",
    fetchImpl: async (url) => {
      tried.push(String(url));
      if (tried.length === 1) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({ embeddings: [{ values: [3, 4] }, { values: [0, 5] }] }),
      };
    },
  });
  assert.equal(tried.length, 2);
  assert.match(tried[1], /text-embedding-004:batchEmbedContents$/);
  assert.deepEqual(vectors, [[0.6, 0.8], [0, 1]]);
});

test("a model that just refused is not put in front of the one that answered", async () => {
  // A key with no entitlement to the first model used to buy that refusal on every find,
  // ahead of the model that was always going to answer it.
  resetEmbeddingHealth();
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(String(url).includes("gemini-embedding-001") ? "first" : "second");
    if (String(url).includes("gemini-embedding-001")) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => ({ embeddings: [{ values: [1, 0] }] }) };
  };

  await embedTexts(["a"], { apiKey: "k", fetchImpl });
  await embedTexts(["a"], { apiKey: "k", fetchImpl });

  assert.deepEqual(tried, ["first", "second", "second"], "the second call goes straight there");

  // The memory expires rather than pinning the deployment to a fallback for good.
  tried.length = 0;
  await embedTexts(["a"], { apiKey: "k", fetchImpl, now: () => Date.now() + EMBEDDING_COOLDOWN_MS + 1 });
  assert.deepEqual(tried, ["first", "second"], "the preferred model is tried again once cooled");
  resetEmbeddingHealth();
});

test("a caller that went away is not counted against the model", async () => {
  resetEmbeddingHealth();
  const signal = AbortSignal.abort();
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(String(url));
    throw new Error("aborted");
  };

  await embedTexts(["a"], { apiKey: "k", fetchImpl, signal });
  assert.equal(tried.length, 1, "the chain stops at the abort rather than walking on");

  tried.length = 0;
  await embedTexts(["a"], {
    apiKey: "k",
    fetchImpl: async () => ({ ok: true, json: async () => ({ embeddings: [{ values: [1, 0] }] }) }),
    onModel: (model) => tried.push(model),
  });
  assert.deepEqual(tried, ["gemini-embedding-001"], "still the preferred model, and it reports itself");
  resetEmbeddingHealth();
});

/* ---------------- fetching ---------------- */

function response(body, { ok = true, status = 200, type = "text/html" } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? type : null) },
    text: async () => body,
  };
}

test("fetchPage extracts a page's text", async () => {
  const page = await fetchPage("https://example.gov/report", {
    fetchImpl: async () => response("<title>T</title><p>The figure was revised to 4.2% in March.</p>"),
  });
  assert.equal(page.title, "T");
  assert.match(page.text, /revised to 4.2% in March/);
});

test("fetchPage reports an unreachable page as a finding about the source", async () => {
  await assert.rejects(
    fetchPage("https://example.gov/gone", { fetchImpl: async () => response("", { ok: false, status: 404 }) }),
    (error) => {
      assert.ok(error instanceof PageFindError);
      // The message is a prompt: it tells the model what it may still do with the source.
      assert.match(error.message, /snippet is all this source can support/);
      return true;
    },
  );
});

test("fetchPage refuses a PDF rather than tokenising its binary", async () => {
  await assert.rejects(
    fetchPage("https://example.gov/f.pdf", {
      fetchImpl: async () => response("%PDF-1.7", { type: "application/pdf" }),
    }),
    /not a readable page/,
  );
});

test("fetchPage refuses a page that declares itself enormous, before reading it", async () => {
  let read = false;
  await assert.rejects(
    fetchPage("https://example.gov/big", {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (n) => (n === "content-length" ? "99000000" : "text/html") },
        text: async () => {
          read = true;
          return "x";
        },
      }),
    }),
    /too large/,
  );
  assert.equal(read, false);
});

/* ---------------- the page cache ---------------- */

test("PageCache fetches a page once per turn and re-fetches after a failure", async () => {
  let calls = 0;
  const cache = new PageCache({
    fetchPageImpl: async () => {
      calls += 1;
      if (calls === 1) throw new PageFindError("nope");
      return { title: "T", text: PAGE };
    },
  });

  await assert.rejects(cache.load("https://example.gov/a"), /nope/);
  // A failure is not remembered as one: the model is entitled to try again.
  const first = await cache.load("https://example.gov/a");
  const second = await cache.load("https://example.gov/a");
  assert.equal(calls, 2, "the successful fetch is reused");
  assert.equal(first, second);
});

test("a page's passages are embedded once however many times it is read", async () => {
  const batches = [];
  const embedImpl = async (texts) => {
    // The query is always first; the rest are passages.
    batches.push(texts.slice(1));
    return texts.map((text, i) => normalise(text.includes("Vaccine") ? [1, 0] : [i, 1]));
  };
  const cache = new PageCache({ fetchPageImpl: async () => ({ title: "T", text: PAGE }) });
  const url = "https://example.gov/review";
  const at = (n) => ({ url, find: n, claim: "The claim being checked here.", max_passages: 2 });

  const first = await findInPage(at("did vaccine coverage fall"), { apiKey: "k", cache, embedImpl });
  const second = await findInPage(at("did vaccine coverage fall in 2023"), { apiKey: "k", cache, embedImpl });

  assert.equal(first.semantic, true);
  assert.equal(second.semantic, true, "the cached vectors still give a semantic ranking");
  assert.ok(batches[0].length > 0, "the first find embeds the query and its shortlist");
  // The saving is exactly the overlap: a passage this page has already had embedded is
  // never sent again, whatever the next find asks about. Two reads of one page used to
  // cost two full embeddings of it.
  assert.equal(batches[1].length, 0, "the second read of the same shortlist embeds no passages");
  const sent = batches.flat();
  assert.equal(new Set(sent).size, sent.length, "no passage is ever embedded twice");
});

test("later batches for a page are pinned to the model that embedded it", async () => {
  // Cosine between two models' vectors is arithmetic over unrelated spaces. Once a page
  // belongs to one model, every later batch for it either uses that model or gives up the
  // semantic half — it must never quietly blend the two.
  const asked = [];
  const embedImpl = async (texts, options) => {
    asked.push(options.models ?? null);
    options.onModel?.("gemini-embedding-001");
    return texts.map(() => normalise([1, 0]));
  };
  const cache = new PageCache({ fetchPageImpl: async () => ({ title: "T", text: PAGE }) });
  const at = (n) => ({ url: "https://example.gov/a", find: n, claim: "A claim to check here." });

  await findInPage(at("coverage in 2023"), { apiKey: "k", cache, embedImpl });
  await findInPage(at("road safety figures"), { apiKey: "k", cache, embedImpl });

  assert.equal(asked[0], null, "a fresh page takes whichever model answers");
  assert.deepEqual(asked[1], ["gemini-embedding-001"]);
});

test("a page whose second batch fails keeps its cached vectors and drops to lexical", async () => {
  let call = 0;
  const embedImpl = async (texts) => {
    call += 1;
    return call === 1 ? texts.map(() => normalise([1, 0])) : null;
  };
  const cache = new PageCache({ fetchPageImpl: async () => ({ title: "T", text: PAGE }) });
  const at = (n) => ({ url: "https://example.gov/a", find: n, claim: "A claim to check here." });

  const first = await findInPage(at("coverage in 2023"), { apiKey: "k", cache, embedImpl });
  const second = await findInPage(at("road safety figures"), { apiKey: "k", cache, embedImpl });

  assert.equal(first.semantic, true);
  assert.equal(second.semantic, false, "no query vector means no semantic half, not a wrong one");
  assert.ok(second.passages.length >= 0, "and the find still answers");
});

/* ---------------- the tool, end to end ---------------- */

test("findInPage returns passages under the page's existing number", async () => {
  const result = await findInPage(
    { url: "https://example.gov/review", find: "did vaccine coverage fall in 2023", claim: "Coverage fell in 2023.", max_passages: 2 },
    { apiKey: null, fetchImpl: async () => response(`<title>Review</title><body>${PAGE.replace(/\n\n/g, "<p>")}</body>`) },
  );

  assert.equal(result.title, "Review");
  assert.ok(result.passages.length >= 1);
  assert.match(result.passages[0].text, /Vaccine coverage/);
  assert.equal(result.semantic, false);
});

test("findInPage says so when a page has no readable text", async () => {
  await assert.rejects(
    findInPage(
      { url: "https://example.com/app", find: "anything at all", claim: "The claim is checkable." },
      { apiKey: null, fetchImpl: async () => response("<div id=root></div>") },
    ),
    /no readable text/,
  );
});

/* ---------------- the schema ---------------- */

test("validateFindQuery applies defaults and trims", () => {
  const query = validateFindQuery({
    url: "  https://example.gov/a  ",
    find: " the revised figure ",
    claim: "The figure was revised down.",
  });
  assert.deepEqual(query, {
    url: "https://example.gov/a",
    find: "the revised figure",
    claim: "The figure was revised down.",
    max_passages: 4,
  });
});

test("validateFindQuery rejects what the model gets wrong, in words it can act on", () => {
  assert.throws(() => validateFindQuery({ find: "x y z", claim: "A claim here." }), FindQueryError);
  assert.throws(
    () => validateFindQuery({ url: "example.gov/a", find: "the figure", claim: "A claim here." }),
    /not an http\(s\) URL/,
  );
  assert.throws(
    () => validateFindQuery({ url: "https://a.gov", find: "x", claim: "A claim here.", page: 2 }),
    /Unknown argument "page"/,
  );
  assert.throws(
    () => validateFindQuery({ url: "https://a.gov", find: "the figure", claim: "A claim here.", max_passages: 40 }),
    /between 1 and 8/,
  );
});

test("both research tools are declared together, in one group", () => {
  assert.equal(RESEARCH_TOOLS.length, 1);
  assert.deepEqual(
    RESEARCH_TOOLS[0].function_declarations.map((d) => d.name),
    ["web_search", "find_in_page"],
  );
  // Gemini rejects a declaration carrying JSON Schema's string keywords.
  const parameters = RESEARCH_TOOLS[0].function_declarations[1].parameters;
  assert.equal(parameters.type, "OBJECT");
  assert.equal(JSON.stringify(parameters).includes("maxLength"), false);
});

/* ---------------- the ledger's side of it ---------------- */

test("the ledger only lets a find read a page it retrieved", () => {
  const ledger = new CitationLedger();
  ledger.record({
    query: "q",
    claim: "A claim.",
    provider: "test",
    retrievedAt: "now",
    results: [{ title: "T", url: "https://example.gov/a", domain: "example.gov", snippet: "s" }],
  });

  assert.equal(ledger.find("https://example.gov/a")?.n, 1);
  assert.equal(ledger.find("https://elsewhere.example/x"), undefined);
});

test("recordFind files passages against the source and dedupes them", () => {
  const ledger = new CitationLedger();
  ledger.record({
    query: "q",
    claim: "A claim.",
    provider: "test",
    retrievedAt: "now",
    results: [{ title: "T", url: "https://example.gov/a", domain: "example.gov", snippet: "s" }],
  });

  ledger.recordFind({
    url: "https://example.gov/a",
    find: "the figure",
    claim: "The figure fell.",
    passages: [{ text: "The rate fell to 4.2%.", score: 0.9 }],
  });
  ledger.recordFind({
    url: "https://example.gov/a",
    find: "the date",
    claim: "It was published in March.",
    passages: [{ text: "The rate fell to 4.2%.", score: 0.8 }, { text: "Published 14 March.", score: 0.7 }],
  });

  const source = ledger.sources[0];
  assert.equal(source.passages.length, 2, "the same paragraph is filed once");
  assert.deepEqual(source.claims, ["A claim.", "The figure fell.", "It was published in March."]);
  assert.equal(ledger.finds.length, 2);
  // Reading a page creates no new source: the ledger still holds one.
  assert.equal(ledger.size, 1);
});

test("describeFind tells the model to reuse the number, and reports absence as a finding", () => {
  const ledger = new CitationLedger();
  ledger.record({
    query: "q",
    claim: "A claim.",
    provider: "test",
    retrievedAt: "now",
    results: [{ title: "Review", url: "https://example.gov/a", domain: "example.gov", snippet: "s" }],
  });
  const entry = ledger.sources[0];

  const hit = CitationLedger.describeFind(entry, {
    find: "the figure",
    passages: [{ text: "The rate fell to 4.2%.", score: 0.91, phrase: true }],
    semantic: true,
    passageCount: 12,
  });
  assert.match(hit, /Cite it as \[1\]/);
  assert.match(hit, /does not create a new source/);
  assert.match(hit, /exact phrase match/);

  const miss = CitationLedger.describeFind(entry, {
    find: "the figure",
    passages: [],
    semantic: false,
    passageCount: 12,
  });
  assert.match(miss, /real finding about the page, not an error/);
  assert.match(miss, /Do not cite \[1\] for that claim/);
  // A lexical-only miss is a weaker negative, and the model is told so.
  assert.match(miss, /ranked by wording only/);
});

/* ---------------- scoring internals worth pinning ---------------- */

test("IDF stops a term in every passage from deciding the ranking", () => {
  const passages = extractPassages(
    "The Bureau said coverage rose in the north of the country last year, by a small amount.\n\n" +
      "The Bureau said coverage fell in the south of the country last year, by a small amount.\n\n" +
      "The Bureau declined to comment further on the report it published last year in autumn.",
  );
  const terms = queryTerms("Bureau coverage fell south");
  const weights = idfWeights(terms, passages);
  assert.ok(weights.get("south") > weights.get("bureau"), "the rare word must weigh more");

  const scores = passages.map((passage) => lexicalScore(terms, weights, passage).score);
  assert.ok(scores[1] > scores[0] && scores[1] > scores[2]);
});

test("the fuzzy index scores exactly what a per-passage scan scored", () => {
  // The index exists to stop the same two words being compared once per occurrence. It is
  // a speed change and must not be anything else, so the two ways of calling `lexicalScore`
  // — with the page's index, and with none at all — have to agree everywhere.
  const passages = extractPassages(PAGE);
  for (const query of [
    "vaccination rates fell in 2023",
    "whether the agency revised the figure downward",
    "from 62 per cent to 58 per cent",
    "zoning ordinance municipal referendum",
  ]) {
    const terms = queryTerms(query);
    const weights = idfWeights(terms, passages);
    const index = fuzzyIndex(terms, passages);
    for (const passage of passages) {
      assert.deepEqual(
        lexicalScore(terms, weights, passage, index),
        lexicalScore(terms, weights, passage),
        `${query} / ${passage.text.slice(0, 40)}`,
      );
    }
  }
});

test("phraseHit needs a real phrase, not two words", () => {
  const [passage] = extractPassages(
    "Coverage among adults declined through 2023, from 62 per cent to 58 per cent overall.",
  );
  assert.equal(phraseHit("declined through 2023", passage), true);
  assert.equal(phraseHit("up", passage), false);
});

/* ---------------- two bugs found by running this against a live page ---------------- */

test("a comment sequence inside a script does not leak the script into the passages", () => {
  // Found on Wikipedia, whose embedded JSON contains the characters `<!--` inside a string.
  // Stripping comments before elements deleted through to the next `-->`, taking the
  // script's closing tag with it — and several kilobytes of raw wikitext then ranked as the
  // fourth-best passage on the page.
  const { text } = htmlToText(
    '<script type="application/json">{"wt":"\\n<!--\\n | latd = 48.8583\\n-->","x":1}</script>' +
      "<p>The tower was completed in 1889 and stands 330 metres tall.</p>",
  );
  assert.ok(!text.includes("latd"), "the script must not survive");
  assert.ok(!text.includes('"wt"'));
  assert.match(text, /completed in 1889/);
});

test("a page's own footnote numbers are stripped, because they collide with our markers", () => {
  // This is a correctness problem, not a tidiness one. The model is told to quote passages
  // verbatim, so a passage carrying Wikipedia's `[ 108 ]` puts `[108]` in the answer — where
  // the citation audit reads it as a citation of a source that does not exist and fails the
  // answer for fabricating one.
  const { text } = htmlToText(
    "<p>The tower was the world's tallest structure when completed in 1889. [ 108 ] " +
      "It lost the title in 1930.[53] Some claim otherwise.[citation needed]</p>",
  );
  assert.ok(!/\[\s*\d+\s*\]/.test(text), `a bracketed number survived: ${text}`);
  assert.ok(!/citation needed/i.test(text));
  assert.match(text, /completed in 1889/);
  assert.match(text, /lost the title in 1930/);
});
