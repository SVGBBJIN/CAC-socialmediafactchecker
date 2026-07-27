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
| **TikTok** | oEmbed → WKWebView → ReplayKit → Whisper | Pipeline complete and tested; **blocked on ReplayKit audio** |
| **Instagram** | same as TikTok | **Blocked twice** — same audio issue, plus Meta App Review |

Only platforms that can actually be served are registered, so a user sharing a TikTok today
gets an honest "not supported yet" instead of an empty result.

## Two things to action

1. **Rotate the Gemini API key.** It was shared in a chat message during handoff — assume
   it's compromised. [docs/SECRETS.md](docs/SECRETS.md)
2. **Run `AudioCaptureDiagnostic` on a device.** It answers, in one run, whether the
   TikTok/Instagram capture path is viable at all. Everything else on that path is written
   and tested; this is the only open question.
   [docs/EXTRACTION_PIPELINE.md](docs/EXTRACTION_PIPELINE.md)

## Layout

```
Sources/SeerCore/          Pure Foundation — builds and tests anywhere
  Model/                   ClaimContext, Platform + the ingestion fork
  Pipeline/                ClaimExtractor protocol, routing, assembly
  Gemini/                  Video client + model fallback chain
  Extractors/              YouTubeExtractor, CaptureBasedExtractor
  Capture/                 MediaCaptureSource seam, oEmbed resolvers
  Transcription/           Groq/Whisper
  Secrets/                 Keychain, AES-GCM bundle, store chaining
Sources/SeerCapture/       iOS-only: WKWebView + RPScreenRecorder + diagnostic
Sources/SeerSecretsTool/   Dev tool: plaintext credentials → secrets.enc
```

## The architectural line

Any future platform lands on one of two paths, decided once in `Platform.ingestionStrategy`:

- **Has a native video-ingestion API** (YouTube/Gemini) → skip capture entirely.
- **Doesn't** (TikTok/Instagram) → WKWebView + RPScreenRecorder + transcription.

Both conform to `ClaimExtractor` and produce the same `ClaimContext`. Adding X or Facebook
means answering that one question, not rediscovering the fork.

## Tests

```bash
swift test    # 67 tests, no network
```

Parsers are tested against **live** captured responses from Gemini and TikTok, not against
what the docs claim. That caught a field the documented shape doesn't mention.

`SeerCapture` requires the iOS SDK and has not been compiled — see the note at the end of
[docs/EXTRACTION_PIPELINE.md](docs/EXTRACTION_PIPELINE.md).

## Docs

- [Extraction pipeline](docs/EXTRACTION_PIPELINE.md) — architecture, per-platform status,
  the capture blocker in detail
- [Instagram spike](docs/SPIKE-instagram.md) — what was tested, what it found, what unblocks it
- [Secrets](docs/SECRETS.md) — how keys are handled, and what that does and doesn't protect
