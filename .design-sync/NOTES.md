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
