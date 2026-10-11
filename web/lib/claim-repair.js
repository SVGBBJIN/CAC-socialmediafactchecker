// A verdict with nothing under it gets one more look before it reaches the reader.
//
// The failure this exists for: a claim block closed with `VERDICT: Corroborated` (or
// Contradicted, or Disputed) whose text cites no source this turn retrieved. Sometimes the
// model judged the claim "obviously true" and never searched for it; sometimes a long video
// had more claims than its three tool rounds could cover and the last few were written from
// memory. Either way the claim's verdict rests on nothing the reader can follow, and until
// now the only response was lib/corroboration.js lowering it to Insufficient evidence after
// the fact — honest, but it reports a check the app never actually ran.
//
// So before that audit runs, the app runs the search itself: one `web_search` per uncited
// claim, its own `[[claim: …]]` line as the query, all at once. The results go into the same
// ledger under the same numbering, and the model is asked once more — no tools, no video, just
// those blocks and those sources — to rewrite each block against what came back. The rewrite
// is spliced in over the original block and the whole answer then goes through the
// corroboration audit and citation cleanup exactly as before, so a repaired block that still
// cites nothing (or cites a page that does not carry the claim) is lowered the usual way.
//
// What this is not, for the same reasons lib/corroboration.js gives: it is not the
// sentence-level claim detection this app tore out, and it is not the old "rewrite the whole
// answer" repair round either. It acts only on the model's own `[[claim: …]]` and `VERDICT:`
// lines, it touches only the blocks that carry a decisive verdict and no marker, and
// everything it can fail at — a search that errors, a model that refuses, a reply that does
// not parse — leaves the original block in place for the audit to handle.

import { splitClaims, VERDICTS } from "../public/claims.js";
import { CitationLedger, markersIn } from "./citations.js";

/**
 * The verdicts that assert something about the world and so need a source under them.
 * Insufficient evidence is the one verdict that is honest with nothing cited — it is the
 * statement that nothing settled the claim — so it is never re-checked here.
 */
export const DECISIVE_VERDICTS = new Set(["corroborated", "contradicted", "disputed"]);

/**
 * How many uncited claims one turn will re-check. The prompt caps a check at five claims,
 * so this covers every block of an answer that ignored its citations entirely; past that
 * the audit's downgrade is the backstop, as it is for anything this pass cannot fix.
 */
export const MAX_REPAIR_CLAIMS = 5;

/**
 * Every claim block whose verdict is decisive and which cites no source in the ledger.
 *
 * A marker the ledger cannot resolve counts as no citation at all — cleanup deletes it a
 * moment later, so a block resting on an invented `[9]` rests on nothing.
 */
export function uncitedClaims(answer, ledger) {
  const claims = splitClaims(answer);
  if (!claims) return [];
  return claims.filter(
    (claim) =>
      claim.verdict &&
      DECISIVE_VERDICTS.has(claim.verdictKey) &&
      !markersIn(claim.text).some((n) => ledger?.has(n)),
  );
}

/**
 * The message the model is handed for the re-check: each uncited block as it wrote it, and
 * under each, the sources the app just retrieved for it.
 *
 * Written as an instruction rather than a conversation turn because there is no
 * conversation here — the model is not shown the video or the rest of its answer, only what
 * it needs to rewrite these blocks, which keeps the call cheap and its output easy to splice.
 */
export function repairPrompt(items) {
  const blocks = items.map(({ claim, description }, index) =>
    [
      `CLAIM ${index + 1}`,
      `[[claim: ${claim.title}]]`,
      claim.text,
      `VERDICT: ${VERDICTS[claim.verdictKey]?.label ?? claim.verdictKey}`,
      "",
      `Sources the app retrieved for claim ${index + 1}:`,
      description,
    ].join("\n"),
  );
  return [
    "[Re-check from the app, not the user.] In your answer you gave the claim block(s) below a",
    "verdict without citing any source you retrieved, which breaks THE CITATION RULE. The app",
    "has now run a web search for each one; the results are listed under each block, numbered",
    "in the same ledger as the rest of the turn. You have no tools in this step.",
    "",
    "Rewrite each block so that its verdict rests on these sources:",
    "• Keep the same `[[claim: …]]` line, word for word, and the blocks in the same order.",
    "• Keep what you wrote about what the post says, and any `[t=…]` timestamps, as written.",
    "• Every sentence that asserts a fact about the world ends with a marker for one of the",
    "  sources listed under that block.",
    "• Apply WHAT COUNTS AS CORROBORATION: if the sources only share the claim's topic and",
    "  never state its specific person, figure, date or quote, the verdict is Insufficient",
    "  evidence. Do not keep a verdict the sources do not support.",
    "• Close each block with its own `VERDICT:` line.",
    "",
    "Write only the rewritten blocks — nothing before the first, nothing after the last.",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}

/**
 * Splice the model's rewritten blocks over the originals.
 *
 * Matched by order, the order the prompt asked it to keep. Each replacement keeps the
 * *original* claim line rather than whatever the model wrote, so the panel's label cannot
 * drift between what streamed and what was stored; only the body and the verdict change.
 * A rewritten block with no verdict line — cut off, or not written at all — is skipped, and
 * the original stays for the audit to judge.
 *
 * @returns `{text, repaired}` — `repaired` is the number of blocks replaced.
 */
export function spliceRepairs(answer, originals, reply) {
  const rewritten = splitClaims(reply) ?? [];
  const edits = [];
  originals.forEach((claim, index) => {
    const next = rewritten[index];
    if (!next?.verdictKey || !next.text.trim()) return;
    edits.push({
      start: claim.range.start,
      end: claim.verdict.end,
      replacement: `[[claim: ${claim.title}]]\n${next.text.trim()}\nVERDICT: ${VERDICTS[next.verdictKey].label}`,
    });
  });
  let text = String(answer);
  // Back to front, so each edit's offsets still mean what they meant in the original.
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  }
  return { text, repaired: edits.length };
}

/**
 * The search a claim gets: its own claim line, as both query and claim. Clipped to the
 * schema's limits (lib/search-schema.js) so an over-long label still gets searched rather
 * than refused.
 */
function searchArgs(claim) {
  return { query: claim.title.slice(0, 300), claim: claim.title.slice(0, 500) };
}

/**
 * Re-check every uncited decisive claim in a finished answer.
 *
 * A generator because the searches it runs are part of the evidence trail and the reader
 * should see them land the way every other search does: it yields the same `searching` and
 * `search` frames the tool loop does, and its caller turns those into provisional sources.
 * The rewritten answer is the generator's return value, not a frame — the caller already
 * owns the one `answer` replacement frame the turn sends.
 *
 * @param search `(args, opts) => Promise<searchResult>`, already bound to the turn's env,
 *   fetch, signal and source tiers.
 * @param ask `(prompt) => Promise<string>`, one tool-less model call returning its text.
 * @returns `{text, repaired, checked}`.
 */
export async function* repairUncitedClaims(answer, { ledger, search, ask, signal, max = MAX_REPAIR_CLAIMS }) {
  const claims = uncitedClaims(answer, ledger).slice(0, max);
  if (claims.length === 0) return { text: answer, repaired: 0, checked: 0 };

  yield { type: "stage", stage: "rechecking", claims: claims.length };
  yield {
    type: "searching",
    searches: claims.map(searchArgs),
    reads: [],
  };

  const settled = await Promise.all(
    claims.map((claim) =>
      Promise.resolve()
        .then(() => search(searchArgs(claim)))
        .then(
          (result) => ({ claim, result }),
          (error) => ({ claim, error }),
        ),
    ),
  );
  if (signal?.aborted) return { text: answer, repaired: 0, checked: claims.length };

  const items = [];
  for (const { claim, result, error } of settled) {
    if (error || !result) {
      yield { type: "search", query: claim.title, error: String(error?.message ?? "Search failed") };
      continue;
    }
    const filed = { ...result, claim: claim.title };
    const entries = ledger.record(filed);
    yield {
      type: "search",
      query: filed.query,
      claim: filed.claim,
      provider: filed.provider,
      recheck: true,
      results: entries.map(({ n, title, url, domain, tier }) => ({ n, title, url, domain, tier })),
    };
    // Nothing came back: there is nothing new to rewrite the block against, and the audit's
    // downgrade already says exactly what is true about it.
    if (entries.length > 0) items.push({ claim, description: CitationLedger.describe(entries, filed) });
  }
  if (items.length === 0) return { text: answer, repaired: 0, checked: claims.length };

  let reply;
  try {
    reply = await ask(repairPrompt(items));
  } catch {
    return { text: answer, repaired: 0, checked: claims.length };
  }
  if (signal?.aborted || !reply?.trim()) return { text: answer, repaired: 0, checked: claims.length };

  const { text, repaired } = spliceRepairs(
    answer,
    items.map((item) => item.claim),
    reply,
  );
  return { text, repaired, checked: claims.length };
}
