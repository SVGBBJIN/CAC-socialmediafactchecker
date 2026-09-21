// What kind of thing a source is.
//
// A check that answers "Corroborated" off a thread in r/BarbaraWalters4Scale is not wrong
// about having found something — it is wrong about what it found. The citation ledger
// (lib/citations.js) treats every retrieved page as one source, and the reader is given no
// way to tell the government statistics release from the forum post agreeing with it.
//
// So every result is tagged with one of four tiers, in this order of standing:
//
//   primary   — the body the claim is actually about, publishing about itself: a
//               government, a court, a regulator, a university, a journal, a company's own
//               newsroom. The document rather than a report of the document.
//   news      — an outlet that reports and edits: a newspaper, a wire, a broadcaster, a
//               dedicated fact-checking organisation.
//   reference — an encyclopedia, a dictionary, an archive, a data portal. Reliable for what
//               a thing *is*, weaker for what just happened to it.
//   forum     — anything whose author is whoever showed up: Reddit, Quora, Stack Exchange,
//               X, Facebook, a comment section, a personal blog platform, a content farm.
//
// ## What this is not
//
// It is not a truth rating, and nothing here should be read as one. A forum thread can be
// right and a ministry's press release can be self-serving. What the tier says is *how much
// the page's provenance is worth on its own* — who stands behind it, and whether there is
// an editor or a records office between the claim and the reader. That is a property of the
// publisher, which is knowable from the URL, rather than a property of the claim, which is
// not.
//
// It is also deliberately not a reputation list. There is no per-outlet scoring, no
// left/right axis and no blocklist of publications — those are judgements this app has no
// business making silently, and they would be the first thing to rot. What is here is
// structural: a TLD that only a government can hold, a path that only a journal uses, a
// platform whose whole design is that anyone may post.
//
// Pure, no network, no DOM and no dependencies — it is read by both halves of the app: the
// server filters search results with it, and the browser labels the pills and offers the
// settings rows off the same four names. It lives in `public/` for the same reason
// `claims.js` does — `lib/` may import from `public/`, never the other way round, because
// only `public/` is served to the browser. See `test-source-quality.js`.

/** The tiers, best-supported first. Order is the ranking. */
export const TIERS = ["primary", "news", "reference", "forum"];

/** How a tier is shown, and what it means in one line the reader can act on. */
export const TIER_LABELS = {
  primary: { label: "Primary", hint: "The organisation or record the claim is about" },
  news: { label: "News", hint: "An outlet that reports and edits" },
  reference: { label: "Reference", hint: "An encyclopedia, archive or data portal" },
  forum: { label: "Forum", hint: "Anyone can post here" },
};

/** Everything on, which is what an untouched install means. */
export const ALL_TIERS = [...TIERS];

/**
 * Suffixes only an institution can hold, and what they make it.
 *
 * These are the strong signals: `.gov`, `.gov.uk`, `.mil` and `.int` are issued under a
 * registry that checks who you are, and `.edu`/`.ac.uk` nearly as strictly. A domain ending
 * in one of these is the institution itself speaking, which is the definition of primary.
 */
const INSTITUTIONAL_SUFFIXES = [
  ".gov", ".mil", ".int",
  ".gov.uk", ".nhs.uk", ".parliament.uk", ".police.uk",
  ".gc.ca", ".gov.au", ".govt.nz", ".gov.in", ".gov.sg", ".gov.za", ".gob.es", ".gouv.fr",
  ".edu", ".ac.uk", ".edu.au", ".ac.nz", ".edu.sg",
  ".europa.eu",
];

/** Hosts that are the record itself: standards bodies, statistics offices, journals. */
const PRIMARY_HOSTS = new Set([
  "who.int", "un.org", "worldbank.org", "imf.org", "oecd.org", "wto.org",
  "nature.com", "science.org", "thelancet.com", "nejm.org", "bmj.com", "cell.com",
  "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "arxiv.org", "doi.org", "jstor.org",
  "ons.gov.uk", "eurostat.ec.europa.eu", "ipcc.ch", "sec.gov", "federalreserve.gov",
]);

/** Outlets that report and edit. Not a ranking of them — only "there is an editor here". */
const NEWS_HOSTS = new Set([
  "bbc.co.uk", "bbc.com", "reuters.com", "apnews.com", "afp.com", "pa.media",
  "nytimes.com", "washingtonpost.com", "wsj.com", "ft.com", "economist.com",
  "theguardian.com", "telegraph.co.uk", "thetimes.co.uk", "independent.co.uk",
  "cnn.com", "nbcnews.com", "cbsnews.com", "abcnews.go.com", "npr.org", "pbs.org",
  "aljazeera.com", "dw.com", "france24.com", "politico.com", "politico.eu",
  "bloomberg.com", "cnbc.com", "axios.com", "propublica.org", "theatlantic.com",
  "newscientist.com", "scientificamerican.com",
  // Dedicated fact-checking organisations — the same standing as a newsroom, which is
  // what they are. (The wires' own fact-check desks live on the domains already listed.)
  "snopes.com", "politifact.com", "factcheck.org", "fullfact.org", "checkyourfact.com",
]);

/** Encyclopedias, dictionaries, archives, open data. Matched as suffixes, because the
 * language editions of a wiki are subdomains (`en.wikipedia.org`) rather than hosts of
 * their own. */
const REFERENCE_SUFFIXES = [
  "wikipedia.org", "wikidata.org", "wikisource.org", "wiktionary.org",
  "britannica.com", "merriam-webster.com", "dictionary.com", "oed.com",
  "archive.org", "web.archive.org", "ourworldindata.org", "statista.com",
  "imdb.com", "discogs.com", "musicbrainz.org", "openstreetmap.org",
];

/**
 * Platforms whose author is whoever showed up.
 *
 * The test has to catch subdomains — `r/x` lives on `reddit.com`, but a Substack lives on
 * `someone.substack.com` — so these are matched as suffixes rather than by equality.
 */
const FORUM_SUFFIXES = [
  "reddit.com", "quora.com", "stackexchange.com", "stackoverflow.com", "answers.com",
  "x.com", "twitter.com", "facebook.com", "instagram.com", "tiktok.com", "threads.net",
  "youtube.com", "youtu.be", "tumblr.com", "pinterest.com", "linkedin.com",
  "medium.com", "substack.com", "blogspot.com", "wordpress.com", "wixsite.com",
  "weebly.com", "ghost.io", "hashnode.dev", "dev.to", "livejournal.com",
  "4chan.org", "8kun.top", "rumble.com", "bitchute.com", "gab.com", "truthsocial.com",
  "telegram.me", "t.me", "discord.com", "patreon.com",
];

/** A host with `www.` gone and case folded, or "" if this wasn't a URL at all. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Whether `host` is `suffix` or something under it. */
function under(host, suffix) {
  const tail = suffix.startsWith(".") ? suffix : `.${suffix}`;
  return host === suffix.replace(/^\./, "") || host.endsWith(tail);
}

/**
 * Which tier a source belongs to.
 *
 * Order of tests is the whole design, and it runs most-specific first:
 *
 *  1. An explicit host list, because a named host is a decision already made.
 *  2. A forum platform, *before* the institutional suffixes — a university's student
 *     Reddit is still Reddit, and this is the direction an error should fall.
 *  3. An institutional suffix, which is the strongest structural signal there is.
 *  4. A press path (`/press-release/`, `/newsroom/`) on an ordinary company domain, which
 *     is that company publishing about itself — primary for what the company said, and the
 *     reader is told which it is.
 *  5. Everything else is `news`, not `forum`. An unrecognised domain is most often a
 *     regional paper or a trade publication, and defaulting it to the bottom tier would
 *     mean the filter quietly threw away most of the web the first time it was switched on.
 *     An unknown source is an unranked one, not a bad one.
 */
export function classifySource(source) {
  const url = typeof source === "string" ? source : source?.url;
  const host = hostOf(url) || String(source?.domain ?? "").toLowerCase().replace(/^www\./, "");
  if (!host) return "news";

  if (PRIMARY_HOSTS.has(host)) return "primary";
  if (NEWS_HOSTS.has(host)) return "news";

  if (FORUM_SUFFIXES.some((suffix) => under(host, suffix))) return "forum";
  if (REFERENCE_SUFFIXES.some((suffix) => under(host, suffix))) return "reference";
  if (INSTITUTIONAL_SUFFIXES.some((suffix) => under(host, suffix))) return "primary";

  let path = "";
  try {
    path = new URL(String(url)).pathname.toLowerCase();
  } catch {
    path = "";
  }
  if (/\/(press[-/]?releases?|newsroom|media[-/]centre|investors?)(\/|$)/.test(path)) return "primary";

  return "news";
}

/** A result with its tier on it. Non-destructive — callers keep the original shape. */
export function withTier(result) {
  return { ...result, tier: classifySource(result) };
}

/**
 * The tiers a request is allowed to use, cleaned up.
 *
 * Two rules, both there so a bad value cannot silently empty the ledger: anything that
 * isn't a known tier is dropped, and an empty result means "all of them" rather than
 * "none". A reader who unticks every box in settings has said something contradictory, and
 * the app answering with zero sources for every check afterwards would look broken rather
 * than obedient.
 */
export function normaliseTiers(tiers) {
  if (!Array.isArray(tiers)) return ALL_TIERS;
  const allowed = TIERS.filter((tier) => tiers.includes(tier));
  return allowed.length > 0 ? allowed : ALL_TIERS;
}

/**
 * Results tagged, filtered to the allowed tiers, and ordered best-supported first.
 *
 * The sort is **stable within a tier**, which matters: inside one tier the provider's own
 * relevance ordering is the best signal available, and re-sorting it by anything here would
 * be replacing a ranking built on the query with one built on the domain.
 */
export function rankResults(results, tiers = ALL_TIERS) {
  const allowed = new Set(normaliseTiers(tiers));
  return (results ?? [])
    .map(withTier)
    .filter((result) => allowed.has(result.tier))
    .map((result, index) => ({ result, index }))
    .sort((a, b) => TIERS.indexOf(a.result.tier) - TIERS.indexOf(b.result.tier) || a.index - b.index)
    .map(({ result }) => result);
}
