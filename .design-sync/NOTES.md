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
