# Pipeline audit — 2026-08-02

A read of both pipelines for correctness bugs: `web/` (the fact-checker that ships) and
`Sources/SeerCore/` (the Swift extraction pipeline). No code was changed.

**Baseline.** `cd web && npm test` → 243 pass, 0 fail (245 after the fixes below).
`swift build` was not run: no Swift toolchain in this environment, so everything below
about `Sources/` is from reading, and `SeerCapture`/`SeerUI` are unverified for the reason
[EXTRACTION_PIPELINE.md](EXTRACTION_PIPELINE.md#status) already gives.

**On checking the browser fixes.** `npm test` covers `lib/` and `api/`; `public/app.js` has
no test at all, and two of the three bugs below are in it — both of them cases where the
code ran without erroring and simply showed the reader the wrong thing, which is exactly
what a unit test of the server half cannot catch. They were verified by driving the real
page in headless Chromium against a stubbed `/api/chat` that replays each frame sequence:
truncated, interrupted-with-text, interrupted-with-nothing, and a clean turn as the
control. That harness is not checked in — it needs a browser the repo doesn't currently
depend on — but the frame fixtures it uses are written out in §2 and §3 and are cheap to
rebuild.

Findings are ordered by what they cost a reader, not by how hard they are to fix. The
first three are all on the same seam — the server does careful work to salvage a damaged
turn, and the browser throws the result away.

**1–5 and 7 are fixed; 6 was resolved by decision rather than by patch** (see the status
line under each). Everything under "Smaller things" and "What looked wrong and isn't" is
still open or, respectively, already known-fine.

---

## 1. Citation cleanup deletes prose between markers — `web/lib/citation-cleanup.js:249`

> **Fixed.** `MARKER_GROUP`'s inter-bracket separator is now `[ \t]*` rather than `\s*`, so
> a group cannot span a line break. Regression tests in `test-cleanup.js`: *"a line break
> between two markers is not a marker stack"* and *"markers side by side on one line are
> still one stack"* — the second because narrowing the pattern must not cost the collapsing
> the pass exists for.

`cleanCitations` states three rules, and the second is *"Only ever change markers. The
prose the model wrote comes out byte-identical apart from the markers and the whitespace a
removed marker leaves behind."* The renumber pass breaks it.

`MARKER_GROUP` is `/\[\d+…\](?:\s*\[\d+…\])*/g`, and `\s` matches newlines. In
`cleanSentence` that is harmless — cleanup runs per line there. But the renumber pass at
line 250 runs `outsideCode(working, prose => prose.replace(MARKER_GROUP, …))` over the
*whole* answer, so two markers separated only by whitespace — including a paragraph break —
are matched as one group and rewritten with `formatMarkers`, which joins with nothing
between them.

Reproduced:

```
IN : "Summary line [2]\n\n[1] Some closing remark."
OUT: "Summary line [1][2] Some closing remark."
```

Three things went wrong in one rewrite: the paragraph break is gone, `[1]` was hauled up
onto the previous sentence, and the sentence that owned it is now uncited. A milder case,
`"The rate fell [1]\n[1]"` → `"The rate fell [1][1]"`, loses the line break and keeps a
duplicate that the per-sentence dedupe would have caught had the two been on one line.

The fix is to keep the renumber replacement from spanning a newline — either a
line-at-a-time `outsideCode` callback, as pass one already uses, or a `MARKER_GROUP` whose
inter-group separator is `[ \t]*` rather than `\s*`.

## 2. A partial answer and its sources are discarded when the turn ends in an error — `web/public/app.js:617`

> **Fixed.** An `error` frame arriving after text has streamed is recorded rather than
> thrown: the reader is cancelled, and `streamChat` returns `{answer, sources, incomplete}`
> with the reason attached. An error with no text before it still throws, since there is
> nothing to preserve. The card renders the surviving answer, its linked markers, an
> `Interrupted` notice naming the upstream reason, and the sources under it.

`verifiedChat` goes to real trouble here. When the stream dies after the model has written
something — Gemini ending a turn on `RECITATION` or `SAFETY` mid-answer, which it does
without warning — the error is *held* rather than thrown (`verified-chat.js:639`), the
sources frame is emitted, the citations are cleaned, and only then is it re-thrown
(`verified-chat.js:709`). The comment says why: throwing on the spot "would leave the
reader a half-answer whose `[1]` markers point at nothing".

The browser undoes all of it. In `streamChat`:

```js
} else if (frame.type === "error") throw new Error(frame.message);
```

That unwinds out of the read loop, so the `{ answer, sources }` accumulated so far never
returns, and `runCheck`'s catch renders an error card with nothing under it. The entire
hold-and-re-throw mechanism is inert as long as this is the consumer.

What it should do instead: record the error, break out of the loop, and let the caller
decide — a turn that has text is a turn worth showing with the failure noted above or below
it. Same for the abort path.

## 3. Truncation never reaches the reader — `web/public/app.js:610-617`

> **Fixed.** `truncated` is tracked through the same `incomplete` channel as 2 and shown as
> a `Cut short` notice. One knock-on worth naming: a cut-off answer never reaches its
> `VERDICT:` line, and the old `?? "insufficient"` fallback then stamped it *Insufficient
> evidence* — the app asserting a finding the model never made, indistinguishable from one
> it did. The verdict badge and the sidebar label are now suppressed on an incomplete turn
> that parsed no verdict; the notice explains the gap instead.

`gemini.js:930` explains that a fact-check cut off mid-sentence "reads as a completed
verdict, and the sentence it was cut off in is frequently the one carrying the citation",
and emits `{type: "truncated", …}` so the turn can be labelled. `verified-chat.js:586`
tracks it, uses it to keep the ledger's numbering and to force the fallback source list, and
forwards the frame. `api/chat.js:150` logs the token breakdown.

`app.js` has no branch for `frame.type === "truncated"`. It falls through every
`else if` and is dropped. A truncated verdict renders identically to a finished one — no
badge, no note, no visual difference at all. The one place the reader could act on it is the
only place it doesn't arrive.

(The `sources` frame's `fallback` flag is dropped the same way — `app.js:616` keeps
`frame.sources` and ignores `frame.fallback`. That one is benign, because the client always
renders the list, but it means the distinction `sourcesFrame` computes has no consumer.)

## 4. A check interrupted by a reload is stuck at "Checking…" forever — `web/public/app.js:658, 842`

> **Fixed.** The reap now happens in `loadLibrary()` itself, the single place the library
> is read back from storage: any entry still `status: "running"` at load time is one whose
> `runCheck` died with the previous page, so it's converted to `status: "error"` with a
> clear interruption message, and the fix is persisted immediately so the stale
> `running` state doesn't keep reappearing on every subsequent load. That gives it back the
> retry button and an honest sidebar label — both of which only ever existed on the error
> card — instead of a `Checking…` that nothing will ever resolve.

`runCheck` sets `entry.status = "running"` and calls `persistLibrary()` before the request
starts, so an in-flight check is written to `localStorage` with that status. If the tab is
closed or reloaded mid-check, the boot sequence at line 843 handles only `done` and
`error`:

```js
if (entry.status === "done") renderResultCard(entry);
else if (entry.status === "error") renderErrorCard(entry);
```

A `running` entry gets neither. The claims pane keeps whatever markup `index.html` shipped,
the sidebar row says "Checking…" with a warn dot indefinitely, `selectedDoneEntry()` returns
null so the composer offers no follow-up, and there is no retry button — that only exists on
the error card. The entry is unrecoverable except by clearing storage.

A one-line sweep at load (`running` → `error`, with a "this check was interrupted" message)
restores the retry path.

## 5. `findClipLinks` is provider-major, not first-seen — `web/lib/gemini.js:551`

> **Fixed.** `findClipLinks` now scans the raw text once — the same `URL_PATTERN` and
> trailing-punctuation trim each provider's own finder already applied — and classifies
> each candidate, in the order it actually appears, by asking every provider's own
> `matches()` predicate (`isTikTokLink`/`isInstagramLink`, already exported and already
> tested) whether that one link is theirs. `MAX_CLIP_ATTACHMENTS` is still enforced by
> `resolveClipParts` in exactly the same way — a running counter over the returned list —
> but the list itself is now true first-seen order across every platform at once, so the
> two links that keep their slot are whichever two the user actually typed first,
> regardless of which platform either one is. Two new tests pin this directly: one on
> `findClipLinks` reproducing the audit's own repro, and one end-to-end through
> `resolveClipParts` confirming an Instagram link pasted first — previously the one that
> lost its slot to two later TikToks — now keeps it.

The docstring promises "first-seen order across providers". The implementation loops
providers on the outside and links on the inside, so every TikTok in a message sorts ahead
of every Instagram link regardless of where they appear in the text:

```
"first https://instagram.com/reel/… then https://tiktok.com/@u/video/… and https://tiktok.com/@u/video/…"
→ [TikTok, TikTok, Instagram]
```

That matters because `MAX_CLIP_ATTACHMENTS` is 2 and the cap is applied in this order
(`resolveClipParts:674`). In the message above, the reel the user pasted *first* is the one
that gets refused with "only the first 2 Instagram videos in a message are fetched" — which
is also a slightly wrong sentence, since the cap is counted across platforms and the
platform named is whichever one lost.

Fix: scan the text once and ask each provider whether it claims the match, or interleave by
match index rather than by provider.

## 6. Swift `TikTokURL` does no host check; its JS counterpart does — `Sources/SeerCore/Media/TikTokMediaResolver.swift:214, 241`

> **Not fixed — left as documented, intentional drift.** This finding is the fourth
> instance of the same pattern (host allowlist, download cap, `503` handling, and now
> this), and it's what tipped "decide which surface is canonical" from an open question in
> the README into an actual decision: `web/` is canonical, `Sources/` is frozen, and a
> backport here would be exactly the incremental parity-patch this repo has now stopped
> doing. See the README's *"`web/` is canonical. `Sources/` is frozen"* section and
> `docs/EXTRACTION_PIPELINE.md#sources-is-frozen`. The gap below is real and stays exactly
> as found.

`web/lib/tiktok.js` opens both URL predicates with a host check
(`if (!isTikTokHost(url.hostname)) return null`, line 141; `isTikTokHost(host) && …`,
line 181). The Swift port has neither:

- `TikTokURL.videoID(from:)` reads an ID off any host's `/video/<digits>` path.
- `TikTokURL.isShortLink(_:)` returns `true` for **any** host whose first path segment is
  `t` — the `vm.`/`vt.` cases are checked against the host, the `/t/` case is not.

`resolveVideoID` then issues a redirect-following GET to that URL and reads
`response.url`, which is an outbound request to an attacker-named host on the strength of a
path segment.

Inside the pipeline this is unreachable — `DirectMediaExtractor.canHandle` gates on
`Platform.detect(from:) == .tikTok` first. But both functions are `public`, `TikTokURL` is
documented as a standalone URL-shape helper, and `YouTubeExtractor.videoID` right next door
carries an explicit comment about exactly this hazard ("it's `public static` and documented
for standalone use, so it can't lean on that"). The web version is the correct one — and,
per the note above, that correctness stays a fact about `web/lib/tiktok.js` rather than
becoming a change to `Sources/`.

## 7. `/api/resolve-media` returns the CDN URL without the host allowlist — `web/api/resolve-media.js:86`

> **Fixed.** The handler now runs the resolved `mediaURL`'s hostname through the same
> `hostAllowed()` check the downloaders use, against the same per-platform
> `ALLOWED_MEDIA_HOSTS` list (imported directly from `lib/tiktok.js`/`lib/instagram.js`
> rather than duplicated), before ever handing it back to the browser. Verified live
> against a real TikTok video end to end: the route resolved and returned a
> `tiktokcdn-us.com` URL successfully, confirming the new check doesn't disturb the
> legitimate path — only an unexpected host would now be refused with a 502.

The README's first media-path guarantee is *"It will not fetch a host the platform doesn't
serve from"*, and both downloaders enforce it (`tiktok.js:422`, `instagram.js:577`) on the
grounds that the media URL is "the one URL in the pipeline chosen by somebody else".

This route calls the resolver and returns `resolved.mediaURL` straight to the browser
without running `hostAllowed`. The server does not fetch it, so this is not the SSRF the
allowlist exists to stop — but it does hand a page a URL from an undocumented third-party
blob and point a `<video>` at it, and it is the one exit where the stated invariant doesn't
hold. Running the same check before responding costs one function call and keeps the rule
true everywhere.

---

## Smaller things

**`mediaResolution` is gated on the wrong capability** — `web/lib/gemini.js:1420`.
`supportsThinkingBudget(model)` answers "does this model accept `thinkingConfig`", and it is
being used to decide whether to send `generationConfig.mediaResolution`. The two are
unrelated fields; the effect is that `gemini-2.0-flash` never receives the resolution
setting an operator explicitly configured. `isUnsupportedMediaResolution` +
`mediaResolutionRefused` already handle a wrong guess correctly, so the guard is redundant
as well as wrong.

**Swift concatenates thinking summaries into the JSON it parses** —
`Sources/SeerCore/Gemini/GeminiWire.swift:132`. `GeminiResponse.text` joins every part's
`text`, and `Part` doesn't decode `thought`. Harmless today because nothing sets
`includeThoughts`, but the chain's head models are thinking models and the web side filters
`thought` parts explicitly (`gemini.js:914`). A summary part would land inside the string
handed to `GeminiVideoAnalysis.decode` and fail it.

**Swift reserves no output budget on a thinking model** —
`Sources/SeerCore/Gemini/GeminiVideoClient.swift:46`. `GenerationConfig` has a
`maxOutputTokens` field (`GeminiWire.swift:89`) that no call site sets, and there is no
`thinkingConfig` at all. `DEFAULT_THINKING_BUDGET_TOKENS` in `gemini.js` documents at length
why the visible answer needs a floor reserved for it; on the Swift side the `MAX_TOKENS`
salvage path is absorbing a failure a budget cap would prevent.

**Instagram's shared session carries the first caller's abort signal** —
`web/lib/instagram.js:300`. `session()` deduplicates the homepage seed across concurrent
resolves, which is the right call, but the in-flight promise was created with whichever
caller arrived first and its `signal`. Two links resolving in parallel (the normal case —
`resolveClipParts:644` fires them together) means aborting the first fails the seed for the
second. The seed is cheap enough to make the shared one signal-free.

**`fetchWithTimeout` with no `timeoutMs` aborts immediately** — `web/lib/media-fetch.js:20`.
`setTimeout(fn, undefined)` coerces to 0. Every in-repo caller passes a value, so this is
latent, but the helper is exported and reads as "timeout optional".

**Markdown rendering has no list support** — `web/public/app.js:186`. The system prompt
devotes a whole section (`verified-chat.js:104-115`) to instructing bullet-point answers,
with a worked example. `renderMarkdown` handles fenced code, inline code, `**bold**` and
newlines only, so those bullets render with a literal `-`/`*`/`•` and no indentation.

**Dead branches.** `app.js:546` still handles a `"rewriting"` stage; the repair round it
described was removed and nothing emits it. `ProgressSink.rebound(to:)`
(`ExtractionProgress.swift:213`) has no caller — `ExtractionPipeline` builds the sink with
the extractor's platform already resolved.

---

## What looked wrong and isn't

Worth recording so the next pass doesn't re-derive them:

- `walkChain`'s `index -= 1; continue` for a refused `mediaResolution`
  (`gemini.js:1509`) does terminate: `mediaResolutionRefused` is set before the retry, so
  the second attempt cannot carry the field and cannot be refused for that reason again.
- `resolveClipParts` can leave an entry with neither `part` nor `error` if the download
  throws while the signal is aborted (`gemini.js:708`), which would push `undefined` into
  `parts`. Unreachable through `streamChat` — the `deadline.callerAborted` check at line
  1161 returns first. It is reachable by a direct caller of the two exported functions.
- `checkRateLimit`'s `hits.find(t => now - t < MINUTE)` (`guard.js:114`) really is the
  oldest in-window hit: the array is append-ordered by time.
- `cleanLine`'s `boundary.lastIndex = start` (`citation-cleanup.js:290`) is redundant
  rather than wrong; `SENTENCE_BREAK` cannot match empty, so `exec` was already positioned
  there.
