# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The one thing to know before anything else

`web/` is the product and the whole implementation: the fact-checker, link → transcript →
research → cited verdict. All work goes here.

`worker/` is a second, optional piece: a Playwright browser-automation service `web/` can
call as a fallback when its plain-HTTP TikTok/Instagram resolvers get throttled or refused.
It's off by default (`BROWSER_WORKER_URL` unset) and never touches the byte path itself —
it only reports a media URL for `web/` to download normally.

## Commands

### `web/`

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
test-article.js test-browser-resolve.js test-post-preview.js test-device.js
test-timestamps.js test-claims.js test-markdown.js test-corroboration.js
test-corroboration-judge.js test-claim-repair.js test-caption-search.js test-page-shapes.js test-supabase-config.js test-auth-callback.js
test-youtube.js`). As of
this writing the whole suite is 753 tests; `worker/`'s is 5.

Note that `web/design-system/` is **not** part of `web/` — no bundler, no tests, not in the
request flow. It is a hand-maintained React mirror of `web/public`'s markup, staged there
for pushing to the Trase design-system project. If you change anything under `web/public/`,
see `.design-sync/PUSH-REFERENCE.md` — it is the standing answer to "what does the design
system now owe, or owe us", and the mirror goes stale silently otherwise.

`test-page-shapes.js` is the one suite backed by files rather than inline HTML: `web/fixtures/`
holds one page per *shape* (front page, story, paywalled, JS shell, AMP copy, link-heavy
reference page), because "is this a front page" is judged from three signals at once and an
inline fixture written to satisfy that judgement only proves it agrees with itself. Still no
network — the files are handed to the same stub fetch as every other article test.

### `worker/` (optional browser-resolve fallback)

```bash
cd worker
npm start                # node server.js — needs playwright + its browser download
node --test test.js      # exercises urls.js only (pure), no playwright install needed
```

### CI

`.github/workflows/tests.yml` runs both test suites (web, worker) daily via cron and on
manual dispatch — not on push/PR.

## Architecture

### `web/` request flow

A pasted link goes through: `api/probe-link.js` (intake ping) → `api/chat.js` (the only
reader of `GEMINI_API_KEY`, streams SSE) → `lib/verified-chat.js` (the fact-check turn:
system prompt, both research tools, frames) → `lib/gemini.js` (model client + fallback
chain + tool loop).

Two routes run *before* the check and exist to keep the check from repeating their work:

- **`api/probe-link.js`** (`lib/link-probe.js`) — intake's "is there actually something at
  this URL, and what is it?" ping. It replaces the old hostname regex with the network:
  follow the redirects, classify what answered, read headers and never the body. It is the
  one place in the app that fetches a host the user named, which is the shape of an SSRF
  proxy, so the vetting there — scheme allowlist, DNS-resolved address checks on *every*
  hop, redirect cap, short deadline — is load-bearing rather than defensive tidiness. A
  non-200 from this route means the probe couldn't run, and the client falls back to
  URL-shape classification.
- **`api/page-outline.js`** (`fetchPageOutline`) — asked only when the pasted URL's *shape*
  could be a front page (`shallowPagePath` in `public/app.js`, the cheap half of the
  server's test). It shares `readPage` with the check's own fetch, so there is one
  implementation of the hop vetting rather than two that can drift; what differs is only
  what comes back — link text and same-origin URLs, never the page's prose. A front page is
  refused as a check subject and its headlines are offered as checks instead, so the refusal
  arrives at the paste rather than at the end of a run.
- **`api/resolve-media.js`** — the library UI's video pane needs a real MP4, because neither
  TikTok nor Instagram has an iframe embed that plays for a logged-out visitor. This exposes
  the same resolve step the check runs internally. YouTube never calls it for a *video*: a
  video ID is enough to build an embed URL client-side. It does call this route once for the
  post's *title* (`lib/youtube.js`, `kind: "title"` branch) — YouTube's oEmbed has no CORS
  header, so the browser can't ask it directly, and without this the pane named a YouTube
  post by its pasted URL forever instead of its real title the way TikTok/Instagram posts do.
  A generic page/article link gets the same `kind: "title"` treatment off
  `lib/article.js`'s `fetchPageTitle` — a bare call to the same hop-vetted `readPage`
  `fetchArticle` wraps, skipping its index-page/paywall/reader-fallback judgment since none
  of that bears on a title. Client-side, `loadLinkTitle` (public/app.js) is the one function
  behind both branches — the video pane, the composer's follow-up placeholder, and the
  sidebar row all read off the same `entry.title` it updates via `applyPostTitle`.

That second resolve would otherwise be paid twice — once at intake, once when the user hits
Check — and a shared cache **cannot** fix it, because `api/chat.js` and `api/resolve-media.js`
are separate Vercel functions with separate memory (a module-level `Map` in `lib/` works
perfectly under `node server.js` and silently does nothing in production, the same trap the
rate limiter has). So the resolve travels with the request instead: `lib/resolve-hint.js`
vets what the browser hands back field by field, and anything that doesn't survive is simply
resolved the usual way. The hint is never truth — the download re-validates the host
regardless — so a stale or hostile hint costs a wasted attempt and never a wrong answer.

**Getting media to Gemini** — four shapes, cheapest first, decided per platform:
1. **YouTube** — handed to Gemini as a `file_data` URL part; Gemini fetches and watches it itself. No bytes touch this app. The part carries `media_processing: "AGENTIC"` (`MEDIA_PROCESSING_AGENTIC` in `lib/gemini.js`), so the model navigates the timeline and loads only the stretches the prompt needs instead of ingesting every frame at 1 FPS — the difference between free and ~180k tokens per round on a half-hour video. Only models that have the feature get the field; `streamRound` strips it per attempt as the chain is walked, and a refusal is repaired the same way `mediaResolution` is. YouTube only: downloaded clips are short enough that a static read is the better one. `GEMINI_VIDEO_PROCESSING=static` turns it off.
2. **TikTok** — `lib/tiktok.js`: embed page → `__FRONTITY_CONNECT_STATE__` blob → CDN URL (video or, for photo posts, `imagePostInfo.displayImages[]`) → bytes downloaded and attached (inline or via `lib/gemini-files.js`'s resumable upload past ~14 MB).
3. **Instagram** — `lib/instagram.js`: same shape via `/graphql/query` (`doc_id` + shortcode + CSRF) → `video_url` or each `XDTGraphImage.display_url` for carousels.
4. **Any other link** — treated as a "page", not a video: `lib/article.js` fetches and extracts text, quoted into the prompt as the subject under examination (never cited as a source). A homepage or section front is refused rather than read (`looksLikeIndexPage` — shallow path + a wall of anchors + almost no prose that isn't link text): there is no single claim on one, and the failure it prevents is the model checking whichever headline it happened to see. Two other shapes are handled rather than mis-read: a page whose text extracts to nothing is retried once against its own AMP/print copy (`readerVariants`, same-origin only, half the deadline), and a metered page is flagged `partial` (`looksPaywalled` — the site's own `isAccessibleForFree`, or a meter phrase in a short body) so the model is told the rest is unread rather than absent.

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

**A Corroborated verdict is audited against what its sources actually say.** The failure
this catches is a claim marked *Corroborated* whose cited pages are about the claim's
subject without confirming it — the Wikipedia article for an office and a gov.uk list of
ministers, cited for who currently holds that office. `lib/corroboration.js` runs over the
finished answer, before `cleanCitations`, and asks one question per `[[claim: …]]` block the
model marked Corroborated: do the pages it cited, **taken together**, contain the claim's own
specifics? The set is read as a whole — a two-part claim carried by two sources, one part
each, is confirmed, which asking each source for everything got wrong. Names
and figures are required outright (a figure matches a source that rounds to it or states a
range around it, and a figure the claim qualifies — "over 300 million", "under 5%", "about 2
million" — matches a source figure on the right side of it, within 10×, at the same scale,
never a year); the claim's other words are required on a scale that
loosens as more names and figures match, because a source that has matched two of them is
demonstrably about *this claim* and the rest is wording (see the note in `sourceConfirms`).
A claim nothing confirms is rewritten to **Insufficient evidence** with one app-voiced line
saying why. It only ever moves a verdict in that direction — it can withhold a finding,
never manufacture one — and, like `cleanCitations`, it never un-draws anything: the rewrite
travels as the same `{type: "answer"}` replacement frame.

This is **not** the sentence-level claim detection torn out above, for the same reason the
claim-marker section below gives: it acts on the model's own `[[claim: …]]` and `VERDICT:`
lines and on text the app itself retrieved, never on a guess about which prose is a claim.
The word match is a **filter, not the gate**. A downgrade it proposes is first sent to
`lib/corroboration-judge.js`: the cited pages are read for the claim (`findImpl` over the
turn's `PageCache`, usually already prefetched; capped at `READ_BUDGET_MS`), and one
tool-less, video-less model call (`JUDGE_SYSTEM_PROMPT`, temperature 0) judges every flagged
claim at once, one `CLAIM n: SUPPORTED|NOT SUPPORTED` line each. A claim judged supported is
passed back to `auditCorroboration` as `spare` and keeps its verdict. Anything else — judged
unsupported, a claim that cited nothing, a failed or unparseable call, a stream that already
errored — keeps the word match's downgrade. The judge only runs when the word match flagged
something, so a clean turn costs nothing extra; `CORROBORATION_JUDGE_ENABLED=false` turns it
off. It can only spare a verdict the model wrote, never raise one, and it never looks at a
claim the word match passed — so a page saying cases *rose*, cited for a claim they *fell*,
still gets through when every name and figure matches. Catching that stays the model's job,
which the WHAT COUNTS AS CORROBORATION section of the prompt asks it to do.

**A decisive verdict with no source under it is re-checked before that audit runs.**
`lib/claim-repair.js` finds every claim block closed Corroborated, Contradicted or Disputed
whose text cites nothing in the ledger (the model judged it "obvious", or a long video ran
out of tool rounds), runs one `web_search` per such claim with its own `[[claim: …]]` line
as the query, and makes one tool-less, video-less model call asking for just those blocks
rewritten against the new sources. Each rewrite is spliced over its original block (claim
line kept verbatim) and the answer then goes through the corroboration audit and cleanup as
usual — so a rewrite that still cites nothing, or cites only the topic, is lowered the normal
way. Capped at `MAX_REPAIR_CLAIMS` (5); any failure (search, model, unparseable reply) leaves
the block for the audit. Skipped on a truncated or errored answer. The prompt's CHOOSING
WHICH CLAIMS TO CHECK section caps claim blocks at 3 for a short clip/post/article and 5 for
a longer video, so every kept claim fits in the three tool rounds; EVERY VERDICT NEEDS A
SOURCE tells the model this re-check exists. Like the audit, this acts only on the model's
own markers, not on guessed prose.

**One search may run before the model has asked for anything.** `lib/caption-search.js`
turns a post's caption into a single speculative `web_search`, issued while the clip is
still downloading. The caption comes back from the *resolve* step — before the download
starts — and on short-form political video it is frequently where the claim actually lives,
so the query is free: it runs in time the request was going to spend anyway. Its results are
numbered into the same ledger and the prompt tells the model they are there, that they are
the only sources it will ever be given that it did not ask for, and that an unused one costs
nothing. `captionQuery` returns `null` for most captions and that is the normal answer —
`MIN_CAPTION_WORDS`/`MIN_CAPTION_CHARS` reject "😂😂 #fyp" and hashtags are stripped
entirely. Gated by `CAPTION_SEARCH_ENABLED` (default on) and, above that, by
`searchEnabled`.

This is **not** the sentence-level claim detection torn out above, and the distinction is
the same one the claim-marker section below draws: it reads metadata the platform handed us
rather than guessing at prose, it never rejects or rewrites an answer, and a bad guess costs
one query that `cleanCitations` then drops from the source list.

**An answer's block structure is parsed, not guessed at with `<br>`s.** `public/markdown.js`
(`parseBlocks`) turns the model's text into blocks — paragraph, heading, blockquote, fenced
code, and lists that nest — and `renderBlocks` in `public/app.js` turns those into HTML,
because only app.js knows the source ledger and whether the video pane can be seeked. The
split is what makes the shape half testable in Node with no browser (`test-markdown.js`),
the same way `claims.js`, `timestamps.js` and `device.js` are pure. What it buys over the
line-at-a-time renderer it replaced: a `•` bullet is a bullet (the model does not always
write `- `), indentation nests instead of flattening, a wrapped line under a bullet stays in
that bullet, and a blank line between two items no longer splits one list into two. Inline
spans are still app.js's `renderInline`, which lifts code spans out before the bold/italic
and `[n]`/`[t=…]` passes run — a code span is the one place in a line meant to be read
literally.

**Timestamps are a separate marker from citations, and they point at the post, not at a
source.** On a video check the model is asked to write `[t=M:SS]` (or `[t=M:SS-M:SS]`) after
each claim, marking when in the clip it is made. `public/timestamps.js` owns that syntax —
parsing, formatting, and turning the marks into playback windows — and `public/app.js`
renders each one as a chip that seeks the video pane (`currentTime` on the MP4 element,
`postMessage` for the YouTube embed) and lights up while the playhead is inside it. The
`t=` keeps the asked-for shape well clear of citations: `lib/citation-cleanup.js` deletes
any digits-only `[n]` it can't resolve in the ledger. The parser is tolerant of the shapes
the model drifts into anyway, including `[0:12]`, `[t=12s]`, `[t=1:05, 1:10]`, `(t=0:12)` and
`[t=0:12 to 0:20]`, so none of them leaks out as raw text. One line holds firm: a bracket
without `t=` must contain a colon, so `[12]` is never claimed from the citation pass. Chips
are only rendered as controls when there is something to seek — an article or a photo
carousel gets inert text.

**Claims are split into panes by a marker the model writes, not by guessing from prose.**
The CLAIM STRUCTURE section of `FACT_CHECK_SYSTEM_PROMPT` (`lib/verified-chat.js`) asks the
model to open each distinct claim with `[[claim: …]]` on its own line and close it with its
own `VERDICT: …` line before the next one starts. `public/claims.js` is the only thing that
parses that — `splitClaims` turns the raw answer into one block per marker (or `null` if
there are none, which is the normal case for a follow-up or a greeting, and also covers
every answer written before this feature existed), and `public/app.js`'s `claimPanesHTML`
renders one `.claim-card` per block instead of the single card a `null` result still falls
back to. This is not the sentence-level claim-detection heuristic the paragraph above says
was torn out and must not come back — that guessed which sentences in already-written prose
"looked like" a claim; this only ever acts on a marker the model was explicitly asked to
write, the same shape `[t=…]` timestamps and the (now per-claim) `VERDICT:` line already
are. Don't blur the two back together by trying to split an answer some other way.

The parse is deliberately tolerant of the shape drifting while still acting only on those
markers. A marker must open its line, but body text may follow it on the same line. A
claim's verdict is the *last* VERDICT line in its own block, so a `---` or a stray line
after it no longer costs the badge. The overview is an `[[overview]]` block the prompt asks
for *ahead of* the first claim, so it is whole before the first claim card appears and is
drawn above the claims from the loading grid onward (`renderClaimSkeletons`); text after the
final claim (behind the marker, or bare) still parses as the overview too, which is how
answers stored before that change were written. Either way it renders as a collapsible card
above the claims (`claimsOverview`). Switching it off in Settings is sent with each request (`overview:
false`), so the model is given `factCheckSystemPrompt({ overview: false })` and never asked
for one. The CSS switch only covers answers stored before the change. Text before the first marker is a
context note (`claimsPreamble`): the "this is satire" line. Source pills go on the card
whose text cites them (`attributeSources`), and anything no card cites goes in an "Other
sources" row after the claims, never into the last card.

A YouTube video reaches Gemini as a bare `file_data` URL, so its title, often the post's
biggest claim, is looked up via oEmbed (`resolveVideoTitles` in `lib/gemini.js`, opted
into by `api/chat.js`, 2.5s cap, run alongside clip attachment) and handed to the model
in a note beside the video. The prompt's FIND THE CLAIM THE POST IS MAKING section makes
that central claim, causal chains included, the first block.

The verdict vocabulary is closed — **Contradicted, Disputed, Corroborated, Insufficient
evidence** — and it is written down twice: as the four labels the prompt asks for, and as
the `VERDICTS` map in `public/claims.js` that turns each into a badge. `splitVerdict` also
accepts close synonyms via `VERDICT_ALIASES` ("False" for Contradicted, "Unverified" for
Insufficient evidence) so a model that drifts on wording still gets badged — a net under the
prompt, not a licence to add a fifth verdict on one side only. An alias that maps to none of
the four keys still parses to `null`.

**Model fallback chain** (`lib/gemini.js` / `lib/degradation.js`): Flash 3.7 → 3.6 → 3.5 →
3-preview → 2.5 → 2.0, then the Lite tier — 3.5-flash-lite → 3.1-flash-lite →
2.5-flash-lite, reached only once every full model above has failed or is cooling down, not
interleaved as a cheaper same-generation fallback. Walked on 404/403 (unavailable,
remembered per-model — a retired preview ID or a key not entitled to a model doesn't get
re-learned on every request), 429/`RESOURCE_EXHAUSTED` (quota, remembered per-model with
cooldown), and 503/overloaded-500 (capacity, remembered 20s) — but a bare `500` is
terminal, not walked, and an invalid key (401, or a 403 that's actually `API_KEY_INVALID`)
is terminal and never recorded against any one model, since the model wasn't the problem.

Two 400s are **repaired in place rather than walked**: a `thinkingConfig` or a
`mediaResolution` the model says it doesn't recognise. Both are caps on how the question is
answered rather than part of the question, and `supportsThinkingBudget` guesses about every
model by the same version-number rule — so falling through was the one move guaranteed not
to work, collecting the identical 400 at every step and failing the turn. Instead the field
is dropped, the same model is retried, and the refusal is remembered per model
(`thinkingConfigRefused`) so it is learned once instead of on every request. The retry can't
be refused for the same reason twice, since it no longer carries the field.

**Bounding a request**: `lib/guard.js` (passphrase, rate limits, input size, per-day/turn
caps — all in-memory, resets on cold start / new process, so treat `APP_PASSWORD` as the
real control on a public deploy, not the rate limiter). Per-turn bounds live scattered
near what they bound: two attached clips per message (`MAX_CLIP_ATTACHMENTS`), 120s stall
timeout reset per chunk (`STREAM_IDLE_TIMEOUT_MS`), 15s keep-alive, **three** rounds of tool
calls then tools are withdrawn (`MAX_TOOL_ROUNDS` — a round is one model call plus every
tool call it asked for, and the prompt tells the model the same number, so changing one
means changing both), a 120s budget on the whole clip stage (`CLIP_BUDGET_MS`), and
`MAX_OUTPUT_TOKENS` (16384) separate from `THINKING_BUDGET_TOKENS` (4096 — it reserves room
for the visible answer on thinking models, which capping total output tokens alone doesn't
do, since reasoning and reply share one pool). A round that still holds its tools thinks on
a smaller budget again (`TOOL_ROUND_THINKING_BUDGET_TOKENS`, 1024): deciding what to look up
is a shallower task than weighing what came back, and the reader waits through that
deliberation before the first search is even dispatched.

## Testing conventions

- **`web/` tests are pure unit tests with no network and no dependencies** — if a change
  needs network access to test, it likely needs a captured-fixture test instead.
- Deploy-affecting behavior (Vercel function timeout, rate-limit storage being in-memory,
  root `vercel.json` vs. Root Directory setting) is documented in `web/README.md` — read it
  before changing deploy config.
