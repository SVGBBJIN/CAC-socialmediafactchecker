# Seer extraction pipeline

Turns a shared URL into a `ClaimContext` — transcript, optional frames, provenance — that
the fact-check layer consumes without knowing or caring which platform it came from.

## The fork

Every platform lands on one of three paths. The distinction is stated once, in
`Platform.ingestionStrategy`, and all three conform to `ClaimExtractor`:

```
            ┌─ will the model fetch the URL itself? ─┐
          yes                                        no
           │                                          │
 .nativeVideoIngestion              ┌─ can we get the media file? ─┐
           │                      yes                              no
 Gemini reads the URL               │                               │
      directly                .directMediaFetch              .screenCapture
           │                        │                               │
           │            embed page → CDN URL → download    oEmbed → WKWebView
           │                → Gemini (inline or Files)      → RPScreenRecorder
           │                        │                          → Whisper
           │                        │                               │
    YouTubeExtractor        DirectMediaExtractor          CaptureBasedExtractor
           │                        │                               │
           └────────────────► ClaimContext ◄───────────────────────┘
```

Ask the questions in order and stop at the first yes; each arm is strictly cheaper and
less fragile than the one below it. Adding a platform means answering them and adding a
`Platform` case — not rediscovering the fork. Arm 2 is a `MediaURLResolver` conformance,
arm 3 is an `EmbedResolver` conformance; the rest of each path is shared.

`ExtractionPipeline` asserts in debug builds that an extractor's declared strategy matches
its platform's, so the two can't drift apart.

## Status

| Platform | Path | Status |
|---|---|---|
| YouTube | native ingestion | **Working.** Verified against the live API. |
| TikTok | direct media fetch | **Working.** Resolve + download verified live 2026-07-28; the Gemini leg needs a key to confirm. |
| Instagram | screen capture | **Blocked twice over** — ReplayKit audio, plus Meta app review. See [SPIKE-instagram.md](SPIKE-instagram.md). |

Only platforms that can actually be served get registered. TikTok and YouTube need nothing
but the Gemini key. `SeerPipelineBuilder` leaves Instagram out unless a capture source and
a Meta token are supplied, so a user sharing one gets a clear "not supported yet" rather
than silence. `SeerPipelineBuilder.supportStatus` returns the reason for each gap, for the
UI to show up front.

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

## 2. TikTok — working, without capture

`URL → embed page → CDN MP4 → Gemini Flash`. `TikTokMediaResolver` + `MediaDownloader` +
`DirectMediaExtractor`.

### How the blocker got removed

The previous design was `oEmbed → WKWebView → RPScreenRecorder → Whisper`, and it was stuck:
`RPScreenRecorder`'s `.audioApp` stream frequently arrives **silent** when the sound comes
from a `WKWebView`, because the web view plays on its own `AVAudioSession` and ReplayKit's
app-audio tap does not reliably capture it. The recording succeeds, the file is well-formed,
and it contains nothing.

That problem was not solved. It was **made irrelevant for TikTok**, by going one level down
from oEmbed.

oEmbed returns a `blockquote` plus `<script src="tiktok.com/embed.js">`. What that script
does is inject an **iframe pointed at `tiktok.com/embed/v2/<id>`** — and that page is served
to anonymous requests with no credential. It carries its own server-rendered state blob,
`__FRONTITY_CONNECT_STATE__`, and inside it:

```
source.data["/embed/v2/<id>"].videoData.itemInfos
  ├─ video.urls[0]        ← a direct CDN URL for the MP4
  ├─ video.videoMeta      ← width, height, duration
  ├─ text                 ← the caption
  └─ …plus author, covers, counts
```

So the whole capture apparatus is skippable: resolve the embed the iframe would have
loaded, read the media URL out of it, fetch the file, hand the bytes to Gemini.

**Verified live on 2026-07-28** through the compiled resolver, not by hand: anonymous
request → HTTP 200, blob parsed, extracted URL served **3,224,978 bytes of `video/mp4`**
with a valid `ftyp` box and no credential or `Referer` required. The captured payload is
checked in as the fixture in `Tests/SeerCoreTests/TikTokDirectFetchTests.swift`.

### What this buys beyond unblocking

- **No recording permission.** The capture path needed the user to grant screen recording
  in a share extension, which is a conversion cliff.
- **Faster than real time.** Recording a 60-second clip took 60 seconds. Downloading it
  takes as long as 5 MB takes.
- **No Whisper, so no second vendor and no second failure mode** — one call instead of
  record-then-upload-then-transcribe.
- **On-screen text is recoverable.** This is the substantive one. Whisper hears; it cannot
  read. A clip whose claim is a caption over silent B-roll — a large share of short-form
  political content — produced an *empty transcript* on the capture path, which reads
  downstream as "this video makes no claims". A video model watches, so the same clip now
  yields `onScreenText` and candidate claims.

### What it costs

`__FRONTITY_CONNECT_STATE__` is **not a documented API**. It is the internal state of a
page TikTok serves to its own iframe, and it can change shape without notice. Two things
follow, both implemented:

- **Every parse failure names what went missing** rather than returning an empty result.
  When TikTok moves this, the error says which step stopped finding what it expected.
  Tested — see `testMissingStateBlobFailsWithADiagnosticMessage`.
- **The decoder is permissive about fields it doesn't read and strict about the ones it
  does**, so an added key can't break extraction but a removed `urls` array fails loudly.

Distinguishing *"the page shape changed"* (`malformedResponse`) from *"this video isn't
available"* (`emptyResult`) matters: the first is a bug report, the second is a user
message. A private, deleted or region-blocked post renders a valid page with no
`videoData`, and is reported as the latter.

### Edge cases handled

- **Short links.** `vm.tiktok.com/…`, `vt.tiktok.com/…` and `/t/…` carry no ID; the
  resolver follows the redirect and reads the canonical URL.
- **Photo carousels.** `/@user/photo/<id>` is a real post with no video. Declined up front
  as `notAMediaURL`, so the user is told it isn't a video rather than getting a confusing
  upstream error.
- **Unknown IDs return HTTP 400 from the embed endpoint, not 404** (verified live).
  Translated to `notAMediaURL`.
- **Size.** `generateContent` caps a request at 20 MB and base64 costs a third on top, so
  clips over ~14 MB route through the Files API instead of going inline. See below.
- **A hard byte ceiling on the download** (96 MB), because a share extension has a memory
  budget it cannot negotiate and being killed mid-download looks like the app doing nothing.

### The Gemini leg

Small clips go inline as base64 in one call. Larger ones go through `GeminiFilesClient`:
a resumable `X-Goog-Upload-*` handshake, then polling until the file leaves `PROCESSING`
— not optional for video, since referencing a file before it turns `ACTIVE` fails the
generate call. The file is deleted after analysis rather than left in the project's quota.

**This leg has not been run against the live API**, because no Gemini key was available
where this was written. It reuses the same `GeminiVideoClient` and `generateContent`
endpoint as the working YouTube path — the difference is an `inline_data` or `file_data`
part instead of a YouTube URL — and both request shapes are asserted in tests. Run one
TikTok link with a real key before trusting it.

### The caption is untrusted input

The poster's caption is passed to the model as context, because on short-form video the
claim is often typed rather than spoken. It is also attacker-controlled text being pasted
into a prompt. It is fenced in a `<caption>` delimiter, explicitly labelled as data, and
the task is re-stated after it. That is mitigation, not a guarantee — the real protection
is structural: nothing downstream acts on model output except to fact-check it.

## 2a. The capture path — still there, still blocked

`CaptureBasedExtractor`, `MediaCaptureSource`, `ScreenRecorderCaptureSource` and
`AudioCaptureDiagnostic` are unchanged and still wired up. Instagram needs them, and the
ReplayKit audio question is unresolved.

If Instagram ever gets a Meta token, **check whether it has an equivalent of TikTok's embed
blob before investing anything further in capture.** The TikTok result is a reason to
suspect the capture path is avoidable rather than fixable.

Two properties of that path worth preserving if it is revisited:

- **Silence is detected rather than assumed.** `ScreenRecorderCaptureSource` measures peak
  amplitude and reports `CapturedMedia.containsAudio` honestly; `CaptureBasedExtractor`
  refuses to transcribe and `GroqWhisperTranscriber` refuses to upload. Whisper
  hallucinates plausible text from silence, so this is a real risk, not a theoretical one.
- **`AudioCaptureDiagnostic` still answers the open question in one run on a device** —
  whether the video never played (a fixable autoplay problem) or played and ReplayKit heard
  nothing (the audio-session issue).

```swift
let report = try await AudioCaptureDiagnostic(hostContainer: { self.view })
    .run(on: URL(string: "https://www.instagram.com/reel/ABC/")!)
print(report.summary)
```

## 3. Instagram — spiked, blocked

Short version: **it does not behave like TikTok.** The legacy token-free oEmbed endpoint is
dead (HTTP 500), the Graph replacement requires a Meta app token gated behind App Review,
and anonymous instagram.com is login-walled. Full findings and what unblocks it:
[SPIKE-instagram.md](SPIKE-instagram.md).

The code is written and tested — `CaptureBasedExtractor.instagram` reuses the capture
pipeline verbatim. It stays unregistered until someone obtains a token.

Note that TikTok moving to `directMediaFetch` changed what "reuses the TikTok pipeline"
means: Instagram is now the *only* platform on the capture arm, so that arm is carried
entirely for a platform that is itself blocked on someone else's review queue. Before
spending anything more on capture, re-run the spike and check whether Instagram's embed
iframe exposes a media URL the way TikTok's does. If it does, the capture path can be
retired outright rather than fixed.

## Cross-cutting

**Retries** — exponential backoff with full jitter (`RetryPolicy`). Jitter matters because
share-extension launches cluster. `Retry-After` wins over the local curve when the server
sends one, clamped so a hostile value can't park the extension. 429/408/5xx retry; 4xx
doesn't; cancellation never does.

**Timeouts** — per-request and overall. Video calls get a 120s request / 300s overall
budget; metadata calls get 20s.

**Credentials** — never in source. See [SECRETS.md](SECRETS.md). The Gemini key shared
during handoff should be rotated.

**Testing** — 102 tests, no network. `HTTPTransport`, `Sleeper`, `MediaCaptureSource`,
`MediaURLResolver`, `MediaDownloading` and `Transcriber` are all injectable. Live responses
from Gemini and TikTok are checked in as fixtures, so the parsers are tested against what
the APIs actually return rather than what the docs say they return — the live Gemini
response included a `thoughtSignature` field alongside `text` that a stricter parser would
have thrown on. For the TikTok embed blob it is the only option available: that payload has
no documentation to write a fixture from.

```bash
swift test
```

## Building

`SeerCore` is pure Foundation and builds anywhere, including Linux CI. `SeerCapture` holds
the iOS-only ReplayKit/WebKit code, guarded by `#if os(iOS)`.

**`SeerCapture` has never been compiled** — it needs the iOS SDK, which wasn't available
where this was written. Expect to fix small things on first build in Xcode. `SeerCore`,
which is everything else, is compiled and tested.
