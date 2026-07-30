// The rule this file exists to enforce: **no claim without a citation, and no citation
// without a source that was actually retrieved.**
//
// A system prompt asking for citations gets citations most of the time. Most of the time
// is the wrong bar for a fact-checker, and the failure is invisible — a fabricated `[3]`
// looks exactly like a real one, and an uncited verdict reads more confident than a cited
// one, not less. So the prompt is the instruction and this is the check: every source the
// model is allowed to cite is recorded in a ledger as it comes back from the search tool,
// and the finished answer is audited against that ledger before the turn is allowed to end.
//
// Two failure modes are caught here, and they are different crimes:
//
//   - **Uncited claim** — an assertion with no marker. The reader cannot check it.
//   - **Unknown source** — a `[7]` when seven sources were never retrieved, or a bare URL
//     no search returned. The reader *thinks* they can check it. This is the worse one.

/** Markers look like `[1]`, `[1, 2]` or `[1][2]`. Captured together, split after. */
const MARKER_PATTERN = /\[(\d+(?:\s*[,;]\s*\d+)*)\]/g;

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"']+/g;

/**
 * The sources the model may cite, numbered in the order they were retrieved.
 *
 * Numbering is global across the turn and never reused: the model sees `[4]` attached to
 * one specific page for the whole conversation, so a marker means the same thing in the
 * answer as it did in the search result.
 */
export class CitationLedger {
  constructor() {
    this.sources = [];
    this.searches = [];
    this.finds = [];
    this.byURL = new Map();
  }

  get size() {
    return this.sources.length;
  }

  /**
   * File one search's results. Returns the numbered entries, which is what gets handed
   * back to the model — the model never sees a source that isn't in the ledger, because
   * this return value *is* the tool's output.
   */
  record(searchResult) {
    const entries = [];
    for (const result of searchResult.results) {
      const existing = this.byURL.get(result.url);
      if (existing) {
        // Same page found by two searches: one number, both claims attached to it.
        if (!existing.claims.includes(searchResult.claim)) existing.claims.push(searchResult.claim);
        entries.push(existing);
        continue;
      }
      const entry = {
        n: this.sources.length + 1,
        ...result,
        claims: [searchResult.claim],
        query: searchResult.query,
        provider: searchResult.provider,
        retrievedAt: searchResult.retrievedAt,
      };
      this.sources.push(entry);
      this.byURL.set(entry.url, entry);
      entries.push(entry);
    }
    this.searches.push({
      query: searchResult.query,
      claim: searchResult.claim,
      provider: searchResult.provider,
      resultCount: entries.length,
    });
    return entries;
  }

  /**
   * The ledger entry for a URL, or `undefined`.
   *
   * This is the gate on `find_in_page`: the page reader is only allowed to open a page some
   * search already returned, so the passages it quotes hang off a source that already has a
   * number. A find on an arbitrary URL would hand the model quotable text with no entry
   * here — citable by no marker, and therefore uncitable — which is the hole the ledger
   * exists to close.
   */
  find(url) {
    const raw = String(url ?? "").trim();
    return this.byURL.get(raw) ?? this.byURL.get(raw.replace(/[.,;:)\]]+$/, ""));
  }

  /**
   * File the passages one in-page find pulled out of a source.
   *
   * They are kept on the source rather than only shown to the model because they are the
   * strongest thing this app ever holds about a citation: not "this page was returned for
   * this query" but "this page says these words". The claim is recorded too, exactly as a
   * search's is — reading a page to check a claim is checking it.
   *
   * @returns the source entry, now carrying `passages`.
   */
  recordFind(findResult) {
    const entry = this.find(findResult.url);
    if (!entry) return undefined;
    if (!entry.claims.includes(findResult.claim)) entry.claims.push(findResult.claim);
    entry.passages ??= [];
    for (const passage of findResult.passages ?? []) {
      // The same paragraph can be the best answer to two different questions about a page.
      // Filed once.
      if (!entry.passages.some((existing) => existing.text === passage.text)) {
        entry.passages.push({ text: passage.text, score: passage.score, find: findResult.find });
      }
    }
    this.finds.push({
      url: findResult.url,
      find: findResult.find,
      claim: findResult.claim,
      n: entry.n,
      passageCount: findResult.passages?.length ?? 0,
    });
    return entry;
  }

  has(n) {
    return n >= 1 && n <= this.sources.length;
  }

  hasURL(url) {
    return this.byURL.has(url) || this.byURL.has(url.replace(/[.,;:)\]]+$/, ""));
  }

  /** The tool result, as the model reads it. Numbers first — they're the point. */
  static describe(entries, searchResult) {
    if (entries.length === 0) {
      return (
        `No results for "${searchResult.query}". This claim is NOT verified. Try a different ` +
        `query, or tell the user the claim could not be checked — do not assert it either way.`
      );
    }
    const lines = entries.map(
      (e) =>
        `[${e.n}] ${e.title}\n    ${e.url}\n    ${e.snippet || "(no snippet)"}${
          e.published ? `\n    published: ${e.published}` : ""
        }`,
    );
    return (
      `${entries.length} source${entries.length === 1 ? "" : "s"} retrieved for the claim ` +
      `"${searchResult.claim}" (query: "${searchResult.query}", via ${searchResult.provider}, ` +
      `${searchResult.retrievedAt}).\n\n${lines.join("\n\n")}\n\n` +
      `Cite these by number. ${
        entries.length === 1 ? "[1] refers" : `[${entries[0].n}]–[${entries.at(-1).n}] refer`
      } to the pages above and to nothing else. Do not cite a number outside the range you ` +
      `have been given, and do not state anything these sources do not support.`
    );
  }

  /**
   * One find's passages, as the model reads them.
   *
   * Written to make the passages the evidence and the marker their address. Two details
   * carry weight:
   *
   * - Every passage is prefixed with the *same* number, the one the page already had. A
   *   find retrieves no new source — it reads one — so it must not look like it produced
   *   one, or the model will cite the reading separately from the page.
   * - An empty result is stated as a finding about the page rather than as a failure, and
   *   the model is told which ranking produced it. "Not on this page" from both halves of
   *   the ranking is worth acting on; from the lexical half alone it is worth one more
   *   query with different wording before concluding anything.
   */
  static describeFind(entry, findResult) {
    const where = `[${entry.n}] ${entry.title} — ${entry.url}`;
    if (findResult.passages.length === 0) {
      return (
        `Nothing on ${where} matches "${findResult.find}". The page was read in full ` +
        `(${findResult.passageCount} passages${findResult.semantic ? ", ranked by meaning and by wording" : ", ranked by wording only — the semantic ranking was unavailable"}).\n\n` +
        `This is a real finding about the page, not an error: it does not say what you were ` +
        `looking for. Do not cite [${entry.n}] for that claim.` +
        (findResult.semantic ? "" : " If the claim may be phrased very differently on the page, one search with other wording is worth a try.")
      );
    }

    const lines = findResult.passages.map(
      (passage, index) =>
        `[${entry.n}] passage ${index + 1} (relevance ${passage.score}${passage.phrase ? ", exact phrase match" : ""}):\n    “${passage.text}”`,
    );
    return (
      `Read ${where}\nLooking for: "${findResult.find}"\n` +
      `${findResult.passages.length} of ${findResult.passageCount} passages match${
        findResult.semantic ? "" : " (ranked by wording only — the semantic ranking was unavailable)"
      }.\n\n${lines.join("\n\n")}\n\n` +
      `This is the page's own text, quoted exactly. Cite it as [${entry.n}] — reading a page ` +
      `does not create a new source, so do not give it a new number. Quote it directly where ` +
      `the wording matters, and if these passages do not settle the claim, say so rather ` +
      `than reading more into them than they say.`
    );
  }
}

/**
 * Split into sentences, skipping the parts of an answer that aren't prose.
 *
 * Fenced code, the Sources list at the end, and markdown headings are excluded: none of
 * them are places a claim gets made, and auditing them produces noise that trains the
 * model to sprinkle markers where they mean nothing.
 */
/**
 * Where one sentence ends and the next begins.
 *
 * Whitespace after the terminator is required, which is what keeps `$1.5 billion` and
 * `4.2%` in one piece — a decimal point has no space after it. The abbreviations are the
 * remaining case that does have a space after the period; splitting on "Dr. Fauci" would
 * cut a sentence in half and leave both halves under the length floor, i.e. silently
 * unaudited. That is the failure mode to fear here: a splitter that produces fragments
 * doesn't report anything, it just stops checking.
 */
const SENTENCE_BREAK =
  /(?<=[.!?])(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|Sen|Rep|Gov|Gen|St|Jr|Sr|vs|etc|al|Inc|Ltd|Co|No|Fig|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.)(?<!\b[A-Z]\.)["')\]]?\s+(?=["'(\[]?[A-Z0-9])/;

/** Fenced code is not prose: neither its URLs nor its brackets are citations. */
function stripCode(text) {
  return String(text).replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

export function auditableSentences(text) {
  const withoutCode = stripCode(text);

  // Everything from a "Sources"/"References" heading onward is the bibliography.
  const bibliography = withoutCode.search(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:sources|references|citations)(?:\*\*)?\s*:?\s*$/im);
  const body = bibliography === -1 ? withoutCode : withoutCode.slice(0, bibliography);

  const sentences = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue; // Heading.
    if (/^\|/.test(line)) continue; // Table row — cells aren't sentences.
    if (/^>\s/.test(line)) continue; // Blockquote: quoted material, attributed by its lead-in.

    // Strip a list marker or a bold label so the sentence starts where the claim does.
    const content = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "");

    for (const part of content.split(SENTENCE_BREAK)) {
      const sentence = part.trim();
      if (sentence) sentences.push(sentence);
    }
  }
  return sentences;
}

/** Verdict vocabulary — the words that turn a sentence into a ruling. */
const VERDICT_PATTERN =
  /\b(?:true|false|misleading|accurate|inaccurate|incorrect|correct|debunked|unfounded|baseless|verified|confirms?|confirmed|refutes?|refuted|contradicts?|no evidence|does not support|out of context|misrepresents?|fabricated|exaggerat\w+)\b/i;

/** Attribution — a sentence putting words in someone's mouth needs a source most of all. */
const ATTRIBUTION_PATTERN =
  /\b(?:according to|reported|reports|said|says|stated|announced|found that|study|research|data|survey|poll|records?|court|ruling|filed|testified)\b/i;

/** Meta and hedging: sentences about the *answer* rather than about the world. */
const META_PATTERN =
  /^(?:here(?:'s| is| are)\b|i (?:searched|looked|checked|could not|couldn't|cannot|can't|don't|do not|wasn't|was not|found no)|let me\b|to summari[sz]e\b|in short\b|the (?:claim|video|post|clip|user)\b.{0,40}\b(?:asks?|says?|states?|claims?)\b|this (?:is|was) (?:a |an )?(?:mixed|complicated|nuanced)\b|note that\b|caveat\b|bottom line\b)/i;

/**
 * Self-reference and direct address: a sentence *about the conversation* rather than
 * about the world, even when it happens to name something proper-noun-shaped — the
 * app's own name, a platform it fetches video from, its own tools.
 *
 * This exists because of a sentence like "I'm Seer, a fact-checker." on a plain "hi": it
 * carries no verdict, no attribution and no digit, but "Seer" is capitalised and not the
 * sentence's first word, so the proper-noun fallback below used to wave it through as a
 * checkable claim — with nothing retrieved yet to cite, which is what turned a greeting
 * into a rejected answer, a rewrite, and an "Unverified: no search was run" banner. Same
 * failure for "Send me a TikTok or YouTube link" — an instruction, not an assertion.
 *
 * Deliberately narrower than `META_PATTERN`: it is only consulted *after* the
 * verdict/attribution/digit checks below have had their say, so a sentence that both
 * introduces itself and states something real — "I found that the WHO withdrew its
 * guidance," rare but possible — still needs its citation, via `ATTRIBUTION_PATTERN`.
 * What this pattern removes is specifically the case where a bare proper noun was the
 * *only* signal.
 */
const SELF_REFERENTIAL_PATTERN =
  /^(?:i(?:'m| am|'ll| will)\b|(?:hi|hello|hey|hiya|greetings|welcome)\b|(?:paste|send|share|drop|provide|attach|give) (?:me )?(?:a |an |the )?.{0,30}\b(?:link|url|video|post|clip|claim|screenshot|statement)\b|feel free to\b|go ahead and\b|what (?:(?:claim|video|post|clip) )?would you like\b)/i;

/**
 * Does this sentence assert something about the world that a reader could check?
 *
 * Deliberately not "every declarative sentence". An answer contains connective tissue —
 * "Here's what I found.", "The picture is mixed." — and demanding a citation on those
 * teaches the model to staple markers onto sentences that don't carry facts, which
 * devalues the markers that do. The signals below are what a checkable assertion looks
 * like: a ruling, an attribution, a number, a date, or a named entity.
 */
export function isCheckableClaim(sentence) {
  const trimmed = sentence.trim();
  if (trimmed.length < 25) return false;
  if (trimmed.endsWith("?")) return false; // A question asserts nothing.
  if (META_PATTERN.test(trimmed)) return false;

  const withoutMarkers = trimmed.replace(MARKER_PATTERN, " ").replace(URL_PATTERN, " ");

  if (VERDICT_PATTERN.test(withoutMarkers)) return true;
  if (ATTRIBUTION_PATTERN.test(withoutMarkers)) return true;
  if (/\d/.test(withoutMarkers)) return true; // Numbers, percentages, years, dates.

  // See `SELF_REFERENTIAL_PATTERN`: checked here, after every other signal has had a
  // chance to fire, so it only ever suppresses the proper-noun fallback immediately below.
  if (SELF_REFERENTIAL_PATTERN.test(trimmed)) return false;

  // A capitalised word that isn't the first word of the sentence: a person, place,
  // organisation or product is being named, and naming one is making a claim about it.
  const words = withoutMarkers.split(/\s+/).slice(1);
  return words.some((word) => /^[A-Z][a-zA-Z'’-]{2,}/.test(word));
}

/** Every citation number appearing in a piece of text. */
export function markersIn(text) {
  const numbers = [];
  for (const match of String(text).matchAll(MARKER_PATTERN)) {
    for (const part of match[1].split(/[,;]/)) {
      const n = Number.parseInt(part.trim(), 10);
      if (Number.isFinite(n)) numbers.push(n);
    }
  }
  return numbers;
}

/**
 * Hold a finished answer to the ledger.
 *
 * @returns `{ok, violations, cited, unused}`. `violations` is ordered worst-first, since
 *   the repair prompt built from it is read top-down and a fabricated citation is the
 *   thing most worth fixing.
 */
export function auditAnswer(text, ledger, { truncated = false } = {}) {
  const violations = [];
  const cited = new Set();
  // Code samples are excluded from every check below, including the URL one: a `curl` line
  // in an example is not a source being cited, and flagging it would fail answers for
  // showing their working.
  const answer = stripCode(text ?? "");

  // Fabricated numbers, checked over the whole answer including its Sources list — a
  // bibliography entry numbered beyond the ledger is as invented as one in the prose.
  const unknownNumbers = new Set();
  for (const n of markersIn(answer)) {
    if (ledger.has(n)) cited.add(n);
    else unknownNumbers.add(n);
  }
  for (const n of [...unknownNumbers].sort((a, b) => a - b)) {
    violations.push({
      type: "unknown_source",
      marker: n,
      message:
        `[${n}] does not exist. ${ledger.size === 0
          ? "No sources have been retrieved in this turn."
          : `Sources [1]–[${ledger.size}] are the only ones retrieved.`}`,
    });
  }

  // Bare URLs the search never returned. A plausible-looking link is the easiest thing
  // for a model to invent and the hardest thing for a reader to doubt.
  const unknownURLs = new Set();
  for (const match of answer.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;:)\]]+$/, "");
    if (!ledger.hasURL(url)) unknownURLs.add(url);
  }
  for (const url of unknownURLs) {
    violations.push({
      type: "unknown_url",
      url,
      message: `${url} was not returned by any search this turn. Link only to retrieved sources.`,
    });
  }

  // Uncited assertions.
  //
  // When the answer was cut off at the token cap, its final sentence is exempt. Not out of
  // leniency — it is the one sentence whose missing citation is *explained*, because the
  // marker goes at the end and the end is what got truncated. Reporting it as a citation
  // failure puts a second, more alarming banner next to the one that already says the
  // answer stops mid-thought, and blames the model for the cap. Every other sentence is
  // still held to the rule, and a fabricated citation still fails wherever it appears.
  const sentences = auditableSentences(answer);
  const exempt = truncated ? sentences.length - 1 : -1;
  const uncited = [];
  for (const [index, sentence] of sentences.entries()) {
    if (index === exempt) continue;
    if (!isCheckableClaim(sentence)) continue;
    if (markersIn(sentence).length > 0) continue;
    uncited.push(sentence);
  }
  for (const sentence of uncited) {
    violations.push({
      type: "uncited_claim",
      sentence,
      message: `No citation: "${truncate(sentence, 160)}"`,
    });
  }

  if (ledger.size === 0 && uncited.length > 0) {
    violations.unshift({
      type: "no_search",
      message:
        "This answer states facts but the web_search tool was never called, so nothing in " +
        "it is verified.",
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    cited: [...cited].sort((a, b) => a - b),
    unused: ledger.sources.filter((s) => !cited.has(s.n)).map((s) => s.n),
  };
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The correction handed back to the model when an answer fails the audit.
 *
 * Written as an instruction with the specific offending sentences in it, because "add
 * citations" produces a reshuffle and "this sentence has no source" produces a fix. It
 * offers two legitimate ways out, and the second matters most: if no source supports the
 * sentence, delete the sentence. An answer that says less is the correct outcome of a
 * failed verification, not a worse one.
 *
 * Searching is deliberately not among the options. This round has no tools — it is a
 * rewrite of an answer the model can see, from sources quoted underneath it — and offering
 * a way out that isn't there would produce a turn that asks for a search and never
 * answers.
 */
export function repairInstruction(violations, ledger) {
  const lines = [
    "STOP. Your previous answer failed the citation check and was not shown to the user.",
    "",
    "Problems found:",
  ];
  for (const violation of violations.slice(0, 12)) {
    lines.push(`- ${violation.message}`);
  }
  if (violations.length > 12) lines.push(`- …and ${violations.length - 12} more.`);

  lines.push(
    "",
    "Rewrite the whole answer. Every sentence that asserts a fact, a verdict, a number, a " +
      "date or something a named person or organisation said must end with a citation " +
      "marker for a source you actually retrieved.",
    ledger.size > 0
      ? `Valid markers this turn: [1]–[${ledger.size}]. Never write any other number, and never link to a URL that was not returned by a search.`
      : "You have retrieved no sources at all, so there is nothing you may assert about the world. Say so.",
    "",
    "You cannot search again — searching is over for this turn. So if a sentence has no " +
      "source behind it, you have two options and only two: attribute it explicitly to the " +
      "video or post being checked (which is the subject, not evidence), or delete the " +
      "sentence. Saying less is the right answer when the evidence is not there.",
    "",
    "Output only the rewritten answer. Do not mention this correction.",
  );
  return lines.join("\n");
}

/**
 * What the user sees when even the repair round failed.
 *
 * The answer still gets shown — a silently withheld reply is worse than a flagged one, and
 * the model may well be right — but it is shown carrying the label the check earned it.
 * The failure is never allowed to be invisible.
 */
export function unverifiedNotice(violations) {
  const kinds = new Set(violations.map((v) => v.type));
  const reasons = [];
  if (kinds.has("no_search")) reasons.push("no search was run");
  if (kinds.has("unknown_source") || kinds.has("unknown_url")) {
    reasons.push("it cites sources that were never retrieved");
  }
  if (kinds.has("uncited_claim")) {
    const count = violations.filter((v) => v.type === "uncited_claim").length;
    // The verb agrees too. Pluralising the noun and leaving "carry" gave "1 statement
    // carry no citation" — a small thing, on the one banner in the app whose whole job is
    // to be believed.
    reasons.push(count === 1 ? "1 statement carries no citation" : `${count} statements carry no citation`);
  }
  return `Unverified: ${reasons.join("; ")}. Treat the statements above as unchecked.`;
}
