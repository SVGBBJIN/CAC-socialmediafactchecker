// Finding a check again.
//
// The sidebar's filter used to be `entry.title.toLowerCase().includes(needle)` and nothing
// else, which meant the search box matched the one field a reader is least likely to
// remember. A check of a TikTok about the San Diego Zoo is titled with whatever caption the
// platform handed back, so "elephant" found nothing, "youtube" found nothing, and
// "contradicted" found nothing — three searches that are all obviously about checks the
// library was holding.
//
// So a row is searched by everything it is: its title, the link it checked, the platform it
// came from, the verdict it reached, the claims the model wrote, and the domains of the
// sources it cited. Two filters sit alongside the text — verdict and platform — because
// those are the two axes a reader narrows by rather than searches for ("the contradicted
// ones", "the TikToks"), and typing a verdict name into a text box to get them is a worse
// version of a chip.
//
// Pure and DOM-free on purpose, like `claims.js` and `deeplink.js` — `test-library-search.js`
// exercises it in Node with no browser, per the convention in CLAUDE.md.

import { VERDICTS } from "./claims.js";

/** Every filter off, which is what an untouched sidebar means. */
export const NO_FILTERS = { text: "", verdict: null, platform: null };

/**
 * Everything about one entry a text search may match, as one lower-cased string.
 *
 * Built fresh per call rather than cached on the entry: a library is tens of rows, the
 * string is short, and a cache would have to be invalidated by every follow-up, every
 * re-run and every cloud merge — three places that would each have to remember.
 *
 * The verdict is included **as its label** ("Contradicted", "Insufficient evidence") rather
 * than as the internal key, because the label is the word the reader saw on the badge and
 * therefore the word they will type.
 */
export function searchTextFor(entry) {
  if (!entry) return "";
  const parts = [entry.title, entry.url, entry.platform, VERDICTS[entry.verdictKey]?.label];

  // The claims themselves — the `[[claim: …]]` labels are the sentences the reader actually
  // read, and the body is where a name like "San Diego Zoo" lives when the title is a
  // caption full of hashtags.
  for (const claim of entry.claims ?? []) {
    parts.push(claim?.title, claim?.text);
  }
  if (!entry.claims) parts.push(entry.answer);

  // A source's domain, not its title: "reddit.com" or "bbc.co.uk" is how someone remembers
  // where an answer came from, and the titles would swamp the haystack with the prose of
  // every page ever cited.
  for (const source of entry.sources ?? []) parts.push(source?.domain);

  // Follow-ups are part of the same conversation and are routinely where the thing worth
  // finding again was actually said.
  for (const followup of entry.followups ?? []) parts.push(followup?.question, followup?.answer);

  return parts.filter(Boolean).join(" \u0000 ").toLowerCase();
}

/**
 * The words a query is made of.
 *
 * Every word has to appear somewhere in the row, in any order and in any field — so
 * "contradicted tiktok" finds the contradicted TikToks without either word having to sit
 * next to the other. Substring rather than whole-word matching, deliberately: this is a
 * find-as-you-type box, and "eleph" should already be narrowing.
 */
function queryWords(text) {
  return String(text ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
}

/**
 * Does this row survive the filters?
 *
 * The three tests are ANDed — a chip narrows what the text box found, which is what a chip
 * beside a search box is universally taken to mean. A null chip is "any", not "none".
 */
export function matchesFilters(entry, filters = NO_FILTERS) {
  if (!entry) return false;
  const { text = "", verdict = null, platform = null } = filters ?? {};

  if (verdict && entry.verdictKey !== verdict) return false;
  // Platform is compared case-insensitively because it is a display string ("TikTok",
  // "YouTube") that the chips are built from, not an enum.
  if (platform && String(entry.platform ?? "").toLowerCase() !== platform.toLowerCase()) return false;

  const words = queryWords(text);
  if (words.length === 0) return true;
  const haystack = searchTextFor(entry);
  return words.every((word) => haystack.includes(word));
}

/** The library, filtered, in the order it was already in — newest first, untouched. */
export function filterLibrary(library, filters = NO_FILTERS) {
  return (library ?? []).filter((entry) => matchesFilters(entry, filters));
}

/**
 * The platform chips to offer: the platforms this library actually holds, most-used first.
 *
 * Built from the rows rather than from a fixed list, so the chip row never offers
 * "Instagram" to someone who has only ever checked TikToks, and never fails to offer a
 * platform added to `platformFor` later.
 */
export function platformsIn(library) {
  const counts = new Map();
  for (const entry of library ?? []) {
    const name = String(entry?.platform ?? "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}

/**
 * The verdict chips to offer, in the fixed order `VERDICTS` declares them.
 *
 * Fixed order, not frequency: these four are a scale (refuted → confirmed → unsettled) and
 * reordering them per library would make the chip row move under the reader's finger
 * between visits. Only verdicts present are offered, for the same reason as above.
 */
export function verdictsIn(library) {
  const present = new Set((library ?? []).map((entry) => entry?.verdictKey).filter(Boolean));
  return Object.keys(VERDICTS).filter((key) => present.has(key));
}
