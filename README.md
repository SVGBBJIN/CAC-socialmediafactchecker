# Seer

Paste a link to a short-form video; get its claims checked against live sources, each one
carrying a citation you can follow.

There are **two surfaces in this repository, and they are not equals.**

| | What it is | State |
|---|---|---|
| **`web/`** | The fact-checker: link → transcript → research → cited verdict | **The product, and the canonical implementation.** Ships, and is where the work happens |
| **`Sources/`** | A Swift extraction pipeline: link → `ClaimContext` | **Frozen — reference only.** No fact-check layer exists on this side, and it no longer receives ported fixes |

Read that table before reading anything else, because the obvious assumption — that the
Swift package is the app and `web/` is a viewer for it — is backwards.

## `web/` is canonical. `Sources/` is frozen, not a second target.

This used to be an open question — "decide which surface is canonical before adding to
either" — and every time it went unanswered, the same thing happened: a fix landed in
`web/`, and `Sources/` either got the same fix rediscovered from scratch later, worse the
first time, or never got it at all.

- **The web side is where fixes land.** Over three months: 42 commits to `web/`, 12 to
  `Sources/`.
- **Fixes got made twice.** The Files API poll ramp was written for `web/` on 2026-07-30
  and rediscovered from scratch for Swift on 2026-08-02 — initially in the worse shape of
  the two, bounding the wait by a poll count where the web version had already worked out
  that a varying interval needs a wall-clock bound.
- **Swift lagged on things that mattered, repeatedly.** A missing CDN host allowlist, an
  unbounded media download, and a model chain that gave up on `503` were all correct in
  `web/` first and have since been backported. A fourth instance turned up in the very
  next audit pass — `Sources/SeerCore/Media/TikTokMediaResolver.swift`'s `TikTokURL` has no
  host check on its short-link/video-ID parsing where `web/lib/tiktok.js`'s
  `isTikTokHost`-gated equivalents do — and this one has been **deliberately left
  unfixed**, not overlooked. See the next paragraph for why, and
  [docs/EXTRACTION_PIPELINE.md](docs/EXTRACTION_PIPELINE.md#sources-is-frozen) for exactly
  what that means for anyone reading `Sources/` and wondering whether a gap like this one
  is a bug to report or a known, accepted property of frozen code.

**The decision: `web/` is canonical, full stop, and `Sources/` is frozen rather than a
second target for incremental parity patches.** Three months of evidence all point the
same direction, and continuing to patch `Sources/` piecemeal every time an audit finds the
next divergence is the pattern that produced this section in the first place. Concretely,
frozen means:

- **No more parity ports into `Sources/`.** A fix that lands in `web/` stays in `web/`.
  `Sources/` is not owed a backport, and a gap between the two — like the `TikTokURL` one
  above — is not evidence of neglect; it is the expected shape of a frozen codebase next to
  one that keeps moving.
- **`Sources/` still compiles and its own tests still pass**, and a change that breaks
  that is still a regression worth fixing — frozen is not the same as abandoned to bit rot.
  What stops is *porting web's new work in*, not maintaining what is already there.
- **Deleting `Sources/`** — named as the other branch of this decision before it was made,
  and it removes the whole class of problem along with roughly 5,700 lines — **is not done
  by this pass.** That is a repository-shape change with its own blast radius (the Swift
  app, `SeerUIDemo`, the whole `docs/EXTRACTION_PIPELINE.md` narrative) and belongs to
  whoever owns that decision, not to an audit fixing bugs. Freezing is the reversible half
  of that choice; deleting is the irreversible half, and is worth doing deliberately once
  the frozen state has been lived with for a while, not as a side effect of a bug-fix pass.

## Where things stand

| Platform | Path | web | Swift |
|---|---|---|---|
| **YouTube** | Gemini native URL ingestion | Working | Working |
| **TikTok** | render oEmbed player → capture → Gemini Flash, falling back to embed page → CDN MP4 → Gemini Flash | Working — capture leg unverified live, see below | Working (CDN-fetch only, unchanged) — Gemini leg needs a key to confirm |
| **Instagram** | post query → CDN MP4 → Gemini Flash | Working — verified live 2026-08-02 | **Not ported.** Still the capture extractor, still unregistered |

Only platforms that can actually be served get registered, so an Instagram link shared
*to the Swift app* gets an honest "not supported yet" rather than an empty result. The web
app answers it.

## The Swift extraction pipeline

```swift
let pipeline = SeerPipelineBuilder.makePipeline(.init(secrets: secrets))
let context = try await pipeline.extract(from: sharedURL)

context.transcript        // what was said
context.frames            // sampled stills, when the path produced any
context.candidateClaims   // claims the extractor noticed in passing — hints, not results
context.provenance        // platform, source URL, which path produced it
```

Nothing downstream of `ClaimContext` knows which platform a claim came from. Note the
shape of that promise: `ClaimContext` is documented as what "claim detection, retrieval and
verdict rendering" consume, and **on the Swift side none of those exist.** Everything past
extraction — search, citations, verdicts — lives only in `web/`.

### TikTok no longer needs screen capture

The capture path was blocked on ReplayKit returning silent audio from a `WKWebView`. That
turned out to be avoidable rather than fixable: the iframe TikTok's embed script builds
points at `tiktok.com/embed/v2/<id>`, that page is served to anonymous requests, and its
`__FRONTITY_CONNECT_STATE__` blob carries **a direct CDN URL for the MP4** along with the
duration, caption and author.

So Seer fetches the file and hands the bytes to Gemini Flash. No web view, no player, no
recording permission, no Whisper, and no waiting on a physical device. It also runs at
network speed instead of in real time — a 60-second clip no longer takes 60 seconds — and
because a video model watches rather than only listens, a clip whose claim is text over
silent B-roll now yields on-screen text where the capture path yielded nothing.

Verified live on 2026-07-28 through the compiled resolver: anonymous request, no
credential, 3.2 MB `video/mp4` with a valid `ftyp` box.

This is unchanged, and is what the Swift side still does — `Sources/` is frozen (see
below), so it never picked up the web-only change described next.

### `web/`'s TikTok path changed again: oEmbed capture is now primary

The CDN-scrape path above is exactly what's described — but as of this pass, it's no
longer what `web/` tries first. `web/lib/tiktok-capture.js` renders TikTok's real,
*documented* oEmbed player (`GET /oembed`, then the `<blockquote>` + `embed.js` it
returns) in a headless browser, and records what plays via `captureStream()` +
`MediaRecorder` from inside the page. The CDN-scrape path — reading a direct MP4 URL out
of the embed page's undocumented `__FRONTITY_CONNECT_STATE__` blob — is now the fallback,
tried only when capture fails.

The reason is legal posture, not reliability: that state blob is internal page state
TikTok serves to its own iframe, and reading it is scraping no matter how carefully the
parser is written. oEmbed is TikTok's published integration point for a third party
showing one of its posts, and rendering it in a real browser is using that integration
point as designed rather than reverse-engineering around it. It costs real things back:
capture is real-time (a 45-second clip takes at least 45 seconds to record, where the CDN
download took as long as the file's size implied), and it puts a headless Chromium in the
request path — `playwright-core` plus, for a Vercel deployment, `@sparticuz/chromium`
providing a serverless-packaged binary. `web/`'s dependency count goes from zero to two
because of this.

**This has not been run against the live site.** Whether TikTok's embed `<video>` actually
exposes an audio track to `captureStream()` is unconfirmed — a sandboxed spike hit a
network-layer TLS reset against TikTok before it could find out. Fifteen tests in
`web/test-tiktok-capture.js` cover the resolve/capture/fallback logic against stubbed
Chromium and network responses, the same injection pattern the rest of `web/`'s test suite
uses, but none of them can confirm the one fact the whole path depends on. Run one real
capture against a real deployment before trusting this in production — see the header of
`web/lib/tiktok-capture.js` for the full reasoning and what to check.

### Instagram doesn't either

Same shape, different door. Instagram's embed iframe carries no media, and its oEmbed
endpoint needs a Meta app that has passed App Review — but the query instagram.com's own
web client runs to render a post does not: `POST /graphql/query` with a `doc_id` and the
post's shortcode, carrying a CSRF token from a plain GET of the homepage, returns the post
including `video_url`. That CDN link then serves the MP4 to an anonymous request.

So a reel costs what a TikTok costs, and the App Review blocker is gone. `web/lib/instagram.js`
ships this and the fact-checker attaches reels today; the Swift extractor is still the
capture one, unregistered, and — now that `Sources/` is frozen (see above) — stays that
way rather than being ported. Verified live on 2026-08-02 against three public reels:
6.2 MB and 9.9 MB `video/mp4`, no credential.
[docs/SPIKE-instagram.md](docs/SPIKE-instagram.md)

## What the media path refuses to do

Three guarantees on the `directMediaFetch` arm, all of which the web app had first and the
Swift side has now been brought up to:

**It will not fetch a host the platform doesn't serve from.** The media URL is read out of
TikTok's undocumented `__FRONTITY_CONNECT_STATE__` blob, which makes it the one URL in the
pipeline chosen by somebody else — reachable by anyone who can share a link.
`Platform.allowedMediaHosts` lists the CDN families per platform and
`allowsMediaHost(_:)` suffix-matches against a dot boundary, so `tiktokcdn.com.evil.test`
is not a match for `tiktokcdn.com`. An empty list means *fetch nothing*, never *fetch
anything*: a platform that hasn't declared its CDNs — Instagram, on the Swift side, and
permanently now that `Sources/` is frozen rather than pending a port — cannot download at
all. A rejected host is named in the error, so a new CDN family is a one-line fix rather
than an investigation.

**It will not buffer an oversized clip into memory.** The ceiling used to be checked on
`data.count` after the transport had already built the whole body, which cannot stop the
allocation it exists to prevent — a share extension is killed for the memory or it isn't,
and by then it is. `HTTPTransport.send(_:maxBytes:)` streams to a temporary file, sizes it
on disk, and only reads it in once it is known to fit. It does not abort mid-transfer;
disk is not what jetsam counts.

**It will not give up on a model that is merely full.** Capacity in Gemini is metered per
model, and the newest model in the chain is the one most likely to be overloaded — so a
`503` is the *common* upstream failure, not an exotic one. It now falls through to the next
model instead of failing the request. A bare `500` with no overload wording still doesn't:
that is an outage, and walking the chain through one adds four more failed requests to a
service already in trouble.

## Two things to action

1. **Rotate the Gemini API key.** It was shared in a chat message during handoff — assume
   it's compromised. [docs/SECRETS.md](docs/SECRETS.md)
2. **Run one TikTok link end to end with a real key.** Everything up to the Gemini call is
   verified against live TikTok; the analysis leg reuses the same `generateContent` client
   the working YouTube path uses, but has not been run with a key.
   [docs/EXTRACTION_PIPELINE.md](docs/EXTRACTION_PIPELINE.md)
3. **Confirm TikTok's embed player actually exposes audio to `captureStream()`.** The new
   primary web path depends on it and it has not been checked against the live site — see
   [the section above](#webs-tiktok-path-changed-again-oembed-capture-is-now-primary).

## Layout

```
Sources/SeerCore/          Pure Foundation — builds and tests anywhere
  Model/                   ClaimContext, Platform + the ingestion fork
  Pipeline/                ClaimExtractor protocol, routing, assembly, progress
  Gemini/                  Video client, model fallback chain, Files API upload
  Extractors/              YouTubeExtractor, DirectMediaExtractor, CaptureBasedExtractor
  Media/                   TikTok embed → CDN URL resolver, downloader
  Capture/                 MediaCaptureSource seam, oEmbed resolvers
  Transcription/           Groq/Whisper
  Secrets/                 Keychain, AES-GCM bundle, store chaining
Sources/SeerCapture/       iOS-only: WKWebView + RPScreenRecorder + diagnostic
Sources/SeerUI/            SwiftUI progress animation + its observable model
Sources/SeerUIDemo/        Runnable harness for the above — no key, no network
Sources/SeerSecretsTool/   Dev tool: plaintext credentials → secrets.enc
web/                       The fact-checker. Static front end, Gemini key server-side
  lib/tiktok-capture.js    no Swift counterpart — the primary path, oEmbed capture
  lib/tiktok.js            ⟷ Sources/SeerCore/Media/TikTokMediaResolver.swift — now the
                            fallback on the web side; still the only path in Swift
  lib/gemini-files.js      ⟷ Sources/SeerCore/Gemini/GeminiFilesClient.swift
  lib/gemini.js            ⟷ Sources/SeerCore/Gemini/GeminiVideoClient.swift
  lib/media-fetch.js       ⟷ Sources/SeerCore/Media/MediaDownloader.swift
  lib/instagram.js         no Swift counterpart — the unported resolver
  lib/search.js            no Swift counterpart — research, citations, verdicts
  lib/verified-chat.js     ⌟
```

The `⟷` pairs are the duplicated pipeline. They are ports, not shared code, and keeping
them honest is manual — which is the problem described at the top of this file.

## The fact-checker

`web/` is a fact-checking library interface over Gemini: static front end, one server
route that holds the key. No build step, no dependencies.

```bash
cp web/.env.example web/.env.local     # paste the rotated key into GEMINI_API_KEY
cd web && npm run dev                  # → http://127.0.0.1:3000
npm test                               # 66 tests, no network
```

Unlike the iOS path, the key here never reaches the client at all — there is a server to
put it behind. See [web/README.md](web/README.md) for how that works, the controls that
keep strangers off your quota, and the Vercel deploy.

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

It ingests video the same two ways the Swift pipeline does, for the same reasons. A
**YouTube** link is handed to Gemini as a URL and Gemini watches it itself. A **TikTok**
link can't be — Gemini won't fetch one — so `web/lib/tiktok.js` does what the model won't:
resolves the embed page to a CDN URL, downloads the MP4 and puts the bytes in the request,
inline or via the Files API depending on size. That is the same `directMediaFetch` shape as
`TikTokMediaResolver.swift`, and the two parsers are held to the same captured payload.

## Progress

Extraction is slow in a way users read as broken — the YouTube path is a single HTTPS call
that can sit for half a minute while Gemini watches a video, returning nothing until it is
done. So the pipeline reports stages:

```swift
let context = try await pipeline.extract(from: url) { progress in
    print(progress.label)   // "Analyzing your YouTube video"
}
```

| Platform | Stages |
|---|---|
| YouTube | `resolving` → `analysing` → `done` |
| TikTok | `resolving` → `fetchingMedia` → `analysing` → `done` |
| TikTok (large clip) | …with `uploading` before `analysing` |

`SeerUI` renders these as an indeterminate scanning animation plus a stage checklist with
per-stage timings. Indeterminate deliberately: none of the underlying work reports a
percentage, and a bar filling at an invented rate is a lie — a worse one once it stalls at
90%. `AnalysisModel.timingReport` prints the same breakdown as text, which is what makes a
slow run diagnosable rather than just annoying.

To actually watch it, on macOS:

```bash
swift run SeerUIDemo      # or open Package.swift in Xcode → SeerUIDemo scheme
```

`SeerUIDemo` drives the animation with `ScriptedExtractor`, which walks the real stage
sequence on a timer and returns a canned `ClaimContext` — no Gemini key, no network, no
share extension. Pick TikTok for the longest script, which is the only one that reaches
`uploading` (the stage inserted mid-run rather than laid out up front) and the only one
whose `analysing` beat runs long enough to trip the patience threshold and show the
reassurance text. The same file carries the SwiftUI previews.

**Ordering matters and the obvious bridge gets it wrong.** The handler is called
synchronously off the main actor; forwarding each event with its own
`Task { @MainActor in … }` spawns unordered tasks and the stage list jumps backwards.
Yield into an `AsyncStream` and consume it with `for await`, or compare
`ExtractionProgress.sequence`. `AnalysisModel` does both.

## The architectural line

Any future platform lands on one of three paths, decided once in
`Platform.ingestionStrategy`. Ask the questions in order and stop at the first yes — each
arm is strictly cheaper and less fragile than the one below it:

1. **Will the model fetch the URL itself?** (YouTube/Gemini) → `nativeVideoIngestion`.
   One HTTPS call, no media on the device.
2. **Can we get at the media file?** (TikTok, via its embed page) → `directMediaFetch`.
   Resolve, download, hand the bytes over.
3. **Neither** → `screenCapture`. Render the embed, record the screen, transcribe. Slow,
   needs a recording permission, and blocked on ReplayKit audio.

All three conform to `ClaimExtractor` and produce the same `ClaimContext`. Adding X or
Facebook means answering those questions, not rediscovering the fork.

**Arm 3 is dead in principle and permanent in practice.** TikTok moved off it, which is
what unblocked TikTok; Instagram — its last remaining occupant — turned out to belong on
arm 2, and `web/lib/instagram.js` proves it by shipping that route today. What survives is
`SeerCapture/` plus `CaptureBasedExtractor`: an unregistered extractor for a platform that
no longer needs it, carrying the unresolved ReplayKit audio bug, in the one module CI
cannot even compile (everything there is behind `#if os(iOS)`, so Linux builds it to
nothing). Porting the Instagram resolver would retire the arm and the bug together — and
used to be the recommendation here. It no longer is: `Sources/` is frozen (see above), and
that port is exactly the kind of web → Swift work the freeze stops. So this arm is not
scheduled to go anywhere; it stays as dead weight in a frozen module rather than being
retired. **Do not spend anything on capture** either way — including tuning it; nothing
there is getting less dead, only less maintained.

## Tests

```bash
swift test
```

Parsers are tested against **live** captured responses from Gemini and TikTok, not against
what the docs claim. That caught a field the documented shape doesn't mention, and it is
the only way to test the TikTok embed blob at all — that payload has no documentation to
write a fixture from.

`SeerCapture` and `SeerUI` need an Apple SDK — see the note at the end of
[docs/EXTRACTION_PIPELINE.md](docs/EXTRACTION_PIPELINE.md). Both are wrapped in
`#if canImport(…)`, so they build to nothing on Linux and the package still tests there;
that also means a syntax error in them does not surface there. Everything they depend on —
the stage sequence, the labels, the ordering guarantee — is in `SeerCore` and is tested,
as is `ScriptedExtractor`, which is what the demo and the previews animate.

`SeerUI` now has a consumer: `swift build` on macOS compiles it because `SeerUIDemo`
imports it, and running that demo is how the animation gets looked at rather than merely
described. `SeerCapture` still has none, and still needs a device.

## Docs

- [Extraction pipeline](docs/EXTRACTION_PIPELINE.md) — architecture, per-platform status,
  the capture blocker in detail
- [Instagram spike](docs/SPIKE-instagram.md) — what was tested, what it found, and the credential-free route that unblocked it
- [Secrets](docs/SECRETS.md) — how keys are handled, and what that does and doesn't protect
