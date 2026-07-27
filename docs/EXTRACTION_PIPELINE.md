# Seer extraction pipeline

Turns a shared URL into a `ClaimContext` — transcript, optional frames, provenance — that
the fact-check layer consumes without knowing or caring which platform it came from.

## The fork

Every platform lands on one of two paths. The distinction is stated once, in
`Platform.ingestionStrategy`, and both paths conform to `ClaimExtractor`:

```
                       ┌─ has a native video-ingestion API? ─┐
                     yes                                     no
                      │                                       │
        .nativeVideoIngestion                          .screenCapture
                      │                                       │
         Gemini reads the URL                  oEmbed → WKWebView → RPScreenRecorder
              directly                                → Whisper
                      │                                       │
              YouTubeExtractor                     CaptureBasedExtractor
                      │                                       │
                      └──────────► ClaimContext ◄─────────────┘
```

Adding a platform means answering one question and adding a `Platform` case — not
rediscovering the fork. If it has a native ingestion API, it needs no capture code at all;
if it doesn't, it reuses `CaptureBasedExtractor` with a different `EmbedResolver`.

`ExtractionPipeline` asserts in debug builds that an extractor's declared strategy matches
its platform's, so the two can't drift apart.

## Status

| Platform | Path | Status |
|---|---|---|
| YouTube | native ingestion | **Working.** Verified against the live API. |
| TikTok | screen capture | **Pipeline complete and tested; blocked on capture audio.** |
| Instagram | screen capture | **Blocked twice over** — same audio issue, plus Meta app review. See [SPIKE-instagram.md](SPIKE-instagram.md). |

Only platforms that can actually be served get registered. `SeerPipelineBuilder` leaves
TikTok and Instagram out unless a capture source is supplied, so a user sharing a TikTok
gets a clear "not supported yet" rather than silence. `SeerPipelineBuilder.supportStatus`
returns the reason for each gap, for the UI to show up front.

## 1. YouTube — working

Gemini accepts a YouTube URL as a `file_data` part and fetches the video itself. There is
no download, no frame extraction, no capture, and no media on the device. The extractor is
one HTTPS call plus a mapping step.

Verified live on 2026-07-27 against `gemini-3.6-flash` — returned an accurate verbatim
transcript and a correctly extracted claim. The response is checked in as a test fixture
in `GeminiClientTests.liveResponse`.

**Model fallback chain.** `gemini-3.6-flash` → `3.5-flash` → `3-flash-preview` →
`2.5-flash` → `2.0-flash`. Every ID was verified present and advertising `generateContent`
via `GET /v1beta/models`. Two naming details that are easy to get wrong: the 3-series Flash
model only ships under a `-preview` suffix, and the 2-series ID is `gemini-2.0-flash`,
not `gemini-2-flash`.

The chain walks on *availability* failures only — 404, 403, and 400s that name the model.
Rate limits and 5xx are the retry layer's job; falling through on a transient blip would
burn the chain and land on the weakest model. A malformed request fails immediately rather
than being retried against four more models at four more models' cost.

**Operational caveats.** YouTube URL ingestion is a preview feature: pricing and limits can
move. The free tier caps daily YouTube intake (8 hours/day at time of writing). Videos must
be public or unlisted. `maxAnalysedDuration` (default 30 min) caps how much of a long video
is billed.

## 2. TikTok — complete except for capture

`oEmbed → WKWebView → RPScreenRecorder → Groq/Whisper`.

The oEmbed leg is verified: the endpoint is public, needs no credential, and returns embed
HTML plus author metadata. The live response is a test fixture. It returns **no transcript**
— which is the entire reason this path exists.

### The blocker

`RPScreenRecorder`'s `.audioApp` stream frequently arrives **silent** when the sound comes
from a `WKWebView`. The web view plays on its own `AVAudioSession`, and ReplayKit's
app-audio tap does not reliably capture it. The recording succeeds, the file is well-formed,
and it contains nothing.

This was not resolved here — it needs a physical device, and this work was done without
one. What was done instead:

**1. Everything downstream of capture is finished and tested.** `MediaCaptureSource` is the
seam. `MockCaptureSource` drives the full TikTok pipeline in tests today; the real recorder
drops in behind the same protocol with no downstream change. This is also what lets
Instagram reuse the path — the platforms differ in embed markup, not in how a recording is
taken.

**2. Silence is detected rather than assumed.** `ScreenRecorderCaptureSource` measures peak
amplitude across the captured buffers and reports `CapturedMedia.containsAudio` honestly.
A silent capture fails with a clear error instead of producing an empty transcript — which
matters more here than in most apps, because an empty transcript reads downstream as
*"this video makes no claims"*, and a fact-checker silently reporting nothing to check is
worse than one reporting an error. Two layers enforce it: `CaptureBasedExtractor` refuses
to transcribe, and `GroqWhisperTranscriber` refuses to upload. (Whisper hallucinates
plausible text from silence, so this is a real risk, not a theoretical one.)

**3. There's a diagnostic to answer the question.** `AudioCaptureDiagnostic` runs the
capture leg in isolation on a device and reports which layer failed — embed didn't resolve,
didn't render, never played, ReplayKit sent zero buffers, or buffers arrived silent. Run it
before writing or trusting anything else on this path:

```swift
let report = try await AudioCaptureDiagnostic(hostContainer: { self.view })
    .run(on: URL(string: "https://www.tiktok.com/@user/video/123")!)
print(report.summary)
```

It distinguishes the two failure modes that look identical from the outside: *the video
never played* (a WKWebView autoplay problem, fixable) versus *the video played and
ReplayKit heard nothing* (the audio-session issue, possibly fatal to this approach).

If it reports BLOCKED, the capture path is not viable as designed and the alternatives are
worth pricing before spending more on it: `AVAudioEngine` tapping the session directly, an
`RPBroadcast` extension, or asking the user to screen-record themselves.

### The web view leg

Two things the naive version gets wrong, handled in `WebViewEmbedRenderer`:

- **The web view must be on screen and unobscured** for the whole capture. ReplayKit
  records the display; an off-screen or transparent view records as nothing. Hence the API
  takes a container view rather than returning a detached one.
- **Embeds autoplay muted.** A muted player is a silent recording — the same symptom as the
  audio-session bug, from a completely different cause. The renderer explicitly unmutes and
  sets volume before playing, and `isPlayingAudibly()` verifies a `<video>` is actually
  playing, unmuted, past 0s before the recording is trusted.

The embed document is loaded against a real platform origin, not `about:blank`; platform
embed scripts check the origin and refuse to hydrate otherwise.

## 3. Instagram — spiked, blocked

Short version: **it does not behave like TikTok.** The legacy token-free oEmbed endpoint is
dead (HTTP 500), the Graph replacement requires a Meta app token gated behind App Review,
and anonymous instagram.com is login-walled. Full findings and what unblocks it:
[SPIKE-instagram.md](SPIKE-instagram.md).

The code is written and tested — `CaptureBasedExtractor.instagram` reuses the TikTok
pipeline verbatim, which is the reuse story working as intended. It stays unregistered
until someone obtains a token.

## Cross-cutting

**Retries** — exponential backoff with full jitter (`RetryPolicy`). Jitter matters because
share-extension launches cluster. `Retry-After` wins over the local curve when the server
sends one, clamped so a hostile value can't park the extension. 429/408/5xx retry; 4xx
doesn't; cancellation never does.

**Timeouts** — per-request and overall. Video calls get a 120s request / 300s overall
budget; metadata calls get 20s.

**Credentials** — never in source. See [SECRETS.md](SECRETS.md). The Gemini key shared
during handoff should be rotated.

**Testing** — 67 tests, no network. `HTTPTransport`, `Sleeper`, `MediaCaptureSource` and
`Transcriber` are all injectable. Live responses from Gemini and TikTok are checked in as
fixtures, so the parsers are tested against what the APIs actually return rather than what
the docs say they return — the live Gemini response included a `thoughtSignature` field
alongside `text` that a stricter parser would have thrown on.

```bash
swift test
```

## Building

`SeerCore` is pure Foundation and builds anywhere, including Linux CI. `SeerCapture` holds
the iOS-only ReplayKit/WebKit code, guarded by `#if os(iOS)`.

**`SeerCapture` has never been compiled** — it needs the iOS SDK, which wasn't available
where this was written. Expect to fix small things on first build in Xcode. `SeerCore`,
which is everything else, is compiled and tested.
