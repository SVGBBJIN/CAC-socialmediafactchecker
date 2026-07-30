// Citation cleanup — the pass between the answer the model wrote and the answer the reader
// is shown, and now the only thing standing between the two.
//
// Most of what it does is copy-editing. A model told to cite its sources will cite them
// several times over, because nothing in the prompt punishes over-citation and it would be
// a bad idea if it did — a checker that penalised extra markers would teach the model to
// use fewer, and of the two failures under-citation is by far the one that matters. So the
// answers arrive reading like this:
//
//     The agency revised the figure down to 4.2% [1][2][3]. That revision was published in
//     March [1][3][2], after the review closed [2][2].
//
// Every marker there is real. Collectively they are noise: they push the eye off the
// sentence, they imply three independent confirmations where there is one page found by
// three queries, and they make the one marker that *does* add a second source
// indistinguishable from the two that don't. So this pass does what a copy editor does —
// removes what repeats, merges what is secretly the same page, caps what has run away, and
// renumbers so the markers ascend as they are read.
//
// One thing it does is not copy-editing. A marker naming a number the ledger does not have
// is a citation to a page that was never retrieved, and it is **deleted**. That used to be
// an auditor's job, and the auditor's remedy was to reject the whole answer, make the model
// write it again and label the result *Unverified* — see the note at the top of
// citations.js for why that is gone. Deleting the four characters achieves what the banner
// was for, which is that no unopenable citation reaches the reader.
//
// Three rules govern the whole file:
//
//   1. **Never invent a marker, and never take the last real one off a sentence.** Every
//      removal here is either a marker another marker on the same sentence makes redundant,
//      or one that pointed at nothing in the first place.
//   2. **Only ever change markers.** The prose the model wrote comes out byte-identical
//      apart from the markers and the whitespace a removed marker leaves behind.
//   3. **Renumbering is a rename, applied everywhere at once.** The text and the source
//      list are rewritten from one mapping, so a marker cannot end up pointing at a
//      different page than it did a moment ago.

/**
 * Fenced blocks and inline code spans, which are not citation sites.
 *
 * `rows[1]` in a code sample is an array index, not a citation. This pass does not merely
 * read the answer, it rewrites it, so a marker matched inside a code sample would be
 * renumbered — or deleted, since no ledger has a source 1 for it — and the sample would
 * come out saying something else. The one thing this pass must never do is change what the
 * answer says.
 */
const CODE_REGION = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * Apply a rewrite to the prose of a text, leaving its code exactly as written.
 *
 * Splitting rather than masking, so the code comes back byte-identical: there is no
 * placeholder to be mangled by the rewrite and no substitution to get wrong on the way out.
 */
function outsideCode(text, rewrite) {
  let out = "";
  let start = 0;
  for (const match of String(text).matchAll(CODE_REGION)) {
    out += rewrite(text.slice(start, match.index));
    out += match[0];
    start = match.index + match[0].length;
  }
  return out + rewrite(text.slice(start));
}

/** Markers, matched as whole groups so `[1, 2]` and `[1][2]` are both one thing. */
const MARKER_GROUP = /\[\d+(?:\s*[,;]\s*\d+)*\](?:\s*\[\d+(?:\s*[,;]\s*\d+)*\])*/g;

/**
 * Most sources one sentence may cite.
 *
 * Two is the honest maximum for a single assertion: the source, and a second source
 * corroborating it. Past that the extra markers are not corroboration, they are the model
 * attaching everything it read to the sentence it read it for — and the reader, who cannot
 * tell the difference, stops following any of them. Three is allowed because a genuinely
 * contested figure sometimes needs a third, and because a cap that bites too often would
 * be cleanup deciding what the answer says.
 */
export const MAX_MARKERS_PER_SENTENCE = 3;

/** A model-written bibliography, from its heading to the end of the answer. */
const BIBLIOGRAPHY_HEADING =
  /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?(?:sources|references|citations|works cited|bibliography)(?:\*\*|__)?[ \t]*:?[ \t]*$/im;

/**
 * Sentence boundaries. Markers are deduplicated per sentence, so this decides the scope
 * within which a repeat counts as a repeat.
 */
const SENTENCE_BREAK =
  /(?<=[.!?])(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|Sen|Rep|Gov|Gen|St|Jr|Sr|vs|etc|al|Inc|Ltd|Co|No|Fig|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.)(?<!\b[A-Z]\.)["')\]]?\s+(?=["'(\[]?[A-Z0-9])/;

/**
 * The identity of a page, for deciding whether two sources are one.
 *
 * The ledger already collapses two searches that return a byte-identical URL. What it
 * cannot see is the same article reached by two spellings of its address — `?utm_source=`
 * on one, an AMP path on the other, a trailing slash, a fragment. Those arrive as separate
 * numbers, and a sentence citing both looks like two outlets agreeing when it is one page
 * cited twice. That is the most misleading form redundancy takes here, so it is the one
 * worth normalising for.
 */
export function canonicalURL(raw) {
  try {
    const url = new URL(String(raw));
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    url.protocol = "https:";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|ref_?$|ref_src|fbclid|gclid|mc_[a-z]+|igshid|si|s?cid|amp)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.pathname = url.pathname
      .replace(/\/amp\/?$/i, "/")
      .replace(/\.amp(?=$|\.)/i, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(raw).trim().toLowerCase();
  }
}

/**
 * Which ledger numbers are secretly the same page.
 *
 * @returns a Map from every number to the lowest number sharing its canonical URL. Numbers
 *   with no twin map to themselves, so callers can look up unconditionally.
 */
export function mergeMap(sources) {
  const canonical = new Map();
  const merge = new Map();
  for (const source of sources) {
    const key = canonicalURL(source.url);
    const first = canonical.get(key);
    if (first === undefined) {
      canonical.set(key, source.n);
      merge.set(source.n, source.n);
    } else {
      merge.set(source.n, first);
    }
  }
  return merge;
}

/** Every number in a marker group, in order, as written. */
function numbersIn(group) {
  const numbers = [];
  for (const match of group.matchAll(/\d+/g)) {
    const n = Number.parseInt(match[0], 10);
    if (Number.isFinite(n)) numbers.push(n);
  }
  return numbers;
}

/** Render a cleaned marker list the one way this app writes them. */
function formatMarkers(numbers) {
  return numbers.map((n) => `[${n}]`).join("");
}

/**
 * Strip a bibliography the model wrote itself.
 *
 * The prompt tells it not to, and mostly it doesn't. When it does, the list is dead weight:
 * every marker in the answer above is already a link to the page it names, so the list
 * repeats the whole evidence trail in plain text under an answer that had it inline — and
 * unlike the app's own list it is typed from memory, so it is the one place in the answer
 * where a URL can be subtly wrong. Removed rather than trusted.
 *
 * Only the tail is taken, and only when it is mostly citations: a section that goes on to
 * say something is not a bibliography, and cutting an answer short would be a far worse
 * bug than leaving a list in.
 */
export function stripModelBibliography(text) {
  const match = BIBLIOGRAPHY_HEADING.exec(text);
  if (!match) return { text, stripped: false };

  const head = text.slice(0, match.index);
  const tail = text.slice(match.index + match[0].length);
  const lines = tail.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { text: head.trimEnd(), stripped: true };

  // A line belongs to a bibliography if it is a numbered or bulleted entry, a bare URL, or
  // a marker line. Anything else means this heading introduced prose.
  const entryLike = lines.filter((line) =>
    /^(?:[-*+•]|\d+[.)]|\[\d+\])/.test(line) || /^https?:\/\//i.test(line),
  ).length;
  if (entryLike / lines.length < 0.7) return { text, stripped: false };

  return { text: head.trimEnd(), stripped: true };
}

/**
 * Tidy the citations in a finished answer.
 *
 * @param text the finished answer, as the model wrote it.
 * @param ledger the `CitationLedger` its markers refer to.
 * @returns `{text, sources, cited, changed, removed}` — `sources` is the bibliography in
 *   the new numbering and in the order the answer cites them, ready to be sent as-is;
 *   `removed` counts what was taken out, for the log and for tests.
 */
export function cleanCitations(text, ledger, { renumber = true } = {}) {
  const original = String(text ?? "");
  const removed = {
    duplicateMarkers: 0,
    mergedSources: 0,
    cappedMarkers: 0,
    // Markers naming a source that was never retrieved. Counted separately from the
    // redundancy tallies because it is a different event: the others tidy a real citation,
    // this one deletes an invented one. Worth having in the log.
    fabricatedMarkers: 0,
    bibliographyStripped: false,
  };

  const stripResult = stripModelBibliography(original);
  removed.bibliographyStripped = stripResult.stripped;
  let working = stripResult.text;

  const merge = mergeMap(ledger.sources);

  // Pass one: per sentence, so "already cited here" means what a reader would take it to
  // mean. A number repeated in the next sentence is not redundant — that sentence needs its
  // own source.
  working = outsideCode(working, (prose) =>
    prose
      .split("\n")
      .map((line) => cleanLine(line, { merge, ledger, removed }))
      .join("\n"),
  );

  // Pass two: renumber to what the answer actually cites, in the order it cites them.
  // Gaps are the visible residue of everything above — sources retrieved and not used,
  // duplicates merged away — and an answer whose markers run [2][5][9] invites the reader
  // to wonder what happened to the other six. Ascending from 1 is also simply how a
  // numbered citation is read: the first source you meet is [1].
  const order = [];
  outsideCode(working, (prose) => {
    for (const group of prose.match(MARKER_GROUP) ?? []) {
      for (const n of numbersIn(group)) {
        if (ledger.has(n) && !order.includes(n)) order.push(n);
      }
    }
    return prose;
  });

  let mapping = new Map(order.map((n) => [n, n]));
  if (renumber) mapping = new Map(order.map((n, index) => [n, index + 1]));

  if (renumber && order.length > 0) {
    working = outsideCode(working, (prose) =>
      prose.replace(MARKER_GROUP, (group) =>
        formatMarkers(numbersIn(group).map((n) => mapping.get(n) ?? n)),
      ),
    );
  }

  const byNumber = new Map(ledger.sources.map((source) => [source.n, source]));
  const sources = order.map((n) => ({ ...byNumber.get(n), n: mapping.get(n) }));

  return {
    text: working.trimEnd(),
    sources,
    cited: sources.map((source) => source.n),
    changed: working.trimEnd() !== original.trimEnd(),
    removed,
  };
}

/**
 * Clean the marker groups on one line, sentence by sentence.
 *
 * Lines are the unit above sentences because a list item is its own claim: two bullets
 * citing [4] are two assertions each needing a source, not one repeated.
 *
 * Split by offset rather than with `String.split`, because the boundary pattern *consumes*
 * characters — the whitespace, and a closing quote or bracket before it. Splitting and
 * rejoining on a single space would silently eat the quote off the end of `he said "it
 * fell."`, which is a cleanup pass corrupting an answer to tidy its citations.
 */
function cleanLine(line, { merge, ledger, removed }) {
  if (!line.includes("[")) return line;

  const boundary = new RegExp(SENTENCE_BREAK.source, "g");
  let out = "";
  let start = 0;
  for (let match = boundary.exec(line); match; match = boundary.exec(line)) {
    out += cleanSentence(line.slice(start, match.index), { merge, ledger, removed });
    out += match[0];
    start = match.index + match[0].length;
    boundary.lastIndex = start;
  }
  return out + cleanSentence(line.slice(start), { merge, ledger, removed });
}

function cleanSentence(sentence, { merge, ledger, removed }) {
  // Numbers already cited earlier in this sentence, in merged form.
  const seen = new Set();
  let kept = 0;

  return sentence.replace(MARKER_GROUP, (group) => {
    const out = [];
    for (const written of numbersIn(group)) {
      // A number outside the ledger names a source that was never retrieved, so it is
      // dropped — the one place this pass removes something for a reason other than
      // redundancy, and the reason is that a marker is a link. Every other marker in the
      // answer resolves to a page the reader can open; this one resolves to nothing, and
      // rendering it would put an unopenable citation in a fact-check, which is the single
      // worst thing this app can produce.
      //
      // It used to be left in place, because the audit reported it and the "Unverified"
      // banner needed the evidence to still be visible. There is no banner now — see the
      // note at the top of citations.js — so the honest handling is to take the fabrication
      // out rather than to publish it with a warning attached. The sentence keeps whatever
      // real markers it had; a sentence whose *only* marker was invented comes out
      // uncited, which is exactly what it always was.
      if (!ledger.has(written)) {
        removed.fabricatedMarkers += 1;
        continue;
      }

      const canonical = merge.get(written) ?? written;
      if (canonical !== written) removed.mergedSources += 1;

      if (seen.has(canonical)) {
        removed.duplicateMarkers += 1;
        continue;
      }
      if (kept >= MAX_MARKERS_PER_SENTENCE) {
        removed.cappedMarkers += 1;
        continue;
      }

      seen.add(canonical);
      kept += 1;
      out.push(canonical);
    }

    // Everything in the group was redundant — it repeats a marker already standing a few
    // words to the left, which is still there. Removing the group entirely is the point of
    // the pass; the sentence keeps its citation either way.
    return out.length === 0 ? "" : formatMarkers(out);
  })
    // A dropped group can leave a space before punctuation, or two spaces mid-sentence.
    .replace(/[ \t]+([.,;:!?)])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}
