// Resolving a post by watching a browser load it.
//
// The whole job is to answer one question the bare-HTTP resolvers in web/lib couldn't:
// *what is the media URL for this post?* A real Chromium answers it by loading the page the
// way a person would — running the JS, carrying the cookies the site set on the way in, and
// sending the `Referer` the player sends — and then simply requesting the media, at which
// point we read the URL off the wire.
//
// ## Why the network, not the DOM
//
// The obvious approach is to find the `<video>` and read its `src`. It is the fragile one.
// Both platforms hydrate their players from JS, blob-URL the source on some routes
// (`blob:https://...`, which names nothing fetchable outside that page), and move their
// markup often — a DOM scrape is a second parser to keep in step with the two in web/lib,
// with the same shape of breakage and no captured fixture to test it against.
//
// The network is stabler than the markup. Whatever the player does internally, it ends up
// making an HTTP request to a CDN for the bytes, and that request has a URL, a host and a
// content-type. So `page.on("response")` watches for the first response that looks like
// media on a host the platform actually serves from, and that URL is the answer. It works
// the same whether the player is React, a web component or something new next quarter.
//
// ## Why the URL is enough
//
// A reasonable objection: if the browser had to be logged in to see it, handing the URL to
// a plain `fetch` elsewhere won't work. In practice these CDN URLs are signed rather than
// cookie-bound — anonymous, time-limited, and fetchable by anyone holding the signature,
// which is the property the entire direct-fetch arm already rests on (verified live, see
// the README). The session is what gets you *to* the URL, not what makes it fetchable.
//
// That is also why this service does not download or record anything. It returns a URL and
// some metadata; web/ fetches the bytes over its normal path, through the same host
// allowlist, size cap, timeout and retry policy every other clip goes through. Nothing here
// is on the byte path.

import { chromium } from "playwright";

import { MEDIA_HOSTS, hostAllowed, vetPostURL } from "./urls.js";

/**
 * What counts as the media response we're waiting for.
 *
 * Video only, and that is a limitation rather than an oversight. Two reasons:
 *
 * A poster frame is an image, and it loads *before* the video on both platforms — so a
 * matcher that accepted images would settle on the thumbnail nearly every time and report
 * it as the post's media.
 *
 * And a photo post is not one URL, it is an ordered set. Slide order is load-bearing (the
 * model is told these are slides "in post order", because otherwise it reads them as
 * unrelated pictures), and network sightings arrive in fetch order, deduplicated by nothing,
 * mixed in with avatars and preview thumbnails. Guessing a sequence out of that would
 * produce a plausible-looking wrong order, which is worse than not answering — a partial or
 * shuffled carousel changes what the model thinks the post says.
 *
 * So a throttled photo post is simply not rescued, and `resolvePost` returns null. The
 * caller keeps the platform's own error, which is the honest outcome.
 */
const MEDIA_TYPE = /^video\//i;

/**
 * A browser kept warm across requests.
 *
 * Launching Chromium is a second or two, which on a path that only runs *after* something
 * already failed is the difference between a recoverable link and one the clip budget gives
 * up on. So the browser outlives the request; only the context — cookies, storage, cache —
 * is per-request, which keeps one caller's session from becoming the next one's.
 */
let browserPromise = null;

export function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // Nothing here plays audio or shows a window; both are pure cost in a container.
        "--mute-audio",
        "--disable-gpu",
      ],
    });
    // A launch that fails must not be remembered as the browser, or every later request
    // awaits the same rejected promise forever.
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  const pending = browserPromise;
  browserPromise = null;
  if (pending) await (await pending).close().catch(() => {});
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/125.0.0.0 Safari/537.36";

/**
 * Load a post and report the media it fetched.
 *
 * @returns the `hintFromResolved` wire shape web/lib/resolve-hint.js validates, or null if
 *   the page produced no media we recognise within the deadline.
 */
export async function resolvePost(rawURL, platform, { timeoutMs = 15_000 } = {}) {
  const url = vetPostURL(rawURL, platform);
  if (!url) throw new Error("not a post URL for that platform");
  const allowed = MEDIA_HOSTS[platform];

  const context = await (await browser()).newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });

  try {
    const page = await context.newPage();

    // Resolved with the URL of the first video response on an allowed host. Set up before
    // navigation so a player that starts fetching during load is not missed. Settling more
    // than once is harmless — a promise keeps its first value, which is the earliest
    // sighting, and that is the one we want.
    let settle;
    const sighting = new Promise((resolve) => {
      settle = resolve;
    });

    page.on("response", (response) => {
      try {
        const target = new URL(response.url());
        if (target.protocol !== "https:") return;
        if (!hostAllowed(target.hostname, allowed)) return;
        if (!MEDIA_TYPE.test(response.headers()["content-type"] ?? "")) return;
        settle(target.toString());
      } catch {
        // A response whose URL won't parse is not the one we're waiting for.
      }
    });

    // `domcontentloaded` rather than `networkidle`: these pages keep a socket open for
    // telemetry and never go idle, and we are not waiting for the page to finish — we are
    // waiting for one specific response, which `sighting` reports the moment it lands.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // Autoplay is muted-only in Chromium, which is enough: a muted play still fetches the
    // video. Best-effort — on a route where the player self-starts this is a no-op, and a
    // click that lands on nothing must not fail the resolve.
    await page
      .locator("video")
      .first()
      .click({ timeout: 2_000, force: true })
      .catch(() => {});

    const mediaURL = await Promise.race([
      sighting,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!mediaURL) return null;

    const meta = await readMetadata(page, platform);

    // Always a video — see MEDIA_TYPE. `video/mp4` rather than the CDN's own spelling
    // because that is the one video type web/'s validator accepts, and the CDN labels the
    // same MP4 several different ways depending on which edge served it.
    return {
      kind: "video",
      videoID: meta.videoID,
      mediaURL,
      mimeType: "video/mp4",
      caption: meta.caption,
      authorName: meta.authorName,
      duration: null,
      width: null,
      height: null,
    };
  } finally {
    // The context, not the browser: the next request gets a clean session and a warm
    // process.
    await context.close().catch(() => {});
  }
}

/**
 * Caption, author and the post's own identifier.
 *
 * All three come from `<meta>` and the URL rather than from the player's markup, because
 * those are the parts of the page that exist to be read by other software — Open Graph tags
 * are what the platforms hand to every link preview on the internet, so they move far less
 * often than the app's own DOM.
 *
 * Everything here is optional. web/'s validator bounds and re-checks all of it, and a post
 * with no caption is a post with no caption, not a failed resolve.
 */
async function readMetadata(page, platform) {
  const content = async (selector) =>
    page
      .locator(selector)
      .first()
      .getAttribute("content", { timeout: 1_000 })
      .catch(() => null);

  const [ogTitle, ogDescription] = await Promise.all([
    content('meta[property="og:title"]'),
    content('meta[property="og:description"]'),
  ]);

  const url = new URL(page.url());
  const segments = url.pathname.split("/").filter(Boolean);

  let videoID = null;
  let authorName = null;
  if (platform === "TikTok") {
    // /@user/video/<id> and /@user/photo/<id> both put the ID last.
    const marker = segments.findIndex((s) => s === "video" || s === "photo");
    if (marker >= 0 && segments[marker + 1]) videoID = segments[marker + 1];
    const handle = segments.find((s) => s.startsWith("@"));
    if (handle) authorName = handle.slice(1);
  } else {
    // /p/<shortcode>/, /reel/<shortcode>/, /tv/<shortcode>/
    const marker = segments.findIndex((s) => s === "p" || s === "reel" || s === "tv");
    if (marker >= 0 && segments[marker + 1]) videoID = segments[marker + 1];
  }

  return {
    videoID,
    caption: ogDescription || ogTitle || null,
    authorName,
  };
}
