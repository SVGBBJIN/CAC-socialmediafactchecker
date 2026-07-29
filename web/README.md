# Seer Chat

A chat UI over Gemini. Static front end in `public/`, one server route in `api/` that
holds the key. No build step, no dependencies.

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

**Check the function timeout before trusting video on a deployment.** A TikTok link is the
slowest request this app makes: resolve the embed, download the clip, possibly upload it,
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

Then set `MAX_REQUEST_SECONDS` a few seconds *below* it. Every stage is logged with its
elapsed second (`[chat] 24s waiting (gemini-3.6-flash)`), so the runtime log names the step
a request died in.

That number is a deadline the turn tries to *land* inside, not just a tripwire:

- **Searching stops while there is still time to answer.** Tools are withdrawn once less
  than `ANSWER_RESERVE_MS` (25s) remains, so the turn ends on a verdict rather than on a
  search it had no time to use. The reader is told: *Out of time to search — answering with
  what I have.*
- **A rewrite that cannot finish is never started.** The citation repair round is a second
  complete answer, and it withdraws the first one to make room. Begun with less than
  `REPAIR_RESERVE_MS` (30s) left, it leaves the reader with less than shipping the flawed
  answer under its warning would have — so with less than that, the warning is what ships.
- **The hard abort remains the backstop**, for when those judgements are wrong. It ends the
  turn with an explanation and whatever text had arrived; left to the host, the same moment
  arrives as a killed process and a connection that stops mid-sentence with nothing to mark
  it.

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
  public/          Front end — index.html, app.js, style.css. No key, ever.
  api/chat.js      The only reader of GEMINI_API_KEY. Streams SSE to the browser.
  api/config.js    Booleans for the UI: is a passphrase needed, is a key present.
  lib/gemini.js    Gemini client + the model fallback chain + video + the tool loop.
  lib/degradation.js  When to stop asking for the best model, and how the UI says so.
  lib/verified-chat.js  The fact-check turn: search tool, system prompt, citation audit.
  lib/search.js    Query → search provider → normalised, openable sources.
  lib/search-schema.js  JSON Schema for a query, and the Gemini tool declaration.
  lib/citations.js The ledger, and the audit that decides if an answer may be shown.
  lib/tiktok.js    TikTok link → embed page → CDN URL → the MP4 bytes.
  lib/gemini-files.js  Resumable upload, for clips too large to send inline.
  lib/guard.js     Passphrase check, rate limits, request validation.
  lib/static.js    Request path → file on disk, with the containment rule.
  bin/search.mjs   Run one search from the terminal, through the same code path.
  server.js        Local dev server. Mounts the same handlers Vercel runs.
  test.js          Unit tests. No network, no dependencies.
  test-search.js   Tests for search, the schema, and the citation audit.
  test-ui.mjs      Browser tests for app.js. Opt-in — see below.
```

## Tests

```bash
npm test                              # unit tests, no network, no dependencies
npm install --no-save playwright      # only needed for the browser tests
npm run test:ui                       # drives the real UI in Chromium
```

`app.js` only runs in a browser, so retry behaviour, streaming and render batching can't
be reached from `test.js` — `test-ui.mjs` drives a real page against a stubbed chat
endpoint instead. Playwright is deliberately *not* a dependency of this package, so the
default `npm test` path stays dependency-free; `test:ui` exits with instructions if it
isn't installed.

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

Separately, an answer that runs into `MAX_OUTPUT_TOKENS` is now labelled instead of being
shipped as if it were finished — a fact-check cut off mid-sentence reads like a verdict,
and the sentence it was cut off in is usually the one carrying the citation.

## Every claim carries a citation

The assistant has one tool, `web_search`, and one rule enforced in code: **it may not
assert a fact it did not retrieve.**

The system prompt (`lib/verified-chat.js`) states plainly that everything factual the
model says in a turn was found with that tool during that turn, that its training data is
not a source and cannot be cited, and that every sentence carrying a verdict, a number, a
date or an attribution must end with a marker — `[3]` — for a source it actually
retrieved. Then the app checks, because a prompt is a request and this needs a guarantee:

1. **The tool is the only door.** Each result comes back numbered by a ledger, and those
   numbers are the entire set of citations the model is permitted to write.
2. **The finished answer is audited** against that ledger before it is allowed to stand —
   `lib/citations.js`. Three ways to fail: a checkable sentence with no marker, a marker
   for a source that does not exist, and a URL no search returned.
3. **A failed answer is withdrawn, not patched.** The model is told which sentences failed
   and made to write the whole thing again; the browser is told to clear what it has shown
   so a rejected answer never sits above its replacement. The rewrite round carries **no
   tools** — searching is over by then, and a round that goes looking again resets the
   answer under audit and can end the turn on a search instead of a verdict — so the
   repair prompt offers two ways out and no others: cite it, or delete the sentence.
4. **If the rewrite fails too, the answer is shown carrying a warning.** Suppressing it
   entirely would hide a failure the reader is better off seeing labelled. If the rewrite
   comes back *empty*, the withdrawn answer goes back up under that same warning: the
   screen was cleared for a replacement that never arrived, and sources over a blank space
   look like a broken app rather than a failed check.
5. **The bibliography is rendered by the app, from the ledger.** The model is told not to
   write one. A source list the model types is a source list it can invent; one built from
   retrieved results cannot contain a page that was never fetched.

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
- **Three rounds of searching, then the tools are withdrawn.** A model that asks anyway is
  told once, in the conversation, to answer from what it has; if it asks again the turn
  ends. Withdrawing a declaration is a hint, and a hint is not a ceiling — without the hard
  stop, a model that keeps calling is an unbounded number of model calls the reader is
  sitting through.

What is *not* audited, deliberately: connective tissue ("here's what I found"), quoted
descriptions of the claim under review — the video is the subject, not evidence — code
blocks, and tables. Demanding a marker on those teaches the model to sprinkle citations
where they mean nothing, which devalues the ones that carry weight.

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
  bill for each. Assistant turns never carry one. For TikTok the bill is larger still,
  because the bytes are in the request body rather than a URL Gemini fetches itself.
- **At most two TikTok clips per request.** Ten pasted links would otherwise be ten
  downloads, ten base64 copies and possibly ten uploads. Links past the cap get a note in
  the prompt rather than silence, so the model can say why it isn't discussing them.
- **A 48 MB ceiling on a clip, checked as it downloads.** Refused from `content-length`
  where the CDN declares one, and abandoned mid-stream where it doesn't — a serverless
  function buffers the whole file and then base64-encodes a copy, so the real cost is
  about double.
- **Media is fetched only from TikTok's own CDN.** The media URL comes out of a third
  party's JSON blob; without the host allowlist in `lib/tiktok.js` the endpoint would
  fetch whatever that blob named, which is a request proxy pointed at our own network and
  reachable by anyone who can paste a link.
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
- **One repair round, not a loop.** An answer that fails the citation audit twice is
  shown with a warning rather than regenerated again. Two failures are a signal that the
  evidence isn't there, and a retry loop over an expensive call is a worse answer to that
  than a labelled one.
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
