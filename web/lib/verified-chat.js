// One turn of fact-checking, start to finish, with the citation rule enforced at the end.
//
// `streamChat` knows how to talk to Gemini and how to run a tool. It does not know what
// the tools are for, and it does not know that this app refuses to publish an uncited
// claim. That policy lives here:
//
//   1. Give the model two tools — `web_search` to find pages and `find_in_page` to read
//      one — and a ledger that numbers every source it retrieves.
//   2. Stream the answer.
//   3. Audit the answer against the ledger. If it asserts something it did not source, or
//      cites a source that does not exist, **the answer is not shown**: the model is told
//      what failed and made to write it again.
//   4. Clean up the citations — merge markers that are secretly the same page, drop the
//      ones that repeat, renumber what is left — and hand the links back with the answer.
//
// Step 4 is why the model is told not to write its own Sources list. A bibliography the
// model types is a bibliography it can invent; the links this layer sends come from the
// ledger and cannot name a page no search returned. They travel *with* the answer rather
// than as a block underneath it, so a marker is a link where it is written; the list under
// the answer is the fallback for the case where the inline links cannot carry the evidence
// on their own — see `sourcesFrame`.

import { streamChat } from "./gemini.js";
import { search, readEnv, SearchError } from "./search.js";
import { SearchQueryError } from "./search-schema.js";
import { RESEARCH_TOOLS, validateFindQuery, FindQueryError } from "./find-schema.js";
import { findInPage, PageCache, PageFindError } from "./page-find.js";
import {
  CitationLedger,
  auditAnswer,
  repairInstruction,
  unverifiedNotice,
} from "./citations.js";
import { cleanCitations } from "./citation-cleanup.js";

/**
 * The system prompt.
 *
 * It states as fact that the model's knowledge of the world in this turn came from
 * `web_search`, because within a turn that is true and is meant to stay true: the audit
 * downstream removes any answer where it wasn't. The prompt and the check say the same
 * thing on purpose — the prompt gets compliance most of the time, and the check is what
 * makes "most of the time" not the standard.
 */
export const FACT_CHECK_SYSTEM_PROMPT = [
  "You are Seer, a social-media fact-checker. You are direct, concrete and unimpressed by",
  "confident phrasing. Use markdown for structure when it helps.",
  "",
  "HOW YOU KNOW THINGS",
  "You have no reliable knowledge of the world of your own. Everything factual you assert",
  "in this conversation you have found with your two research tools during this turn —",
  "`web_search` to find pages, `find_in_page` to read one — and they are the only channel",
  "through which outside fact reaches you. Each source arrives with a numbered citation",
  "marker. Your training data is not a source: it is stale, it cannot be checked by the",
  "reader, and you are not permitted to cite it. If you have not looked something up, you",
  "do not know it.",
  "",
  "THE CITATION RULE",
  "Every sentence that asserts a fact, a verdict, a number, a date, or something a named",
  "person or organisation said must end with a marker for a source you retrieved this",
  "turn — [3], or [3][7] where two sources back it. This is checked automatically after",
  "you answer. An answer that breaks the rule is rejected and you are made to rewrite it,",
  "so writing it correctly the first time is faster than not.",
  "",
  "Never write a marker for a source you were not given. Never write a URL that a search",
  "did not return. A fabricated citation is the worst thing you can produce here — worse",
  "than being wrong, because it looks checkable and is not.",
  "",
  "Cite the one source that actually supports the sentence, or two where a second genuinely",
  "corroborates it. Do not stack markers: [1][2][3][4] on one sentence is not four times the",
  "evidence, it is four links the reader will not follow, and the app strips the redundant",
  "ones before anyone sees them. A marker earns its place by being the source you would send",
  "someone to.",
  "",
  "Do not write a Sources or References list. Every marker you write is turned into a link",
  "to the page it names, right where you wrote it, so a list underneath repeats the whole",
  "trail in plain text — and one you typed from memory is the one place a URL can be wrong.",
  "",
  "HOW TO CHECK",
  "Work in two passes: look everything up, then read it and write the answer.",
  "",
  "First pass — read the post or video through, list every distinct claim in it, and issue",
  "a `web_search` call for each one **in the same turn**. Several calls in one turn are run",
  "at the same time; one call per turn is run one after another and makes the reader wait",
  "through every search in sequence for no benefit, so batch them. Do not narrate what you",
  "are about to look up — the app already shows the reader every search as it runs, so a",
  "'let me check that' line is a delay in front of the answer and nothing else. A turn that",
  "is nothing but tool calls is exactly right.",
  "",
  "Second pass — once the results are in front of you, read the sources that matter with",
  "`find_in_page`, and search again only for a claim the first pass genuinely failed to",
  "settle. Batch those together too. You have three rounds of tool calls in total, shared",
  "between searching and reading, so a claim per search in the first round is what leaves you",
  "a round to read the two sources the answer will actually rest on.",
  "",
  "Name the specific claim you are verifying in each call's `claim` argument, and search",
  "for the claim, not the topic. Where a claim turns on a number, a date or a quote, prefer",
  "the primary source — the agency, the filing, the study — over reporting about it, and",
  "use the `site` argument to go straight to it when you know where it lives. Set",
  "`freshness` when a claim is about anything that moves. Do not repeat a query you have",
  "already run: it returns the same sources and costs the reader another wait.",
  "",
  "READING A SOURCE INSTEAD OF SEARCHING AGAIN",
  "A search result's snippet is a fragment an engine chose for its own purposes. It is often",
  "enough to see that a page is relevant and not enough to settle anything — the figure has",
  "a caveat, the study has a margin of error, the quote has a sentence before it that changes",
  "it. When that happens, do not fire off another search hoping for a better snippet. Call",
  "`find_in_page` on the URL you already have and say what you are looking for; you get the",
  "page's own passages back, quoted exactly, under the number that page already has.",
  "",
  "It matches by meaning, not just by wording, so describe the fact you need in plain words",
  "— 'whether the agency revised the figure down, and by how much' — rather than guessing at",
  "the page's phrasing. Where the claim turns on an exact number, date or quote, include it",
  "verbatim as well: an exact hit outranks every paraphrase. Batch your finds into one turn",
  "like your searches, and reading two pages properly beats searching six times.",
  "",
  "A find that comes back with nothing is a finding, not a failure: that page does not say",
  "it. Do not cite the page for the claim anyway.",
  "",
  "If the search returns nothing that settles a claim, say exactly that. 'I could not find",
  "a source for this' is a complete and acceptable answer, and a far better one than a",
  "verdict you cannot support. Never split the difference by asserting something",
  "confidently and leaving it uncited.",
  "",
  "The claim being checked is not evidence for itself. When you describe what the video or",
  "post says, attribute it — 'the clip claims…' — and no citation is needed for that,",
  "because you are reporting the subject, not the world. The moment you say whether it is",
  "right, you need a source.",
  "",
  "WHEN A VIDEO IS ATTACHED",
  "A YouTube or TikTok link in the user's message is attached for you to watch — don't say",
  "you can't access it. Quote the specific claims made, and read any text shown on screen,",
  "which on short-form video is often where the claim actually lives. Then check each one.",
  "A bracketed note saying a video could not be attached is from the app, not the user: say",
  "what went wrong and work from the link alone.",
].join("\n");

/** How many times a failed answer gets sent back for a rewrite before we ship it flagged. */
export const MAX_REPAIR_ROUNDS = 1;

export function searchEnabled(env = process.env) {
  // Read case-insensitively, like the provider keys: an operator who typed
  // `Web_Search_Enabled=false` meant it, and silently ignoring the flag would be worse
  // than either honouring it or complaining about it.
  return (readEnv(env, "WEB_SEARCH_ENABLED") ?? "true").toLowerCase() !== "false";
}

/**
 * Run the research tools for one model call.
 *
 * Every failure path returns a *result* rather than throwing: a bad argument, a dead key, a
 * page that 404s and a search that finds nothing are all things the model has to be told
 * about so it can react — retry with a valid query, read a different source, or report that
 * the claim could not be checked. Throwing here would take down a whole answer over one bad
 * query.
 */
function makeToolRunner({ ledger, env, fetchImpl, signal, searchImpl, findImpl, apiKey, pages }) {
  // Every search this turn has already run, by the query it ran. A model that asks the
  // same question twice — the same round, having listed a claim twice, or a later round
  // circling back to a result it didn't like — gets the same answer without a second
  // round trip. The results are identical either way, so the only thing a repeat buys is
  // the wait, and waits are what this turn has too many of.
  const seen = new Map();
  const cacheKey = (args) =>
    JSON.stringify([
      String(args?.query ?? "").trim().toLowerCase(),
      String(args?.site ?? "").trim().toLowerCase(),
      String(args?.freshness ?? "any"),
      args?.max_results ?? null,
    ]);

  return async (call, { signal: callSignal } = {}) => {
    if (call.name === "find_in_page") {
      return runFind(call, {
        ledger,
        apiKey,
        fetchImpl,
        pages,
        findImpl,
        signal: callSignal ?? signal,
      });
    }
    if (call.name !== "web_search") {
      return {
        response: {
          error: `No such tool: ${call.name}. The tools are web_search and find_in_page.`,
        },
      };
    }

    try {
      const key = cacheKey(call.args);
      // The *promise* is cached, not the result: two identical queries in one round are
      // dispatched together, so caching only on completion would let both through.
      let pending = seen.get(key);
      if (!pending) {
        pending = Promise.resolve(
          searchImpl(call.args, { env, fetchImpl, signal: callSignal ?? signal }),
        );
        // A failure must not be remembered as one — the model is told what went wrong and
        // is entitled to try the same query again once.
        pending.catch(() => seen.delete(key));
        seen.set(key, pending);
      }

      // Re-filed rather than reused wholesale: the claim can differ between two identical
      // queries, and the ledger attaches each claim to the sources retrieved for it.
      // Filing it again re-uses the numbers those sources already have.
      const base = await pending;
      const result = { ...base, claim: String(call.args?.claim ?? base.claim) };
      const entries = ledger.record(result);
      return {
        response: { result: CitationLedger.describe(entries, result) },
        frame: {
          type: "search",
          query: result.query,
          claim: result.claim,
          provider: result.provider,
          results: entries.map(({ n, title, url, domain }) => ({ n, title, url, domain })),
        },
      };
    } catch (error) {
      if (error instanceof SearchQueryError || error instanceof SearchError) {
        return {
          response: { error: error.message },
          frame: { type: "search", query: String(call.args?.query ?? ""), error: error.message },
        };
      }
      throw error;
    }
  };
}

/**
 * Run one `find_in_page` call.
 *
 * The gate is the first thing that happens and it is not negotiable: the URL has to already
 * be in the ledger. A find on any other page would put quotable text in front of the model
 * that no search retrieved — an unnumbered source, which is to say an uncitable one — and
 * the refusal is worded as an instruction because the model can act on it: search for the
 * page, then read the result.
 *
 * Everything after that is reported to the model rather than thrown, including a page that
 * will not open. A source whose page is unreadable is still a source; it just cannot support
 * more than its snippet, and the model is told exactly that.
 */
async function runFind(call, { ledger, apiKey, fetchImpl, pages, findImpl, signal }) {
  let query;
  try {
    query = validateFindQuery(call.args);
  } catch (error) {
    if (error instanceof FindQueryError) {
      return { response: { error: error.message } };
    }
    throw error;
  }

  const entry = ledger.find(query.url);
  if (!entry) {
    return {
      response: {
        error:
          `${query.url} is not one of the pages retrieved this turn, so it cannot be read or ` +
          `cited. ${ledger.size === 0
            ? "Run a web_search first, then read one of the pages it returns."
            : `Read one of the URLs from a search result instead — you have [1]–[${ledger.size}].`}`,
      },
      frame: { type: "find", url: query.url, find: query.find, error: "not a retrieved source" },
    };
  }

  try {
    const result = await findImpl(query, { apiKey, fetchImpl, signal, cache: pages });
    ledger.recordFind({ ...result, claim: query.claim });
    return {
      response: { result: CitationLedger.describeFind(entry, result) },
      frame: {
        type: "find",
        url: query.url,
        find: query.find,
        claim: query.claim,
        n: entry.n,
        domain: entry.domain,
        matches: result.passages.length,
        passages: result.passages.length,
        semantic: result.semantic,
      },
    };
  } catch (error) {
    if (error instanceof PageFindError) {
      return {
        response: { error: `${error.message} (source [${entry.n}], ${entry.url})` },
        frame: {
          type: "find",
          url: query.url,
          find: query.find,
          n: entry.n,
          domain: entry.domain,
          error: error.message,
        },
      };
    }
    throw error;
  }
}

/** The ledger as prompt text, for a round that has to see the sources without re-searching. */
function ledgerBlock(ledger) {
  if (ledger.size === 0) return "No sources have been retrieved this turn.";
  return ledger.sources
    .map((s) => {
      const lines = [`[${s.n}] ${s.title} — ${s.url}`];
      if (s.snippet) lines.push(`    ${s.snippet}`);
      // Passages a find pulled out of the page, quoted back. The repair round cannot search
      // and cannot read, so this is the only way the page's own words survive into it — and
      // they are the strongest evidence the turn produced. Without them a rewrite is forced
      // back onto the snippets, which is how a correctly-sourced sentence gets softened into
      // a vaguer one to earn its citation.
      for (const passage of s.passages ?? []) lines.push(`    “${passage.text}”`);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * The ledger as a `sources` frame, carrying only the fields the browser renders.
 *
 * `quote` is the best passage a find pulled off the page, when one did. It is what makes a
 * fallback link list worth reading rather than a row of domain names: the reader sees the
 * sentence the citation rests on without opening anything.
 */
function sourceRows(sources) {
  return sources.map(({ n, title, url, domain, published, passages }) => ({
    n,
    title,
    url,
    domain,
    published,
    quote: passages?.[0]?.text ?? undefined,
  }));
}

/**
 * The final `sources` frame, and the decision about whether the links get *shown* as a list.
 *
 * The links are always sent. They are the record of what the turn retrieved, they are what
 * the consumer needs to turn `[3]` into a link, and they are stored with the message so the
 * answer stays checkable after a reload. What is no longer automatic is printing them out
 * underneath the answer.
 *
 * A block of numbered entries under a finished answer was the right design when a marker was
 * inert text and the list was the only way to resolve one. It is redundant now: every marker
 * is a link where it stands, so the list repeats the whole evidence trail in a form nobody
 * reads, and its length is what makes a two-source answer look like a literature review. So
 * it is kept as the *fallback* — pasted in exactly when the inline links cannot carry the
 * evidence by themselves:
 *
 * - **The answer cites nothing.** It never got past searching, or it was cut off before the
 *   first marker. There are no inline links, and these pages were fetched on the reader's
 *   behalf — they are the only evidence the turn produced, and they must not disappear
 *   because no marker happens to point at them.
 * - **The answer failed the audit, was truncated, or its stream died.** Something in it is
 *   unverified or missing, so the reader is being asked to check it themselves — and that
 *   is the one moment a complete list of everything retrieved is worth more than the tidy
 *   subset the text happens to link.
 */
function sourcesFrame(rows, { cited, audit, truncated, streamError }) {
  const flawed = Boolean(truncated || streamError || (audit && !audit.ok));
  return { type: "sources", sources: rows, fallback: !cited || flawed };
}

/**
 * Stream one verified answer.
 *
 * Yields the frames `streamChat` does — including its `{type: "stage"}` progress reports,
 * which pass straight through — plus:
 * - `{type: "searching", searches}` — these searches have just been dispatched, all at
 *   once. Sent before any of them returns, so the UI can show the wait rather than a gap.
 * - `{type: "search", …}` — a search ran; `results` are its numbered sources, or `error`.
 * - `{type: "find", url, find, n, matches}` — a page was read; `matches` is how many of its
 *   passages spoke to the claim, or `error` says why it could not be read.
 * - `{type: "reset", reason}` — discard the text shown so far, because it is no longer the
 *   answer. `superseded` means the model wrote something and then moved on from it, so a
 *   "let me look that up" preamble doesn't sit above the real answer; `citation-check`
 *   means it failed the audit and is being rewritten. Consumers that show text **must**
 *   honour this: text this layer has stopped counting but the screen keeps showing is what
 *   a reader sees as a reply mangling itself. See `supersede`.
 * - `{type: "sources", sources, provisional, fallback}` — the links, built from the ledger.
 *   Sent **as the searches land**, with `provisional: true` and the whole ledger, so the
 *   evidence is on screen and every `[n]` marker resolves to a link from the first token of
 *   the answer rather than only after the last one. Sent once more at the end without the
 *   flag, narrowed and renumbered to what the answer actually cited; a consumer replaces on
 *   each one. `fallback` says whether the links still need to be *shown* as a list — see
 *   `sourcesFrame`, and note that a consumer must keep the rows either way, because they are
 *   what turns a marker into a link.
 * - `{type: "answer", text}` — the final text of the answer, with its citations cleaned up.
 *   Replaces everything streamed as `delta` so far. Sent only when cleanup changed something,
 *   which is why it is a replacement rather than the normal channel: the answer streams
 *   token by token as the model writes it, and the tidy-up can only run once it is whole.
 * - `{type: "unverified", message}` — the answer failed the audit twice and is labelled.
 */
export async function* verifiedChat({
  apiKey,
  messages,
  system = FACT_CHECK_SYSTEM_PROMPT,
  env = process.env,
  fetchImpl = fetch,
  searchImpl = search,
  findImpl = findInPage,
  signal,
  maxRepairRounds = MAX_REPAIR_ROUNDS,
  ...geminiOptions
}) {
  const enabled = searchEnabled(env);
  const ledger = new CitationLedger();
  // One cache for the whole turn, so a second find on a page already open costs the ranking
  // and nothing else. The model is expected to come back to a good source for another claim —
  // that is the point of reading one rather than searching again.
  const pages = new PageCache({ fetchImpl, signal });
  const toolRunner = enabled
    ? makeToolRunner({ ledger, env, fetchImpl, signal, searchImpl, findImpl, apiKey, pages })
    : null;

  let conversation = messages;
  let audit = null;
  let answer = "";
  let truncated = false;
  // The last thing the model actually wrote, kept across the rewrite. A rejected answer is
  // withdrawn from the screen the moment the repair round starts, so if that round then
  // produces nothing the reader is left with sources over an empty space — the one outcome
  // worse than showing a flawed answer, because it looks like the app broke. Held here so
  // there is always something to put back.
  let discarded = "";
  // A stream that died *after* the model had already written something. Held rather than
  // thrown on the spot — see the catch below — so the turn can still be finished.
  let streamError = null;
  // How many sources the browser has already been sent, so a search that returns nothing
  // new — a repeat query served from the cache, or a page another search already found —
  // doesn't re-send a bibliography identical to the one already on screen.
  let sentSources = 0;

  /**
   * Withdraw the text written so far, because the model has moved on from it.
   *
   * This is the fix for a reply that arrives and then appears to come apart. The rule
   * that text before the last search is not the answer has always been enforced *here*,
   * on the copy this function audits — but the browser was never told, so it went on
   * showing text this layer had already stopped counting. The two then disagreed about
   * what the answer was, and both ways that disagreement resolved looked, to a reader,
   * exactly like the app mangling a reply that had already arrived:
   *
   * - An abandoned guess sat jammed against the real answer, unseparated —
   *   "…probably 1887." immediately followed by "The Eiffel Tower was completed in
   *   1889 [1]." One reply, reading as though it contradicted itself mid-sentence.
   * - Worse, when the model wrote its whole verdict and *then* ran one last search, the
   *   turn ended by appending "I ran the searches below but did not get to an answer"
   *   directly underneath the answer it was denying the existence of.
   *
   * So the text is moved rather than kept or dropped: withdrawn from the screen, and held
   * in `discarded` so the fallback at the end of this function can put it back when
   * nothing better arrives. A discarded guess stays discarded; a real answer survives.
   */
  function* supersede() {
    if (answer.trim()) {
      discarded = answer;
      yield { type: "reset", reason: "superseded" };
    }
    answer = "";
  }

  for (let attempt = 0; ; attempt += 1) {
    answer = "";
    truncated = false;
    // The highest round this attempt has seen begin. A round that starts while text is
    // already on screen means that text was not the answer — see `supersede` below.
    let lastRound = -1;

    // Only the first attempt searches. The repair round is a rewrite of an answer the
    // model can see, from sources quoted to it below — handing it the tool again invites
    // a fresh round of searching, which resets the answer under audit, spends the reader's
    // time twice over, and can end the turn on a search instead of on a verdict.
    const searchThisAttempt = enabled && attempt === 0;

    try {
      for await (const frame of streamChat({
        apiKey,
        messages: conversation,
        system,
        signal,
        fetchImpl,
        tools: searchThisAttempt ? RESEARCH_TOOLS : null,
        toolRunner: searchThisAttempt ? toolRunner : null,
        // The repair round must not re-attach the video: the bytes are already in the
        // conversation the model is rewriting from, and re-attaching would re-download and
        // re-upload the whole clip to correct a citation. Its sources travel as text below.
        attachMedia: attempt === 0,
        ...geminiOptions,
      })) {
        // Text the model wrote and then moved on from — see `supersede` below. A search is
        // one way that happens: the answer under audit is the text written *after* the last
        // search, because anything before it is the model narrating its own process ("let
        // me check that"), and holding a "I'll look this up" line to the citation rule
        // would fail every answer that thinks out loud before searching.
        if (frame.type === "search" || frame.type === "find") yield* supersede();
        // A fresh round beginning is the other way, and the general case. The model wrote
        // something, the round ended for a reason that was not a search — it asked for a
        // tool past its budget, which is refused rather than run — and the next round
        // starts from the same conversation. What it writes there replaces what it wrote
        // here.
        if (frame.type === "stage" && frame.stage === "waiting" && frame.round > lastRound) {
          lastRound = frame.round;
          yield* supersede();
        }
        if (frame.type === "delta") answer += frame.text;
        if (frame.type === "truncated") truncated = true;
        // `streamChat` reports a round's calls without knowing what they mean; naming them
        // as searches and reads is this layer's job, since this is the layer that chose the
        // tools. Both go out in one frame because the round dispatches them together and the
        // reader is waiting on all of them at once.
        if (frame.type === "tool_start") {
          yield {
            type: "searching",
            searches: frame.calls
              .filter((call) => call.name === "web_search")
              .map((call) => ({
                query: String(call.args?.query ?? ""),
                claim: String(call.args?.claim ?? ""),
              })),
            reads: frame.calls
              .filter((call) => call.name === "find_in_page")
              .map((call) => ({
                url: String(call.args?.url ?? ""),
                find: String(call.args?.find ?? ""),
                claim: String(call.args?.claim ?? ""),
              })),
          };
          continue;
        }
        yield frame;

        // The bibliography goes out as soon as there is one to send, rather than being held
        // until the answer is finished and audited. Two things come of that, both of them
        // paid for by work already done:
        //
        // - The evidence is on screen during the longest silence in the turn. Between the
        //   last search landing and the first token of the answer the model is reading
        //   everything it just retrieved, which on a multi-claim video is most of the wait —
        //   and the reader can spend it reading the sources instead of watching a blank
        //   bubble with a spinner over it.
        // - Every `[n]` in the answer resolves to a link from the moment it is typed. The
        //   browser can only turn a marker into a link if it already holds the source that
        //   marker points at, so with the bibliography arriving last, markers stayed inert
        //   plain text for the whole of the stream and only became clickable once it ended.
        //
        // Provisional because what the answer cites is not known yet: this is everything
        // retrieved, and the frame at the end narrows it to what was actually used.
        if (frame.type === "search" && ledger.size > sentSources) {
          sentSources = ledger.size;
          yield { type: "sources", sources: sourceRows(ledger.sources), provisional: true };
        }
        // A find retrieves no new source, so it does not move `sentSources` — but it does
        // attach the page's own words to a source already on screen, and those quotes are
        // the best thing the provisional list can show while the model is still reading.
        if (frame.type === "find" && frame.matches > 0) {
          yield { type: "sources", sources: sourceRows(ledger.sources), provisional: true };
        }
      }
    } catch (error) {
      // The caller closing the tab is what they asked for, not a failure to dress up.
      if (signal?.aborted) return;
      // Nothing had arrived, so there is nothing to preserve: the error is the entire
      // outcome of the turn, and it belongs to the caller to report.
      if (!answer.trim()) throw error;
      // Text was already on screen when the stream died — most often Gemini ending its turn
      // on RECITATION or SAFETY partway through an answer, which it does without warning.
      // Throwing from here would take the bibliography down with it and leave the reader a
      // half-answer whose [1] markers point at nothing: the app would have thrown away the
      // one thing that makes the surviving text checkable, which is the whole promise of
      // this layer. So the failure is held, the turn is finished with its sources below,
      // and it is re-thrown at the end once the reader has everything that did arrive.
      streamError = error;
    }

    if (signal?.aborted) return;
    if (!enabled) {
      if (streamError) throw streamError;
      return;
    }

    // A stream that died mid-answer cut the text off exactly the way the token cap does, so
    // the audit's last-sentence exemption applies for the same reason: the citation marker
    // goes at the end of a sentence, and the end is what was lost.
    audit = auditAnswer(answer, ledger, { truncated: truncated || Boolean(streamError) });
    // Cheap and local, so it is over before the frame is read — but a rejected answer is
    // about to be pulled off the screen, and "Checking citations" is what makes the next
    // few seconds legible rather than alarming.
    if (!audit.ok && !truncated && !streamError && attempt < maxRepairRounds) {
      yield { type: "stage", stage: "rewriting" };
    }
    // A truncated answer fails the audit almost by construction — it was cut off, and the
    // sentence it was cut off in is the one that would have carried the citation. Sending
    // it back for a rewrite spends a second full answer to arrive at the same cliff edge,
    // so the cap is reported honestly instead: the text that arrived is kept, and labelled.
    // A stream that died gets the same treatment for a blunter reason: the model just
    // failed partway through an answer, and asking it to go again is as likely to fail the
    // same way with the reader waiting through it a second time.
    if (audit.ok || truncated || streamError || attempt >= maxRepairRounds) break;

    // Rejected. The UI is told to drop what it has shown before the rewrite starts, so a
    // failed answer is never left on screen next to the one that replaces it.
    discarded = answer;
    yield { type: "reset", reason: "citation-check" };

    // Note that this is a *new* conversation built from app-level messages, not a
    // continuation of the turn that just failed: the tool-call history and its thought
    // signatures are deliberately left behind. The model is being asked to rewrite an
    // answer it can see, from sources quoted below it — not to resume the reasoning that
    // produced the answer that was rejected.
    conversation = [
      ...messages,
      { role: "assistant", content: answer },
      {
        role: "user",
        content: `${repairInstruction(audit.violations, ledger)}\n\nSources retrieved this turn:\n${ledgerBlock(ledger)}`,
      },
    ];
  }

  // Nothing was written. An empty answer passes the citation audit trivially — there is
  // nothing in it to be uncited — so without this the turn ends clean and the reader gets
  // a list of sources with a blank space above it, which reads as the app being broken and
  // is indistinguishable from it. Both ways out below end the turn with words in it.
  if (!answer.trim()) {
    if (discarded.trim()) {
      // Something was withdrawn from the screen earlier in this turn and nothing came
      // along to replace it, so it goes back up. Two ways to get here: a repair round
      // that came back empty, or a model that wrote its answer and then spent its last
      // round searching instead of restating it. Either way the withdrawn text is the
      // only thing this turn produced, and it beats a blank bubble or the apology below —
      // if it fails the citation check it is labelled as such, which is still far more
      // useful than pretending there was no answer at all.
      answer = discarded;
      // Re-audited so the label and the bibliography describe the text actually on screen,
      // not the rewrite that never arrived.
      audit = auditAnswer(answer, ledger, { truncated });
      yield { type: "delta", text: answer };
    } else if (ledger.size > 0) {
      // Sources were retrieved and then nothing was said about them: the model spent the
      // whole turn searching. Say so plainly — the sources are still shown, and they are
      // still worth reading.
      answer =
        "I ran the searches below but did not get to an answer before running out of " +
        "room to search. The sources are listed; ask again and I'll read them.";
      yield { type: "delta", text: answer };
    }
  }

  // Citation cleanup, and the last thing done to the answer.
  //
  // It runs *after* the audit on purpose: the audit judges what the model wrote, and tidying
  // first would mean auditing our own edit and reporting its mistakes as the model's. What
  // is left to do here is what a copy editor does — merge two markers that turn out to be
  // one page reached by two URLs, drop the ones that repeat inside a sentence, cap a runaway
  // stack, and renumber so the markers ascend as they are read. Nothing is ever added, and a
  // sentence that arrived with a citation keeps one; see lib/citation-cleanup.js.
  if (ledger.size > 0) {
    // An answer the reader is being asked to check themselves — one that failed the audit,
    // was cut off, or died mid-stream — gets every source listed, and therefore must keep the
    // ledger's own numbering. Renumbering it would leave the list and the text disagreeing
    // about which page is [2], and it is precisely the answers with something wrong in them
    // where a marker must still point where the model pointed it: the fabricated `[9]` the
    // "Unverified" banner is about to describe has to stay a `[9]`.
    const flawed = Boolean(truncated || streamError || (audit && !audit.ok));
    let rows = sourceRows(ledger.sources);
    let cited = false;

    if (answer.trim()) {
      const cleaned = cleanCitations(answer, ledger, { renumber: !flawed });
      if (cleaned.changed) {
        answer = cleaned.text;
        // A replacement rather than more deltas: the answer streamed token by token while it
        // was being written, and this pass could only run once it was whole.
        yield { type: "answer", text: answer };
      }
      if (cleaned.sources.length > 0 && !flawed) {
        rows = sourceRows(cleaned.sources);
        cited = true;
      }
    }

    yield sourcesFrame(rows, { cited, audit, truncated, streamError });
  }

  if (audit && !audit.ok) {
    yield {
      type: "unverified",
      message: unverifiedNotice(audit.violations),
      violations: audit.violations.slice(0, 10).map(({ type, message }) => ({ type, message })),
    };
  }

  // Held back this whole time so everything above could reach the reader first. The turn is
  // now as complete as it is going to get — the partial answer, its sources, its label —
  // and the reader is still owed the reason it stopped, so the failure goes on to the
  // caller to be reported as one.
  if (streamError) throw streamError;
}
