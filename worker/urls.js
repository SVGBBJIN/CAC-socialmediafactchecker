// Which hosts the worker may navigate to, and which it may believe about media.
//
// Split out from resolve.js for the same reason the platform parsers in web/lib are split
// out from their fetches: this is the part that decides where a caller can point a browser,
// and it should be testable without launching one. resolve.js imports Playwright; this file
// imports nothing.

/**
 * CDN families each platform's media may come from.
 *
 * Deliberately a copy of the lists in web/lib/tiktok.js and web/lib/instagram.js rather
 * than an import: this service is a separate package with its own dependencies, and wiring
 * a cross-package import for two arrays would couple their release cycles for no benefit.
 * The copy is not load-bearing — web/ re-checks every URL against its own list before
 * fetching a byte (see `validateHint`), so a stale entry here can only cost a resolve, and
 * can never widen what web/ is willing to download.
 */
export const MEDIA_HOSTS = {
  TikTok: [
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "tiktokcdn-in.com",
    "tiktokv.com",
    "tiktokv.us",
    "ttwstatic.com",
    "muscdn.com",
    "byteoversea.com",
  ],
  Instagram: ["cdninstagram.com", "fbcdn.net"],
};

/** Where each platform's posts live, so a request can't point the browser anywhere else. */
export const PAGE_HOSTS = {
  TikTok: ["tiktok.com"],
  Instagram: ["instagram.com"],
};

/** Suffix match on a dot boundary, so `tiktokcdn.com.evil.test` is not `tiktokcdn.com`. */
export function hostAllowed(hostname, allowed) {
  const host = String(hostname).toLowerCase();
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * The post URL, checked to be a post URL on the platform it claims.
 *
 * This is the only thing standing between a request body and an arbitrary navigation, so it
 * fails closed on everything: a host that merely looks like the platform's, a scheme that
 * isn't https, credentials in the URL, an unknown platform, a string that isn't a URL.
 */
export function vetPostURL(raw, platform) {
  const hosts = PAGE_HOSTS[platform];
  if (!hosts) return null;
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!hostAllowed(url.hostname, hosts)) return null;
  // No credentials in the URL, same rule web/lib/link-probe.js applies at intake.
  if (url.username || url.password) return null;
  return url.toString();
}
