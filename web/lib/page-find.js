// Ctrl+F for a fact-checker: open a page that a search returned, and find the passage that
// settles the claim.
//
// Search results are a list of *pages*, described by a snippet the engine wrote for a
// different purpose. Verifying a claim from snippets is verifying it from advertising copy:
// the snippet says the study found an increase, and the page says the increase was within
// the margin of error. The model either cites the snippet and gets it subtly wrong, or
// spends a round issuing three more searches hoping one comes back with a better snippet.
// Both are slow and both are how an uncited or over-cited answer happens.
//
// So this reads the page. `find_in_page` takes a URL the ledger already holds and a
// description of what is being looked for, and returns the handful of passages that
// actually address it — verbatim, with the citation number the page already has. The model
// gets to quote the source instead of paraphrasing a snippet, and it gets there in one
// call instead of three searches.
//
// Ranking is hybrid, because the two halves fail in opposite directions:
//
//   - **Semantic** (embeddings) finds the passage that means the right thing in the wrong
//     words. It is also the half that can quietly return nothing useful for a page of
//     tables and figures, where meaning is thin and the number is everything.
//   - **Fuzzy lexical** (lib/fuzzy.js) finds the number, the name and the date, tolerating
//     the spelling and formatting drift that breaks an exact match. It is the half that
//     cannot tell "coverage declined" from "declined to comment".
//
// Neither is trusted alone, and the semantic half is optional: if the embedding call fails
// the find still works on lexical scoring and says so in its result. A degraded find beats
// a failed one, because the alternative the model falls back on is guessing.

import { embedTexts, similarity } from "./embeddings.js";
import { idfWeights, lexicalScore, phraseHit, queryTerms, tokenise } from "./fuzzy.js";

/** Longest one page fetch may take. */
export const FETCH_TIMEOUT_MS = 12_000;

/** Most bytes we will pull down for one page. Past this it is a download, not a source. */
export const MAX_PAGE_BYTES = 3_000_000;

/** Most characters of extracted text we will rank over. */
const MAX_TEXT_CHARS = 400_000;

/**
 * Passage sizing, in characters. Roughly a paragraph: big enough to quote, small enough to
 * rank.
 *
 * Two floors rather than one, and the difference between them is load-bearing. `GLUE_TARGET`
 * is how much text is accumulated before a run of short lines is allowed to end — it keeps a
 * page built out of one-sentence divs from becoming hundreds of unrankable fragments.
 * `MIN_PASSAGE` is the much lower bar a finished passage has to clear to be kept at all,
 * and it is low because the sentence that settles a claim is sometimes the whole paragraph:
 * "Coverage fell to 58% in 2023." is 29 characters, is the entire finding, and would be
 * thrown away by a floor set where the glue target is. Below `MIN_PASSAGE` what is left is
 * navigation and captions — "Read more", "Share" — which have no room to support anything.
 */
const GLUE_TARGET_CHARS = 120;
const MIN_PASSAGE_CHARS = 25;
const MAX_PASSAGE_CHARS = 1_200;

/** How many passages get embedded. The cap is a quota and latency decision, not a quality one. */
const MAX_EMBEDDED_PASSAGES = 60;

/** A passage scoring below this is not a hit, however many were asked for. */
const RELEVANCE_FLOOR = 0.3;

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

export class PageFindError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "PageFindError";
    this.retryable = retryable;
  }
}

/* ---------------- getting the text out of the page ---------------- */

/** Elements whose contents are never prose. Removed wholesale, contents and all. */
const DROPPED_ELEMENTS =
  /<(script|style|noscript|template|svg|canvas|iframe|form|select|button|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Elements that end a paragraph. Turned into breaks so passages split where the page does. */
const BLOCK_BOUNDARY =
  /<\/?(p|div|section|article|header|h[1-6]|li|ul|ol|tr|td|th|table|blockquote|pre|br|dd|dt|dl|figcaption|main)\b[^>]*>/gi;

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…",
  deg: "°", euro: "€", pound: "£", times: "×", middot: "·", eacute: "é", egrave: "è",
};

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (match, entity) => {
    const key = entity.toLowerCase();
    if (key in NAMED_ENTITIES) return NAMED_ENTITIES[key];
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * HTML to readable text.
 *
 * Regexes rather than a parser, for the same reason `search.js` parses DuckDuckGo the same
 * way: `web/` has no dependencies, and the failure mode of this approach is text with some
 * junk in it rather than a crash. Junk in a passage costs the ranking a little precision;
 * a parser dependency costs the deployment story.
 *
 * The <title> is pulled out separately rather than left in the body text, because it is
 * the one line that reliably names what the page is about and it belongs in the tool
 * result's header — where the model reads it as context for every passage below it —
 * rather than competing with those passages in the ranking.
 */
export function htmlToText(html) {
  const source = String(html ?? "");
  const title = decodeEntities(
    (source.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim(),
  );

  const text = decodeEntities(
    source
      // Scripts and styles go **before** comments, and the order is not cosmetic. A
      // `<script type="application/json">` — Wikipedia ships a large one — can contain the
      // characters `<!--` inside a string value. Stripping comments first then deletes
      // everything from there to the next `-->`, which takes the script's own closing tag
      // with it; what is left no longer matches as a script element, and several kilobytes
      // of raw JSON survive into the passages. It ranked well, too, which is how it was
      // found: a "passage" of wikitext markup came back as the fourth-best answer.
      .replace(DROPPED_ELEMENTS, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(BLOCK_BOUNDARY, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    // Reference superscripts, and the wiki furniture around them.
    //
    // A bracketed number in page text is a collision with this app's own citation syntax,
    // and that makes it a correctness problem rather than a tidiness one: the model is
    // encouraged to quote passages verbatim, so a passage carrying Wikipedia's `[ 108 ]`
    // puts `[108]` in the answer — where the audit reads it as a citation of a source that
    // does not exist, and rightly fails the answer for fabricating one. The page's own
    // footnote numbers mean nothing here anyway; the citation is the page.
    .replace(/\[\s*\d+\s*\]/g, " ")
    .replace(/\[\s*(?:citation needed|edit|sic|clarify|when\?|who\?|note \d+)\s*\]/gi, " ")
    // Non-breaking and zero-width space are invisible in the page and would otherwise
    // survive tokenisation as part of a word.
    .replace(/[\u00a0\u200b\ufeff]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();

  return { title, text: text.slice(0, MAX_TEXT_CHARS) };
}

/**
 * Split text into rankable passages.
 *
 * Paragraph-first, because a paragraph is the unit a page's author already decided was one
 * thought. Two adjustments to that:
 *
 * - Runs of short lines are glued together. Pages built out of one-sentence divs — most
 *   news sites, and every page with a bullet list in it — would otherwise produce hundreds
 *   of fragments, each too small to score against anything and each too small to quote.
 * - Long paragraphs are cut at sentence boundaries. A 4,000-character block scores as a
 *   weak match for everything, and quoting the whole of it back is not a quote.
 */
export function extractPassages(text) {
  const blocks = [];
  let buffer = "";

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) blocks.push(trimmed);
    buffer = "";
  };

  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    buffer = buffer ? `${buffer} ${trimmed}` : trimmed;
    if (buffer.length >= GLUE_TARGET_CHARS && /[.!?:;"'”’)]$/.test(trimmed)) flush();
    else if (buffer.length >= MAX_PASSAGE_CHARS) flush();
  }
  flush();

  const passages = [];
  for (const block of blocks) {
    for (const piece of splitLong(block)) {
      // Below the floor a "passage" is a nav label, a byline or a caption fragment. It has
      // no room to support a claim, and letting one win a ranking would hand the model a
      // citation pointing at "Read more".
      if (piece.length < MIN_PASSAGE_CHARS) continue;
      passages.push(prepare(piece, passages.length));
    }
  }
  return passages;
}

function splitLong(block) {
  if (block.length <= MAX_PASSAGE_CHARS) return [block];
  const pieces = [];
  let current = "";
  // Same sentence rule as the citation auditor: a terminator followed by whitespace and a
  // capital. Splitting on bare periods would cut "1.2 million" and "Dr. Fauci" in half.
  for (const sentence of block.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)) {
    if (current && current.length + sentence.length > MAX_PASSAGE_CHARS) {
      pieces.push(current.trim());
      current = "";
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

/** A passage with everything the scorers need precomputed, since each is scored many times. */
function prepare(text, index) {
  const tokens = tokenise(text);
  const terms = new Set(tokens);
  const firstAt = new Map();
  for (const [position, token] of tokens.entries()) {
    if (!firstAt.has(token)) firstAt.set(token, position);
  }
  return { index, text, tokens, terms, firstAt, normalised: tokens.join(" ") };
}

/* ---------------- fetching ---------------- */

/** Content types worth extracting text from. Anything else is a download, not a source. */
const READABLE_TYPE = /^(?:text\/|application\/(?:xhtml\+xml|xml|json))/i;

export async function fetchPage(url, { fetchImpl = fetch, signal, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const timer = new AbortController();
  const onAbort = () => timer.abort();
  if (signal?.aborted) timer.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => timer.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: timer.signal,
    });

    if (!response.ok) {
      throw new PageFindError(
        `Could not open the page: HTTP ${response.status}. The search snippet is all this ` +
          `source can support — cite it for no more than that, or find another source.`,
        { retryable: response.status >= 500 || response.status === 429 },
      );
    }

    const type = response.headers?.get?.("content-type") ?? "";
    if (type && !READABLE_TYPE.test(type)) {
      throw new PageFindError(
        `That URL is ${type.split(";")[0]}, not a readable page — most likely a PDF or a ` +
          `media file. Nothing can be quoted from it here.`,
      );
    }

    // Checked before the body is read where the server declares it, so an enormous page is
    // refused rather than buffered. The same cap is applied to what actually arrived,
    // because `content-length` is absent on every chunked response.
    const declared = Number(response.headers?.get?.("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
      throw new PageFindError("That page is too large to read.");
    }

    const body = await response.text();
    if (body.length > MAX_PAGE_BYTES) {
      throw new PageFindError("That page is too large to read.");
    }
    return htmlToText(body);
  } catch (error) {
    if (error instanceof PageFindError) throw error;
    if (signal?.aborted) throw error;
    if (timer.signal.aborted) {
      throw new PageFindError(
        `The page did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        { retryable: true },
      );
    }
    throw new PageFindError(`Could not fetch the page: ${error.message}`, { retryable: true });
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
  }
}

/* ---------------- ranking ---------------- */

/**
 * How the two signals are weighted when both are available.
 *
 * Lexical carries slightly more, and the reason is the job: a fact-check turns on figures,
 * dates and names, which are exactly what lexical matching is good at and exactly what a
 * paraphrase-tolerant embedding will happily match to the wrong number. Semantic is the
 * recall half — it puts the right paragraph in the running when the wording has nothing in
 * common — and it is weighted like it.
 */
const LEXICAL_WEIGHT = 0.55;
const SEMANTIC_WEIGHT = 0.45;

/** A verbatim phrase match is decisive, not merely helpful. See `phraseHit`. */
const PHRASE_BONUS = 0.25;

/**
 * Rank passages against a query using whichever signals are available.
 *
 * @returns `{passages, semantic}` — `semantic` says whether the embedding half ran, which
 *   the tool result passes on to the model. A find that was lexical-only is a weaker
 *   negative result: "not on this page" from half the ranking deserves less confidence
 *   than "not on this page" from both halves, and the model is told which it got.
 */
export async function rankPassages(
  query,
  passages,
  { apiKey, fetchImpl = fetch, signal, limit = 4, embedImpl = embedTexts, vectors: cachedVectors } = {},
) {
  const terms = queryTerms(query);
  const weights = idfWeights(terms, passages);

  const scored = passages.map((passage) => {
    const { score, matched } = lexicalScore(terms, weights, passage);
    return { passage, lexical: score, matched, semantic: 0 };
  });

  // Only the lexically plausible passages are embedded. Embedding a whole page is the
  // slowest and most expensive thing this file can do, and the passages that score zero on
  // every query term are almost never the answer — but "almost never" is why the shortlist
  // is generous rather than tight, and why it falls back to the head of the page when
  // nothing matched a word at all.
  const shortlist = shortlistFor(scored);

  let vectors = cachedVectors ?? null;
  if (!vectors && apiKey && shortlist.length > 0) {
    vectors = await embedImpl(
      [query, ...shortlist.map((entry) => entry.passage.text)],
      { apiKey, fetchImpl, signal },
    );
  }

  let semantic = false;
  if (vectors && vectors.length === shortlist.length + 1) {
    semantic = true;
    const [queryVector, ...passageVectors] = vectors;
    for (const [index, entry] of shortlist.entries()) {
      entry.semantic = similarity(queryVector, passageVectors[index]);
    }
  }

  const results = [];
  for (const entry of scored) {
    const phrase = phraseHit(query, entry.passage);
    const blended = semantic
      ? entry.lexical * LEXICAL_WEIGHT + entry.semantic * SEMANTIC_WEIGHT
      : entry.lexical;
    const score = Math.min(1, blended + (phrase ? PHRASE_BONUS : 0));
    if (score < RELEVANCE_FLOOR) continue;
    results.push({
      text: entry.passage.text,
      score: Number(score.toFixed(3)),
      lexical: Number(entry.lexical.toFixed(3)),
      semantic: semantic ? Number(entry.semantic.toFixed(3)) : null,
      phrase,
      matched: entry.matched,
      position: entry.passage.index,
    });
  }

  results.sort((a, b) => b.score - a.score || a.position - b.position);
  return { passages: results.slice(0, limit), semantic, terms };
}

function shortlistFor(scored) {
  const withHits = scored.filter((entry) => entry.lexical > 0);
  const pool = withHits.length > 0 ? withHits : scored;
  return [...pool]
    .sort((a, b) => b.lexical - a.lexical || a.passage.index - b.passage.index)
    .slice(0, MAX_EMBEDDED_PASSAGES);
}

/**
 * One page, fetched and parsed once per turn.
 *
 * The model is expected to come back to the same page for a second claim — that is the
 * point of reading a source rather than searching again — and re-fetching and re-splitting
 * it for each question would spend the reader's time re-doing settled work. Embeddings are
 * deliberately *not* cached alongside, because they are computed against a specific query
 * and reusing them would answer the second question with the first one's ranking.
 */
export class PageCache {
  constructor({ fetchImpl = fetch, signal, fetchPageImpl = fetchPage } = {}) {
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.fetchPageImpl = fetchPageImpl;
    this.pages = new Map();
  }

  /** @returns `{title, text, passages}`. Throws `PageFindError`; a failure is not cached. */
  async load(url) {
    let pending = this.pages.get(url);
    if (!pending) {
      pending = (async () => {
        const { title, text } = await this.fetchPageImpl(url, {
          fetchImpl: this.fetchImpl,
          signal: this.signal,
        });
        const passages = extractPassages(text);
        return { title, text, passages };
      })();
      pending.catch(() => this.pages.delete(url));
      this.pages.set(url, pending);
    }
    return pending;
  }
}

/**
 * Run one find: open the page, rank its passages, hand back the ones that match.
 *
 * @returns `{url, find, claim, title, passages, semantic, passageCount}`. An empty
 *   `passages` is a real and useful answer — this page does not say that — and is
 *   reported as such rather than as a failure.
 */
export async function findInPage(
  { url, find, claim, max_passages: maxPassages = 4 },
  { apiKey, fetchImpl = fetch, signal, cache, embedImpl = embedTexts } = {},
) {
  const pages = cache ?? new PageCache({ fetchImpl, signal });
  const page = await pages.load(url);

  if (page.passages.length === 0) {
    throw new PageFindError(
      "That page has no readable text — it is probably rendered by JavaScript, or is a " +
        "video or image page. Nothing can be quoted from it.",
    );
  }

  const { passages, semantic } = await rankPassages(find, page.passages, {
    apiKey,
    fetchImpl,
    signal,
    limit: maxPassages,
    embedImpl,
  });

  return {
    url,
    find,
    claim,
    title: page.title,
    passages,
    semantic,
    passageCount: page.passages.length,
  };
}
