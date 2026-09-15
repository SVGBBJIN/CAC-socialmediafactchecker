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

## Next session — the mobile bar bug, and reopening the two declined pieces

Two things came back from the user after the pass above: the mobile landing composer was
reading as broken ("the bar needs to be in the middle"), and an explicit ask to reconsider
the analyzing interstitial and the shared-element flights this file had just finished
declining — "Animations need to be copied faithfully, just replace the fake start with an
actual trigger." Taken together, that's permission to spend real engineering on the
flight/interstitial rather than the earlier note's easier call to skip them, so both went
in this session, alongside the actual bug fix.

**The mobile bar bug, and why it was a real bug, not a taste call.** `.entry-bar` has always
been a single persistent DOM node — the real composer, one set of listeners, one focus/value
state — docked as the last flex child of `.main`, below `.content-grid` (which is
`flex: 1 1 auto` and fills whatever height the screen has). On the empty/landing state that
card sits at the *top* of `.claims-pane` (nothing gave it `justify-content: center`), so on
a phone the landing content reads as pinned to the top of the screen with a dead gap below
it before reaching the composer, which is itself pinned to the very bottom edge — nothing
like the DS's "Mobile Landing" screen, where `EntryBar` lives inside `entry-block`, embedded
in the scrollable composition right under the brand HUD, not docked separately at all. That
gap was the actual bug the user was pointing at.

The fix moves the *real* composer node, not a clone: `landingMarkup()` now renders an empty
`#landingEntrySlot` (a `.landing-entry` card matching the DS's `entry-block` — heading,
subtext, and nothing else) right where the DS puts `EntryBar`, and `syncLandingComposer`
(app.js) appends the actual `#entryBar` into it whenever `device.kind === "phone"` and the
landing card is on screen, or hands it back to its static dock (`#entryBarDock`, a marker
`index.html` carries right where the bar always used to sit) otherwise. Desktop/tablet are
untouched on purpose — nothing about that layout was reported broken, and "always reachable
without scrolling" there is a documented, deliberate property (see `.entry-bar`'s own
"Desktop/tablet" comment) this wasn't asked to revisit. `.landing-entry` is `display: none`
outside the phone breakpoint for exactly that reason: one markup path for both breakpoints,
same as the rest of `landingMarkup`, with the embed only *active* on one of them.

Moving a live node in and out of a subtree that gets `innerHTML`-replaced is the one way
this goes wrong quietly — `claimsPane.innerHTML = …` doesn't move a live descendant, it
destroys it (detaches every listener, drops focus, discards the typed value). Every one of
the claims pane's seven call sites now goes through `setClaimsPaneHTML`, which redocks the
composer first if it isn't already at `#entryBarDock`, so no render path can be added later
without this protection by construction rather than by remembering to call a second
function.

**The shared-element flight**, reopened: the composer's move from embedded to docked, at
the exact moment a check starts, is now an actual flight (`flyEntryBarHome`) rather than a
snap — a FLIP transform (capture the real `getBoundingClientRect()` right before the redock,
then invert and let it animate to `none`), not the DS demo's scripted per-frame ring-color
interpolation. That larger piece is still declined, and deliberately: the demo's dial
morph is tuned to a fixed ~1.7s clock for visual effect, and this app's own dial is driven
by real, unpredictable backend latency — forcing a scripted color sweep onto it would
misrepresent progress the same way the analyzing interstitial's steps would (see below), for
the same reason the pixel-clone hero-to-dial morph was declined the first time around. What
*did* change is honest to build: a positional flight is a fixed-duration UI transition, not
a progress signal, so animating it on a fixed ~500ms is not the thing that was declined.
Scope stays where it was drawn before, too — this flight only fires where the composer is
actually embedded-then-redocked, which is the phone landing path; desktop/tablet keep the
crossfade-only "Chat to shell" treatment from the previous pass, since nothing there moves.

**The analyzing interstitial**, reopened, scoped honestly: `showAnalyzingOverlay`/
`hideAnalyzingOverlay` (app.js) port the DS's frosted scan-ring-plus-step-list layer, called
from the real `playLandingExit`/`runCheck` turn rather than a scripted timeline — but the
step list here never advances past "Fetching the source." The DS demo scripts its three
steps against fixed millisecond offsets because it has no real backend to answer to; this
app does, and at the moment this overlay is on screen the request hasn't even been sent yet,
so there is no real signal to justify "Extracting claims" or "Matching evidence" lighting up
— doing that anyway would be exactly the kind of fake progress this file has repeatedly
declined to fake elsewhere (see the "declined" note this section is reopening). The overlay
now exists to bridge the ~550ms real window between the landing card leaving and the running
card's own dial mounting underneath it (`irisMarkup`, already real, already stage-driven) —
`hideAnalyzingOverlay` is called a fixed, short beat after `renderRunningCard()`, handing the
"still working" narrative to that dial rather than trying to keep narrating progress itself.
A single node appended to `<body>` (`analyzingOverlayEl`), not part of any pane's markup, so
`setClaimsPaneHTML` rebuilding what's under it never touches it.

**Verification.** All three pieces were exercised in a headless pass with the real trigger,
not by eye: `page.route` stubbed `/api/probe-link` to answer instantly (the sandbox's own
network egress made the real probe hang long enough to make manual testing impractical), a
dummy `GEMINI_API_KEY` was set so `#checkBtn` wasn't disabled (the app disables it outright
with none configured — a real product behavior, not a test artifact, and the actual cause of
several minutes of "the click does nothing" before that was noticed), and the resulting
Gemini-rejects-the-key error card at the end of the run confirms the pipeline ran for real
rather than being short-circuited. Confirmed by reading live state rather than screenshots
alone: the composer's `parentElement` against `#landingEntrySlot`/`#entryBarDock` at each
stage, the overlay's `.on` class and its target text, the bar's inline `transform`/
`transition` mid-flight. Also checked: resizing live across the phone breakpoint moves the
composer both directions without a reload, desktop/tablet screenshots are unchanged from the
previous pass, and `reducedMotion: "reduce"` skips the overlay, the flight, and lands the
composer at its dock instantly (via `setClaimsPaneHTML`'s own redock guard, not a separate
reduced-motion branch — there was nothing extra to write). `npm test` — 629/629 — both
before and after.

**Self-critique.** The interstitial's honesty rule (only step 0 ever lights up) is the
correct call given what this app can actually tell the reader at that moment, but it does
mean the DS's three-step list reads as slightly inert next to the demo's fully-animated one
— a reasonable person could want steps 2 and 3 wired to real signals once the app has one to
offer for each (there isn't a clean one for "matching evidence" specifically; tool-call
rounds don't split that finely). The flight's ~500ms duration and its FLIP-only scope
(position and width, not the DS's ring-color/tick-growth choreography) are also a real
simplification, named as one above rather than silently — a fuller port remains possible if
asked for again, but this is the second time it's been weighed against the app's
unpredictable real latency and set aside for the same reason.

## Same session, one more fix — the landing page stops being a card

Immediate follow-up: "make the landing page its own separate page not a card." Fair —
`renderChatPane`'s empty branch wrapped the whole landing composition in `.claim-card`, the
same bordered/backgrounded/pointer-tilting box every settled claim and the running/error
cards use. On a phone that box was already invisible (`.claim-card:not(.claim-pane)` strips
it to a transparent, borderless sheet at that width — see that rule's own comment), which is
why the mobile screenshots in the earlier sections never showed it. Desktop never got that
treatment, so there the landing content sat inside a visibly bordered rectangle that grew to
fill the pane (`flex: 1 1 auto`) even though the content itself was shorter than that —
a card with dead space inside its own border, which is exactly what a screenshot of the
DS's own "App shell — Landing" doesn't show: there, this composition *is* `.lshell-scroll`'s
entire content, no card wrapping it at all.

Fix: `.landing` (already the outermost element `landingMarkup()` returns) is now
`.claimsPane`'s direct child on this state — no `.claim-card` wrapper — and picked up the
two things that wrapper used to supply: `flex: 1 1 auto` (reach the bottom of the pane on a
short viewport) and the `card-in` entrance (same keyframes `.claim-card.run-enter` plays,
just not riding on that class to get it). `playLandingExit`'s "Chat to shell" exit
(`.claim-empty.leaving` → `.landing.leaving`) and its `querySelector` moved with it. No
`justify-content: center` was added to vertically center the composition within the pane —
checked against the DS's own screen, which doesn't do that either (`.lshell-scroll` is a
plain top-down flex column, same as `.landing` always was); on a viewport taller than the
content, this now just shows plain page background past the footer line rather than a
bordered box with room inside it, which reads as intentional rather than short.

Verified in a headless pass: computed style on the live `.landing` element confirms no
`.claim-card` class, transparent background, no border, zero padding, and `#claimsPane` as
its direct parent; a full desktop screenshot alongside the mobile one from the previous
section shows the border is simply gone rather than relocated. The leave/flight/overlay
sequence from the previous section was re-run end to end against the renamed classes to
confirm nothing there was riding on the old selector unnoticed. `npm test` — 629/629 —
unaffected, as expected for a markup/CSS-only change.

## Next session — splitting the idle state into the DS's two screens

"Fix the new chat state to match app shell--new chat." The design system has *two* screens
for the one moment this app had one of: `cards/Screens-App Shell-Landing.html` (ported in the
sections above, and until now the only thing `renderChatPane`'s empty branch rendered) and
`cards/Screens-App Shell-New Chat.html`, which nothing here had ever looked at. They are not
the same composition at two sizes — the landing introduces the app to someone who has never
seen it (brand block, HUD, entry block, action tiles, feature row, footer line), and the New
Chat screen is the shell sitting idle with nothing to introduce (brand block, HUD, stop).

The user's call on how they should map, asked before any of this was written: **split them**
— landing while the library is empty, the New Chat hero once there is anything to go back
to — and **rework the landing to be exactly like the design**, which they clarified means
"in the landing we're removing the sidebar and entry bar." That clarification is what
resolved the one apparent contradiction in the brief: the DS's `.newchat-hero` is a bordered
box, which is precisely the border commit e2bc62f had just deliberately removed from the
landing. It isn't a contradiction, because the two belong to different screens — the hero is
a box *inside* a shell that stays, and the landing is a page with no shell at all.

- **The landing is now a page, not a pane.** `data-view="landing"` on `<html>`
  (`setLandingView` in app.js) takes the sidebar, both top bars and every ancestor's padding
  off the screen; `landingMarkup` supplies the DS's own `.lshell-topbar` (hamburger +
  settings) over `.lshell-scroll` instead. Sizes are the DS's rather than the shrunk-to-fit
  card ones this state used to use: 52px mark, 42px wordmark, 12px tagline on one line (the
  old markup broke it in two — that is the *New Chat* screen's treatment, not the landing's),
  the HUD at its full 280x340 with a 236px cluster, `entry-block` at 26px padding and 560px
  wide, 21px action-tile icons, a 760px feature row.
- **The composer is embedded at every width now, not just on a phone.** Nothing clever: with
  the shell gone there is no docked position left for it to be in, so the breakpoint that
  used to choose between the two has nothing to choose. `syncLandingComposer` lost its
  `device.kind === "phone"` test and became "is the slot on screen"; `playLandingExit`'s
  flight test lost the same clause and now asks only where the composer actually is. The
  desktop composer arrives wearing the raised-card treatment (`@media (min-width: 701px)` on
  `.entry-bar`) that the phone one never had, so `.landing-entry .entry-bar` had to strip
  border, radius, shadow and background as well as the old hairline — without that the
  landing showed a card inside a card.
- **The sidebar is off-screen, not absent.** `#landingLibBtn` opens it as the drawer, and
  `openDrawer`'s `device.kind !== "phone"` guard is now `&& !isLandingView()` so that works
  at a desktop too — otherwise the library and the sign-in button under it would be
  unreachable while the page is up. `drawerHandle`/`setDrawerHandleState` keep whichever of
  the two handles is on screen carrying the `aria-expanded`/`aria-label` state and taking
  focus back on close (the phone's `.drawer-toggle` is `display: none` above 700px, and
  focusing a hidden element drops focus on `<body>` — the exact bug that focus restore
  exists to prevent).
- **The shell topbar stops being blank.** `updateShellTopbar` hid `.shell-topbar` outright
  with nothing selected; on the New Chat screen the DS gives it "New chat" / "Nothing checked
  yet", so it now does, and stays hidden only on the landing, which has no shell to put it
  in. The sidebar button is "New chat" too, both label and `aria-label`/`title`.
- **Both screens leave the same way.** `playLandingExit` queries `.landing, .newchat-hero`
  and the `.leaving` rules are shared: the hero is the same brand block over the same HUD,
  and a check starting from it is the same event, so it flies its pills out rather than
  blinking away while the landing gets a send-off.
- **Removed**: `.claim-empty-text` (the invitation paragraph the DS's landing replaces with
  `entry-block`'s own heading and subtext) and the whole phone-only `.landing-entry` block,
  now that the embed is unconditional. `.landing` itself no longer animates — its children
  stagger in via the DS's `rise-in` — so both reduced-motion overrides moved to
  `.landing .rise, .landing .brand-hud` with it.

**Two bugs the headless pass caught that a screenshot wouldn't have.** Both are the kind
that look fine until you read the numbers:

- `.lshell-scroll` is a column flex container, and a column flex container shrinks its items
  to fit before it will overflow. The HUD was arriving **160px tall instead of 340**, its
  absolutely-positioned rings quietly crushed together, on any viewport shorter than the
  composition — which is every laptop. `.lshell-scroll > * { flex-shrink: 0 }` is what makes
  `overflow-y: auto` above it mean anything.
- The phone's HUD scale was written as `transform: scale(0.86)` the way the existing
  `.brand-hud` phone rule does it — and silently did nothing, because `.brand-hud` is the one
  element here carrying the `rise-in` animation, whose last keyframe is `transform: none`,
  and an animation beats a plain declaration. Re-specified as real geometry (241x292 wrap,
  1.035 cluster scale) instead. Worth remembering before reaching for `transform` on anything
  in `.lshell-scroll`.

**Verification.** Headless, reading live state rather than judging by eye, across both
breakpoints and both screens: the view attribute, each chrome element's computed
visibility and box, the composer's real `parentElement` at each stage, the rendered wordmark
size, and the HUD's measured box (which is how both bugs above surfaced). The drawer was
opened from `#landingLibBtn` at 1440px and closed from the scrim. The exit was driven through
the real trigger from *both* screens — `/api/probe-link` stubbed, the intake confirm dialog
answered the way a reader answers it — confirming `.landing.leaving` / `.newchat-hero.leaving`,
the analyzing overlay, the composer landing back at its dock, and `flyEntryBarHome` running at
desktop width for the first time (its `style.transform` is set, where an unrun flight leaves it
empty). `npm test` — 629/629 — before and after; nothing in the suite touches this markup.

**Self-critique.** Three things are worth naming rather than leaving to be discovered:

- The phone top bar still says "New check" / "Paste a link to get started" while the sidebar
  button next to it now says "New chat" and the desktop bar says "New chat" / "Nothing checked
  yet". That is exactly what was asked for (the phone-copy option was offered and not picked),
  but it is an inconsistency, and if it wasn't deliberate it is a two-line fix.
- The split is on `library.length === 0`, so the landing is genuinely unreachable once you
  have checked anything — clearing the library is the only way back to it. That follows from
  the mapping that was chosen, but it does mean the screen most of the design effort went
  into is the one almost nobody sees twice.
- `#landingLibBtn` opens a library that is empty by definition on the screen it appears on.
  It is in the DS's own landing topbar and it is the only route to sign-in while the page is
  up, which is why it is wired rather than dropped, but "Open checks" opening an empty list is
  a fair thing to call odd.

## Same session — who gets the landing, and when

Follow-up to the split above: "Make the landing page load for anyone without browser data
and if they're inactive for a certain period." The first half already worked (an empty
library is what routes to the landing), so the real change is the second. The user's calls:
**7 days**, **checked at page load only**, and a reader returning after that gap gets the
**New chat hero**, not the landing — the landing stays strictly for a browser with nothing
in it.

Those three together reduce to one mechanism, which is why it is small: **after a long
enough gap, don't auto-reopen the last check.** `selectedId` has always initialised to
`library[0]?.id`, so a reload dropped you straight back into whatever you were last reading;
now `startedFresh` gates that, and a null `selectedId` falls through the startup path's
existing empty-state branch, which already picks landing-vs-hero by `library.length`. No new
screen, no new routing — the two screens from the section above just get a second way in.

- `trase.activity.v1` holds one number, written by `markActive` on load and on every
  `pointerdown`/`keydown` (capture phase, passive, throttled to one write a minute — the
  value only needs to be right to within far less than seven days). Capture phase so nothing
  that stops propagation can make a tab in active use look abandoned.
- `resumedFresh()` is read **once**, at module scope, before `markActive` can overwrite the
  value it reads. A missing record counts as fresh, which covers a first visit, cleared site
  data, a private window — and, one time only, an existing reader upgrading into this
  version, who has a library but no activity record yet. That one-off hero is the correct
  answer for them rather than a bug to special-case.
- Storage failures are swallowed: the only cost of a browser that won't persist this is
  being greeted by the landing every time, which is the safe direction to fail in.

**Verification.** Six startup states driven headlessly, each a fresh context with its
localStorage seeded before the app loads: no browser data → landing; library + active 5
minutes ago → the check reopens; + 6 days → still reopens (the boundary holds from below);
+ 8 days → New chat hero; library with no activity record → hero; no library + 8 days →
landing. The stamp refreshes to "now" on all six. `npm test` — 629/629 — and the four-screen
pass from the previous section re-run unchanged.

**One test artifact worth writing down**, because it cost time and will again: seeding
localStorage via Playwright's `addInitScript` *silently corrupts this particular test*. The
app carries a static `<iframe id="videoEmbed">` with no `src`, so it is `about:blank` and
same-origin, and an init script re-runs inside it — putting the seeded, stale timestamp back
*after* app.js has already refreshed it. The activity stamp read as untouched on exactly the
cases that had one seeded, which looks precisely like `markActive` never running. Guard any
such seeding with `if (window.top !== window) return;`.

**Self-critique.** Two things:

- Inactivity is measured per browser, not per person — signed-in readers get no continuity
  across devices, and clearing site data reads as seven days away. Consistent with how the
  library itself works (localStorage, see `LIBRARY_KEY`), so this adds no new limitation, but
  it does mean "inactive for 7 days" is really "this browser hasn't been used for 7 days."
- The gap is only ever checked at load, as asked. A tab left open for a fortnight and
  returned to still shows the check that was open, and only a reload moves it. That is the
  conservative reading and nothing changes under a reader mid-look, but it does mean the
  longest-idle case in practice — the always-open tab — is the one case this doesn't catch.
