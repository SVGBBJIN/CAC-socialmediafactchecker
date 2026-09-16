# Trase design system — build conventions

Trase is a dark-mode fact-checking UI: a sidebar library of past checks, a composer that
takes a pasted link, and a claims feed of verdict cards. Everything below is real — verify
against `styles.css` and `tokens/` in this bundle before styling anything new.

## No provider, no wrapper required

Every component here is a plain function component with no context/provider dependency —
there is nothing to wrap the app in. Just import and render:

```jsx
import { Sidebar, LibraryItem, EntryBar, ClaimCard, VerdictBadge } from "@trase/design-system";
```

## The styling idiom: CSS custom properties, dark by default

Trase has no utility-class system and no prop-driven theming — components style themselves
from a fixed token set defined on `:root` (see `tokens.css` in this bundle). Build your own
layout glue (page background, spacing between these components) with the **same** tokens
rather than inventing new colors:

| Token | Use |
|---|---|
| `--bg` / `--surface` / `--surface-raised` | page background → card background → raised/hover surface, darkest to lightest |
| `--border` | hairline borders, `1px solid var(--border)` |
| `--ink` / `--ink-dim` / `--muted` | primary text → secondary text → placeholder/meta text |
| `--accent` | the one accent color (teal) — links, focus rings, the active/primary affordance |
| `--good` / `--warn` / `--bad` | the three non-neutral verdict colors (`corroborated` / `disputed`+`disagreement` / `contradicted`) |
| `--font-display` | serif, for claim titles and analysis prose (`ClaimCard`) — see the note below |
| `--font-body` | sans, for UI chrome — buttons, inputs, labels |
| `--font-mono` | monospace, for the eyebrow labels, timestamps, source-pill domains |

Dark is the default and the register everything was designed in (`--bg: #12151A`). A light
theme exists alongside it as **token overrides only** — set `data-theme="light"` on `<html>`
(or any ancestor) and every component follows, because they all read the same `var()`s. It
is not a flat inversion: surfaces are warm off-white, and the accent and verdict hues are
*darkened* from their dark-mode values to hold contrast on them.

One token exists solely because of that flip. `--on-accent` is the ink that sits **on** the
accent gradient rather than in it — the primary button. A constant cannot work: the gradient
is bright in dark mode and wants near-black on it, and dark in light mode and wants
near-white. Use `--on-accent` for any text or glyph drawn on `--accent`/`--accent-2` fill,
and never a literal.

The product also ships a `data-contrast="high"` mode on top of either theme. It is
product-only and has no component-level contract here — build against the tokens and it
follows for free.

### One known divergence in the type stack

`--font-display` is a **serif** here and in the product (`ui-serif, "New York", Georgia, …`),
while the design system's own `tokens.css` and README set it to the same grotesque as
`--font-body`. The product's serif is deliberate and permanent: what a claim card holds is
prose to be read, not UI copy, and the serif is what says so. Build against the token and
this resolves itself either way.

## The verdict vocabulary is closed

`VerdictBadge` and `LibraryItem`'s `status` prop both take exactly one of four values:
`contradicted` (`--bad`), `disputed` (`--warn`), `corroborated` (`--good`), `insufficient`
(`--muted`). Never introduce a fifth — every consumer of a verdict (badges, status dots,
claim cards) reads this same closed set.

**`disputed` is the real spelling.** Older material in this project says *Misleading* for the
same verdict, and some `VerdictBadge` variants carry `misleading`/`false`/`true` as extra
keys. Those are drift, not vocabulary: the product's four are the ones above.

## Where the truth lives

- `styles.css` (this bundle's root) — the full token + component stylesheet, `@import`-
  reachable from a design's rendered output.
- `<Name>.d.ts` next to each component — the real prop contract; `ClaimCard`'s `children`
  is a `ReactNode` (composed prose, e.g. with `TimestampChip` inline), not a string.
- `<Name>.prompt.md` — per-component usage notes and the authored preview compositions.

## A real composition

```jsx
<ClaimCard eyebrow="Claim 1 of 3" title="The vaccine contains microchips" verdict="contradicted"
  sources={[{ url: "https://reuters.com/...", domain: "reuters.com", title: "Reuters fact check" }]}>
  No credible source supports this. The claim traces to a 2021 hoax article.
</ClaimCard>
```
