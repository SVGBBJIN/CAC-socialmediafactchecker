// Ping the link before believing anything about it.
//
// Intake used to decide what a pasted string was entirely from its shape: a regex said
// "that looks like a URL", a hostname switch said "that's TikTok", and the rest of the
// pipeline took both on faith. That is wrong in both directions. A share wrapper
// (`vm.tiktok.com/ZM…`, `instagram.com/share/…`, anything behind a shortener) is a
// supported post that the hostname switch calls unsupported, and a stray token with a dot
// in it (`hi.there`, `Amazing.So`) is a sentence that the URL regex calls a video and
// burns a full fact-check run on.
//
// So the primary measure is now the network: follow the redirects, see what answers, and
// classify the URL we actually landed on. The regex stays as the fallback for when the
// probe can't run — a dev server without the route, a probe that times out — because
// "shape says TikTok" is still better than nothing. Secondary, not absent.
//
// The cost of pinging is that this is the one place in the app that fetches a host the
// user named, which is the shape of an SSRF proxy. Everything below the platform
// detection is about making that safe: scheme allowlist, no credentials, DNS-resolved
// address checks on every hop, a redirect cap, a short deadline, and a response we read
// the headers of and never the body of. Nothing this route returns contains a byte the
// remote host sent as content.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { fetchWithTimeout } from "./media-fetch.js";

/** The UA a probe presents. Same shape as the embed clients' — a plain desktop browser. */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Long enough for a redirect chain over a slow link, short enough that intake never sits
 * there. The probe is a latency tax on every paste, so it is deliberately impatient: a
 * host that hasn't answered in this long falls back to the regex rather than holding the
 * user.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 6_000;

/**
 * Share links legitimately chain two or three hops (shortener → platform → canonical
 * path). Past this it is a loop or a tarpit, neither of which intake needs to solve.
 */
export const MAX_REDIRECTS = 5;

/** A refusal on policy grounds — the URL is one we will not fetch at all. */
export class ProbeRefused extends Error {
  constructor(message, { status = 400, kind = "refused" } = {}) {
    super(message);
    this.name = "ProbeRefused";
    this.status = status;
    this.kind = kind;
  }
}

/* --------------------------------------------------------------- platform naming */

/**
 * Platform from a URL's host — the same judgement the client's `platformFor` makes.
 *
 * Duplicated across the boundary on purpose, exactly as `youTubeVideoID` is: the client
 * needs it synchronously with no network, the server needs it on the *resolved* URL, and
 * a shared module for two small host switches would cost more than it saves.
 *
 * @returns "TikTok" | "YouTube" | "Instagram" | null
 */
export function platformForURL(urlString) {
  let host;
  try {
    host = new URL(urlString).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "TikTok";
  if (host === "youtube.com" || host.endsWith(".youtube.com")) return "YouTube";
  if (host === "youtu.be" || host === "youtube-nocookie.com") return "YouTube";
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "Instagram";
  if (host === "instagr.am" || host.endsWith(".instagr.am")) return "Instagram";
  return null;
}

/**
 * Query parameters a share link picks up on the way out, none of which identify the post.
 *
 * A followed TikTok share link lands on a canonical URL trailing a dozen of these, and
 * that string is what the library would then show as the thing being checked. Removed by
 * name rather than by keeping a known-good list: `v`, `t` and `list` on YouTube are load-
 * bearing, and a rule that only kept what it recognised would eventually eat one.
 */
const TRACKING_PARAMS = new Set([
  "_d",
  "_r",
  "_t",
  "checksum",
  "fbclid",
  "gclid",
  "igsh",
  "igshid",
  "is_from_webapp",
  "mkt_tok",
  "preview_pb",
  "sec_user_id",
  "sender_device",
  "sender_web_id",
  "share_app_id",
  "share_item_id",
  "share_link_id",
  "si",
  "social_sharing",
  "source",
  "timestamp",
  "tt_from",
  "u_code",
  "web_id",
]);

/** The URL a human would recognise: same page, without the share-tracking exhaust. */
export function stripTracking(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return urlString;
  }
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || lower.startsWith("utm_")) url.searchParams.delete(key);
  }
  return url.toString();
}

/* ------------------------------------------------------------- address vetting */

/**
 * Whether an IPv4 literal is routable on the public internet.
 *
 * The ranges refused here are the ones that make an outbound fetch a way *into* our own
 * network: loopback, the RFC1918 blocks, carrier NAT, and — the one that matters most on
 * a cloud host — 169.254.0.0/16, where the instance metadata service and its credentials
 * live.
 */
export function classifyIPv4(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return "invalid";
  }
  const [a, b, c] = parts;
  if (a === 0) return "blocked"; // "this network"
  if (a === 10) return "blocked"; // RFC1918
  if (a === 127) return "blocked"; // loopback
  if (a === 100 && b >= 64 && b <= 127) return "blocked"; // CGNAT
  if (a === 169 && b === 254) return "blocked"; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return "blocked"; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "blocked"; // IETF protocol / TEST-NET-1
  if (a === 192 && b === 168) return "blocked"; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return "blocked"; // benchmarking
  if (a === 198 && b === 51 && c === 100) return "blocked"; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "blocked"; // TEST-NET-3
  if (a >= 224) return "blocked"; // multicast, reserved, broadcast
  return "public";
}

/** `net.isIP` has already said this is valid IPv6; expand it to eight 16-bit groups. */
function expandIPv6(address) {
  let text = String(address).toLowerCase().split("%")[0];

  // A trailing dotted quad (`::ffff:1.2.3.4`) is two groups written in IPv4 notation.
  const lastColon = text.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const quad = tail.split(".").map(Number);
    if (quad.length !== 4 || quad.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    const hi = ((quad[0] << 8) | quad[1]).toString(16);
    const lo = ((quad[2] << 8) | quad[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (fill < 0) return null;

  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest].map((g) =>
    Number.parseInt(g || "0", 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * Whether an IPv6 literal is routable — and, for the mapped forms, whether the IPv4
 * address hiding inside it is.
 *
 * The embedded-v4 cases are the whole reason this isn't a two-line check: `::ffff:127.0.0.1`
 * and `64:ff9b::169.254.169.254` are loopback and the metadata service wearing an IPv6 hat,
 * and a classifier that only knew about `fc00::/7` would wave both through.
 */
export function classifyIPv6(address) {
  const groups = expandIPv6(address);
  if (!groups) return "invalid";

  const embeddedV4 = () =>
    classifyIPv4(
      [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join("."),
    );

  const leading = groups.slice(0, 6).every((g) => g === 0);
  if (leading && groups[6] === 0 && groups[7] === 0) return "blocked"; // ::
  if (leading && groups[6] === 0 && groups[7] === 1) return "blocked"; // ::1
  // ::ffff:0:0/96 (v4-mapped) and the deprecated ::a.b.c.d (v4-compatible).
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return embeddedV4();
  }
  // 64:ff9b::/96 — NAT64, another way to name a v4 address.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return embeddedV4();
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return "blocked"; // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return "blocked"; // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return "blocked"; // ff00::/8 multicast
  return "public";
}

/** `classifyIPv4`/`classifyIPv6`, dispatched on what the literal actually is. */
export function classifyAddress(address) {
  const version = isIP(String(address));
  if (version === 4) return classifyIPv4(address);
  if (version === 6) return classifyIPv6(address);
  return "invalid";
}

/**
 * Refuses unless every address `hostname` resolves to is public.
 *
 * *Every* address, not the first: a name with one public A record and one pointing at
 * 127.0.0.1 is a deliberate attempt at exactly this, and which record the connect picks
 * is not ours to choose.
 *
 * Known gap, stated rather than papered over: we resolve here and then hand the
 * *hostname* to fetch, which resolves again. A record that changes between the two calls
 * (DNS rebinding) beats this check. Closing it properly means pinning the vetted address
 * and overriding the connect, which `fetch` gives no seam for. It is an acceptable
 * residual here specifically because the probe returns only status, content-type and the
 * final URL — never a byte of the response body — so a won race yields a boolean about a
 * port, not the contents of an internal service.
 */
export async function assertPublicHost(hostname, lookupImpl = dnsLookup) {
  const host = String(hostname ?? "").toLowerCase();
  if (!host) throw new ProbeRefused("That link has no host.", { kind: "invalid" });

  // Names that never mean anything outside the machine or its LAN. Refused before the
  // resolver, since a split-horizon resolver would happily give them a public-looking answer.
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new ProbeRefused("That link points at this machine.", { kind: "blocked" });
  }
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    throw new ProbeRefused("That link points at a private network.", { kind: "blocked" });
  }

  if (isIP(host)) {
    if (classifyAddress(host) !== "public") {
      throw new ProbeRefused("That link points at a private address.", { kind: "blocked" });
    }
    return [host];
  }

  let records;
  try {
    records = await lookupImpl(host, { all: true });
  } catch {
    // No DNS answer at all. Not a policy refusal — this is the signal intake most wants,
    // "there is nothing at that name", so it goes back as an unreachable result.
    throw new ProbeRefused(`Nothing answers at ${host}.`, { status: 200, kind: "dns" });
  }

  const addresses = (Array.isArray(records) ? records : [records])
    .map((record) => record?.address)
    .filter(Boolean);
  if (addresses.length === 0) {
    throw new ProbeRefused(`Nothing answers at ${host}.`, { status: 200, kind: "dns" });
  }
  if (addresses.some((address) => classifyAddress(address) !== "public")) {
    throw new ProbeRefused("That link resolves to a private address.", { kind: "blocked" });
  }
  return addresses;
}

/** The URL, parsed and vetted for shape, or a `ProbeRefused` explaining why not. */
export function parseProbeURL(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new ProbeRefused("That isn't a valid URL.", { kind: "invalid" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProbeRefused("Only http and https links can be checked.", { kind: "scheme" });
  }
  // Credentials in a URL are either a phishing shape or an attempt to authenticate to
  // something internal. Neither belongs on a link we're about to fetch on the user's behalf.
  if (url.username || url.password) {
    throw new ProbeRefused("That link carries embedded credentials.", { kind: "blocked" });
  }
  return url;
}

/* ------------------------------------------------------------------- the probe */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Statuses that mean "not with that method" rather than "not there".
 *
 * TikTok and Instagram both answer a bare HEAD with a refusal, so a probe that trusted
 * the first status would report every supported platform as broken. These retry as a GET
 * asking for a single byte, whose body is cancelled the moment the headers land.
 */
const RETRY_AS_GET = new Set([400, 403, 405, 501]);

async function requestOnce(url, method, { fetchImpl, timeoutMs, signal }) {
  return fetchWithTimeout(url.toString(), {
    fetchImpl,
    timeoutMs,
    signal,
    method,
    redirect: "manual",
    // No cookies, ever. The probe must not carry the server's ambient identity to a host
    // the user named, and an unauthenticated request is what keeps this a "does it exist"
    // question rather than an access-granting one.
    credentials: "omit",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      // Only relevant on the GET retry; harmless on HEAD. Asks for one byte so a host that
      // insists on a body doesn't start streaming a page we're going to throw away.
      ...(method === "GET" ? { range: "bytes=0-0" } : {}),
    },
  });
}

/**
 * Follow a pasted link and report what's actually there.
 *
 * Never throws for the ordinary "that link is dead" outcomes — those come back as a
 * result with `reachable: false` and a `kind` intake can branch on. `ProbeRefused` is
 * reserved for URLs we decline to fetch at all.
 *
 * @returns {Promise<{url: string, finalURL: string, reachable: boolean, status: number|null,
 *   contentType: string|null, redirects: number, platform: string|null, reason: string|null,
 *   kind: string|null}>}
 */
export async function probeLink(
  raw,
  {
    fetchImpl = fetch,
    lookupImpl = dnsLookup,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    signal,
  } = {},
) {
  const start = parseProbeURL(raw);
  let current = start;
  let redirects = 0;

  const result = (fields) => ({
    url: start.toString(),
    finalURL: current.toString(),
    // What the rest of the app should actually use. Same page as `finalURL`, minus the
    // share-tracking parameters a redirect chain hangs off it.
    canonicalURL: stripTracking(current.toString()),
    redirects,
    platform: platformForURL(current.toString()),
    status: null,
    contentType: null,
    reason: null,
    kind: null,
    ...fields,
  });

  for (;;) {
    // Re-vetted on every hop, not just the first. A public host redirecting to
    // http://169.254.169.254/ is the standard way past a check that only looked at what
    // the user typed.
    try {
      await assertPublicHost(current.hostname, lookupImpl);
    } catch (error) {
      // "That name doesn't resolve" is an answer about the link, not a refusal to look at
      // it — and it is the answer that tells intake the string was never a link. Every
      // other refusal is policy and keeps throwing.
      if (error instanceof ProbeRefused && error.kind === "dns") {
        return result({ reachable: false, kind: "dns", reason: error.message });
      }
      throw error;
    }

    let response;
    try {
      response = await requestOnce(current, "HEAD", { fetchImpl, timeoutMs, signal });
      if (RETRY_AS_GET.has(response.status)) {
        await response.body?.cancel?.().catch(() => {});
        response = await requestOnce(current, "GET", { fetchImpl, timeoutMs, signal });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
      return result({
        reachable: false,
        kind: timedOut ? "timeout" : "connect",
        reason: timedOut
          ? "That link took too long to answer."
          : `Couldn't reach ${current.hostname}.`,
      });
    }

    // The headers are the entire payload of interest; the body is never read, and on the
    // GET retry it is cancelled here so the transfer stops at the first byte.
    await response.body?.cancel?.().catch(() => {});

    const status = response.status;
    const location = response.headers?.get?.("location");
    if (REDIRECT_STATUSES.has(status) && location) {
      redirects += 1;
      if (redirects > maxRedirects) {
        return result({
          reachable: false,
          status,
          kind: "redirects",
          reason: "That link redirects in circles.",
        });
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        return result({
          reachable: false,
          status,
          kind: "connect",
          reason: "That link redirects somewhere invalid.",
        });
      }
      // A redirect out of http(s) — to `file:`, `gopher:`, an app scheme — is not a hop
      // we follow. parseProbeURL states the rule once; reuse it rather than restate it.
      current = parseProbeURL(next.toString());
      continue;
    }

    const contentType = response.headers?.get?.("content-type") ?? null;
    // 4xx/5xx still tell us the host is real and the path isn't, which is the distinction
    // intake needs: a 404 on tiktok.com is a dead post, not an unsupported platform.
    return result({
      reachable: status >= 200 && status < 400,
      status,
      contentType,
      kind: status >= 400 ? "status" : null,
      reason:
        status >= 400
          ? status === 404 || status === 410
            ? "That post doesn't exist any more."
            : `That link answered ${status}.`
          : null,
    });
  }
}
