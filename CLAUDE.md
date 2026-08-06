# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The one thing to know before anything else

This repo has two surfaces, and they are **not equals**:

| | What it is | State |
|---|---|---|
| **`web/`** | The fact-checker: link → transcript → research → cited verdict | **The product, and the canonical implementation.** All new work goes here. |
| **`Sources/`** | A Swift extraction pipeline: link → `ClaimContext` | **Frozen — reference only.** No fact-check layer exists on this side, and it no longer receives ported fixes. |

Concretely: **a fix that lands in `web/` stays in `web/`.** Do not port it into `Sources/`. A
gap between the two (e.g. `Sources/` missing a host-allowlist check `web/` has) is expected,
not a bug to fix.

The one standing exception is **presentation**, not pipeline: `SeerUI/LibraryConceptView.swift`
is a mirror of the `web/` library screen by design, so a *layout* decision made in `web/` may
be ported to it (`DeviceProfile.swift` ⟷ `public/device.js` is the current example). That is
still a narrow carve-out — it covers how the same screen is arranged, never how a claim is
extracted, fetched, searched or cited. `Sources/` still must compile and its own tests must still pass — "frozen"
means no new parity work goes in, not that it's abandoned to bit rot. Don't delete
`Sources/` either unless explicitly asked; that's a separate, deliberate decision.

`worker/` is a third, optional piece: a Playwright browser-automation service `web/` can
call as a fallback when its plain-HTTP TikTok/Instagram resolvers get throttled or refused.
It's off by default (`BROWSER_WORKER_URL` unset) and never touches the byte path itself —
it only reports a media URL for `web/` to download normally.

## Commands

### `web/` (the product — most work happens here)

```bash
cd web
cp .env.example .env.local   # paste GEMINI_API_KEY in
npm run dev                  # → http://127.0.0.1:3000, node server.js, no build step
npm test                     # all unit tests, no network, no deps
npm run search -- --claim "..." --query "..."   # run one search from the terminal
npm run find -- --url <url> --find "..."        # run one in-page find, --show-scores for both ranking halves
```

There is no bundler and no `node_modules` dependency for `web/` itself — everything used is
Node 20+ stdlib. To run a single test file directly: `node --test test-search.js` (etc. —
see the `test` script in `web/package.json` for the full list of suites:
`test.js test-search.js test-find.js test-cleanup.js test-probe.js test-hint.js
test-article.js test-browser-resolve.js test-post-preview.js test-device.js`).

### `Sources/` (Swift, frozen)

```bash
swift test               # SeerCoreTests + SeerUITests
swift run SeerUIDemo     # macOS only: watch the progress animation with a scripted extractor, no key/network
```

`SeerCapture` and the SwiftUI half of `SeerUI` need an Apple SDK and are wrapped in
`#if canImport(…)`, so they build to nothing on Linux (CI runs `swift test` on
`ubuntu-latest`). `SeerUI/DeviceProfile.swift` is deliberately outside that guard — it is
pure Foundation precisely so the layout rule stays testable in CI, which is what
`SeerUITests` covers.

### `worker/` (optional browser-resolve fallback)

```bash
cd worker
npm start                # node server.js — needs playwright + its browser download
node --test test.js      # exercises urls.js only (pure), no playwright install needed
```

### CI

`.github/workflows/tests.yml` runs all three test suites (swift, web, worker) daily via
cron and on manual dispatch — not on push/PR.

## Architecture

### `web/` request flow

A pasted link goes through: `api/probe-link.js` (intake ping) → `api/chat.js` (the only
reader of `GEMINI_API_KEY`, streams SSE) → `lib/verified-chat.js` (the fact-check turn:
system prompt, both research tools, frames) → `lib/gemini.js` (model client + fallback
chain + tool loop).

**Getting media to Gemini** — three shapes, cheapest first, decided per platform:
1. **YouTube** — handed to Gemini as a `file_data` URL part; Gemini fetches and watches it itself. No bytes touch this app.
2. **TikTok** — `lib/tiktok.js`: embed page → `__FRONTITY_CONNECT_STATE__` blob → CDN URL (video or, for photo posts, `imagePostInfo.displayImages[]`) → bytes downloaded and attached (inline or via `lib/gemini-files.js`'s resumable upload past ~14 MB).
3. **Instagram** — `lib/instagram.js`: same shape via `/graphql/query` (`doc_id` + shortcode + CSRF) → `video_url` or each `XDTGraphImage.display_url` for carousels.
4. **Any other link** — treated as a "page", not a video: `lib/article.js` fetches and extracts text, quoted into the prompt as the subject under examination (never cited as a source).

`lib/media-fetch.js` is what TikTok/Instagram share: deadline, CDN host allowlist, capped
streamed read (48 MB ceiling, refused/aborted rather than buffered past it).
`lib/post-preview.js` and oEmbed are metadata fallbacks tried in cost order when a
download fails but the post still resolved (caption/creator beats losing the post
entirely). `lib/browser-resolve.js` is the last resort, escalating to `worker/` only for a
closed set of failure kinds (`rateLimited`, `forbidden`, `malformed`, `upstream`) and only
for video posts.

**Citations are enforced by a ledger, not a heuristic.** The model has two tools:
`web_search` (`lib/search.js`, schema in `lib/search-schema.js`) and `find_in_page`
(`lib/page-find.js`, hybrid lexical (`lib/fuzzy.js`) + optional semantic
(`lib/embeddings.js`) ranking). Every result is numbered into a ledger as retrieved; a
`[3]` in the answer must resolve to that ledger. `lib/citation-cleanup.js` merges duplicate
URLs, dedupes/caps/renumbers markers, and **deletes any marker the ledger can't resolve** —
that deletion is the entire enforcement mechanism. There used to be a second layer (an
LLM-based auditor that guessed which sentences were "claims" and forced rewrites); it was
removed because the guess was unreliable, not replaced. Don't reintroduce sentence-level
claim detection — it was deliberately torn out.

**Model fallback chain** (`lib/gemini.js` / `lib/degradation.js`): Flash 3.6 → 3.5 →
3-preview → 2.5 → 2.0, walked on 404/403 (unavailable), 429/`RESOURCE_EXHAUSTED` (quota,
remembered per-model with cooldown), and 503/overloaded-500 (capacity, remembered 20s) —
but a bare `500` is terminal, not walked. This chain is intentionally mirrored in
`Sources/SeerCore/Gemini/GeminiModel.swift`; if you ever do touch that Swift file for a
non-web reason, keep the comments' reasoning in sync since model IDs get retired.

**Bounding a request**: `lib/guard.js` (passphrase, rate limits, input size, per-day/turn
caps — all in-memory, resets on cold start / new process, so treat `APP_PASSWORD` as the
real control on a public deploy, not the rate limiter). Per-turn bounds live scattered
near what they bound: two attached clips per message, 120s stall timeout reset per chunk,
15s keep-alive, four rounds of tool calls then tools are withdrawn, `MAX_OUTPUT_TOKENS`
separate from `THINKING_BUDGET_TOKENS` (the latter reserves room for the visible answer on
thinking models — capping total output tokens alone doesn't do that, since reasoning and
reply share one pool).

### `Sources/` (Swift, frozen — read `docs/EXTRACTION_PIPELINE.md` before touching)

Ingestion strategy is decided once per platform in `Platform.ingestionStrategy`, in a
fixed cost order — ask each question and stop at the first yes:
1. Will the model fetch the URL itself? (YouTube) → `nativeVideoIngestion`
2. Can we get the media file? (TikTok, via embed page) → `directMediaFetch`
3. Neither → `screenCapture` (dead in practice: blocked on a ReplayKit silent-audio bug; `SeerCapture` has no working use and nothing should be spent on it)

All three conform to `ClaimExtractor` and produce a platform-agnostic `ClaimContext`
(transcript, frames, candidate claims, provenance). Nothing downstream knows which
platform a claim came from — but on the Swift side there *is* no downstream: search,
citations and verdict rendering only exist in `web/`.

Layout: `Model/` (`ClaimContext`, `Platform`), `Pipeline/` (extractor protocol, routing,
`SeerPipelineBuilder`, `ScriptedExtractor` for the demo), `Gemini/` (video client, model
chain, Files API upload), `Extractors/`, `Media/` (TikTok resolver, downloader),
`Capture/` + `SeerCapture/` (dead arm 3), `Transcription/` (Groq/Whisper), `Secrets/`
(Keychain, AES-GCM bundle).

### Where `web/` and `Sources/` still correspond

A handful of `web/` files are ports of `Sources/SeerCore` originals and are commented as
such (`lib/tiktok.js` ⟷ `TikTokMediaResolver.swift`, `lib/gemini-files.js` ⟷
`GeminiFilesClient.swift`, `lib/gemini.js` ⟷ `GeminiVideoClient.swift`,
`lib/media-fetch.js` ⟷ `MediaDownloader.swift`, `lib/retry.js` ⟷ `RetryPolicy.swift`).
These are duplicated logic, not shared code — per the freeze policy above, keeping them in
sync is no longer expected or wanted going forward; the pairing is documentation of
history, not a maintenance obligation.

## Testing conventions

- **Swift parsers are tested against live-captured payloads**, not documented shapes —
  TikTok's embed blob has no official docs, so fixtures come from real captured responses.
- **`web/` tests are pure unit tests with no network and no dependencies** — if a change
  needs network access to test, it likely needs a captured-fixture test instead, matching
  the Swift convention above.
- Deploy-affecting behavior (Vercel function timeout, rate-limit storage being in-memory,
  root `vercel.json` vs. Root Directory setting) is documented in `web/README.md` — read it
  before changing deploy config.
