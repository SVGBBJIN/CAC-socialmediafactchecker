// The post's own link preview, read off the page it lives on.
//
// This is the last thing tried before a clip is reported as simply missing. By the time it
// runs, three cheaper things have failed: the platform's resolve carried no caption or
// creator (or never completed), the browser worker either wasn't configured or couldn't
// help, and the platform's oEmbed — which only TikTok has — didn't answer either.
//
// What's left is the page itself, and specifically the four or five `<meta>` tags in its
// `<head>` that every platform maintains for other software to read. `og:description` on a
// reel *is* the caption. That is worth having: on short-form political content the caption
// is frequently the claim and the video is B-roll, so a post described by its caption is a
// post the model can still check, where a post described by nothing is a dead link.
//
// ## Why Open Graph and not the article scraper
//
// The obvious move is to point `lib/article.js` at the post URL — it already fetches a page,
// vets every redirect and pulls the readable text out. It does not work here, and it fails
// in a way worth naming so nobody tries it again: `fetchArticle` requires
// `MIN_ARTICLE_CHARS` (200) of readable prose and throws `empty` below that, on the grounds
// that a page with less than a paragraph is one whose content is drawn by JavaScript.
//
// A TikTok or Instagram post page *is* a page whose content is drawn by JavaScript. Its body
// is an app shell; `htmlToText` on it returns navigation furniture and a cookie notice. The
// article path is right to refuse it, and would refuse it every single time.
//
// The `<head>` is the opposite. Open Graph tags exist precisely so that Slack, iMessage,
// Discord and every link preview on the internet can render a post without executing its JS,
// which means the platforms serve them to anonymous requests and keep them stable — they are
// the most crawler-friendly surface these sites have, and the last thing they break. So this
// module reads the head and ignores the body entirely.
//
// ## What it costs, and what it can't do
//
// One GET, capped at the first `MAX_PREVIEW_BYTES` of HTML because the tags are in the head
// and the rest is megabytes of bundle. No browser, no dependency, no credential.
//
// It is not a way around a login wall. A post that Instagram serves only to signed-in
// viewers returns a login interstitial whose OG tags describe Instagram rather than the
// post, so `looksLikeInterstitial` drops answers that describe the site instead of the
// content. A miss returns null and the clip keeps the error it already had.

import { fetchStream } from "./media-fetch.js";
import { isTikTokHost } from "./tiktok.js";
import { isInstagramHost } from "./instagram.js";

/** Which host check gates each platform's post page. */
const PAGE_HOST = {
  TikTok: isTikTokHost,
  Instagram: isInstagramHost,
};

/**
 * How much of the page to read.
 *
 * The tags live in `<head>`, so this is a head-sized budget rather than a page-sized one —
 * both platforms ship hundreds of KB of bundle after it, and none of that is ever parsed.
 * Reaching the cap is a normal outcome, not an error: the read stops and whatever arrived
 * is parsed. That is the difference from `readCapped`, which throws, because there the cap
 * is a limit on a file we wanted all of.
 */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/** Longest one preview fetch may take, headers and body together. */
export const PREVIEW_TIMEOUT_MS = 8_000;

/** Matches the cap `describeClip` applies to a caption from any other source. */
const MAX_CAPTION_CHARS = 500;
const MAX_AUTHOR_CHARS = 120;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/125.0.0.0 Safari/537.36";

/**
 * `<meta property="og:title" content="...">` and its `name=` spelling, either attribute
 * order, single or double quotes.
 *
 * A regex rather than a parser because the target is four known tags in a head we are
 * reading a truncated prefix of — a real parser would need the document to be well-formed,
 * and a 256 KB slice of one is by construction not. Both attribute orders are matched
 * because both platforms emit both, sometimes in the same document.
 */
function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escaped}["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]).trim() || null;
  }
  return null;
}

/**
 * The handful of entities that actually turn up in a caption.
 *
 * Not a general decoder: captions are user-authored text that the platform has HTML-escaped,
 * and in practice that means quotes, ampersands, angle brackets and the numeric escapes an
 * emoji or a non-Latin script arrives as. Anything else is left alone rather than guessed at.
 */
function decodeEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // Last, so an escaped `&amp;lt;` does not become `<`.
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Whether the preview describes the platform rather than the post.
 *
 * A login wall, an age gate and a "content unavailable" page all return 200 with a perfectly
 * well-formed set of OG tags — describing Instagram or TikTok. Handing those on would tell
 * the model the post's caption is "Instagram · Sign up to see photos and videos from your
 * friends", which is worse than saying nothing: it looks like content and is not.
 */
export function looksLikeInterstitial(title, description) {
  const text = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  if (!text.trim()) return true;
  return [
    "log in",
    "login",
    "sign up",
    "sign in",
    "create an account",
    "page not found",
    "content unavailable",
    "this page isn't available",
    "watch the latest videos from",
  ].some((phrase) => text.includes(phrase));
}

/**
 * Read up to `maxBytes` of the body and stop, without treating the cap as a failure.
 *
 * `readCapped` in lib/media-fetch.js throws past its ceiling, which is right for a media
 * file — the whole point there is that we wanted all of it and it was too big. Here the cap
 * is the *plan*: the tags are in the head and the rest of the document is bundle, so hitting
 * it is the expected path and truncation costs nothing.
 */
async function readHead(response, maxBytes) {
  const iterator = response.body?.[Symbol.asyncIterator]
    ? response.body[Symbol.asyncIterator]()
    : response.body;
  if (!iterator) return "";

  const chunks = [];
  let total = 0;
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    chunks.push(chunk);
    total += chunk.length;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, maxBytes);
}

/**
 * Fetch a post page and return what its link preview says about it.
 *
 * Never throws. Every failure — a refused host, a non-200, a page with no tags, a login
 * interstitial — is `null`, because the caller already holds the error that actually
 * explains the missing clip and this tier only ever adds to it.
 *
 * @returns `{title, authorName, thumbnailURL}` — the shape `entry.metadataOnly` already
 *   uses, so `describeOEmbedFallback` renders it with no changes.
 */
export async function fetchPostPreview(
  rawURL,
  {
    platform,
    fetchImpl = fetch,
    signal,
    timeoutMs = PREVIEW_TIMEOUT_MS,
    maxBytes = MAX_PREVIEW_BYTES,
  } = {},
) {
  const isHost = PAGE_HOST[platform];
  if (!isHost) return null;

  let url;
  try {
    url = new URL(String(rawURL));
  } catch {
    return null;
  }
  // Re-checked here rather than trusted from the caller: this module fetches a URL, so it
  // owns the question of which URLs it will fetch. https only, the platform's own host, and
  // no credentials — the same three rules lib/link-probe.js applies at intake.
  if (url.protocol !== "https:") return null;
  if (!isHost(url.hostname)) return null;
  if (url.username || url.password) return null;

  let response;
  let release = () => {};
  try {
    ({ response, release } = await fetchStream(url.toString(), {
      fetchImpl,
      signal,
      timeoutMs,
      // Followed by the runtime: every hop stays on a host this platform owns or the final
      // response fails the check above's intent anyway, and unlike lib/article.js this
      // returns four short strings rather than the page body.
      redirect: "follow",
      credentials: "omit",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    }));
  } catch {
    return null;
  }

  try {
    if (!response?.ok) return null;
    // A redirect chain that left the platform — to a login host, a regional domain we don't
    // know, anything — is not a post page, whatever it answered.
    if (response.url) {
      try {
        if (!isHost(new URL(response.url).hostname)) return null;
      } catch {
        return null;
      }
    }

    const html = await readHead(response, maxBytes);
    if (!html) return null;

    const title = metaContent(html, "og:title");
    const description = metaContent(html, "og:description");
    if (looksLikeInterstitial(title, description)) return null;

    // The description is the caption on both platforms; the title is a fallback for the
    // rare post that carries one and no description.
    const caption = description || title;
    if (!caption) return null;

    return {
      title: caption.slice(0, MAX_CAPTION_CHARS),
      authorName: authorFrom(html, url, platform),
      thumbnailURL: metaContent(html, "og:image"),
    };
  } catch {
    return null;
  } finally {
    release();
  }
}

/**
 * The creator, from the page if it says and from the URL if it doesn't.
 *
 * TikTok puts the handle in the path (`/@handle/video/<id>`), which is the most reliable
 * source it has — it survives every markup change because it is the URL the user pasted.
 * Instagram's post URLs carry only a shortcode, so there the tags are the only option.
 */
function authorFrom(html, url, platform) {
  if (platform === "TikTok") {
    const handle = url.pathname.split("/").filter(Boolean).find((s) => s.startsWith("@"));
    if (handle && handle.length > 1) return handle.slice(1, MAX_AUTHOR_CHARS);
  }
  const tagged = metaContent(html, "article:author") || metaContent(html, "profile:username");
  return tagged ? tagged.slice(0, MAX_AUTHOR_CHARS) : null;
}
