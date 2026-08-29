# Seer

Paste a link to a short-form video; get its claims checked against live sources, each one
carrying a citation you can follow.

`web/` is the whole product: a static front end and a small set of Node server routes,
with no build step and no external dependencies. `worker/` is an optional Playwright
browser-automation service `web/` can fall back to when its plain-HTTP TikTok/Instagram
resolvers get throttled or refused — it never touches the byte path itself, only reports
a media URL for `web/` to download normally.

## Getting media to Gemini

Four shapes, cheapest first, decided per platform:

1. **YouTube** — handed to Gemini as a `file_data` URL part; Gemini fetches and watches it
   itself. No bytes touch this app.
2. **TikTok** — `web/lib/tiktok.js`: embed page → `__FRONTITY_CONNECT_STATE__` blob → CDN
   URL (video or, for photo posts, `imagePostInfo.displayImages[]`) → bytes downloaded and
   attached (inline or via the Files API for larger clips).
3. **Instagram** — `web/lib/instagram.js`: same shape via `/graphql/query` (`doc_id` +
   shortcode + CSRF) → `video_url` or each `XDTGraphImage.display_url` for carousels.
4. **Any other link** — treated as a "page", not a video: `web/lib/article.js` fetches and
   extracts text, quoted into the prompt as the subject under examination (never cited as
   a source).

### TikTok needs no screen capture or device

The iframe TikTok's embed script builds points at `tiktok.com/embed/v2/<id>`, that page is
served to anonymous requests, and its `__FRONTITY_CONNECT_STATE__` blob carries **a direct
CDN URL for the MP4** along with the duration, caption and author. So Seer fetches the
file and hands the bytes to Gemini Flash directly — no player, no recording permission, no
waiting on a physical device, and it runs at network speed instead of in real time.

Verified live on 2026-07-28: anonymous request, no credential, 3.2 MB `video/mp4` with a
valid `ftyp` box.

### Instagram, same shape

Instagram's embed iframe carries no media, and its oEmbed endpoint needs a Meta app that
has passed App Review — but the query instagram.com's own web client runs to render a post
does not: `POST /graphql/query` with a `doc_id` and the post's shortcode, carrying a CSRF
token from a plain GET of the homepage, returns the post including `video_url`. That CDN
link then serves the MP4 to an anonymous request.

Verified live on 2026-08-02 against three public reels: 6.2 MB and 9.9 MB `video/mp4`, no
credential.

### Photo posts are posts too

A TikTok `/photo/` URL and an Instagram carousel of stills are exactly the thing somebody
pastes in to be checked — a screenshot dump, a text-card slideshow or an infographic
carousel carries its whole argument in the images, with none of the B-roll padding a video
has. Both resolve to their stills, which reach the model as one image part per slide, in
post order, labelled as an ordered set.

Verified live on 2026-08-04. TikTok's slides live at
`videoData.imagePostInfo.displayImages[]` on the same embed route the video path already
uses. Instagram's come from `display_url` on each `XDTGraphImage`, from the query that
already fetches reels.

Two things fell out of doing it:

- **A `/photo/` URL was never a type signal.** TikTok serves `/video/<id>` and
  `/photo/<id>` interchangeably for the same post, so reading the path as the content was
  costing real videos, not just slideshows. Only the payload decides now.
- **A carousel is capped, and says so.** Both platforms allow 35 slides; twelve are
  attached and the remainder is named in the prompt, because every slide is an image the
  model is billed to read. A slide that fails to download is skipped rather than failing
  the post — eleven of twelve still says most of what a slideshow says.

## What the media path refuses to do

**It will not fetch a host the platform doesn't serve from.** The media URL is read out of
TikTok's undocumented `__FRONTITY_CONNECT_STATE__` blob, which makes it the one URL in the
pipeline chosen by somebody else — reachable by anyone who can share a link. A CDN host
allowlist per platform suffix-matches against a dot boundary, so `tiktokcdn.com.evil.test`
is not a match for `tiktokcdn.com`. A rejected host is named in the error, so a new CDN
family is a one-line fix rather than an investigation.

**It will not buffer an oversized clip into memory.** `web/lib/media-fetch.js` streams to a
capped read (48 MB ceiling), refused or aborted rather than buffered past it.

**It will not give up on a model that is merely full.** Capacity in Gemini is metered per
model, and the newest model in the chain is the one most likely to be overloaded — so a
`503` is the *common* upstream failure, not an exotic one. `web/lib/gemini.js` falls
through to the next model instead of failing the request. A bare `500` with no overload
wording still doesn't: that is an outage, and walking the chain through one adds four more
failed requests to a service already in trouble.

## What the clip path survives

`TikTokError` and `InstagramError` sort their failures into "this link will never work"
and "try again".

**A transient refusal is not the answer.** `web/lib/retry.js` — exponential backoff with
full jitter, a per-delay cap, and a budget on the whole step — and both platforms' network
steps run through it. A `429` from Instagram's GraphQL endpoint is its normal response to
anonymous datacenter traffic rather than an incident, and `Retry-After` is believed when
the server sends one. A *decision* is never repeated: a private post, a photo carousel, a
deleted video and a rotated `doc_id` are answers, and asking twice only doubles the bill.

**A transfer that stops has a deadline.** `fetchStream` keeps the timeout and abort signal
armed until the body has been read, and `readCapped` additionally gives up on a transfer
that has gone quiet, which is faster than waiting out the full media timeout to learn the
same thing.

**An expired URL is repaired rather than reported.** The CDN links both platforms hand back
are signed and short-lived, and a `403` on one means the clock ran out, not that the link
is bad — so retrying the same dead URL is the one retry that cannot work. It is classified
as its own kind, the platform modules skip it, and `resolveClipParts` resolves the post
again for a freshly signed URL and downloads from that. Once: a second expiry in the same
breath is not a clock problem.

**A clip that can't be downloaded is described, not dropped.** Resolving a post already
returns its caption, creator and duration, so a failed download no longer costs the whole
link. The model gets the caption and the reason the video is missing in one note, which
matters most on short-form political content, where the caption is frequently the claim
and the video is B-roll.

## What the clip path doesn't re-do

Gemini has no memory between requests, so every turn replays the whole conversation and
re-attaches each clip at its first mention. That much is unavoidable — the bytes have to be
in the request body or the model can't see the video it is being asked about. What is
avoidable is where the bytes came from: a ten-turn thread about one TikTok would otherwise
resolve that post and pull the same MP4 off the CDN ten times.

`web/lib/gemini.js` keeps a downloaded clip for ten minutes, bounded by
`CLIP_CACHE_MAX_BYTES` (one maximum-sized clip's worth by default, which is around ten
typical ones) and evicted oldest-first. It is process-global and shared across requests on
a warm instance, so it is off in the library and switched on by `api/chat.js`, where
deployment decisions are made. The whole clip stage also runs under a budget, so one hung
platform can't hold a request open.

## The fact-checker

`web/` is a fact-checking library interface over Gemini: static front end, one server
route that holds the key. No build step, no dependencies.

```bash
cp web/.env.example web/.env.local     # paste GEMINI_API_KEY in
cd web && npm run dev                  # → http://127.0.0.1:3000
npm test                               # 515 tests, no network
```

The key never reaches the client at all — there is a server to put it behind. See
[web/README.md](web/README.md) for how that works, the controls that keep strangers off
your quota, and the Vercel deploy.

### What the reader waits through

A short-form video turn is three model calls, not one, and the video is in every one of
them. Most of the thirty seconds between pasting a link and reading a verdict is spent in
places that produce no output at all, so they are the places worth measuring.

**The early rounds think on a shorter leash.** A turn runs up to `MAX_TOOL_ROUNDS` model
calls, and the first one's entire output is a list of searches — but it used to be handed
the same 4096-token reasoning budget as the round that writes the verdict. A thinking
model given room to deliberate uses it, so the reader waited out thousands of tokens of
invisible reasoning before the first search was dispatched, and then waited out more of it
next round. Any round that still holds its tools now gets
`TOOL_ROUND_THINKING_BUDGET_TOKENS` (default 1024) instead. The budget is a ceiling rather
than a target, so a round that was going to be brief costs the same as before; what it
removes is the rambling one. The answering round — where `tools` is withdrawn — keeps the
full budget, because that is where reasoning becomes the verdict.

**The pages a search returns are opened before anyone asks for them.** The prompt asks for
two passes: search everything, then read what matters. That means a second-round
`find_in_page` almost always lands on a URL the first round already retrieved — and
waiting to be told which one puts the whole page fetch in series behind a model call that
was itself waiting on the search. So the top three results of each search are fetched and
parsed while the model is still reading the snippets, into the same per-turn `PageCache` a
real find would have used. A find that hits one costs the ranking alone. It is speculative
work, so it is bounded twice: three pages per search, nine per turn.

**The wait for an uploaded clip starts short.** Clips past the inline ceiling go through
the Files API, which reports `PROCESSING` and has to be polled until it doesn't. That poll
was a flat two seconds, which is the right interval for a slow transcode and the wrong one
for a ten-second TikTok that is ready almost immediately — the fast case cannot be
discovered sooner than the interval's own length. It now starts at 250 ms and backs off to
the same two seconds, and the ceiling on the whole wait is a clock rather than a poll
count.

**`GEMINI_MEDIA_RESOLUTION` is the biggest lever left, and it is off.** Video reaches the
model as roughly one frame per second, so a 45-second clip is ~45 images to read before it
can say anything — on every round. Dropping to `low` cuts that by about four. What it
spends is detail within the frame, and on short-form video the claim is frequently an
on-screen text card rather than anything in the audio, which is exactly what that detail
is for. Making the app faster at the thing it exists to do carefully is not a default, so
it is opt-in: try `medium` first, against clips whose claim is written rather than spoken.

## Every claim carries a citation

The chat assistant has two research tools — `web_search` to find pages, `find_in_page` to
read one — and is not permitted to assert a fact it did not retrieve with them. Search
results are numbered into a ledger as they arrive, and that ledger is what a `[3]` in the
answer addresses: the app renders the marker as a link to the page it names, and the
Sources list under an answer is built from what was actually fetched, never typed by the
model. Each search and each page read is shown as it happens, so the evidence trail is the
record of how the answer was arrived at.

The **ledger is the enforcement**. A marker naming a number the ledger does not have is a
citation to a page that was never retrieved, and it is deleted before the answer is sent —
the reader is never shown a citation that leads nowhere. Everything else is the prompt's
job.

**There used to be more, and it was removed on purpose.** An auditor split the finished
answer into sentences, guessed which of them asserted a checkable fact, and rejected the
whole answer when one of those carried no marker: the reply was withdrawn from the screen,
the model was made to write it again, and the result was labelled `Unverified`. The guess
was the problem, and improving it was not the fix. "Which sentences are claims?" was
answered with verdict vocabulary, attribution verbs, digits and capitalised words — and a
greeting trips all four. *I'll tell you whether it's accurate* has the verdict words; *Send
me a TikTok link* has the proper noun. Typing `hi` produced an answer that streamed in,
vanished, came back rewritten, and arrived under a banner announcing that no search had
been run. Each narrowing of the heuristic was walked around by the next wording, because no
regex separates an offer to check something from a ruling on it.

What is left is not a weaker guarantee so much as a differently-shaped one: the exact check
stayed and now *removes* the bad marker instead of reporting it, and the guess is gone.
Nothing the server sends ever asks the browser to un-draw something it has already shown.

The same search path runs from the terminal, so a citation can be reproduced rather than
taken on trust:

```bash
cd web && npm run search -- --claim "Measles cases tripled in 2026" \
                            --query "measles cases 2026 CDC"
```

It works with no configuration (DuckDuckGo, best-effort) and properly with any one of
Brave, Tavily, Serper or Google Programmable Search. [web/README.md](web/README.md#every-claim-carries-a-citation)
has the rules, the query schema, and how the ledger is built.

## Layout

```
web/                       The fact-checker. Static front end, Gemini key server-side
  lib/tiktok.js            TikTok embed → CDN URL resolver, downloader
  lib/instagram.js         Instagram post query → CDN URL resolver, downloader
  lib/gemini.js            Model client, fallback chain, tool loop
  lib/gemini-files.js       Files API resumable upload for larger clips
  lib/media-fetch.js       Shared deadline / host allowlist / capped streamed read
  lib/retry.js             Exponential backoff with full jitter
  lib/article.js           A pasted page, read and quoted
  lib/search.js            Research, citations, verdicts
  lib/verified-chat.js     The fact-check turn: system prompt, tools, frames
worker/                    Optional Playwright browser-resolve fallback
```

## Tests

```bash
cd web && npm test
```

515 unit tests, no network, no dependencies. `worker/`'s suite is 5 tests and exercises
`urls.js` only (pure), no Playwright install needed.

## Docs

- [Pipeline audit](docs/PIPELINE-AUDIT.md) — a correctness-bug pass over the fact-checking
  pipeline
