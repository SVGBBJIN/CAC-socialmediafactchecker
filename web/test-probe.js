// node --test test-probe.js
//
// Covers the link probe: the address vetting that keeps it from being an SSRF proxy, and
// the redirect-following that is the whole reason intake pings at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  probeLink,
  parseProbeURL,
  assertPublicHost,
  classifyIPv4,
  classifyIPv6,
  classifyAddress,
  platformForURL,
  stripTracking,
  ProbeRefused,
  MAX_REDIRECTS,
} from "./lib/link-probe.js";

/* ------------------------------------------------------------------ stub helpers */

/** A response with headers and a cancellable body, the two things the probe touches. */
function reply(status, headers = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => lower.get(String(name).toLowerCase()) ?? null },
    body: { cancel: async () => {} },
  };
}

/** Routes by URL; each entry is a response or a function of (url, init). */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers });
    const route = routes[url];
    if (!route) throw new Error(`unstubbed fetch: ${url}`);
    return typeof route === "function" ? route(url, init) : route;
  };
  impl.calls = calls;
  return impl;
}

/** Every name resolves to one public address unless overridden. */
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

/* -------------------------------------------------------------- address classing */

test("classifyIPv4 blocks the ranges that reach back inside", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "198.18.0.1",
    "255.255.255.255",
    "224.0.0.1",
  ]) {
    assert.equal(classifyIPv4(address), "blocked", address);
  }
});

test("classifyIPv4 lets real addresses through", () => {
  for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "192.167.1.1", "1.1.1.1"]) {
    assert.equal(classifyIPv4(address), "public", address);
  }
});

test("classifyIPv6 sees through the mapped forms", () => {
  assert.equal(classifyIPv6("::1"), "blocked");
  assert.equal(classifyIPv6("::"), "blocked");
  assert.equal(classifyIPv6("fc00::1"), "blocked");
  assert.equal(classifyIPv6("fe80::1"), "blocked");
  assert.equal(classifyIPv6("ff02::1"), "blocked");
  // Loopback and the metadata service, wearing an IPv6 hat.
  assert.equal(classifyIPv6("::ffff:127.0.0.1"), "blocked");
  assert.equal(classifyIPv6("::ffff:169.254.169.254"), "blocked");
  assert.equal(classifyIPv6("64:ff9b::169.254.169.254"), "blocked");
  assert.equal(classifyIPv6("2606:4700:4700::1111"), "public");
  assert.equal(classifyIPv6("::ffff:8.8.8.8"), "public");
});

test("classifyAddress dispatches on the literal's version", () => {
  assert.equal(classifyAddress("8.8.8.8"), "public");
  assert.equal(classifyAddress("::1"), "blocked");
  assert.equal(classifyAddress("not-an-ip"), "invalid");
});

/* ------------------------------------------------------------------ URL vetting */

test("parseProbeURL refuses schemes, credentials and nonsense", () => {
  assert.throws(() => parseProbeURL("file:///etc/passwd"), ProbeRefused);
  assert.throws(() => parseProbeURL("gopher://example.com"), ProbeRefused);
  assert.throws(() => parseProbeURL("https://user:pass@example.com/"), ProbeRefused);
  assert.throws(() => parseProbeURL("not a url"), ProbeRefused);
  assert.equal(parseProbeURL("https://tiktok.com/x").hostname, "tiktok.com");
});

test("assertPublicHost refuses names that never mean the public internet", async () => {
  for (const host of ["localhost", "db.localhost", "printer.local", "metadata.internal"]) {
    await assert.rejects(() => assertPublicHost(host, publicLookup), ProbeRefused, host);
  }
});

test("assertPublicHost refuses a private literal without asking DNS", async () => {
  const lookup = async () => {
    throw new Error("should not be called for a literal");
  };
  await assert.rejects(() => assertPublicHost("127.0.0.1", lookup), ProbeRefused);
  assert.deepEqual(await assertPublicHost("8.8.8.8", lookup), ["8.8.8.8"]);
});

test("assertPublicHost refuses a name with any private record, not just the first", async () => {
  const lookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(() => assertPublicHost("split.test", lookup), (error) => {
    assert.equal(error.kind, "blocked");
    return true;
  });
});

/* ---------------------------------------------------------------- platform naming */

test("platformForURL names the platforms and nothing else", () => {
  assert.equal(platformForURL("https://www.tiktok.com/@a/video/1"), "TikTok");
  assert.equal(platformForURL("https://vm.tiktok.com/ZMabc/"), "TikTok");
  assert.equal(platformForURL("https://youtu.be/abc"), "YouTube");
  assert.equal(platformForURL("https://m.youtube.com/watch?v=abc"), "YouTube");
  assert.equal(platformForURL("https://www.instagram.com/reel/abc/"), "Instagram");
  assert.equal(platformForURL("https://instagr.am/p/abc/"), "Instagram");
  assert.equal(platformForURL("https://nottiktok.com/x"), null);
  assert.equal(platformForURL("garbage"), null);
});

/* ---------------------------------------------------------------------- probing */

test("a live link comes back reachable, with its platform", async () => {
  const url = "https://www.tiktok.com/@a/video/1";
  const fetchImpl = stubFetch({ [url]: reply(200, { "content-type": "text/html" }) });
  const probe = await probeLink(url, { fetchImpl, lookupImpl: publicLookup });

  assert.equal(probe.reachable, true);
  assert.equal(probe.status, 200);
  assert.equal(probe.platform, "TikTok");
  assert.equal(probe.finalURL, url);
  assert.equal(probe.redirects, 0);
  assert.equal(fetchImpl.calls[0].method, "HEAD");
});

test("a share wrapper is classified by where it lands, not what was pasted", async () => {
  const short = "https://vm.tiktok.com/ZMabc/";
  const canonical = "https://www.tiktok.com/@someone/video/7123456789";
  const fetchImpl = stubFetch({
    [short]: reply(301, { location: canonical }),
    [canonical]: reply(200, { "content-type": "text/html" }),
  });

  const probe = await probeLink(short, { fetchImpl, lookupImpl: publicLookup });
  assert.equal(probe.reachable, true);
  assert.equal(probe.finalURL, canonical);
  assert.equal(probe.platform, "TikTok");
  assert.equal(probe.redirects, 1);
});

test("a relative Location is resolved against the hop it came from", async () => {
  const fetchImpl = stubFetch({
    "https://example.test/a": reply(302, { location: "/b" }),
    "https://example.test/b": reply(200),
  });
  const probe = await probeLink("https://example.test/a", {
    fetchImpl,
    lookupImpl: publicLookup,
  });
  assert.equal(probe.finalURL, "https://example.test/b");
});

test("a host that refuses HEAD is retried as a one-byte GET", async () => {
  const url = "https://www.instagram.com/reel/abc/";
  const fetchImpl = stubFetch({
    [url]: (_u, init) => (init.method === "HEAD" ? reply(405) : reply(200, { "content-type": "text/html" })),
  });

  const probe = await probeLink(url, { fetchImpl, lookupImpl: publicLookup });
  assert.equal(probe.reachable, true);
  assert.equal(probe.platform, "Instagram");
  assert.deepEqual(
    fetchImpl.calls.map((call) => call.method),
    ["HEAD", "GET"],
  );
  assert.equal(fetchImpl.calls[1].headers.range, "bytes=0-0");
});

test("the probe carries no cookies and follows nothing itself", async () => {
  const url = "https://example.test/";
  const fetchImpl = stubFetch({ [url]: reply(200) });
  await probeLink(url, { fetchImpl, lookupImpl: publicLookup });
  // `redirect: manual` is what makes the per-hop vetting below possible at all; a
  // `follow` here would have the runtime chase the chain with no checks in between.
  const init = fetchImpl.calls[0];
  assert.equal(init.headers["user-agent"].startsWith("Mozilla/5.0"), true);
});

test("a redirect into a private address is refused mid-chain", async () => {
  const start = "https://example.test/go";
  const fetchImpl = stubFetch({
    [start]: reply(302, { location: "http://169.254.169.254/latest/meta-data/" }),
  });

  await assert.rejects(
    () => probeLink(start, { fetchImpl, lookupImpl: publicLookup }),
    (error) => {
      assert.ok(error instanceof ProbeRefused);
      assert.equal(error.kind, "blocked");
      return true;
    },
  );
});

test("a redirect out of http(s) is refused", async () => {
  const start = "https://example.test/go";
  const fetchImpl = stubFetch({ [start]: reply(302, { location: "file:///etc/passwd" }) });
  await assert.rejects(() => probeLink(start, { fetchImpl, lookupImpl: publicLookup }), ProbeRefused);
});

test("a redirect loop ends at the cap instead of spinning", async () => {
  const fetchImpl = stubFetch({
    "https://example.test/a": reply(302, { location: "https://example.test/b" }),
    "https://example.test/b": reply(302, { location: "https://example.test/a" }),
  });
  const probe = await probeLink("https://example.test/a", {
    fetchImpl,
    lookupImpl: publicLookup,
  });
  assert.equal(probe.reachable, false);
  assert.equal(probe.kind, "redirects");
  assert.equal(probe.redirects, MAX_REDIRECTS + 1);
});

test("a name that doesn't resolve reports kind dns — intake's cue that it was text", async () => {
  const lookupImpl = async () => {
    throw new Error("ENOTFOUND");
  };
  const probe = await probeLink("https://Amazing.So", {
    fetchImpl: stubFetch({}),
    lookupImpl,
  });
  assert.equal(probe.reachable, false);
  assert.equal(probe.kind, "dns");
});

test("a dead post is unreachable but still a link", async () => {
  const url = "https://www.tiktok.com/@a/video/1";
  const fetchImpl = stubFetch({ [url]: reply(404) });
  const probe = await probeLink(url, { fetchImpl, lookupImpl: publicLookup });

  assert.equal(probe.reachable, false);
  assert.equal(probe.kind, "status");
  assert.notEqual(probe.kind, "dns");
  assert.equal(probe.platform, "TikTok");
  assert.match(probe.reason, /doesn't exist/);
});

test("a host that never answers reports a timeout rather than throwing", async () => {
  const fetchImpl = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  const probe = await probeLink("https://slow.test/", {
    fetchImpl,
    lookupImpl: publicLookup,
    timeoutMs: 20,
  });
  assert.equal(probe.reachable, false);
  assert.equal(probe.kind, "timeout");
});

test("the resolved URL is handed on without its share-tracking exhaust", async () => {
  const short = "https://vt.tiktok.com/ZSHabc/";
  const landed =
    "https://www.tiktok.com/@a/video/7123?_r=1&u_code=0&share_item_id=7123&utm_campaign=client_share";
  const fetchImpl = stubFetch({
    [short]: reply(302, { location: landed }),
    [landed]: reply(200),
  });

  const probe = await probeLink(short, { fetchImpl, lookupImpl: publicLookup });
  assert.equal(probe.canonicalURL, "https://www.tiktok.com/@a/video/7123");
  // The raw landing URL is still reported — stripping is a recommendation, not a redaction.
  assert.equal(probe.finalURL, landed);
});

test("stripTracking leaves load-bearing parameters alone", () => {
  assert.equal(
    stripTracking("https://www.youtube.com/watch?v=abc&t=30&list=PL1&utm_source=x&si=y"),
    "https://www.youtube.com/watch?v=abc&t=30&list=PL1",
  );
  assert.equal(stripTracking("not a url"), "not a url");
});
