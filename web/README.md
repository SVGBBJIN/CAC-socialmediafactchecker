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
(10s on Hobby), and a function killed mid-flight looks to the user like the answer simply
stopped. Raise it under **Settings → Functions → Max Duration** — 300s is the ceiling on
Pro. It is deliberately not set in `vercel.json`, because that file uses the legacy
`builds` key, which `functions` cannot be combined with; the project setting is the one
that always applies. YouTube has the same exposure and always has — Gemini watching a
video takes tens of seconds — which is what the 15s keep-alive below is for.

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
  lib/gemini.js    Gemini client + the model fallback chain + video attachment.
  lib/tiktok.js    TikTok link → embed page → CDN URL → the MP4 bytes.
  lib/gemini-files.js  Resumable upload, for clips too large to send inline.
  lib/guard.js     Passphrase check, rate limits, request validation.
  lib/static.js    Request path → file on disk, with the containment rule.
  server.js        Local dev server. Mounts the same handlers Vercel runs.
  test.js          Unit tests. No network, no dependencies.
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
Flash 3.6, then 3.5, 3-preview, 2.5, 2.0 — and falls through on availability errors
(404/403) only. Model IDs get retired and key tiers differ; pinning one ID breaks in the
field. See the comments in the Swift file for the full reasoning.

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
- **Two timeouts.** 30s for response headers, and a 120s stall timeout that is reset by
  every chunk received. Without them a connection that opens and then goes quiet holds
  the request, and the function instance behind it, indefinitely.
- **A keep-alive every 15s.** Gemini's first token on a video it has to watch can take a
  while, and proxies close silent connections. Sent as an SSE comment, so the client's
  frame parser ignores it.
- **An invalid key is terminal.** Gemini reports it as HTTP 400 / `API_KEY_INVALID`, not
  401 — so it is matched on the message, not the status, and never falls through to the
  next model with the same dead credential.
- **Replies are capped in tokens, not just requests in messages.** Every other cap in
  `guard.js` bounds input; `MAX_OUTPUT_TOKENS` (default 4096) bounds the one thing that
  wasn't bounded at all — a single reply could otherwise run until the model stopped on
  its own, and output tokens are the expensive side of the meter. Sent as Gemini's
  `maxOutputTokens`, which arrives as `finishReason: "MAX_TOKENS"` if hit — the same
  finish reason `parseSSE` already treats as a clean stream end, not an error.

## Notes

- Conversations live in `localStorage`, per browser. Clearing site data clears them.
  Nothing is stored server-side.
- Streaming uses SSE over `fetch`, not `EventSource`, because the request is a POST.
- Stop cancels the upstream request, so a stopped answer stops costing tokens.
