# Browser worker

Resolves a TikTok or Instagram post with a real Chromium, for the cases where `web/`'s
bare-HTTP resolvers can't.

It is a fallback, and it only ever runs after something else has already failed. With no
worker configured, `web/` behaves exactly as it did before this existed.

## What problem this solves

`web/lib/tiktok.js` reads an embed page; `web/lib/instagram.js` runs the GraphQL query
instagram.com's own client runs. Both are anonymous HTTP, both need no credential, and both
are the right default — that is what makes a reel cost what a TikTok costs.

They fail in four ways that have nothing to do with the post being unavailable:

| Failure | What it means | Can a browser get past it? |
|---|---|---|
| `rateLimited` | 429 — Instagram's normal answer to anonymous datacenter traffic | Yes, with a real session |
| `forbidden` | The endpoint declining us specifically | Usually |
| `malformed` | The payload shape moved; our parser is behind | Yes — the *page* is fine |
| `upstream` | The catch-all: the platform answered, but not with anything usable | Often — it is the default kind, so it covers whatever hasn't been classified yet |
| `unavailable` | Private, deleted, region-blocked | **No** — a browser sees the same nothing |
| `notAVideo` | Never a post | **No** |
| `tooLarge` | About the file we already found | **No** |
| `expired` | Signed URL aged out | **No** — already repaired over plain HTTP, more cheaply |

Only the first four escalate. The set lives in `ESCALATED_KINDS` in
`web/lib/browser-resolve.js`, and a kind that isn't in it never spends browser time — a new
failure mode has to be classified deliberately before it can start costing seconds.

`upstream` is worth reading twice, because it is the one that isn't a diagnosis. It is the
default `kind` on both `TikTokError` and `InstagramError`, so it means "something went wrong
at the platform and nothing narrowed it further" — which is exactly the population a real
browser is most likely to succeed on, and also the one most likely to waste a resolve. That
is the trade the clip budget bounds rather than the classifier.

## What this is not

It is not screen recording — that's slow by construction, needs a visible surface to
record, and only ever bought back what a resolved media URL already gets for free.

The insight that makes a browser worth running here is not that it can be *recorded* — it is
that it holds a session. Cookies, a `Referer`, and a JS runtime that has already executed are
what get you to the media URL. Once you have that URL, it is fetchable by an ordinary
anonymous request, which is the property the whole direct-fetch arm already rests on.

So this service returns a URL and some metadata. It never downloads and never records.
`web/` fetches the bytes over its normal path, through the same host allowlist, size cap,
timeout and retry policy every other clip goes through. **Nothing here is on the byte path.**

## Why the network, not the DOM

The obvious approach is to find the `<video>` and read its `src`. It's the fragile one: both
platforms hydrate their players from JS, blob-URL the source on some routes (naming nothing
fetchable outside that page), and move their markup often. A DOM scrape would be a third
parser to keep in step with the two in `web/lib`, with no captured fixture to test it against.

Whatever the player does internally, it ends up making an HTTP request to a CDN, and that
request has a URL, a host and a content-type. `page.on("response")` watches for the first one
that looks like media on a host the platform actually serves from. That works the same
whether the player is React, a web component, or something new next quarter.

## Video only

The matcher accepts `video/*` and nothing else, which is a limitation rather than an
oversight:

- **A poster frame is an image, and it loads first.** A matcher that accepted images would
  settle on the thumbnail nearly every time and report it as the post's media.
- **A photo post is not one URL, it is an ordered set.** Slide order is load-bearing — the
  model is told these are slides *in post order*, because otherwise it reads them as
  unrelated pictures. Network sightings arrive in fetch order, deduplicated by nothing, mixed
  in with avatars and preview thumbnails. Guessing a sequence out of that would produce a
  plausible-looking wrong order, which is worse than not answering: a shuffled or partial
  carousel changes what the model thinks the post says.

So a throttled *photo* post is not rescued. `resolvePost` returns null, `web/` keeps the
platform's own error, and the user gets the note they would have got anyway.

## Trust

The worker's reply is validated by `web/` through `validateHint` — the same function that
vets a resolve handed back by a browser. An https URL on the platform's own CDN allowlist or
nothing; a bounded caption; a `videoID` matching the identifier shape; no `referer`; and
`sourceURL` stamped from the link `web/` already has rather than read from the payload. The
downloader then re-checks the host anyway.

That's deliberate. The worker is operator-configured infrastructure, so it isn't hostile the
way a browser-supplied hint is — but its output is derived from a third-party page it just
rendered, which is exactly the input the validator exists to bound. One validator, one
description of what a resolve may say, no second copy to drift.

The allowlists in `urls.js` are a copy of the ones in `web/lib`, not an import — the two are
separate packages and coupling their releases for two arrays buys nothing. The copy is not
load-bearing: a stale entry here can only cost a resolve, never widen what `web/` will
download.

## Running it

```bash
cd worker
npm install
npx playwright install --with-deps chromium
BROWSER_WORKER_TOKEN=$(openssl rand -hex 32) npm start
```

Then point `web/` at it, in `web/.env.local`:

```
BROWSER_WORKER_URL=https://your-worker.example/
BROWSER_WORKER_TOKEN=<the same token>
```

`web/` refuses an `http://` worker URL unless it is loopback — a token over plaintext is a
token in the clear.

### Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `127.0.0.1`, or `0.0.0.0` once a token is set | Which interface to listen on. With no token set the worker answers anyone who can reach it, so it binds to loopback by default; setting a token is what opens it up, and setting `HOST` explicitly overrides either way. A container that needs the port published wants `HOST=0.0.0.0` **and** a token. |
| `BROWSER_WORKER_TOKEN` | none | Shared secret. Set it whenever the worker is reachable by anything but localhost. |
| `MAX_CONCURRENCY` | `4` | Open pages at once. Past it, callers get an immediate 503 rather than a queue slot — see below. |
| `RESOLVE_TIMEOUT_MS` | `15000` | Ceiling on one resolve inside the browser. |

### Where to run it

Anywhere that can hold a warm Chromium: a small container, a VM, a Fly machine. **Not a
serverless function** — a cold browser launch per request is most of the latency this service
exists to avoid, and neither Vercel's runtime nor its execution ceiling suits a browser.

The browser process outlives requests; only the context (cookies, storage, cache) is
per-request, which keeps one caller's session from becoming the next one's.

## Latency, and why it's bounded twice

This path is slow by nature, and it runs when the user is already waiting. So:

- The **client** caps its call at `BROWSER_RESOLVE_TIMEOUT_MS` (20s), and further at whatever
  is left of the clip budget — an escalation starting with two seconds left gets two seconds,
  not twenty. Below `MIN_ESCALATION_MS` (3s) it isn't attempted at all, because a page load
  can't finish in that and the attempt would only postpone a note we already have.
- The **worker** turns callers away at `MAX_CONCURRENCY` instead of queueing them. A request
  that waits in line only to time out has spent the clip budget for nothing; a fast 503 lets
  `web/` report the original platform error while it's still worth reporting.

## Tests

```bash
npm test
```

Covers `vetPostURL`, which is the only thing standing between a request body and an arbitrary
navigation. It's pure and lives in `urls.js` precisely so it can be tested without launching a
browser. The Playwright half needs a live post and isn't covered here.
