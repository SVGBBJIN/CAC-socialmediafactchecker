// Turning a post's caption into one speculative search, issued while the video downloads.
//
// The first search of a fact-check cannot start until the model has watched the clip and
// decided what to look up — so the clip resolve, the download, the upload and the whole of
// round 0 all happen before a single source is retrieved. That is the longest stretch in the
// request, and for most of it the machine is doing nothing a search would interfere with.
//
// But the caption is known much earlier. It comes back from the *resolve* step, before the
// download starts, and on an intake that warmed the link it is in hand before the request
// reaches the server at all. On short-form political video the caption is frequently where
// the claim actually lives — the clip is B-roll — which is why `describeClip` already passes
// it to the model as its own line. So it is worth a search, and that search is free: it runs
// in the time the download was going to take anyway.
//
// ## What this is not
//
// This does not look at the model's answer, reject anything, force a rewrite, or label a
// turn. It is not the sentence-level claim detection that lib/citations.js records being
// torn out — that one guessed which sentences in already-written prose "looked like" claims
// and withdrew answers over the guess. This reads metadata the platform handed us and turns
// it into one ordinary `web_search` the model is free to ignore. If the guess is bad the
// cost is one wasted query, and `cleanCitations` already drops uncited sources from the
// final list, so a bad guess cannot even reach the reader as a source.
//
// Pure and network-free on purpose, like claims.js and timestamps.js, so the whole of the
// decision — is this caption worth searching, and what do we search for — is testable in
// Node with no fixtures. See test-caption-search.js.

import { readEnv } from "./search.js";
import { SEARCH_QUERY_SCHEMA } from "./search-schema.js";

/**
 * How much real text a caption needs before it is worth a query.
 *
 * Both floors are about the same failure. "😂😂 #fyp #viral" and "wait for it" are captions
 * in the sense that they are the caption field, and neither describes a claim about the
 * world — searching them spends a query to retrieve nothing anyone will cite. Requiring
 * several actual words, and a sentence's worth of them, is what separates a caption that
 * asserts something from one that is just noise around the video.
 */
const MIN_CAPTION_WORDS = 4;
const MIN_CAPTION_CHARS = 25;

const MAX_QUERY_CHARS = SEARCH_QUERY_SCHEMA.properties.query.maxLength;
const MAX_CLAIM_CHARS = SEARCH_QUERY_SCHEMA.properties.claim.maxLength;

/**
 * Whether the caption search runs at all.
 *
 * Two gates rather than one. Its own flag is what an operator reaches for to stop paying
 * for a speculative query per check; `searchEnabled` is the deployment having no search at
 * all, in which case there is no tool to run this through and the question does not arise.
 * Read case-insensitively for the same reason `searchEnabled` is — an operator who typed
 * `Caption_Search_Enabled=false` meant it.
 */
export function captionSearchEnabled(env = process.env) {
  return (readEnv(env, "CAPTION_SEARCH_ENABLED") ?? "true").toLowerCase() !== "false";
}

/**
 * The parts of a caption that are decoration rather than statement.
 *
 * Hashtags go entirely, tag and word together, and that is a deliberate loss: `#fyp`,
 * `#viral` and `#foryoupage` are on nearly every post and would drag every query toward the
 * same useless results, which costs more than the occasional informative `#BridgeCollapse`
 * is worth. A caption whose only content was hashtags fails the floors below and is skipped
 * — which is the right outcome, not a missed opportunity.
 */
const DECORATION = [
  /https?:\/\/\S+/g, // links; the post's own URL is already in the prompt
  /[@#][\p{L}\p{N}_]+/gu, // mentions and hashtags
  /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, // emoji, skin tones, joiners
];

/** A caption reduced to the words a search engine can do something with. */
export function captionText(caption) {
  let text = String(caption ?? "");
  for (const pattern of DECORATION) text = text.replace(pattern, " ");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * One search for a post's caption, or `null` when the caption isn't worth one.
 *
 * `null` is the normal answer, not a failure: most captions are decoration. The caller
 * treats it as "no speculative search this turn" and the turn proceeds exactly as it did
 * before this existed.
 *
 * The returned pair is shaped to pass `validateSearchQuery` unchanged — same bounds, same
 * required fields — so this never becomes a second, looser door into the search tool.
 *
 * @returns `{query, claim}` or `null`.
 */
export function captionQuery(caption, { platform = null } = {}) {
  const text = captionText(caption);
  if (text.length < MIN_CAPTION_CHARS) return null;
  if (text.split(/\s+/).filter(Boolean).length < MIN_CAPTION_WORDS) return null;

  const query = text.slice(0, MAX_QUERY_CHARS).trim();
  if (query.length < SEARCH_QUERY_SCHEMA.properties.query.minLength) return null;

  // Worded as what it actually is. The ledger files every source against the claim it was
  // retrieved for, and the model reads that line back in the tool result — so it has to be
  // true. We are not asserting the caption; we are checking what it says, and a claim that
  // said otherwise would be the app putting words in the post's mouth.
  const subject = platform ? `${platform} post` : "post";
  const claim = `What the ${subject}'s caption states: "${text}"`.slice(0, MAX_CLAIM_CHARS);
  if (claim.length < SEARCH_QUERY_SCHEMA.properties.claim.minLength) return null;

  return { query, claim };
}
