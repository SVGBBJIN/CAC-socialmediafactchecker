// The corroboration check: does a *Corroborated* verdict actually rest on a source that
// confirms the claim, or only on one that is about the same subject?
//
// The failure this exists for is specific and it is the worst one this app can produce,
// because unlike a missing citation it looks right. A claim about who currently holds an
// office — "X is the Prime Minister" — gets checked, two sources come back and get cited,
// and the answer says **Corroborated**. The two sources are the Wikipedia article
// *Prime Minister of the United Kingdom* and a gov.uk page listing ministers: both are
// squarely on topic, neither one says X holds the job, and a reader who follows either
// link finds a page that confirms the office exists rather than the claim being made about
// it. Topical overlap was mistaken for confirmation.
//
// ## What this is, and what it deliberately is not
//
// It is not the sentence-level claim detector this codebase tore out (see the header of
// lib/citations.js). That guessed which sentences of already-written prose "looked like"
// claims, out of regexes over verdict words and capitalisation, and a greeting tripped it.
// Nothing here guesses at prose. It acts on three things the model was explicitly asked to
// write or the app itself retrieved:
//
//   1. the `[[claim: …]]` marker — the model's own statement of what this block checks,
//      parsed by `splitClaims`, the same function that renders the panes;
//   2. the `VERDICT:` line — the model's own statement of the finding;
//   3. the ledger — the pages the app fetched, and the text those pages actually returned.
//
// So the question asked is narrow and answerable without interpreting anything: *the model
// said this claim is confirmed and pointed at these pages — do those pages contain the
// thing the claim is specifically about?* The claim's specifics are its named entities and
// its numbers; a page whose title, snippet, URL and read passages never mention the person,
// place, organisation, figure or date the claim turns on has not confirmed it, whatever
// else it is about.
//
// ## What it does when the answer is no
//
// It rewrites that one claim's verdict to **Insufficient evidence** and says, in one
// app-voiced line, why. Three properties make that safe to do automatically:
//
//   - **It only ever moves in one direction.** Corroborated is the only verdict audited.
//     Contradicted, Disputed and Insufficient evidence are left exactly as written — this
//     cannot manufacture a finding, only withhold one the evidence does not carry.
//   - **It never un-draws anything.** Like `cleanCitations`, it runs on the finished text
//     and its result travels as the same `{type: "answer"}` replacement frame. There is no
//     rejection, no rewrite round, no banner over a withdrawn answer.
//   - **Insufficient evidence is a verdict the prompt already asks for**, in exactly this
//     situation: "I could not find a source for this" is stated there as a complete and
//     acceptable answer. A downgrade lands the claim where a compliant model would have
//     put it itself.
//
// The cost of a false downgrade is a claim that was true being reported as unsettled, with
// its sources still linked underneath. The cost of the false positive it prevents is a
// false claim stamped **Corroborated** in green. Those are not the same size, which is why
// the coverage rule below is strict about entities and why the whole thing is one-way.

import { markersIn } from "./citations.js";
import { splitClaims, VERDICTS } from "../public/claims.js";
import { tokenise, queryTerms, tokenSimilarity } from "./fuzzy.js";

/**
 * Words that are capitalised in a claim label without naming anything.
 *
 * Entity extraction below reads a run of capitalised words as a name. That is a good rule
 * on prose written about the world and a bad one at the start of a sentence, where every
 * sentence's first word is capitalised and most claim labels open with "The". These are
 * the words that get dropped from a run rather than being allowed to start one.
 */
const NOT_A_NAME = new Set(
  (
    "the a an and or but if then than that this these those there here it its it's he she they " +
    "we you i his her their our your my as at by for from in into of on to with without over " +
    "under about after before during between across per via is are was were be been being am " +
    "do does did done has have had having will would can could may might must shall should " +
    "not no nor only also just even still yet more most less least much many few several " +
    "said says say claims claim claimed states state stated asserts assert asserted argues " +
    "argue argued according reports report reported video clip post reel footage speaker " +
    "narrator caption text screen who what when where why how which whose whom"
  ).split(" "),
);

/**
 * Words that are long enough to look substantial and carry no fact.
 *
 * The term test below asks whether the source used the claim's own substantial words, and
 * these are the ones that would make it ask the wrong question. "Current", "reportedly" and
 * "actually" belong to the framing of a claim, not to what it asserts: a page confirming
 * who holds an office right now has no reason to print the word "current", and holding that
 * against it would downgrade a claim its source settles outright.
 */
const FRAMING_WORDS = new Set(
  (
    "current currently recent recently today yesterday tomorrow actually really apparently " +
    "allegedly reportedly supposedly according claimed claiming asserted stating another " +
    "several various certain entire single exactly always never sometimes almost nearly " +
    "around roughly approximately himself herself itself themselves something anything " +
    "everything nothing person people someone anyone number amount before during between " +
    "against because through without within among amongst towards despite unless whether " +
    "however therefore whereas although though besides instead rather across behind"
  ).split(" "),
);

/**
 * Alternate spellings that mean the same entity, so a source is not judged silent about
 * something it named a different way. Deliberately short: this is a list of abbreviations
 * whose expansion is unambiguous, not a synonym dictionary. Anything looser would start
 * matching pages that are merely adjacent again, which is the bug.
 */
const ENTITY_ALIASES = [
  ["uk", "united kingdom", "britain", "great britain"],
  ["us", "usa", "u s", "united states", "america"],
  ["eu", "european union"],
  ["un", "united nations"],
  ["nhs", "national health service"],
  ["who", "world health organization", "world health organisation"],
  ["cdc", "centers for disease control"],
  ["fbi", "federal bureau of investigation"],
  ["nasa", "national aeronautics and space administration"],
  ["pm", "prime minister"],
];

/** Normalised form → every normalised form that means the same thing, itself included. */
const ALIAS_INDEX = new Map();
for (const group of ENTITY_ALIASES) {
  for (const member of group) ALIAS_INDEX.set(member, group);
}

/**
 * Text as it is compared: lower case, punctuation flattened to spaces, spaces collapsed.
 *
 * Matching happens on this form for both halves — the claim's terms and the source's text
 * — so "U.S.", "U. S." and "US" are one string, `Sunak's` contains the token `sunak`, and
 * `4.2%` and `4.2 percent` both reduce to a `4.2` token. Curly quotes and dashes are
 * flattened for the same reason: a page and a claim label rarely agree about them, and
 * disagreeing about a dash is not disagreeing about a fact.
 */
export function normalize(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[‘’“”]/g, "'")
    .toLowerCase()
    // A thousands separator is formatting, not content: a claim writing 405,000 against a
    // page printing 405000 is not a disagreement about a figure. Same rule lib/fuzzy.js
    // applies, for the same reason.
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    // "Ireland's" names Ireland. Left in, the possessive becomes a stray "s" token and the
    // entity becomes a two-word phrase no page contains.
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9.]+/g, " ")
    // A period is kept above only so decimals survive; everywhere else it is a separator.
    .replace(/(\d)\.(?!\d)/g, "$1 ")
    .replace(/(^|\s)\.+|\.+(\s|$)/g, " ")
    .replace(/([a-z])\.([a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a normalised haystack contains a normalised phrase as whole words. */
function containsPhrase(haystack, phrase) {
  if (!phrase) return false;
  return ` ${haystack} `.includes(` ${phrase} `);
}

/** How many leading characters two words agree on. */
function commonPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Is this word of the claim's one of the words the source said?
 *
 * Exact first, then `tokenSimilarity` from lib/fuzzy.js — the same comparison the in-page
 * find ranks passages with, so "vaccine"/"vaccination" and "rate"/"rates" are one word here
 * exactly as they are there — and finally a shared four-letter stem, which catches the
 * derivations trigrams are worst at ("closure"/"closed"). The threshold is well above
 * `find_in_page`'s own floor: that one is ranking passages, where a loose match costs a
 * slightly worse ordering, and this one is deciding whether a source confirms a claim,
 * where a loose match costs the whole point of the check.
 */
function wordPresent(word, evidenceTokens) {
  if (evidenceTokens.has(word)) return true;
  for (const token of evidenceTokens) {
    if (tokenSimilarity(word, token) >= 0.8) return true;
    if (word.length >= 5 && token.length >= 5 && commonPrefix(word, token) >= 4) return true;
  }
  return false;
}

/**
 * A figure, stripped to what makes it that figure: `4.2%`, `$4.2` and `4,200` give `4.2`,
 * `4.2` and `4200`. Only a token that *starts* as a number is one — `covid19` is a word
 * with a digit in it, and reading `19` out of it would invent a figure the page never
 * quoted and then match a claim about the 19th of the month against it.
 */
function numeric(token) {
  const text = String(token).replace(/,/g, "");
  const match = text.match(/^[$€£]?(\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

/**
 * The claim's specifics: the named entities and the numbers it turns on.
 *
 * These are what make a claim a claim rather than a subject heading. "Prime Minister of the
 * United Kingdom" is a topic; "Rishi Sunak is the Prime Minister" is a claim, and the part
 * that makes it one is the name. Runs of capitalised words become entities (split at
 * lowercase joiners, so "Prime Minister of the United Kingdom" yields "Prime Minister" and
 * "United Kingdom" — two things a page can be checked for, rather than one long phrase that
 * only an exact copy would contain), quoted spans become entities too, and every number,
 * percentage, year and date-like figure becomes a required number.
 *
 * `terms` is everything else, filtered to the words long enough to be doing work. A claim
 * is not only its names: "Sunak said inflation halved" and "Sunak said inflation doubled"
 * name the same people and the same subject, and a source that settles one contradicts the
 * other. Six characters is where a word stops being scaffolding ("said", "this", "week")
 * and starts being the thing asserted, and `wordPresent` is forgiving enough about endings
 * that requiring them does not turn every paraphrase into a downgrade.
 */
export function claimSpecifics(claim) {
  const text = String(claim ?? "");
  const entities = [];
  const demoted = [];
  const seen = new Set();
  const add = (raw, { name = true } = {}) => {
    const value = normalize(raw);
    if (!value || value.length < 2 || seen.has(value)) return;
    // A run that survives normalisation as a single non-name word — "The", "Video" — is
    // capitalisation, not a name.
    if (!value.includes(" ") && NOT_A_NAME.has(value)) return;
    seen.add(value);
    // Two-letter entities — UK, US, EU, UN — are demoted to ordinary words rather than
    // required outright. A source can settle a claim about UK inflation without printing
    // "UK" anywhere the app can see (the Office for National Statistics does not caption
    // its own bulletins with the country), and requiring it downgrades claims their
    // sources plainly carry. Nothing is lost: what makes those claims specific is the
    // figure, the date or the person, all of which are still required.
    if (name && value.length > 2) entities.push(value);
    else demoted.push(value);
  };

  for (const quoted of text.matchAll(/["\u201c']([^"\u201d']{3,})["\u201d']/g)) add(quoted[1]);

  // A capitalised run, allowing internal lowercase joiners so "Bank of England" stays whole
  // before it is split; the split then drops the joiners.
  for (const run of text.matchAll(/\b[A-Z][\w'\u2019-]*(?:\s+(?:of|the|and|for|de|van|von|al)?\s*[A-Z][\w'\u2019-]*)*/g)) {
    // Every sentence's first word is capitalised, so a single capitalised word at the very
    // start of a claim is not evidence of a name — "Vaccines cause autism" opens with a
    // common noun, "Sunak resigned" with a surname, and nothing in the capitalisation tells
    // them apart. It becomes an ordinary word instead, which costs nothing: an ordinary
    // word is still required to appear, just under the rule for words rather than the rule
    // for names. An acronym (all capitals) is exempt — that is not sentence case.
    const opensClaim = run.index === 0 && !/\s/.test(run[0]) && run[0] !== run[0].toUpperCase();
    const parts = run[0]
      // "Germany's Angela Merkel" is two names, not one: the possessive joins them in the
      // sentence and nowhere else, and a page naming only the person would be judged silent
      // about a phrase that never appears anywhere.
      .split(/['\u2019]s\s+/)
      .join(" | ")
      .split(/\s*\|\s*|\s+(?:of|the|and|for|de|van|von|al)\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const part of parts) {
      const words = part.split(/\s+/).filter((word) => !NOT_A_NAME.has(normalize(word)));
      if (words.length > 0) add(words.join(" "), { name: !opensClaim });
    }
  }

  const numbers = [];
  // A figure, not a digit that happens to be inside a name: the 19 of COVID-19 and the 7 of
  // G7 are parts of words, and counting them as figures the source must quote would both
  // demand nonsense of the page and — because two matched figures relax the word rule below
  // — hand a claim a specificity it never had.
  for (const match of text.matchAll(/(?<![A-Za-z\d-])\d[\d,]*(?:\.\d+)?\b/g)) {
    const value = numeric(match[0]);
    if (value && !numbers.includes(value)) numbers.push(value);
  }

  const entityWords = new Set(entities.flatMap((entity) => entity.split(" ")));
  const terms = [...queryTerms(text), ...demoted].filter(
    (term) =>
      term.length >= 6 &&
      !/\d/.test(term) &&
      !entityWords.has(term) &&
      !NOT_A_NAME.has(term) &&
      !FRAMING_WORDS.has(term),
  );

  return { entities, numbers, terms: [...new Set(terms)] };
}

/**
 * Everything a source actually said, as one normalised string.
 *
 * Title, snippet, publication date, read passages, and the URL's own path — a slug is the
 * publisher's own description of the page and regularly names the subject the snippet
 * truncated away, so leaving it out would cost real matches for nothing.
 *
 * What is **not** in here is `entry.claims` and `entry.query`: those are the model's words,
 * the claim it went looking for. Counting them as evidence would let a claim confirm itself
 * — search for "X is Prime Minister", get any page back, and the claim text is in the
 * ledger entry. That is the exact circularity this module exists to break.
 */
export function sourceEvidenceText(entry) {
  const parts = [entry?.title, entry?.snippet, entry?.published, entry?.domain];
  try {
    if (entry?.url) parts.push(decodeURIComponent(new URL(entry.url).pathname));
  } catch {
    parts.push(entry?.url);
  }
  for (const passage of entry?.passages ?? []) parts.push(passage?.text);
  return normalize(parts.filter(Boolean).join(" "));
}

/** Whether an entity (or any spelling of it) appears in a source's evidence text. */
function entityCovered(evidence, evidenceTokens, entity) {
  const spellings = ALIAS_INDEX.get(entity) ?? [entity];
  for (const spelling of spellings) {
    if (containsPhrase(evidence, spelling)) return true;
  }
  const words = entity.split(" ");
  if (words.length === 1) return wordPresent(words[0], evidenceTokens);
  // A multi-word name is covered when the page names all of its parts, in whatever order
  // and whatever inflection — "Starmer, the prime minister" covers "Prime Minister" — or by
  // its distinctive part alone: a page that says "Sunak said" has named Rishi Sunak. Only
  // the last word qualifies for that, and only when it is long enough to be a name rather
  // than an initial or a particle.
  if (words.every((word) => wordPresent(word, evidenceTokens))) return true;
  const head = words.at(-1);
  return head.length > 3 && evidenceTokens.has(head);
}

/**
 * Does this source confirm this claim, or is it just about the same subject?
 *
 * Every name the claim gives and every figure it turns on has to appear in what the source
 * actually said — all of them, not a majority. A page that has the office but not the
 * officeholder, or the year but not the figure, is precisely the page that produced the bug
 * this file is named for. The claim's remaining words are required on the sliding scale
 * described at the bottom of the function, which is where the reasoning for it lives.
 *
 * A claim with nothing specific in it at all — no name, no figure, no substantial word —
 * cannot be checked this way, and is left alone rather than guessed at.
 *
 * @returns `{confirms, missing}` — `missing` is what the source never mentioned, which is
 *   what makes a downgrade explainable rather than mysterious.
 */
export function sourceConfirms(claim, entry) {
  const { entities, numbers, terms } = claimSpecifics(claim);
  if (entities.length === 0 && numbers.length === 0 && terms.length === 0) {
    return { confirms: true, missing: [] };
  }

  const evidence = sourceEvidenceText(entry);
  if (!evidence) return { confirms: false, missing: [...entities, ...numbers, ...terms] };
  const evidenceTokens = new Set();
  for (const token of tokenise(evidence)) {
    evidenceTokens.add(token);
    const figure = numeric(token);
    if (figure) evidenceTokens.add(figure);
  }

  const missingEntities = entities.filter((entity) => !entityCovered(evidence, evidenceTokens, entity));
  const missingNumbers = numbers.filter((number) => !evidenceTokens.has(number));
  const missingTerms = terms.filter((term) => !wordPresent(term, evidenceTokens));

  // Names and figures are required outright. Nothing else in a claim is as hard: a page
  // that never mentions the officeholder, the year, the sum or the person quoted is a page
  // about the subject, which is the whole failure this file exists to catch.
  //
  // The claim's other words are required on a sliding scale, because what they are worth as
  // evidence depends on what else already matched. A source that has matched two or more of
  // the claim's names and figures is demonstrably about this claim and not merely its
  // topic, and the remaining wording is then mostly the claim's phrasing: INPE reports
  // "11,568 km2 in the Brazilian Amazon" for a claim about square kilometres of rainforest,
  // and that is the same fact, differently written. Requiring the words there would
  // downgrade sources that settle the claim outright. At the other end, a claim with no
  // name and no figure in it at all — "vaccines cause autism" — has nothing but its words,
  // so all of them are required, and a page about vaccine safety that never says "autism"
  // does not confirm it. One matched name or figure sits between: half the words.
  //
  // What this scale does not do, at any setting, is decide entailment. A page reporting
  // that measles cases rose contains every name and figure of a claim that measles was
  // eradicated, and no amount of word-matching sees the contradiction. That is the model's
  // job, and the prompt says so; this pass is the backstop for the narrower failure it can
  // actually detect — a source that is not about this claim at all.
  const anchors = entities.length + numbers.length;
  const termsNeeded = anchors >= 2 ? 0 : anchors === 1 ? Math.ceil(terms.length / 2) : terms.length;
  const termsShort = terms.length - missingTerms.length < termsNeeded;

  const confirms = missingEntities.length === 0 && missingNumbers.length === 0 && !termsShort;
  return {
    confirms,
    missing: confirms ? [] : [...missingEntities, ...missingNumbers, ...(termsShort ? missingTerms : [])],
  };
}

/**
 * A normalised value, spelled the way the claim spelled it.
 *
 * Everything above compares lower-cased, punctuation-flattened text, which is right for
 * matching and wrong for a sentence the reader is about to read: "none of them mentions
 * rishi sunak" is the app showing its working rather than talking to anyone. Falls back to
 * the normalised form if the claim's own wording cannot be located, which it can be for
 * anything extracted from the claim in the first place.
 */
function asWritten(claim, value) {
  const pattern = value
    .split(" ")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^A-Za-z0-9]+");
  const match = String(claim ?? "").match(new RegExp(pattern, "i"));
  return match ? match[0] : value;
}

/**
 * The line a downgraded claim carries in place of the verdict it lost.
 *
 * App-voiced and marked as such, because it is the app talking and the reader is entitled
 * to know which sentence in front of them the model did not write. It names what the
 * sources never mentioned rather than only announcing a downgrade: "none of these mentions
 * Rishi Sunak" is checkable against the links directly underneath it, and a reader who
 * disagrees can see exactly what the check went looking for.
 */
function downgradeNote(claim, missing, cited) {
  if (cited.length === 0) {
    return (
      "\n\n*Checked by the app: this claim was marked corroborated without citing any of the " +
      "sources retrieved for it, so there is nothing here to check it against. Verdict " +
      "lowered to insufficient evidence.*"
    );
  }
  const named = missing
    .slice(0, 3)
    .map((value) => asWritten(claim, value))
    .join(" or ");
  return (
    "\n\n*Checked by the app: the sources cited above are on this subject but none of them " +
    (named ? `mentions ${named}, so ` : "confirms this specific claim, so ") +
    "they corroborate the topic rather than the claim. Verdict lowered to insufficient evidence.*"
  );
}

/**
 * Audit every **Corroborated** verdict in a finished answer against the ledger.
 *
 * Runs before `cleanCitations`, on the ledger's own numbering, so a marker means here
 * exactly what it meant when the model wrote it. A marker the ledger cannot resolve is not
 * evidence of anything and simply fails to support the claim — cleanup deletes it a moment
 * later anyway.
 *
 * Returns the answer unchanged (and `changed: false`) for everything this does not touch:
 * an answer with no claim blocks, a claim with any other verdict, a claim whose cited
 * sources do confirm it, and — because there is nothing to check against — a turn with an
 * empty ledger.
 *
 * @returns `{text, changed, downgrades}` where each downgrade is
 *   `{title, cited, missing}`, for logging and for tests.
 */
export function auditCorroboration(answer, ledger) {
  const text = String(answer ?? "");
  const claims = splitClaims(text);
  if (!claims || !ledger || ledger.size === 0) return { text, changed: false, downgrades: [] };

  const downgrades = [];
  const edits = [];

  for (const claim of claims) {
    if (claim.verdictKey !== "corroborated" || !claim.verdict) continue;

    const cited = [...new Set(markersIn(claim.text))].filter((n) => ledger.has(n));
    // The claim says confirmed and points at nothing. Whatever it rests on, it is not a
    // source this turn retrieved — which is the one thing this app is willing to call
    // evidence.
    let missing = [];
    let confirmed = false;
    for (const n of cited) {
      const result = sourceConfirms(claim.title, ledger.sources[n - 1]);
      if (result.confirms) {
        confirmed = true;
        break;
      }
      // Reported from the source that came closest, so the note names the fewest things.
      if (missing.length === 0 || result.missing.length < missing.length) missing = result.missing;
    }
    if (confirmed) continue;

    downgrades.push({ title: claim.title, cited, missing });
    edits.push({
      start: claim.verdict.start,
      end: claim.verdict.end,
      // The note goes *before* the verdict line, inside the claim's own block, because the
      // block ends at its verdict: anything after it belongs to the next claim.
      replacement:
        downgradeNote(claim.title, missing, cited) +
        (claim.verdict.text.startsWith("\n") ? "\n" : "") +
        `VERDICT: ${VERDICTS.insufficient.label}`,
    });
  }

  if (edits.length === 0) return { text, changed: false, downgrades: [] };

  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return { text: out + text.slice(cursor), changed: true, downgrades };
}
