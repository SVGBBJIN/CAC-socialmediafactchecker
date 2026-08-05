# Seer

A fact-checking library UI over Gemini: paste a video link, get claims checked against
live sources. Static front end in `public/`, one server route in `api/` that holds the
key. No build step, no dependencies.

## Run it

```bash
cp web/.env.example web/.env.local     # then paste your rotated key into GEMINI_API_KEY
cd web && npm run dev                  # → http://127.0.0.1:3000
```

There is nothing to install — `npm run dev` runs `node server.js`, and everything used is
in the Node 20+ standard library. On boot the server prints whether it found your key, so
a missing one is obvious immediately rather than at the first message.

## Where the key goes, and why there

`web/.env.local`. Gitignored, read by the server at startup, never sent to the browser.

The rule this arrangement enforces is the one that matters: **the key only ever exists in
a process you control.** The browser posts conversation text to `/api/chat` and receives
tokens back. There is no endpoint that returns the key, and no code path in `public/` that
could hold one. Open devtools and look — the network tab shows message text going out and
text streaming back, and that is all there is to find.

That is a different property from "the key is encrypted", and a stronger one. Compare
`docs/SECRETS.md`, which is honest about the iOS side: an app that calls Gemini directly
must ship something that can produce the key, so any client-side scheme there is
obfuscation. On the web there is a server, so the key can simply not be in the client.
That is the "thin backend" `docs/SECRETS.md` recommends as the real fix — this is it, for
the web surface.

### What this does not protect against

Keeping the key off the client stops it being *copied*. It does not stop someone who can
reach `/api/chat` from *spending* it — they don't need the key, they have your endpoint.
That is the "15 million people on my quota" problem, and it's a separate control:

| Control | Env var | Default | What it stops |
|---|---|---|---|
| Passphrase gate | `APP_PASSWORD` | off | Strangers using the endpoint at all |
| Per-minute limit | `RATE_LIMIT_PER_MINUTE` | 15 | A script, or a stuck retry loop |
| Per-day limit | `RATE_LIMIT_PER_DAY` | 300 | Slow bleed over a day |
| Message size cap | `MAX_INPUT_CHARS` | 8000 | One giant paste costing real money |
| History cap | `MAX_TURNS` | 20 | Long threads resending everything, forever |

Locally the server binds `127.0.0.1`, so nothing off your machine can reach it and the
passphrase is optional. **The moment it is deployed, that changes.** Set `APP_PASSWORD`
before or at deploy time, not after.

And set a quota cap on the key itself in Google Cloud console, scoped to the Generative
Language API. Every control above lives in this app; a cap on the key is the one that
still applies when the app is the thing that's wrong.

## Deploying to Vercel

The layout is already what Vercel expects — `public/` served statically, `api/*.js` as
Node functions — so the deploy is configuration, not a rewrite:

1. Add `GEMINI_API_KEY` and `APP_PASSWORD` as Environment Variables (all environments).
   Vercel stores them encrypted and injects them at runtime — same `process.env` reads,
   no code change. `.env.local` is for local use only and is not uploaded.
2. Check **Settings → Git → Production Branch** matches the branch you actually merge to.
   If it doesn't, pushes build as previews and the production URL keeps serving whatever
   was deployed the day the project was imported.
3. Deploy.

The repo root is a Swift package, so a root-directory build would otherwise find nothing
web-shaped and produce an empty deployment — every path 404s. The `vercel.json` at the
repo root is what prevents that: it builds `web/api/*.js` as Node functions and
`web/public/**` as static files, and routes `/api/*` and `/` at them. Setting **Root
Directory → `web`** in project settings instead also works — then Vercel sees `web/` as
the project root, zero-config detection applies, and the root `vercel.json` is ignored.
Either path deploys correctly; neither one requires the other.

**Check the function timeout before trusting video on a deployment.** A TikTok or
Instagram link is the slowest request this app makes: resolve the post, download the clip,
possibly upload it,
*then* wait for Gemini to watch it. That runs well past Vercel's default max duration
(10s on Hobby), and a function killed mid-flight used to look to the user like the answer
simply stopped — no error, no text, an empty bubble that vanished on the next render. It
now says so: a stream that closes without an answer is reported as a failure, with the
elapsed time and a pointer to this setting. If that message arrives at a suspiciously
round number of seconds, this is what it is.

Raise it under **Settings → Functions → Max Duration** — 300s is the ceiling on Pro. It is
deliberately not set in `vercel.json`, because that file uses the legacy `builds` key,
which `functions` cannot be combined with; the project setting is the one that always
applies. YouTube carries the same exposure and always has, since Gemini watching a video
takes tens of seconds — which is also what the 15s keep-alive below is for.

There is no request deadline inside the app — a turn runs until it finishes or the host
stops it, and the host's limit is the only ceiling. What makes that survivable is that it
is no longer silent: every stage is logged with its elapsed second (`[chat] 24s waiting
(gemini-3.6-flash)`), so the runtime log names the step a request died in, and the browser
reports a stream that closes without an answer instead of quietly dropping the bubble. Set
Max Duration high enough for the slowest thing you actually paste.

One thing to fix when you do: **the rate limiter is in-memory.** It lives per function
instance and resets on a cold start, so on Vercel the real ceiling is looser than the
numbers suggest — fine as a guard against accidents and casual over-use, not against
someone deliberately hammering it. For a public deployment, swap the `windows` Map in
`lib/guard.js` for Vercel KV or Upstash Redis; the function signatures in that file don't
need to change, only the storage behind them. Until then, `APP_PASSWORD` is what is
actually holding the door, so treat it as required rather than optional.

## Layout

```
web/
  public/          Front end — index.html, app.js. No key, ever.
  api/chat.js      The only reader of GEMINI_API_KEY. Streams SSE to the browser.
  api/config.js    Booleans for the UI: is a passphrase needed, is a key present.
  api/probe-link.js  Pings a pasted link so intake knows what's really there.
  lib/gemini.js    Gemini client + the model fallback chain + video + the tool loop.
  lib/degradation.js  When to stop asking for the best model, and how the UI says so.
  lib/verified-chat.js  The fact-check turn: both research tools, system prompt, frames.
  lib/search.js    Query → search provider → normalised, openable sources.
  lib/search-schema.js  JSON Schema for a query, and the Gemini tool declaration.
  lib/page-find.js Ctrl+F by meaning: fetch a retrieved page, rank its passages.
  lib/fuzzy.js     The lexical half of that ranking — IDF, trigrams, proximity.
  lib/embeddings.js  The semantic half. Optional; a failure degrades the ranking only.
  lib/find-schema.js  JSON Schema for a find, and both tool declarations together.
  lib/citations.js The ledger: every source the model may cite, numbered as retrieved.
  lib/citation-cleanup.js  Merge, dedupe, cap, renumber, and delete invented markers.
  lib/tiktok.js    TikTok link → embed page → CDN URL → the MP4 bytes.
  lib/instagram.js  Instagram link → post query → CDN URL → the MP4 bytes.
  lib/media-fetch.js  What both of those share: deadline, host allowlist, capped read.
  lib/link-probe.js  Follow a pasted link, headers only — and the vetting that makes
                   fetching a user-named host safe to do at all.
  lib/article.js   A pasted link that isn't a video: follow it, pull its text out, and
                   quote it to the model as the material being checked.
  lib/resolve-hint.js  Carries intake's resolve to the fact-check so it isn't run twice,
                   and the vetting that makes accepting it from the browser safe.
  lib/browser-resolve.js  When a resolve is throttled or refused, ask the browser worker
                   for a second opinion. Optional; off unless BROWSER_WORKER_URL is set.
  lib/gemini-files.js  Resumable upload, for clips too large to send inline.
  lib/guard.js     Passphrase check, rate limits, request validation.
  lib/static.js    Request path → file on disk, with the containment rule.
  bin/search.mjs   Run one search from the terminal, through the same code path.
  bin/find.mjs     Run one in-page find from the terminal, with both scores shown.
  server.js        Local dev server. Mounts the same handlers Vercel runs.
  test.js          Unit tests. No network, no dependencies.
  test-search.js   Tests for search, the schema, and the turn end to end.
  test-find.js     Tests for the in-page find and the fuzzy matching under it.
  test-cleanup.js  Tests for citation cleanup — what it removes, and what it must not.
  test-probe.js    Tests for the intake ping and its address vetting.
  test-hint.js     Tests for the resolve hint the browser carries to the check.
  test-article.js  Tests for reading a pasted page — vetting, refusals, and fencing.
  test-browser-resolve.js  Tests for the browser-worker tier: which failures escalate,
                   which deliberately don't, and what happens when it can't help.
```

The browser worker itself lives outside this directory, in [`worker/`](../worker/), because
it needs Playwright and `web/` has no dependencies and no build step. It is optional — with
`BROWSER_WORKER_URL` unset, nothing here reaches for it.

## How a pasted video reaches the model

Three shapes, in order of what they cost us:

| Platform | How it reaches Gemini | Credential |
| --- | --- | --- |
| YouTube | the watch URL, as a `file_data` part — Gemini fetches and watches it | none |
| TikTok | `/embed/v2/<id>` → `__FRONTITY_CONNECT_STATE__` → CDN MP4 → bytes in the request | none |
| TikTok photo mode | the same page → `imagePostInfo.displayImages[]` → CDN JPEGs → one part per slide | none |
| Instagram | `/graphql/query` by shortcode → `video_url` → CDN MP4 → bytes in the request | none |
| Instagram images | the same query → each `XDTGraphImage`'s `display_url` → CDN JPEGs → one part per slide | none |

Only YouTube is fetched by Gemini itself. The rest arrive as bytes: inline base64 up
to ~14 MB, and through the Files API past that (`lib/gemini-files.js`), which is also why
they are the slowest requests the app makes and why the cap is two posts per message.

**Photo posts and carousels.** A TikTok `/photo/` link used to not register as a link at
all, and an Instagram carousel of stills was declined by name. That threw away the most
claim-dense format either platform has: a screenshot dump or a text-card slideshow puts its
whole argument in the images, where a video pads it with B-roll. Both resolve now, and the
slides reach the model as one image part each, in post order, labelled as an ordered set so
it doesn't read them as unrelated pictures — or as frames of a video it watched.

Three things worth knowing about the shape of that:

- **`/photo/` never told you what a post was.** TikTok serves `/video/<id>` and
  `/photo/<id>` interchangeably for the same post — `/@memezar/photo/7449708266168274208`
  is an ordinary video — so the old path check was costing real videos too. Only the
  payload decides.
- **Twelve slides, then a note.** Both platforms allow 35. Every slide is an image Gemini is
  billed to read, so the rest are named in the prompt rather than attached, and the model is
  told the post continues past what it can see.
- **A slide that fails is skipped, not fatal.** Eleven of twelve still says most of what a
  slideshow says; half a video says nothing. Only an empty set is an error.

**Instagram, specifically.** `docs/SPIKE-instagram.md` originally shelved this platform:
the legacy oEmbed endpoint is dead, the Graph replacement needs an App-Review-gated Meta
token, and the embed iframe carries no media — re-checked on 2026-08-02, it still serves a
React shell with nothing in it, and `/api/v1/media/<id>/info/` redirects to login.

What works without any of that is the query instagram.com's own web client runs: a POST to
`/graphql/query` with a `doc_id` and `{"shortcode": …}`, carrying a CSRF token taken from a
plain GET of the homepage. It returns the post — including `video_url`, a signed CDN link
that then serves the MP4 to an anonymous request. Reels, video posts, IGTV and the video
slide of a mixed carousel all resolve; share links (`/share/…`) are followed first, because
their code is not the post's shortcode.

Two things that will eventually break, and what they look like when they do:

- **`doc_id` is a rotating server-side query hash, not an API.** When Instagram moves it,
  the query answers `{"errors":[…],"data":null}` and the thrown message says to set
  `INSTAGRAM_DOC_ID` — a comma-separated list, tried in order, so a replacement can be
  rolled out without a deploy.
- **Anonymous traffic is rate-limited**, harder from datacenter IPs than from a laptop. A
  401 or 429 is now retried with backoff and a fresh CSRF token before it is reported at
  all — throttling is Instagram's normal response to a datacenter IP, not an incident, and
  taking the first refusal as final was costing reels that a second ask would have
  returned. The token itself is seeded once per 10 minutes and shared by concurrent
  resolves rather than fetched per request; the seed runs under its own deadline, so one
  caller hanging up doesn't abort the load every other concurrent resolve is waiting on.

Both failure modes end the same way for the user: no video reaches the model, a bracketed
note explains why, and the answer proceeds from what the post itself said.

**When the download fails but the post resolved.** The resolve step returns the caption,
the creator and the duration — so a clip whose CDN link expired between resolving and
downloading is described rather than dropped, and the note carries both the caption and the
reason the video is missing. On short-form political content the caption is frequently the
claim and the video is B-roll, which makes this a much better answer than "that link
couldn't be attached". An expired signed URL (`403` from the CDN) is repaired first, by
resolving the post again for a freshly signed one and downloading from that; the fallback
is only reached if that fails too.

**A refused resolve can get a second opinion from a browser.** Optional, off unless
`BROWSER_WORKER_URL` is set, and only ever reached after something has already failed. The
resolvers above are anonymous HTTP, which is what makes a reel cost what a TikTok costs —
and also why they get `429`'d, refused outright, or left behind when a payload shape moves.
None of those are facts about the post: it is public, and a browser can see it. So a worker
service running a real Chromium loads the post, watches for the media request the player
makes, and reports the URL it saw.

The insight is the session, not the recording. Cookies, a `Referer` and an executed JS
runtime are what get you *to* the media URL; the URL itself is signed rather than
cookie-bound, so the bytes still come down `web/`'s normal path at network speed, through
the same host allowlist, size cap and retry policy as any clip. The worker is never on the
byte path, and its answer is validated by `validateHint` — the same function that vets a
resolve handed back by the browser, for the same reason.

Which failures escalate is a closed set (`ESCALATED_KINDS`): `rateLimited`, `forbidden`,
`malformed`, `upstream`. A private or deleted post does not — a browser gets the same
nothing, more slowly — nor does a link that was never a post, nor an expired signed URL,
which is already repaired more cheaply by resolving again over HTTP. A kind that isn't in
the set never spends browser time, so a new failure mode has to be classified deliberately
before it can start costing seconds.

It rescues **video posts only**. A photo post is an ordered set rather than one URL, and the
worker reads media off the network in fetch order — guessing a slide sequence out of that
would produce a plausible-looking wrong order, which changes what the model thinks the post
says. So a throttled carousel keeps its original error.

It is bounded twice, because it runs while the user is waiting: the call is capped at 20
seconds *and* at whatever is left of the clip budget, and below three seconds remaining it
is not attempted at all. If the worker can't help, the platform's own error is what the user
sees — never "the browser worker returned 502", which would report our infrastructure
instead of their link.

This is **not** the screen-capture path in `Sources/SeerCapture`, which is dead and stays
dead: that one is real-time by construction, needs a visible surface to record, and hits
ReplayKit's silent-audio bug. This resolves; it does not record. See
[worker/README.md](../worker/README.md).

**Clips are kept between turns.** Every turn replays the whole conversation, and each clip
is re-attached at its first mention, so before this a thread about one reel re-resolved and
re-downloaded it on every follow-up question. A downloaded clip is now held for ten minutes
in process memory, bounded by `CLIP_CACHE_MAX_BYTES` and evicted oldest-first. The whole
clip stage also runs under a two-minute budget: past it, the remaining links become notes
rather than holding the request open.

## How a pasted page reaches the model

Anything that is not a TikTok, YouTube or Instagram link is a **page**, and a page is now a
first-class thing to check rather than a link the app talked you out of. Intake pings it
(`/api/probe-link`), and if something readable answers, the check runs; `/api/chat` then
fetches the page server-side, extracts its text with the same `htmlToText` the in-page find
uses, and quotes it into the prompt between `<<<PAGE` markers as the material under
examination — the exact role a video plays for a clip.

What that changes: before this, a pasted article reached the model as a bare URL it could
not open, so it searched for the *headline* and checked whatever came back. Now it checks
what the page actually says.

Four rules hold that together, and each of them is a thing that goes wrong without it:

- **The page is the subject, never a source.** It gets no citation number and the system
  prompt says it may not be cited. A page is not evidence for its own claims; the figures
  in it still need a source `web_search` retrieved.
- **Its text is fenced and disclaimed.** Everything between the markers was written by
  whoever owns that domain, some of whom write for models. The prompt says in as many words
  that an instruction found inside the fence is part of what is being checked — and that a
  page trying to steer its own fact-check is a finding worth reporting.
- **The fetch is vetted per hop.** This is the app fetching a host the user named and
  returning its *body*, which is a strictly bigger exposure than the header-only probe. So
  `lib/article.js` reuses the probe's vetting on every redirect: scheme allowlist, no
  credentials, no cookies, every hop's address re-resolved and refused if it is private, a
  hop cap, a deadline, a size cap, and a content-type allowlist that admits HTML and plain
  text only.
- **Bounded like a clip is.** Two pages per request, 12,000 characters each, cut at the end
  with the model told it was cut. The text is replayed on every turn the way a message is,
  so an uncapped long-read would be re-billed on every follow-up.

A page that will not open — a 404, a PDF, a paywall answering 403, a shell rendered by
JavaScript — is reported to the model as a bracketed note naming the reason, exactly as an
undownloadable clip is, and the turn proceeds from the link and the searches.

## Tests

```bash
npm test                              # unit tests, no network, no dependencies
```

`lib/gemini.js` mirrors the model chain in `Sources/SeerCore/Gemini/GeminiModel.swift` —
Flash 3.6, then 3.5, 3-preview, 2.5, 2.0. Model IDs get retired and key tiers differ;
pinning one ID breaks in the field. See the comments in the Swift file for the full
reasoning.

## Graceful degradation

The chain steps down on its own and steps back up on its own. Five things move it:

| Trigger | What happens | What the pill shows |
| --- | --- | --- |
| The model isn't available to this key (404/403) | Try the next model | `… · fallback` |
| The model is out of quota (429, or `RESOURCE_EXHAUSTED`) | Try the next model, and **remember** — the exhausted one is skipped outright until its cooldown ends | `… · quota` |
| The model is overloaded (503, or a 500 that says so) | Try the next model, and remember for 20s. If *every* model is full, wait and sweep the chain twice more — 0.8s, then 1.6s | `… · busy` |
| The client is near its daily message cap | Start one model down the chain, to make the remaining messages go further | `… · conserving` |
| The conversation is too long for the model | Try the next model; if none accept, say "start a new chat" rather than relaying token arithmetic | `… · long chat` |

Two details worth knowing. Quota in Gemini is metered **per model**, which is why a 429 is
a reason to try the next one rather than to fail the request — and why the 429 is worth
remembering: the next request would otherwise re-learn it at the cost of a round trip, for
as long as the quota window lasts. Cooldowns come from the server's own `Retry-After` or
`retryDelay` where it sends one, are capped at 15 minutes, and expire by themselves — there
is no flag anyone has to remember to flip back.

**Capacity is per model too**, and for the same reason a 503 is a reason to try the next
one rather than to fail the turn. It used to fail the turn: 5xx was treated as terminal on
the grounds that walking the chain through an outage only adds load, which is right for an
outage and wrong for the far more common case — the newest, most popular model in the chain
being full for a few seconds while the ones below it have room. The two are told apart by
what the body says, so a bare `500 Internal error` is still terminal and a 503 is not. Its
cooldown is 20 seconds rather than a minute, because capacity comes back fast and a model
held out after it recovered is an answer quietly taken on a worse model for nothing.

When every model is full, that is worth sitting out rather than handing back: the chain is
swept twice more with a short doubling wait, and the wait is skipped entirely if the turn's
deadline leaves no room to use an answer. Only then does it fail — saying that Google is
turning requests away and that the key and the app are not at fault, which the old *Gemini
is having trouble (HTTP 503)* did not.

The registry lives in `lib/degradation.js` and is process memory, with the same caveat as
the rate limiter in `lib/guard.js`: under `node server.js` it is one shared registry; on
Vercel it is per function instance, so a cold start re-learns from the first 429. That is
one wasted round trip, which is exactly where this started.

Separately, an answer that runs into `MAX_OUTPUT_TOKENS` is labelled instead of being
shipped as if it were finished — a fact-check cut off mid-sentence reads like a verdict,
and the sentence it was cut off in is usually the one carrying the citation.

A truncated answer also keeps the ledger's own numbering rather than being renumbered to
what it cited, and its full source list is printed underneath: the reader is being asked to
make their own judgement about a reply that stops mid-thought, and the sources it never got
as far as citing are still what it was working from.

**`MAX_OUTPUT_TOKENS` alone does not fix truncation, and raising it repeatedly is chasing
the wrong number.** On a thinking model this cap covers the reasoning as well as the
reply — one shared pool — and the models at the head of the chain think before they
search and again before they answer. A bigger pool just gives the reasoning more room to
spend; it does not reserve any of it for what the reader sees.

`THINKING_BUDGET_TOKENS` is what actually does that, via Gemini's
`thinkingConfig.thinkingBudget`. Capping the reasoning specifically guarantees
`MAX_OUTPUT_TOKENS − THINKING_BUDGET_TOKENS` as a floor for the visible answer — the
default, 4096 out of a 16384 total, aims to leave three-quarters of the budget for what
gets shown. It is sent only to models believed to support it (the "3" series and 2.5, not
`gemini-2.0-flash`), matched on the version number so a new preview ID doesn't need a code
change; if that guess is wrong for some future model, Gemini's "unknown field" 400 is
treated the same as an unsupported model — fall through to the next one, not fail the
turn. That guess has not been checked against a live thinking-capable response. Set
`THINKING_BUDGET_TOKENS=0` to turn the field off entirely rather than requesting a zero
budget, which not every model may accept.

## Every claim carries a citation

The assistant has two tools — `web_search` to find pages and `find_in_page` to read one —
and one rule enforced in code: **it may not assert a fact it did not retrieve.**

The system prompt (`lib/verified-chat.js`) states plainly that everything factual the
model says in a turn was found with those tools during that turn, that its training data is
not a source and cannot be cited, and that every sentence carrying a verdict, a number, a
date or an attribution must end with a marker — `[3]` — for a source it actually retrieved.
It also says the part that keeps the rule honest: **not every message is a fact-check**, and
a greeting or a question about what the app does wants a plain reply and no tool call.

Three things back that up, and all three are exact — none of them guesses at what a sentence
is doing:

1. **The tools are the only door.** Each result comes back numbered by a ledger, and those
   numbers are the entire set of citations the model is permitted to write. Reading a page
   creates no new number: `find_in_page` may only open a URL the ledger already holds, and
   its passages come back under that page's existing marker.
2. **A marker the ledger cannot resolve is deleted** before the answer is sent —
   `lib/citation-cleanup.js`. An invented `[9]` names a page that was never retrieved, so it
   would render as a citation the reader cannot open, and that is the worst thing this app
   can produce. The sentence keeps any real markers it had; one whose *only* marker was
   invented comes out uncited, which is what it always was.
3. **The links are rendered by the app, from the ledger.** The model is told not to write a
   source list. One the model types is one it can invent; links built from retrieved results
   cannot name a page that was never fetched. They travel *with* the answer — every `[3]`
   is a link where it stands — and the list under the answer is only a fallback. See "Links
   inline, list as a fallback".

Alongside that, every search and every page read is shown as it happens, so the reader
watches the evidence being gathered rather than being handed a verdict and asked to trust
the process behind it.

### The audit that used to be here

There was a fourth item: the finished answer was split into sentences, each was guessed to
be a claim or not, and an answer with an unmarked claim in it was **withdrawn from the
screen**, rewritten by the model, and labelled `Unverified` if the rewrite failed too.

It is gone, and the reason is the guess. "Which sentences are claims?" was answered with
verdict vocabulary, attribution verbs, digits and capitalised words, and those are not
exclusive to claims. *I'll tell you whether it's accurate* has the verdict words. *Send me a
TikTok link* has the proper noun. So typing `hi` produced a reply that streamed in, vanished
mid-read, came back rewritten, and arrived under a banner announcing that no search had been
run — on a greeting. Every narrowing of the heuristic was walked around by the model's next
wording, because no regex tells an offer to check something from a ruling on it.

Deleting it is not a weakening so much as a change of shape. The exact half — *is this
marker a source we retrieved?* — stayed, and now removes the bad marker rather than
reporting it, which reaches the outcome the banner was for without publishing the
fabrication first. The guessing half is what a reader does, and the app now gives them what
they need to do it: the searches as they run, the passages that were read, and the sources
under the answer.

### Saying what it is doing

Most of a video fact-check produces no text at all: fetching the clip, waiting on a model
that has to watch it before it can speak, the model thinking before its first search. Those
stretches used to be reported as nothing — an empty bubble with a caret, which looks the
same whether the request is working, stuck, or already dead.

The server now emits `{type: "stage", …}` at each of those transitions and the browser
shows it with a running clock: *Fetching the video · 6s*, *Watching the video · 24s*,
*Working out what to check*, *Rewriting — the first answer failed the citation check*. The
clock is the part that matters — "Watching the video" is reassuring at five seconds and
ambiguous at forty, and a number lets the reader tell slow from stuck without guessing.

The model's thinking is announced but never shown. Its content is withheld on purpose —
musings in the middle of a fact-check read as findings — but withholding it *silently* is
what made a model that thinks for thirty seconds look like a model doing nothing.

### Looking everything up at once

A fact-check that searches one claim, reads the result, searches the next claim and reads
that one spends the reader's time in series: every round is a fresh model call that
re-sends the whole conversation — the video included — and waits for the model to read it
again before it can say anything. Four claims that way is four waits for one answer.

So the turn is shaped as two passes, and both the system prompt and the tool description
say so: list every claim first and issue **all** the searches in one turn, then read the
results and write the verdict. The runtime is what makes that pay off:

- **The calls in a round are dispatched together** and awaited in call order, so four
  searches cost one search's worth of waiting and the ledger still numbers them in the
  order the model asked.
- **A repeated query is served from the turn's cache.** Same query, no second round trip —
  the results would be identical, so the only thing a repeat buys is the wait.
- **The searches are announced before they return** (`{type: "searching"}`), so the browser
  shows what is being looked up while it is being looked up, instead of a still bubble
  followed by every chip at once.
- **The video is attached exactly once per turn, not once per round.** A rewrite re-sent
  the YouTube link as a `file_data` part, which made Gemini fetch and watch the whole clip
  again to correct a citation — tens of seconds, on the requests already closest to their
  deadline. Later rounds get a note saying the clip was watched earlier instead. The TikTok
  path was already guarded; the YouTube one was not, because the attachment happens in
  `toGeminiContents` rather than in the code that does the fetching.
- **Three rounds of tool calls, shared between searching and reading, then the tools are
  withdrawn.** A model that asks anyway is told once, in the conversation, to answer from
  what it has; if it asks again the turn ends. Withdrawing a declaration is a hint, and a hint is not a ceiling — without the hard
  stop, a model that keeps calling is an unbounded number of model calls the reader is
  sitting through.

Nothing here demands a marker on connective tissue ("here's what I found"), on quoted
descriptions of the claim under review — the video is the subject, not evidence — or on code
and tables. That used to be a list of exemptions carved out of an auditor; it is now simply
what the prompt asks for, which is the same outcome without a regex deciding which sentence
is which.

### Ctrl+F, by meaning as well as by wording

A search result is a *page*, described by a snippet an engine wrote for its own purposes.
Verifying a claim from snippets is verifying it from advertising copy: the snippet says the
study found an increase, and the page says the increase was inside the margin of error. The
model then either cites the snippet and is subtly wrong, or burns a round firing three more
searches hoping for a better snippet — and both of those are how an over-cited or uncited
answer happens.

So `find_in_page` opens the page. It takes a URL the ledger already holds and a plain-words
description of what is wanted, and returns the passages that address it, quoted exactly,
under the number that page already has. One find on the right source beats three more
searches, and it lets the model quote the source instead of paraphrasing a snippet.

The ranking is hybrid because the two halves fail in opposite directions:

- **Fuzzy lexical** (`lib/fuzzy.js`) finds the number, the name and the date. Token overlap
  weighted by IDF, so a word in every passage cannot decide the ranking; trigram similarity
  with a shared-stem floor, so *vaccine* matches *vaccination*; thousands separators folded,
  so `1,200,000` matches `1200000`; and a proximity bonus, so matches in one sentence beat
  the same words scattered down the page. A verbatim phrase hit outranks every paraphrase,
  which is what stops three half-matches beating the passage that prints the figure.
  Every comparison is made once per *distinct word on the page* rather than once per
  occurrence of it (`fuzzyIndex`), which is the same arithmetic and the same scores for
  about a twentieth of the time — it was ~600ms of blocked event loop per find on a long
  page, and nothing else in the process moves while it runs.
- **Semantic** (`lib/embeddings.js`) finds the passage that means the right thing in the
  wrong words — *coverage declined* for a claim about *rates falling*. It is **optional**:
  every failure path returns "no vectors", the find drops to lexical scoring alone, and the
  model is told which ranking it got, because "not on this page" from half a ranking
  deserves less confidence than from both. Only the lexically plausible passages are
  embedded, capped and timed out — and **once per page, not once per find**. A passage's
  vector is a fact about the passage; only the query's depends on the query. So coming back
  to a good source, which is the behaviour the whole tool exists to encourage, no longer
  re-buys sixty embeddings to ask it a second question. The vectors are pinned to the model
  that produced them, since a cosine across two embedding spaces is a number that looks like
  a score and means nothing. The embedding chain also remembers a model that just refused,
  for a minute — a key with no entitlement to the preferred model used to buy that refusal
  ahead of every single find, at the far end of a 10-second timeout when it hung rather
  than answering.

Absence is a first-class result. "Nothing on this page matches" comes back as a finding
about the page — *do not cite it for that claim* — not as an error, because a fact-checker
that reads a failed lookup as evidence of absence is the worst outcome available here.

Two bugs found by pointing `bin/find.mjs` at a live Wikipedia page, both now pinned by
tests. Comments were stripped before elements, and Wikipedia's embedded JSON contains the
characters `<!--`, so the strip ran to the next `-->` and took a `</script>` with it —
kilobytes of raw wikitext then ranked as the fourth-best passage. And a page's own footnote
markers, `[ 108 ]`, collide with this app's citation syntax: the model is told to quote
verbatim, so quoting one would put `[108]` in the answer — where cleanup reads it as a
citation of a source that does not exist and deletes it, taking a chunk out of the quotation
on the way. The page's footnote numbers are stripped before ranking; the citation is the
page.

### Cleaning up the citations

Nothing asks the model to cite *sparingly*, and nothing should: a rule that punished extra
markers would teach it to use fewer, and under-citing is by far the worse failure. So the
answers arrive reading like this:

    The agency revised the figure down to 4.2% [1][2][3]. That was published in March
    [1][3][2], after the review closed [2][2].

Every marker is real. Collectively they are noise: they push the eye off the sentence, they
imply three independent confirmations where there is one page found by three queries, and
they make the one marker that adds a second source indistinguishable from the two that
don't. `lib/citation-cleanup.js` does what a copy editor does, in this order:

1. **Merge what is secretly one page.** Two searches returning the same article by two
   spellings of its URL — `?utm_source=`, an AMP path, a trailing slash, a fragment — are
   numbered separately by the ledger, and a sentence citing both reads as corroboration.
   Canonicalised and merged to the lower number. Meaningful query strings are kept: `?id=`
   on a docket is the page's identity, and merging those would fuse two documents into one
   citation.
2. **Drop what repeats, per sentence.** A number repeated in a *later* sentence is not
   redundant — that sentence needs its own source — so the scope is one sentence, and a list
   item is its own sentence.
3. **Cap a runaway stack** at three, the point past which extra markers are not
   corroboration but everything the model read attached to the sentence it read it for.
4. **Renumber** to what the answer actually cites, in the order it cites them, so the
   markers ascend as they are read and there are no gaps left by sources gathered and not
   used. It is a rename applied to the text and the link list from one mapping, so a marker
   cannot end up pointing at a different page than it did a moment ago.
5. **Strip a source list the model typed anyway**, but only when the tail is mostly entries
   — a heading that goes on to say something is not a bibliography, and cutting an answer
   short to tidy it would be far worse than leaving a list in.

Three rules hold over all of it. It **never invents a marker, and never takes the last real
one off a sentence** — every removal is either a marker another marker on the same sentence
makes redundant, or one that pointed at nothing to begin with. It **only ever changes
markers**: the prose comes out byte-identical apart from them and the whitespace a removed
marker leaves behind. And an answer that was **truncated or died mid-stream is not
renumbered** — its full source list is printed, so the list and the text have to agree about
which page is `[2]`.

Code is excluded from every pass, fenced and inline: `rows[1]` in a sample is an array
index, and this is the one layer that rewrites the answer rather than only reading it.

### Links inline, list as a fallback

The numbered list under every answer was the right design when a marker was inert text and
the list was the only way to resolve one. Markers are links now — `linkCitations` in
`public/app.js` turns each `[3]` into a link to source 3, from the first token of the
stream, which is why the link rows are sent as the searches land rather than at the end. So
printing the list underneath as well repeats the whole evidence trail in the form nobody
reads, and its length is what made a two-source answer look like a literature review.

The links are still saved for every answer and stored with the message: they are what
resolves the markers, and an answer whose links vanished on reload could not be checked.
What changed is that *printing* them is now conditional, on exactly the cases where the
inline links cannot carry the evidence alone:

- **While the searches are still landing** — there is no answer yet, so there are no inline
  markers to be links, and this is the reader's only view of the evidence during the longest
  silence in the turn.
- **The answer cites nothing** — it never got past searching, or was cut off before the
  first marker. Those pages were fetched on the reader's behalf and must not vanish because
  no marker happens to point at them.
- **The answer is incomplete** — it hit the token cap, or its stream died. Whenever the
  reader is being asked to make their own judgement about a reply that stops mid-thought,
  they get everything that was retrieved, in the ledger's own numbering so the list and the
  text agree.

A passage the page reader pulled off a source rides along with its link, so the fallback
list shows the sentence the citation rests on rather than a row of domain names.

### Finding inside a page from the terminal

```bash
npm run find -- --url https://www.cdc.gov/measles/cases.html \
                --find "how many cases were reported in 2026"
npm run find -- --url <url> --find "…" --show-scores   # both halves of every score
npm run find -- --url <url> --find "…" --lexical       # no embeddings, as a keyless deploy runs
npm run find -- --url <url> --passages                 # what the splitter produced
```

A ranking is the hardest kind of bug to see from a chat answer: when a fact-check misses a
figure that is plainly on the page, the fetch, the splitter, the lexical floor and a quietly
unavailable semantic half all look identical from outside. `--show-scores` separates them.

### Searching from the terminal

The same validator, providers and numbering the model uses, without a browser or a chat:

```bash
npm run search -- --claim "Measles cases tripled in 2026" --query "measles cases 2026 CDC"
npm run search -- --json '{"claim":"…","query":"…","site":"cdc.gov","freshness":"month"}'
npm run search -- --schema          # the JSON Schema a query must satisfy
npm run search -- --schema --tool   # the same thing as Gemini sees it
```

One implementation, so a citation that looks wrong in a chat answer can be reproduced
exactly rather than approximately.

### The query schema

`lib/search-schema.js` holds one JSON Schema, converted into Gemini's function-declaration
dialect for the model and enforced by a hand-written validator on the way back in. The
model cannot invent an argument, ask for fifty results, or pass a URL where a domain
belongs; a bad call comes back as a message it can act on rather than a silently corrected
query. Fields: `query`, `claim`, `freshness`, `site`, `max_results`.

`claim` is required, and that is the load-bearing decision. A fact-checker that searches
for *topics* retrieves sources that are about the right subject and support nothing in
particular. Naming the specific claim makes each search an act of verification and gives
the ledger something to file each source against.

### Which search engine

Whichever one is configured — Brave, Tavily, Serper, or Google Programmable Search — with
DuckDuckGo's HTML endpoint as a keyless fallback so the app works before any account
exists. That fallback is best-effort and says so: DuckDuckGo answers a request it doesn't
like with **HTTP 202 and its own homepage**, which is why the parser treats "no result
markup" as an error rather than as an empty result. Telling the model a claim is
unsupported when nothing was actually searched is the one failure this system cannot
tolerate. Set a key before anyone relies on it — see `.env.example`.

Key names are matched **case-insensitively**, so `Tavily_API_key` works as well as
`TAVILY_API_KEY`. That is not tidiness: environment variables are case-sensitive, a key
the app cannot see produces no error, and the resulting silent fall-through to DuckDuckGo
looks like "search is broken" rather than "the key wasn't picked up". For the same reason
`npm run dev` prints the provider it settled on at boot:

```
  search     tavily (key loaded)
  search     duckduckgo — keyless fallback, blocked often. Set a key: see web/.env.example
```

## What keeps a request bounded

- **Video attachments are sent once each.** A YouTube link becomes a `file_data` part at
  its first mention only. Re-attaching it — which happens on every turn of a long thread
  about one clip — makes Gemini ingest the same video repeatedly in a single request and
  bill for each. Assistant turns never carry one. For a TikTok or Instagram clip the bill
  is larger still, because the bytes are in the request body rather than a URL Gemini
  fetches itself.
- **At most two attached clips per request**, counted across platforms — the cost being
  capped is bytes moved in one request, and Gemini does not care which app they came from.
  Ten pasted links would otherwise be ten downloads, ten base64 copies and possibly ten
  uploads. Links past the cap get a note in the prompt rather than silence, so the model
  can say why it isn't discussing them.
- **A 48 MB ceiling on a clip, checked as it downloads.** Refused from `content-length`
  where the CDN declares one, and abandoned mid-stream where it doesn't — a serverless
  function buffers the whole file and then base64-encodes a copy, so the real cost is
  about double.
- **Media is fetched only from the platform's own CDN.** The media URL comes out of a
  third party's JSON blob; without the host allowlists in `lib/tiktok.js` and
  `lib/instagram.js` the endpoint would fetch whatever that blob named, which is a request
  proxy pointed at our own network and reachable by anyone who can paste a link.
- **A 120s stall timeout**, reset by every chunk received, so a stream that goes quiet
  mid-answer is cut loose rather than holding the request — and the function instance
  behind it — indefinitely. There is deliberately no deadline on the *first* response:
  waiting for headers is unbounded unless a caller passes `requestTimeoutMs`, so an
  upstream that accepts a connection and never answers is bounded only by the browser
  disconnecting or by the platform's own function timeout.
- **A keep-alive every 15s.** Gemini's first token on a video it has to watch can take a
  while, and proxies close silent connections. Sent as an SSE comment, so the client's
  frame parser ignores it.
- **An invalid key is terminal.** Gemini reports it as HTTP 400 / `API_KEY_INVALID`, not
  401 — so it is matched on the message, not the status, and never falls through to the
  next model with the same dead credential.
- **At most four rounds of tool calls per message.** Each round is a model call plus its
  searches, so the cap bounds latency and spend at once. Past it the tools are *withdrawn*
  rather than refused — a model told not to use a tool it can still see will often try
  anyway; a model with no tool declared answers with what it has.
- **The answer is never regenerated.** There is no repair round: a turn is one pass, so a
  message costs what its tool rounds cost and no more. The old citation audit could double
  that — a full second answer, for a verdict the reader had already watched arrive.
- **A 15s ceiling on each search**, independent of the Gemini timeouts. A hung search
  otherwise holds the whole chat request open behind it.
- **Replies are capped in tokens, not just requests in messages.** Every other cap in
  `guard.js` bounds input; `MAX_OUTPUT_TOKENS` (default 4096) bounds the one thing that
  wasn't bounded at all — a single reply could otherwise run until the model stopped on
  its own, and output tokens are the expensive side of the meter. Sent as Gemini's
  `maxOutputTokens`, which arrives as `finishReason: "MAX_TOKENS"` if hit — the same
  finish reason `parseSSE` already treats as a clean stream end, not an error.

## Notes

- **The model's turn is echoed back verbatim, signatures and all.** Thinking models
  attach an opaque `thoughtSignature` to the parts they emit — `functionCall` parts
  especially — and it has to travel back on the part it arrived on when that turn is
  replayed. Rebuilding a call from its name and arguments drops it, and Gemini answers
  that with a warning and worse tool use rather than an error: the model is asked to
  continue reasoning whose thread it can no longer pick up. `ModelTurn` in `lib/gemini.js`
  keeps parts in arrival order and merges two only when both are plain text with no
  signature between them.
- **Thinking summaries are echoed but not shown.** A `thought: true` part is the model's
  working, not its answer; streaming it to the reader would put the model's musings in the
  middle of a fact-check.
- Conversations live in `localStorage`, per browser. Clearing site data clears them.
  Nothing is stored server-side.
- Streaming uses SSE over `fetch`, not `EventSource`, because the request is a POST.
- Stop cancels the upstream request, so a stopped answer stops costing tokens.
