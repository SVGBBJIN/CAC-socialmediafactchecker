# design-sync notes — Trase

## Where the component package comes from

`web/` (the product) has no buildable component library of its own — it's vanilla
HTML/CSS/JS served statically, no bundler, no React. `web/design-system/` is a **new**
package created specifically for this sync: a React + TypeScript component library whose
markup, class names, and CSS were ported verbatim from `web/public/index.html` and
`web/public/app.js`'s render functions (`badgeHTML`, `sourcePillsHTML`, `claimPanesHTML`,
`renderLibrary`, the entry-bar/sidebar markup). It ships 8 components: `Sidebar`,
`LibraryItem`, `EntryBar`, `VerdictBadge`, `TimestampChip`, `SourcePills`, `ClaimCard`,
`Button`.

**This package is not part of `web/`'s request flow or tests** — it exists solely as the
design-sync source. If `web/public`'s markup/CSS changes, this package does not update
itself; re-sync by hand-porting the changed rules the same way this run did (see
`web/design-system/src/components/*.css`, each headed with a "ported from
web/public/index.html" comment naming its source).

## Target project

Re-adopted the existing **Trase Design System** project (`9310f352-c8b4-4404-9a33-59321721029b`)
rather than creating a new one — it already had this name and appeared to be a prior,
unrelated attempt at the same product's DS (different component set: MessageBubble,
ConversationListItem, Composer, SourceList, StageIndicator, Chip, CitationLink, Badge,
IconButton, StatusDot, Dialog — none of which match this run's 8 real-markup-derived
components). The user explicitly asked to re-adopt with a **hard overwrite** — nothing
from the prior project's content was preserved; this sync's `deletes` list covers every
remote path this build doesn't produce.

## Known render warns

- `[FONT_MISSING]` — "SF Pro Text" and "New York" are Apple system fonts (part of
  `--font-body`/`--font-display`'s stacks in `web/public/index.html`'s `:root`). They are
  proprietary OS fonts Apple does not license for web distribution, so there is nothing to
  ship via `extraFonts` — this is a legitimate accepted substitute, not a gap to chase.
  The token stacks already carry real fallbacks (`Georgia`, `"Times New Roman"`, `serif`
  for display; `system-ui`, `sans-serif` for body), so a non-Apple viewer already renders
  reasonably. Substitute accepted without a separate user prompt given the stacks were
  already built with this fallback in mind (ported directly from the product's own tokens,
  not invented for this sync).

## Preview scope

All 8 components got authored previews (2-4 exports each), not floor cards — the
component count was small enough (8, vs. the skill's usual 20-40 "core" scope) that
authoring everything was faster than picking a subset. All 8 graded `good` on the first
pass; no `needs-work` iterations.

`ClaimCard` and `EntryBar` needed `cardMode: "column"` overrides (both render full-width
in the product, so their stories overflowed a standard grid cell) — recorded in
`.design-sync/config.json` under `overrides`.

## Re-sync risks

- **The package is hand-authored, not generated from `web/`'s real DOM/CSS build** — there
  is no automated check that `web/design-system/src/**` still matches
  `web/public/index.html`/`app.js` if either changes. A future re-sync should diff the
  ported CSS blocks (search each component `.css` file's header comment for the exact
  `web/public/index.html` line range it was ported from) against current `index.html`
  before assuming the package is still accurate.
- Preview data (claim text, sources, library entries) in `.design-sync/previews/*.tsx` is
  invented-but-realistic content, not pulled from any fixture — nothing in `web/`'s test
  suite backs it.
- Only 8 components exist; this is a small, illustrative slice of the product's UI (no
  video pane, no action row/like-dislike, no passphrase dialog, no settings panel). Any of
  those could be added as new components in `web/design-system/src/components/` the same
  way, then re-synced.

## 2026-09-14 — pulled new animations back from the design project into the product

Direction reversed from every note above: this run read the **remote** Trase Design
System project and hand-ported what was new there into `web/public` (the real product),
then brought `web/design-system/src/**` back in step so it still mirrors the product —
the same re-sync workflow the "Re-sync risks" section above anticipated, just run for the
first time.

- **The project moved.** `9310f352-c8b4-4404-9a33-59321721029b` (recorded above and in
  the old `.design-sync/config.json`) now 404s. The current "TRASE Design System" project
  is `87a24e5a-ecbf-4bfa-9a0e-bb61ca5fab17` — `config.json` is updated to it. Unclear why
  the id changed; if a future sync finds this one gone too, re-resolve by name via
  `list_projects` rather than assuming the stored id is still good.
- **What came in:** `Matrix` (a static brand HUD — scan rings + four orbiting
  "Sources/Context/Facts/Clarity" pills, used for the empty/landing state) and
  `MatrixLoader` (the same ring/tick/core language, animated three different ways per
  pipeline stage — `watching`/`searching`/`compiling`), replacing the old six-blade "iris"
  spinner. Ported into the product as `.dial*`/`.brand-hud*` in `web/public/index.html`
  and `irisMarkup`/`dialVariant`/`brandHudMarkup` in `web/public/app.js` (`.iris-wrap`
  stays the container name — nothing about that concept changed, only what turns inside
  it), then mirrored back into `web/design-system/src/components/LoadingDial.tsx`/`.css`
  and `BrandHud.tsx`/`.css`, wired into `ClaimCard.tsx` in place of the old `Iris` export
  and `LibraryItem.tsx`'s running-row bolt icon and `SummaryCard.tsx`'s rolling-number
  count animation (`.summary-num.rolling`).
- **`dialVariant` is a product mapping, not a straight port.** The remote `ClaimCard.jsx`
  picks a `MatrixLoader` variant from its own loading-state prop (`found` → searching,
  `skeleton` → compiling, default → watching) — a shape that doesn't line up with the
  product's real state machine, which already tracks a genuine SSE stage per turn
  (attaching/reading/waiting/thinking/busy/rewriting). `dialVariant(frame)` in
  `web/public/app.js` maps *that* onto the three moods instead, so the mark reflects what
  the check is actually doing rather than which loading-state prop happened to be passed.
  The design-system mirror's own `ClaimCard.tsx` exposes an optional `dialVariant` prop
  with the same three sensible per-state defaults, for a consumer with no real stage of
  its own to report.
- **Deliberately not adopted**, each for a reason already on record elsewhere in this repo
  or this file:
  - `ClaimStack` (a single vertical auto-scrolling column replacing the claim grid) — the
    product's 2-column claim grid is a considered, extensively-commented design decision
    in `web/public/index.html` (`claimGridColumns`'s own doc comment: "about four visible,
    the rest a scroll away"), not an oversight `ClaimStack` corrects. Not ported; not
    mirrored.
  - `VerdictBadge`'s remote redesign (solid-fill pills, icon-only/expandable variant, and
    `misleading`/`false`/`true` as additional verdict keys) — the verdict vocabulary is
    closed at four (`public/claims.js`'s `VERDICTS`, `lib/verified-chat.js`'s prompt); the
    remote's own README already drifts from the product here ("Misleading" instead of
    "Disputed"), which is the same drift `SummaryCard.tsx`'s doc comment already flagged
    before this run. Left alone.
  - `tokens.css`'s dropped serif (`--font-display` now the same sans as `--font-body`) —
    `web/public/index.html`'s own token block already documents keeping the serif as a
    deliberate, permanent divergence from the design system. Left alone.
  - The full pixel-cloned Matrix→MatrixLoader morph transition
    (`cards/Screens-Matrix To Watching.html`, a demo-only rAF choreography that measures
    and flies a cloned DOM node between two fixed layouts) — real, but disproportionate to
    port faithfully into vanilla JS for what the product needed; the two marks appear in
    different, non-overlapping moments (empty state vs. running) rather than one morphing
    live into the other.
- **Not yet re-synced**: `LibraryItem`/`ShellTopBar`/`MobileShell`/`ClaimGridSplit` exist
  only in the local mirror (the remote project's file list has no equivalents for the
  first two by those names, and no `MobileShell` at all); `Matrix`/`MatrixLoader`'s exact
  remote class names (`.matrix-*`/`.mload-*`) were renamed on the way in
  (`.brand-hud-*`/`.dial-*`) to fit the product's own existing `.iris-wrap` container and
  naming register — a future diff against the remote project should search for those
  renamed classes, not the original ones.

## Same day, later — the landing pages and the "Chat to shell" transition

Follow-up to the pull above, same session: the remote project also has full-page
`cards/Screens-App Shell-Landing.html` / `-Mobile-Landing.html` (brand block, the brand
HUD, the composer, an action-tile row, a feature row, a footer line) and
`cards/Screens-Chat To Shell.html` / `-Mobile Landing to Shell.html` (the landing card
leaving as a check begins, the shell arriving in its place). These went into the product,
not the mirror:

- **Landing content** — `landingMarkup()` in `web/public/app.js` (brand block, the
  existing `brandHudMarkup()`, the invitation, action tiles, feature row, footer line —
  copy ported verbatim) replaces what the empty-state claim card held before. One markup
  for both breakpoints; the existing phone media query in `web/public/index.html` just
  tightens sizes, same as the rest of this pane's phone treatment already does.
- **The action tiles are decoration with one real behavior.** The remote screens give
  Video/Article/Search/Paste distinct demo actions (fake submits), but the product has one
  composer for every kind of link or question, not a mode per content type — inventing
  four fake modes would be a worse UI than admitting there's only one. Each tile just
  focuses the composer.
- **"Chat to shell" is a crossfade, not the remote's cloned-node morph.** The remote
  screens fly a cloned copy of the Matrix cluster (measured via `getBoundingClientRect`,
  interpolated frame-by-frame via `requestAnimationFrame`) into the exact pixel footprint
  of the real loading dial inside the destination card — the same technique
  `Screens-Matrix To Watching.html` used and the last section already declined to port, for
  the same reason: it's built for a demo's fixed choreography (typed text, timed steps),
  not a real turn whose timing is genuinely unknown (network, model latency). Instead,
  `playLandingExit()` in `web/public/app.js` fades and scales the whole landing card back
  (plus flies the four brand-HUD pills outward on top of that, `.claim-empty.leaving` in
  `web/public/index.html` — this part *is* lifted straight from the remote's `.hero-out`
  treatment) before the running card fades in on its own (`.run-enter`, reusing the
  existing `card-in` keyframe `.claim-empty` already had). `runCheck` awaits the exit
  before doing anything else — see its own comment on why `inFlight` now has to be claimed
  synchronously first, to close a reentrancy window that await would otherwise open.
  The desktop video column growing in beside the claims pane is unchanged; that part was
  already this same design system's "Chat to shell" screen, ported before this file
  existed (see `.content-grid.single-pane` in `web/public/index.html`).
- **No design-system mirror component for any of this.** A landing page is a full
  composition, not a reusable piece — the design-system's own README says as much for its
  `Screens-*` cards ("full-page compositions that aren't reusable components"). There is
  nothing here shaped like the mirror's other entries (one component, one `.tsx`/`.css`
  pair) to port back.
- **Not attempted**: the mobile "Landing to Shell" screen's analyzing interstitial (a scan
  ring + a three-line step list — "Fetching the source"/"Extracting claims"/"Matching
  evidence" — shown between landing and shell) and its own shared-element flights (the
  entry bar and brand mark gliding from their landing position to their docked shell
  position). Same reasoning as the morph transition above: built for a fixed demo
  timeline, and the product already has its own honest progress language for an
  indeterminate wait (the stage text + eased progress bar `createProgressTicker` drives).
  Grafting a second, unrelated "analyzing" language on top would be two ways of saying
  the same thing rather than one considered one.

## Same day, one more pass — the mobile video-strip reveal

One piece of "Mobile Landing to Shell" *was* worth its own pass after all: the strip's
first appearance wiping in (`.mshell-media{clip-path:...}` in the remote screen) rather
than just popping into existence the way it always has. Unlike the analyzing interstitial
and the shared-element flights declined above, this one doesn't compete with anything the
product already says — it's pure entrance, no borrowed progress language — so it went in
as `.media-reveal`/`video-pane-reveal` in `web/public/index.html`, triggered by
`pendingMediaReveal` in `web/public/app.js` (set by `playLandingExit`, consumed once by
`runCheck` right after `renderVideoPane`). A `@keyframes` animation rather than the
`transition` the rest of this file's animations tend to reach for first: the strip's
hidden state is `display: none` (`.content-grid.single-pane .video-pane`), which a
`transition` cannot animate away from, but a `@keyframes` animation only needs the element
to already be visible by the time it starts — true here, since `updatePaneMode` has
already dropped `single-pane` by the point the class is added. Verified against the
animation's own live `clip-path`/`currentTime` in a headless pass rather than by eye: with
only a black placeholder behind it (no `GEMINI_API_KEY` in this sandbox to resolve a real
clip), a partial reveal of a near-black strip against the app's own near-black background
is nearly invisible to a screenshot diff even though the animation is genuinely
interpolating — a real video will make the wipe obvious in a way a placeholder can't.
