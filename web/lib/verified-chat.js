// One turn of fact-checking, start to finish, with the citation rule enforced at the end.
//
// `streamChat` knows how to talk to Gemini and how to run a tool. It does not know what
// the tool is for, and it does not know that this app refuses to publish an uncited
// claim. That policy lives here:
//
//   1. Give the model exactly one tool — `web_search` — and a ledger that numbers every
//      source it retrieves.
//   2. Stream the answer.
//   3. Audit the answer against the ledger. If it asserts something it did not source, or
//      cites a source that does not exist, **the answer is not shown**: the model is told
//      what failed and made to write it again.
//   4. Render the bibliography ourselves, from the ledger, so every marker in the answer
//      resolves to a page that was actually fetched.
//
// Step 4 is why the model is told not to write its own Sources list. A bibliography the
// model types is a bibliography it can invent; one built from the ledger cannot contain a
// page no search returned.

import { streamChat } from "./gemini.js";
import { search, readEnv, SearchError } from "./search.js";
import { SEARCH_TOOLS, SearchQueryError } from "./search-schema.js";
import {
  CitationLedger,
  auditAnswer,
  repairInstruction,
  unverifiedNotice,
} from "./citations.js";

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
  "in this conversation you have found with the `web_search` tool during this turn — that",
  "is the only channel through which outside fact reaches you, and each result it returns",
  "arrives with a numbered citation marker. Your training data is not a source: it is",
  "stale, it cannot be checked by the reader, and you are not permitted to cite it. If you",
  "have not searched for something, you do not know it.",
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
  "Do not write a Sources or References list; the app renders one from the sources you",
  "actually retrieved, and appends it under your answer.",
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
  "Second pass — once the results are in front of you, write the answer. Search again only",
  "for a claim the first pass genuinely failed to settle, and again batch those together.",
  "You have three rounds of searching in total, so a claim per search in the first round is",
  "what makes the third round unnecessary.",
  "",
  "Name the specific claim you are verifying in each call's `claim` argument, and search",
  "for the claim, not the topic. Where a claim turns on a number, a date or a quote, prefer",
  "the primary source — the agency, the filing, the study — over reporting about it, and",
  "use the `site` argument to go straight to it when you know where it lives. Set",
  "`freshness` when a claim is about anything that moves. Do not repeat a query you have",
  "already run: it returns the same sources and costs the reader another wait.",
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
 * Run the `web_search` tool for one model call.
 *
 * Every failure path returns a *result* rather than throwing: a bad argument, a dead key
 * and a search that finds nothing are all things the model has to be told about so it can
 * react — retry with a valid query, stop searching, or report that the claim could not be
 * checked. Throwing here would take down a whole answer over one bad query.
 */
function makeToolRunner({ ledger, env, fetchImpl, signal, searchImpl }) {
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
    if (call.name !== "web_search") {
      return { response: { error: `No such tool: ${call.name}. The only tool is web_search.` } };
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

/** The ledger as prompt text, for a round that has to see the sources without re-searching. */
function ledgerBlock(ledger) {
  if (ledger.size === 0) return "No sources have been retrieved this turn.";
  return ledger.sources
    .map((s) => `[${s.n}] ${s.title} — ${s.url}${s.snippet ? `\n    ${s.snippet}` : ""}`)
    .join("\n");
}

/**
 * Stream one verified answer.
 *
 * Yields the frames `streamChat` does, plus:
 * - `{type: "searching", searches}` — these searches have just been dispatched, all at
 *   once. Sent before any of them returns, so the UI can show the wait rather than a gap.
 * - `{type: "search", …}` — a search ran; `results` are its numbered sources, or `error`.
 * - `{type: "reset"}` — discard the text shown so far. Sent when the model starts a fresh
 *   round, so a "let me look that up" preamble doesn't sit above the real answer.
 * - `{type: "sources", sources}` — the bibliography, built from the ledger.
 * - `{type: "unverified", message}` — the answer failed the audit twice and is labelled.
 */
export async function* verifiedChat({
  apiKey,
  messages,
  system = FACT_CHECK_SYSTEM_PROMPT,
  env = process.env,
  fetchImpl = fetch,
  searchImpl = search,
  signal,
  maxRepairRounds = MAX_REPAIR_ROUNDS,
  ...geminiOptions
}) {
  const enabled = searchEnabled(env);
  const ledger = new CitationLedger();
  const toolRunner = enabled
    ? makeToolRunner({ ledger, env, fetchImpl, signal, searchImpl })
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

  for (let attempt = 0; ; attempt += 1) {
    answer = "";
    truncated = false;

    // Only the first attempt searches. The repair round is a rewrite of an answer the
    // model can see, from sources quoted to it below — handing it the tool again invites
    // a fresh round of searching, which resets the answer under audit, spends the reader's
    // time twice over, and can end the turn on a search instead of on a verdict.
    const searchThisAttempt = enabled && attempt === 0;

    for await (const frame of streamChat({
      apiKey,
      messages: conversation,
      system,
      signal,
      fetchImpl,
      tools: searchThisAttempt ? SEARCH_TOOLS : null,
      toolRunner: searchThisAttempt ? toolRunner : null,
      // The repair round must not re-attach the video: the bytes are already in the
      // conversation the model is rewriting from, and re-attaching would re-download and
      // re-upload the whole clip to correct a citation. Its sources travel as text below.
      attachTikTok: attempt === 0,
      ...geminiOptions,
    })) {
      // The answer under audit is the text written *after* the last search. Anything
      // before it is the model narrating its own process ("let me check that") — it is
      // shown to the user as progress, but holding a "I'll look this up" line to the
      // citation rule would fail every answer that thinks out loud before searching.
      if (frame.type === "search") answer = "";
      if (frame.type === "delta") answer += frame.text;
      if (frame.type === "truncated") truncated = true;
      // `streamChat` reports a round's calls without knowing what they mean; naming them
      // as searches is this layer's job, since this is the layer that chose the tool.
      if (frame.type === "tool_start") {
        yield {
          type: "searching",
          searches: frame.calls
            .filter((call) => call.name === "web_search")
            .map((call) => ({
              query: String(call.args?.query ?? ""),
              claim: String(call.args?.claim ?? ""),
            })),
        };
        continue;
      }
      yield frame;
    }

    if (signal?.aborted) return;
    if (!enabled) return;

    audit = auditAnswer(answer, ledger);
    // A truncated answer fails the audit almost by construction — it was cut off, and the
    // sentence it was cut off in is the one that would have carried the citation. Sending
    // it back for a rewrite spends a second full answer to arrive at the same cliff edge,
    // so the cap is reported honestly instead: the text that arrived is kept, and labelled.
    if (audit.ok || truncated || attempt >= maxRepairRounds) break;

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
      // The rewrite came back empty, so the answer that was withdrawn for it goes back up.
      // It failed the check and is labelled as such below, which is a far more useful
      // thing to hand a reader than a blank bubble.
      answer = discarded;
      // Re-audited so the label and the bibliography describe the text actually on screen,
      // not the rewrite that never arrived.
      audit = auditAnswer(answer, ledger);
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

  if (ledger.size > 0) {
    // The bibliography is what the answer cites. When the answer cites nothing at all —
    // it was cut off, or it never got past searching — the whole ledger is shown instead
    // of an empty list: those pages were fetched on the reader's behalf and are the only
    // evidence the turn produced, so hiding them because no marker points at them throws
    // away the one useful thing that happened.
    const cited = audit?.cited ?? [];
    yield {
      type: "sources",
      sources: ledger.sources
        .filter((s) => cited.length === 0 || cited.includes(s.n))
        .map(({ n, title, url, domain, published }) => ({ n, title, url, domain, published })),
    };
  }

  if (audit && !audit.ok) {
    yield {
      type: "unverified",
      message: unverifiedNotice(audit.violations),
      violations: audit.violations.slice(0, 10).map(({ type, message }) => ({ type, message })),
    };
  }
}
