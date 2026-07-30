// Fuzzy lexical matching — the half of the find that works with no network at all.
//
// This is the Ctrl+F part of Ctrl+F: find the words on the page. The reason it is not
// literally `indexOf` is that the words on the page are never quite the words in the
// question. A claim says "vaccination rate fell in 2023"; the page says "vaccine coverage
// declined through 2023". A name is transliterated differently, a figure is written
// "1.2 million" one place and "1,200,000" another, a plural is singular, a British
// spelling is American. An exact search returns nothing for every one of those and reports
// it as "not on the page", which is the worst possible answer for a fact-checker: it looks
// like evidence of absence.
//
// So matching is graded rather than binary, over three signals that fail differently:
//
//   - **Token overlap, IDF-weighted.** Words shared between query and passage, with rare
//     words counting for more than common ones. "the" appearing in both is not evidence.
//   - **Trigram similarity per token.** Catches the near-misses an exact match drops —
//     morphology, spelling drift, a typo in the query. This is what makes it fuzzy.
//   - **Phrase proximity.** Query words landing near each other in the passage beats the
//     same words scattered across it, because "declined in 2023" and a page that mentions
//     declines in one paragraph and 2023 in another are not the same finding.
//
// Nothing here is trained or configurable. It is arithmetic over one page's text, which
// is what lets it run in the same tick as the fetch and cost nothing when the embedding
// call fails.

/** Words carrying no discriminating power. Kept short — IDF handles the rest per page. */
const STOP_WORDS = new Set(
  ("a an the and or but if then than that this these those there here of in on at to from by for with " +
    "about into over after before between during without within is are was were be been being do does did " +
    "have has had will would shall should can could may might must it its as not no nor so such very " +
    "i you he she they we who whom which what when where why how also more most other some any each")
    .split(" "),
);

/** Fold to comparable shape: lowercase, de-accented, punctuation gone, digits grouped. */
export function tokenise(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // Thousands separators inside a number are formatting, not content: "1,200,000" and
    // "1200000" are the same figure, and a claim quoting one against a page printing the
    // other is exactly the case this file exists for.
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[^a-z0-9%.$€£\s-]/g, " ")
    .split(/[\s-]+/)
    .map((token) => token.replace(/^[.]+|[.]+$/g, ""))
    .filter(Boolean);
}

/** Content words only, deduplicated, for scoring a query against many passages. */
export function queryTerms(text) {
  const terms = [];
  const seen = new Set();
  for (const token of tokenise(text)) {
    if (STOP_WORDS.has(token)) continue;
    if (token.length < 2) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

/** Character trigrams of a token, padded so short tokens still produce some. */
export function trigrams(token) {
  const padded = `  ${token} `;
  const grams = new Set();
  for (let i = 0; i + 3 <= padded.length; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

/**
 * How alike two words are, from 0 to 1, by trigram Jaccard.
 *
 * Chosen over edit distance because it is symmetric, cheap, and forgiving of the specific
 * differences that show up here — a shared stem with a different ending scores high, two
 * unrelated words of the same length score near zero. An exact match short-circuits, which
 * is most calls.
 */
export function tokenSimilarity(a, b) {
  if (a === b) return 1;

  // A shared stem, floored rather than left to trigrams.
  //
  // This is the case trigram Jaccard is worst at and the case that matters most here:
  // "vaccine" against "vaccination" shares six leading characters and scores 0.4 on
  // trigrams, because the longer word's tail contributes grams the shorter one cannot
  // match. 0.4 is below any floor worth setting, so without this the two are simply
  // different words — and a claim about vaccination rates finds nothing on a page about
  // vaccine coverage, which is the exact failure this whole file exists to prevent.
  //
  // Six characters is the threshold because English inflection and derivation happen at
  // the end of a word: two words agreeing on their first six letters are variants of one
  // stem far more often than they are unrelated. Shorter prefixes are left to trigrams,
  // where "content"/"contest" correctly scores low.
  const prefix = commonPrefix(a, b);
  // One word is the whole of the other's beginning: "rate"/"rates", "decline"/"declined".
  // Checked first because it is the stronger signal of the two — an inflection, not merely
  // a shared stem — and it scores accordingly.
  if (prefix >= 4 && (prefix === a.length || prefix === b.length)) return 0.85;
  if (prefix >= 6 && a.length >= 6 && b.length >= 6) return 0.8;

  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.6) return 0;

  const left = trigrams(a);
  const right = trigrams(b);
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** How many leading characters two words agree on. */
function commonPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/** Below this, two words are different words and the match is noise. */
const FUZZY_FLOOR = 0.55;

/**
 * Inverse document frequency for each query term, over the passages being searched.
 *
 * A term appearing in every passage on the page tells you nothing about which passage to
 * read — which is exactly the situation for the subject of the page. Search a page about
 * the CDC for "CDC vaccination schedule" and without this every passage ties on "CDC";
 * with it, "schedule" decides the ranking, which is what the reader asked about.
 */
export function idfWeights(terms, passages) {
  const total = Math.max(passages.length, 1);
  const weights = new Map();
  for (const term of terms) {
    let containing = 0;
    for (const passage of passages) {
      if (passage.terms.has(term)) containing += 1;
    }
    // +1 top and bottom keeps this positive and finite for a term in every passage.
    weights.set(term, Math.log((total + 1) / (containing + 1)) + 0.25);
  }
  return weights;
}

/**
 * Score one passage against one query, and say which words matched.
 *
 * @returns `{score, matched}` — `score` in [0, 1], `matched` the query terms that were
 *   found, which is what lets the tool result tell the model *why* a passage came back.
 */
export function lexicalScore(terms, weights, passage) {
  if (terms.length === 0) return { score: 0, matched: [] };

  const tokens = passage.tokens;
  let earned = 0;
  let possible = 0;
  const matched = [];
  const hitPositions = [];

  for (const term of terms) {
    const weight = weights.get(term) ?? 1;
    possible += weight;

    let best = 0;
    let bestAt = -1;
    if (passage.terms.has(term)) {
      best = 1;
      bestAt = passage.firstAt.get(term) ?? -1;
    } else {
      // No exact hit: this is where fuzzy earns its place. Only tokens of a plausibly
      // similar length are compared, so this stays linear-ish in practice.
      for (let i = 0; i < tokens.length; i += 1) {
        const score = tokenSimilarity(term, tokens[i]);
        if (score > best) {
          best = score;
          bestAt = i;
          if (best === 1) break;
        }
      }
      if (best < FUZZY_FLOOR) best = 0;
    }

    if (best > 0) {
      earned += weight * best;
      matched.push(term);
      if (bestAt >= 0) hitPositions.push(bestAt);
    }
  }

  if (earned === 0) return { score: 0, matched: [] };
  const coverage = earned / possible;

  // Proximity: the tighter the window containing the matches, the more likely they are
  // one statement rather than one page.
  let proximity = 0;
  if (hitPositions.length > 1) {
    hitPositions.sort((a, b) => a - b);
    const span = hitPositions.at(-1) - hitPositions[0] + 1;
    proximity = Math.min(1, hitPositions.length / span);
  }

  return { score: Math.min(1, coverage * 0.85 + proximity * 0.15), matched };
}

/**
 * Does the passage contain the query more or less verbatim?
 *
 * A separate signal from the graded one above, and deliberately strict. When a claim turns
 * on an exact figure or a quote, the passage printing it word for word is not merely the
 * best fuzzy match available — it is the answer, and it must not lose a ranking to three
 * paraphrases that each half-match. This is the bonus that guarantees it doesn't.
 */
export function phraseHit(query, passage) {
  const needle = tokenise(query).join(" ");
  if (needle.length < 8) return false;
  return passage.normalised.includes(needle);
}
