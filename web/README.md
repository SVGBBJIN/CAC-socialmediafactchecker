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

1. **Root Directory → `web`** in the Vercel project settings. Without this it looks at the
   repo root, finds a Swift package, and builds nothing useful.
2. Add `GEMINI_API_KEY` and `APP_PASSWORD` as Environment Variables (all environments).
   Vercel stores them encrypted and injects them at runtime — same `process.env` reads,
   no code change. `.env.local` is for local use only and is not uploaded.
3. Deploy.

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
  lib/gemini.js    Gemini client + the model fallback chain.
  lib/guard.js     Passphrase check, rate limits, request validation.
  server.js        Local dev server. Mounts the same handlers Vercel runs.
```

`lib/gemini.js` mirrors the model chain in `Sources/SeerCore/Gemini/GeminiModel.swift` —
Flash 3.6, then 3.5, 3-preview, 2.5, 2.0 — and falls through on availability errors
(404/403) only. Model IDs get retired and key tiers differ; pinning one ID breaks in the
field. See the comments in the Swift file for the full reasoning.

## Notes

- Conversations live in `localStorage`, per browser. Clearing site data clears them.
  Nothing is stored server-side.
- Streaming uses SSE over `fetch`, not `EventSource`, because the request is a POST.
- Stop cancels the upstream request, so a stopped answer stops costing tokens.
