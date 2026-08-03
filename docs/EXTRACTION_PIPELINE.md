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

> **Note on the capture path's test coverage.** `SeerCoreTests` depends on `SeerCore`
> only, and every file in `SeerCapture` is behind `#if os(iOS)`, so on Linux CI those
> files compile to nothing and no test touches them. Everything in `SeerCapture` —
> `ScreenRecorderCaptureSource`, `WebViewEmbedRenderer`, `AudioCaptureDiagnostic` — is
> therefore unverified by the test suite and needs a device or an iOS-SDK type-check.
> Treat changes there with more suspicion than the green build implies.

| Platform | Path | Status |
|---|---|---|
| YouTube | native ingestion | **Working.** Verified against the live API. |
| TikTok | screen capture, direct media fetch as automatic fallback | **Working, mixed confidence.** Direct-fetch (the fallback arm): resolve + download verified live 2026-07-28, Gemini leg needs a key to confirm. Capture (the primary arm, `TikTokCaptureFirstExtractor`): implemented and unit-tested against mocks, **not yet run on a device** — the ReplayKit/WKWebView silent-audio question this whole path used to be blocked on is still open in practice, just no longer fatal, since a silent capture now falls through to direct-fetch instead of failing the request. See §2 below. |
| Instagram | screen capture (Swift) / direct media fetch (web) | **Working in web; frozen, unported in Swift.** The web app resolves reels anonymously and ships it. The Swift extractor is still the capture one and still unregistered — and, with `Sources/` now frozen (see [Cross-cutting](#sources-is-frozen)), stays that way rather than being ported. See [SPIKE-instagram.md](SPIKE-instagram.md). |

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

The chain walks when another model would plausibly answer, which is a wider set than
"availability":

- **404, 403, 400s naming the model** — the model isn't there or isn't ours. Fall through.
- **429 and other quota exhaustion** — quota is metered per model. This only reaches the
  chain after the retry layer has already backed off and honoured `Retry-After`, so it is
  a spent allowance rather than a blip.
- **503, and 500s whose body says overloaded** — capacity is metered per model too, and the
  newest model in the chain is the likeliest to be full, which makes this the most common
  transient upstream failure rather than a rare one.

Everything else is terminal. A bare 500 is an outage and walking the chain through it adds
four failed requests to a service already struggling; a malformed request fails immediately
rather than being retried against four more models at four more models' cost; and a bad key
is checked for first, because it arrives as a 400 or 403 that the rules above would
otherwise wave through into four more attempts with the same dead credential.

**Operational caveats.** YouTube URL ingestion is a preview feature: pricing and limits can
move. The free tier caps daily YouTube intake (8 hours/day at time of writing). Videos must
be public or unlisted. `maxAnalysedDuration` (default 30 min) caps how much of a long video
is billed.

## 2. TikTok — capture-first, direct fetch as automatic fallback

**This reverses the arrangement the rest of this section describes**, at explicit product
direction rather than as a correction: `TikTokCaptureFirstExtractor` tries the capture
path first (`CaptureBasedExtractor.tikTok`, unchanged), and only falls back to the
direct-fetch path below — `TikTokMediaResolver` + `MediaDownloader` +
`DirectMediaExtractor` — if capture fails. Both arms are real and independently tested;
`Platform.tikTok.ingestionStrategy` is now `.screenCapture` to name capture as the
primary arm, and `SeerPipelineBuilder` registers the composite extractor whenever a
`captureSource` is configured, falling back to direct-fetch alone otherwise (nothing to
record with, same as before).

**Why this doesn't contradict "`Sources/` is frozen"** (see
[Cross-cutting](#sources-is-frozen)): the freeze stops *parity ports from `web/`*, which
has no capture path for TikTok to port — the web app never had this arrangement and
still doesn't. This is new Swift-side product behavior, added by explicit instruction,
not a rediscovered `web/` fix. It also doesn't reopen the ReplayKit audio question as a
blocker: **that question is still open**, but it no longer has to be answered before this
ships, because `TikTokCaptureFirstExtractor` treats a silent capture as a normal,
observable failure of the primary arm and serves the request from direct-fetch instead —
never a silent empty transcript. Which arm actually served a request is always
recoverable from the result: `ClaimContext.provenance.strategy` names it,
`provenance.extra["servedBy"]` repeats it as a fixed string for logging, and
`provenance.extra["capturePathFailure"]` carries the reason whenever the fallback fired.

**What is and isn't verified.** The fallback arm carries the same verification this
section originally described below — resolve and download checked live, the Gemini leg
unconfirmed for lack of a key. The capture arm (`CaptureBasedExtractor`,
`ScreenRecorderCaptureSource`, `WebViewEmbedRenderer`, `AudioProbe`) is implemented and
covered by `CapturePipelineTests` against `MockCaptureSource`, but — per the note at the
top of [Status](#status) — nothing in `SeerCapture` has ever run on a device or
simulator from this environment, which has no Swift toolchain at all, let alone iOS
build tooling. `AudioCaptureDiagnostic` (below) is the tool for that run; it has not been
executed. Treat "capture-first" as correct by construction and unverified in practice
until someone runs it on hardware and reports a `Report.summary`.

### How the blocker got removed, on the fallback arm

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
  Enforced by `HTTPTransport.send(_:maxBytes:)`, which streams to a temporary file and
  sizes it on disk before reading it in — the ceiling used to be a `data.count` check
  *after* the transport had built the whole body in memory, which cannot prevent the
  allocation it exists to prevent.
- **A host allowlist on the media URL.** That URL comes out of TikTok's state blob, so it
  is the one URL in the pipeline a third party chooses, on a path anyone can reach by
  sharing a link. `Platform.allowedMediaHosts` names the CDN families and
  `allowsMediaHost(_:)` suffix-matches on a dot boundary, so `tiktokcdn.com.evil.test`
  fails. An empty list denies everything, so a platform that hasn't declared its CDNs
  cannot be downloaded from by accident.

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

## 2a. The capture path — now primary for TikTok, still the only option for Instagram

> **This section predates §2's reversal and is stale where it says the capture path is
> being left alone.** It no longer is: `TikTokCaptureFirstExtractor` (§2) put it back in
> the primary position for TikTok. Everything below about the mechanics of capture, the
> ReplayKit risk, and `AudioCaptureDiagnostic` is still accurate and load-bearing — only
> the "don't touch this" framing is superseded. For Instagram specifically the framing
> still holds: no capture source exists for it beyond this arm, `Sources/` is frozen
> against new *ports from `web/`*, and the Instagram resolver port described below
> remains not-happening for that reason.

`CaptureBasedExtractor`, `MediaCaptureSource`, `ScreenRecorderCaptureSource` and
`AudioCaptureDiagnostic` are unchanged in themselves — TikTok's reversal wires a new
caller (`TikTokCaptureFirstExtractor`) in front of the same `CaptureBasedExtractor.tikTok`
that already existed. Instagram still has no other option, and the ReplayKit audio
question is unresolved for both platforms alike; TikTok is simply no longer blocked on
answering it first, since a silent capture now falls through to §2's direct-fetch arm
instead of failing the whole request.

Instagram turned out to be resolvable to a direct MP4 with no credential (see §3), which
is the outcome this section was told to check for — and porting the resolver would take
the whole arm away with the ReplayKit problem inside it, for Instagram. That port is not
happening: `Sources/` is frozen (see [Cross-cutting](#sources-is-frozen)), and a
web → Swift port of the Instagram resolver is exactly the work the freeze stops. So the
Instagram arm survives, unregistered and unmaintained rather than retired.

Two properties of that path worth knowing if you're the one running it for the first
time — which, per §2, still hasn't happened:

- **Silence is detected rather than assumed.** `ScreenRecorderCaptureSource` measures peak
  amplitude and reports `CapturedMedia.containsAudio` honestly; `CaptureBasedExtractor`
  refuses to transcribe and `GroqWhisperTranscriber` refuses to upload. Whisper
  hallucinates plausible text from silence, so this is a real risk, not a theoretical one.
- **`AudioCaptureDiagnostic` still answers the open question in one run on a device** —
  whether the video never played (a fixable autoplay problem) or played and ReplayKit heard
  nothing (the audio-session issue).

```swift
let report = try await AudioCaptureDiagnostic(hostContainer: { self.view })
    .run(on: URL(string: "https://www.tiktok.com/@user/video/123")!)  // or an Instagram reel
print(report.summary)
```

It distinguishes the two failure modes that look identical from the outside: *the video
never played* (a WKWebView autoplay problem, fixable) versus *the video played and
ReplayKit heard nothing* (the audio-session issue, possibly fatal to this approach).

**Run this against a real TikTok URL before trusting `TikTokCaptureFirstExtractor` in
production.** It's the blocking gate §2 says hasn't been run — a device or simulator this
environment doesn't have. A PASS or BLOCKED verdict either way is safe to ship *behind
the fallback*: BLOCKED means every TikTok request quietly rides the direct-fetch arm,
which is already the fully-verified path. What isn't safe is assuming a PASS without
having actually run it — the fallback's silence hides a capture arm that never worked
from anyone who isn't watching `provenance.extra["servedBy"]`.

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
- **The recorder starts before playback, not after.** `present()` loads and hydrates the
  embed but deliberately leaves it paused; the caller starts the recorder and only then
  calls `startPlayback()`. Anything that sounds before the tap is live is audio the file
  will never contain, and `startCapture` can sit on a permission prompt long enough for a
  short clip to finish entirely.
- **Playback is polled, not sampled.** `observePlayback(for:)` watches across the whole
  window and latches on the first sighting. A single check cannot answer the question in
  either direction: too early and `currentTime` is still 0 because `play()` has only just
  been issued, too late and a short clip has already ended and gone `paused`. Both read as
  "never played" — which discards a good capture *and* imitates the ReplayKit defect this
  path exists to diagnose.

The embed document is loaded against a real platform origin, not `about:blank`; platform
embed scripts check the origin and refuse to hydrate otherwise.

## 3. Instagram — resolved in the web app, unported in Swift

Short version: **Instagram does not behave like TikTok, but it does not need to.** The
legacy oEmbed endpoint is dead, the Graph replacement is gated behind Meta App Review, the
embed iframe carries no media (re-tested 2026-08-02), and anonymous instagram.com is
login-walled. What *is* open to a logged-out visitor is the query instagram.com's own web
client runs: `POST /graphql/query` with a `doc_id` and the post's shortcode, carrying a
CSRF token from a plain GET of the homepage. It returns `video_url`, and that CDN link
serves the MP4 with no credential. Full findings: [SPIKE-instagram.md](SPIKE-instagram.md).

**The web app ships this** — `web/lib/instagram.js`, same interface as `web/lib/tiktok.js`,
so a reel and a TikTok are one kind of thing to the Gemini layer. No Meta token, no
capture, no ReplayKit.

**The Swift app does not, and now will not.** `CaptureBasedExtractor.instagram` is still
what exists and is still unregistered, which means Instagram remains the only platform on
the capture arm and that arm is still carried for a platform that no longer needs it. The
port used to be described here as small and worth doing — a `MediaURLResolver` alongside
`TikTokMediaResolver`, then register Instagram as `directMediaFetch` and delete the capture
path with it. That recommendation is withdrawn, not completed: see
[the freeze decision](#sources-is-frozen) below. `Sources/` no longer receives new ports
from `web/`, and this would have been one. The capture arm, the ReplayKit audio problem,
and `CaptureBasedExtractor.instagram` all stay exactly as they are.

## Cross-cutting

### `Sources/` is frozen

`web/lib/tiktok.js`, `web/lib/gemini-files.js`, `web/lib/gemini.js` and
`web/lib/media-fetch.js` are ports of the Swift files named in their headers, and nothing
ever kept the pairs in step but hand-porting, which did not happen reliably: the web side
is where fixes land (42 commits to `web/` against 12 to `Sources/` over three months), all
three hardening measures described above existed in `web/` before they existed here, and a
fourth divergence — `TikTokURL` in `TikTokMediaResolver.swift` has no host check on its
short-link and video-ID parsing, where `web/lib/tiktok.js`'s `isTikTokHost`-gated
equivalents do — turned up in the audit that led to this decision.

**The root README states the decision this section used to defer: `web/` is canonical,
and `Sources/` is frozen rather than a second target for incremental parity patches.**
Concretely, for anyone working in this file's directory:

- A fix that lands in `web/` is **not** ported into `Sources/` anymore. The `TikTokURL`
  gap above is left exactly as found — not because it doesn't matter (a stray host check
  missing on a URL-parsing helper is a real, if currently unreachable, gap — see
  `Platform.detect`/`DirectMediaExtractor.canHandle`, which is what keeps it unreachable
  through the registered pipeline today) but because patching it would be exactly the
  incremental-parity pattern this decision exists to stop. It is documented here instead of
  fixed so the next reader finds an explanation, not a surprise.
- `Sources/` still has to compile and its own tests still have to pass. Frozen means no new
  ports in, not "stop maintaining what's here" — a change that breaks the existing build is
  still a regression.
- Deleting `Sources/` — the other branch the root README lays out, worth roughly 5,700
  lines — is a separate, larger decision this freeze does not make on its own. See the
  README for why.

Read the web counterpart before touching anything in `Sources/` regardless — even frozen,
understanding what the web side already learned about a given piece of logic is cheaper
than rediscovering it, which is exactly how the Files API poll ramp got written twice.

**Retries** — exponential backoff with full jitter (`RetryPolicy`). Jitter matters because
share-extension launches cluster. `Retry-After` wins over the local curve when the server
sends one, clamped so a hostile value can't park the extension. 429/408/5xx retry; 4xx
doesn't; cancellation never does. An oversized body is *not* retried — it throws an
`ExtractionError` straight out of the retry loop, since a file does not get smaller on a
second attempt.

**Timeouts** — per-request and overall. Video calls get a 120s request / 300s overall
budget; metadata calls get 20s.

**Truncated output** — a long video can exhaust the model's output budget mid-sentence,
and `MAX_TOKENS` output is by definition not valid JSON. Rather than fail the extraction
and lose a nearly complete transcript, `GeminiVideoAnalysis.decode` falls back to
recovering the transcript string directly from the partial JSON, and flags the result
`truncated`. Only the transcript is recovered: a half-written `claims` entry reads as a
different, shorter assertion than the one that was made, and the fact-check layer would
report it against the speaker.

**Invalid credentials** — Gemini answers a bad key with **HTTP 400 / `API_KEY_INVALID`**,
not 401. That matters twice over: it must not be treated as a model-availability failure
(the chain would re-send the same dead credential to every remaining model), and it is
worth naming explicitly so the operator gets a message pointing at the key rather than a
bare relay of the upstream text.

**Credentials** — never in source. See [SECRETS.md](SECRETS.md). The Gemini key shared
during handoff should be rotated.

**Testing** — no network. `HTTPTransport`, `Sleeper`, `MediaCaptureSource`,
`MediaURLResolver`, `MediaDownloading` and `Transcriber` are all injectable. Live responses
from Gemini and TikTok are checked in as fixtures, so the parsers are tested against what
the APIs actually return rather than what the docs say they return — the live Gemini
response included a `thoughtSignature` field alongside `text` that a stricter parser would
have thrown on. For the TikTok embed blob it is the only option available: that payload has
no documentation to write a fixture from.

```bash
swift test
```

## Progress reporting

Every extractor takes a `ProgressSink` and announces its stage before entering it. The
stages are listed under [the animation](#the-animation) below; `ExtractionStage.expected(for:)`
gives the sequence a platform will follow, so a UI can lay the whole list out up front
instead of growing it a row at a time.

Two details that are easy to get wrong and are pinned by tests:

- **`done` is emitted by the pipeline, not the extractors.** An extraction that returns an
  empty `ClaimContext` has not finished successfully however far it got, and the pipeline
  is where that judgement is made.
- **Events are emitted in order, and the obvious consumer breaks that.** The handler is
  called synchronously off the main actor. Forwarding each event with its own
  `Task { @MainActor in … }` spawns unordered tasks, and stages arrive backwards — this
  actually happened while writing `AnalysisModel`, and the test recorder caught it. Yield
  into an `AsyncStream` and consume with `for await`, or compare
  `ExtractionProgress.sequence`, which increments monotonically per run.

## The animation

`SeerUI.AnalysisProgressView` shows three things, because a waiting user has three
questions:

| | Answers | How |
|---|---|---|
| Scanning filmstrip | "Is this alive?" | Indeterminate sweep, 1.5s loop |
| Stage checklist | "What is it doing?" | Full sequence up front, filled in as stages close |
| Elapsed + explanation | "Should I be worried?" | Explanation appears once a stage passes its `patienceThreshold` |

**Nothing is determinate, on purpose.** None of the underlying work reports a percentage:
Gemini's `generateContent` is one request that returns when it returns, and the download
is buffered whole by `HTTPTransport` rather than streamed. A bar filling at an invented
rate would be a lie, and a worse one the moment it stalls at 90%.

`patienceThreshold` is not a timeout — nothing is cancelled when it passes. It is the
point at which silence stops being normal and the interface should say something.

`AnalysisModel.timingReport` prints the same breakdown as text:

```
YouTube — 14.6s
  resolving: 0.4s
  analysing: 14.2s
```

That is the troubleshooting payoff of staging. "Stuck on analysing for 90s" and "never
left resolving" are different bugs, and this is what makes the difference legible in a bug
report after the fact.

### Watching it

```bash
swift run SeerUIDemo      # macOS; or open Package.swift in Xcode → SeerUIDemo scheme
```

An animation that has never been rendered is a description of an animation. `SeerUIDemo`
drives `AnalysisProgressView` with `ScriptedExtractor`, which walks the stage sequence on
a timer and returns a canned `ClaimContext` — no key, no network, no share extension. The
same file holds the SwiftUI previews.

The scripts come from `ExtractionStage.expected(for:)` rather than being written out, so a
demo cannot drift from the sequence a real run produces; `ScriptedExtractorTests` asserts
that derivation. Two properties of the demo are deliberate and tested:

- The TikTok script includes `uploading`, the one stage inserted mid-run rather than laid
  out up front — so it exercises the stage list's insertion path, which is the part most
  likely to be wrong.
- Its `analysing` beat runs 16s against a 12s `patienceThreshold`, so a run actually
  reaches the state the explanation text exists for. An animation that never crosses that
  threshold can't be judged.

## Building

`SeerCore` is pure Foundation and builds anywhere, including Linux CI. `SeerCapture` holds
the iOS-only ReplayKit/WebKit code guarded by `#if os(iOS)`; `SeerUI` holds the SwiftUI
guarded by `#if canImport(SwiftUI)`.

`SeerUI` now has a consumer — `SeerUIDemo` imports it — so a Mac build compiles it rather
than leaving it as source nothing references. On Linux the guards still compile it to
nothing and the demo falls back to a stub that says where to run it, so `swift build` and
`swift test` keep working there.

**But a green Linux build still says nothing about the SwiftUI itself.** `canImport(SwiftUI)`
is false there, so those files compile to nothing; the guarantee stops at "the package
builds and the demo's non-SwiftUI path runs". The SwiftUI has been checked for syntax with
`swiftc -parse` against the guards stripped, which catches malformed code but does no type
checking — SwiftUI API misuse would still surface first on a Mac. Expect to fix small
things on first build there. `SeerCapture` has no consumer at all and still needs a device.
`SeerCore`, which is everything else including the whole stage sequence, its ordering
guarantee and the scripted extractor the demo animates, is compiled and tested.
