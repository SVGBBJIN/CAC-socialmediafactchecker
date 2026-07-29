# Seer — extraction pipeline

Share a link from YouTube, TikTok or Instagram; get back one shape the fact-check layer
can work with, regardless of where it came from.

```swift
let pipeline = SeerPipelineBuilder.makePipeline(.init(secrets: secrets))
let context = try await pipeline.extract(from: sharedURL)

context.transcript        // what was said
context.frames            // sampled stills, when the path produced any
context.candidateClaims   // claims the extractor noticed in passing — hints, not results
context.provenance        // platform, source URL, which path produced it
```

Nothing downstream of `ClaimContext` knows which platform a claim came from.

## Where things stand

| Platform | Path | Status |
|---|---|---|
| **YouTube** | Gemini native URL ingestion | **Working** — verified against the live API |
| **TikTok** | embed page → CDN MP4 → Gemini Flash | **Working** — resolve + download verified live; Gemini leg needs a key to confirm |
| **Instagram** | oEmbed → WKWebView → ReplayKit → Whisper | **Blocked twice** — ReplayKit audio, plus Meta App Review |

Only platforms that can actually be served are registered, so a user sharing an Instagram
link today gets an honest "not supported yet" instead of an empty result.

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

## Two things to action

1. **Rotate the Gemini API key.** It was shared in a chat message during handoff — assume
   it's compromised. [docs/SECRETS.md](docs/SECRETS.md)
2. **Run one TikTok link end to end with a real key.** Everything up to the Gemini call is
   verified against live TikTok; the analysis leg reuses the same `generateContent` client
   the working YouTube path uses, but has not been run with a key.
   [docs/EXTRACTION_PIPELINE.md](docs/EXTRACTION_PIPELINE.md)

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
web/                       Chat UI — static front end, Gemini key held server-side
```

## Chat UI

`web/` is a chat interface over Gemini: static front end, one server route that holds the
key. No build step, no dependencies.

```bash
cp web/.env.example web/.env.local     # paste the rotated key into GEMINI_API_KEY
cd web && npm run dev                  # → http://127.0.0.1:3000
npm test                               # 66 tests, no network
```

Unlike the iOS path, the key here never reaches the client at all — there is a server to
put it behind. See [web/README.md](web/README.md) for how that works, the controls that
keep strangers off your quota, and the Vercel deploy.

### Every claim carries a citation

The chat assistant has one tool — `web_search` — and is not permitted to assert a fact it
did not retrieve with it. The system prompt says so; the app then *checks*, because a
prompt is a request and this needs a guarantee. Search results are numbered into a ledger,
and the finished answer is audited against it: a checkable sentence with no citation
marker, a marker for a source that does not exist, or a URL no search returned all reject
the answer, which is withdrawn from the screen and sent back to be rewritten. A rewrite
that fails too is shown labelled `Unverified` rather than suppressed. The Sources list
under each answer is rendered by the app from what was actually fetched, never typed by
the model.

The same search path runs from the terminal, so a citation can be reproduced rather than
taken on trust:

```bash
cd web && npm run search -- --claim "Measles cases tripled in 2026" \
                            --query "measles cases 2026 CDC"
```

It works with no configuration (DuckDuckGo, best-effort) and properly with any one of
Brave, Tavily, Serper or Google Programmable Search. [web/README.md](web/README.md#every-claim-carries-a-citation)
has the rules, the query schema, and what is deliberately *not* audited.

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
3. **Neither** (Instagram — login-walled) → `screenCapture`. Render the embed, record the
   screen, transcribe. Slow, needs a recording permission, and still blocked.

All three conform to `ClaimExtractor` and produce the same `ClaimContext`. Adding X or
Facebook means answering those questions, not rediscovering the fork.

TikTok moved from arm 3 to arm 2, which is what unblocked it. Worth checking arm 2 for any
platform sitting on arm 3 before investing in capture.

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
- [Instagram spike](docs/SPIKE-instagram.md) — what was tested, what it found, what unblocks it
- [Secrets](docs/SECRETS.md) — how keys are handled, and what that does and doesn't protect
