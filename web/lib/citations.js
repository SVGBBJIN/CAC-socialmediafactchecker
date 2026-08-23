// The ledger: every source the model is allowed to cite, numbered as it comes back from
// the research tools.
//
// A marker is an address, and this is what it addresses. `[4]` means one specific page for
// the whole turn, because the number is assigned here, once, when the page is retrieved —
// the model never sees a source that isn't in this ledger, since the numbered entries
// returned by `record` *are* the tool's output. That is what lets `lib/citation-cleanup.js`
// turn a marker into a link and drop one that points nowhere.
//
// ## What used to be here, and why it isn't
//
// This file also held an auditor: it split the finished answer into sentences, guessed
// which of them asserted a checkable fact, and rejected the whole answer when one of those
// carried no marker — pulling the reply off the screen, forcing a rewrite, and labelling
// the result *Unverified*.
//
// The guess was the problem, and it was not fixable by improving the guess. "Which
// sentences are claims?" was answered with verdict vocabulary, attribution verbs, digits
// and capitalised words, and the shapes that trip those are not only claims. A greeting
// does: *I'll tell you whether it's accurate* has the verdict words, *Send me a TikTok
// link* has the proper noun. So typing "hi" got an answer that streamed in, vanished, came
// back rewritten, and carried a banner saying no search had been run. Each fix narrowed the
// heuristic and the next wording walked round it, because a regex cannot tell an offer to
// check something from a ruling on it.
//
// What replaced it costs nothing and cannot misfire: markers are matched against this
// ledger exactly, and one that names a source that was never retrieved is **removed from
// the answer** rather than reported as a crime. The reader is never shown a citation that
// leads nowhere, which is the outcome the audit existed to produce — reached by deleting
// four words instead of an answer. The searches themselves are shown as they run, and the
// sources are listed under the reply, so the evidence is on screen either way.

/** Markers look like `[1]`, `[1, 2]` or `[1][2]`. Captured together, split after. */
const MARKER_PATTERN = /\[(\d+(?:\s*[,;]\s*\d+)*)\]/g;

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
      `have been given, and do not state anything these sources do not support.\n\n` +
      `Format your response with bullet points when the claim has multiple parts or when ` +
      `checking sub-claims. Each bullet should end with a citation marker [n]. Use **bold** ` +
      `to highlight what part of the claim you are addressing in each bullet.`
    );
  }

  /**
   * The caption search's sources, as a note in the prompt rather than a tool result.
   *
   * This search was issued by the app before the model's first turn — see
   * lib/caption-search.js — so there is no `functionCall` for it to be the response to. It
   * arrives as prompt context instead, in the same bracketed shape `describeClip` and
   * `describeArticle` already use for everything else the app went and fetched on the
   * model's behalf.
   *
   * Two things it must say and `describe` does not. Where the sources came from, because
   * the model did not ask for them and unexplained numbered sources invite the assumption
   * that they are already-verified findings. And that they are *offered*, not binding: the
   * query came from a caption, which is a guess about what is worth checking, and a model
   * that felt obliged to use a bad guess would be worse off than one that searched for
   * itself. They cost nothing to ignore — they are already paid for.
   */
  static describePresearch(entries, searchResult) {
    if (entries.length === 0) return null;
    const lines = entries.map(
      (e) =>
        `[${e.n}] ${e.title}\n    ${e.url}\n    ${e.snippet || "(no snippet)"}${
          e.published ? `\n    published: ${e.published}` : ""
        }`,
    );
    return (
      `[Before you started, the app searched for the post's own caption and retrieved ` +
      `${entries.length} source${entries.length === 1 ? "" : "s"} (query: ` +
      `"${searchResult.query}", via ${searchResult.provider}, ${searchResult.retrievedAt}). ` +
      `They are numbered in the same ledger as anything you retrieve yourself and you may ` +
      `cite them the same way:\n\n${lines.join("\n\n")}\n\n` +
      `These are a head start, not an instruction. The caption is not always what the post ` +
      `is really claiming, so use the ones that actually bear on a claim you are checking ` +
      `and ignore the rest — an unused source costs nothing. Search for whatever they do ` +
      `not settle, and cite nothing they do not support.]`
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
    // Three states, not two, and they read very differently to the model. `semantic` true
    // is the strong case either way — meaning and wording agree. Lexical-only splits in
    // two: `semanticSkipped` is a *confident* result (the wording matched well enough on
    // its own that a second opinion was never asked for — see LEXICAL_CONFIDENT_SCORE in
    // lib/page-find.js), where plain "the semantic ranking was unavailable" would undersell
    // exactly the finding the model should trust most. The unqualified case — no key, no
    // shortlist, a failed batch — is the one that phrase was written for, and keeps it.
    const rankingNote = findResult.semantic
      ? "ranked by meaning and by wording"
      : findResult.semanticSkipped
        ? "matched confidently enough by wording alone that no further check was needed"
        : "ranked by wording only — the semantic ranking was unavailable";
    if (findResult.passages.length === 0) {
      // Unreachable in practice — a lexical match confident enough to skip embedding is
      // confident enough to clear the relevance floor — but handled rather than assumed,
      // since a scoring change elsewhere could make it possible.
      return (
        `Nothing on ${where} matches "${findResult.find}". The page was read in full ` +
        `(${findResult.passageCount} passages, ${rankingNote}).\n\n` +
        `This is a real finding about the page, not an error: it does not say what you were ` +
        `looking for. Do not cite [${entry.n}] for that claim.` +
        (findResult.semantic || findResult.semanticSkipped
          ? ""
          : " If the claim may be phrased very differently on the page, one search with other wording is worth a try.")
      );
    }

    const lines = findResult.passages.map(
      (passage, index) =>
        `[${entry.n}] passage ${index + 1} (relevance ${passage.score}${passage.phrase ? ", exact phrase match" : ""}):\n    “${passage.text}”`,
    );
    return (
      `Read ${where}\nLooking for: "${findResult.find}"\n` +
      `${findResult.passages.length} of ${findResult.passageCount} passages match (${rankingNote}).\n\n${lines.join("\n\n")}\n\n` +
      `This is the page's own text, quoted exactly. Cite it as [${entry.n}] — reading a page ` +
      `does not create a new source, so do not give it a new number. Quote it directly where ` +
      `the wording matters, and if these passages do not settle the claim, say so rather ` +
      `than reading more into them than they say.`
    );
  }
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
