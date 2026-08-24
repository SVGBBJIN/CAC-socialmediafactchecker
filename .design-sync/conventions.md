# Seer design system — build conventions

Seer is a dark-mode fact-checking UI: a sidebar library of past checks, a composer that
takes a pasted link, and a claims feed of verdict cards. Everything below is real — verify
against `styles.css` and `tokens/` in this bundle before styling anything new.

## No provider, no wrapper required

Every component here is a plain function component with no context/provider dependency —
there is nothing to wrap the app in. Just import and render:

```jsx
import { Sidebar, LibraryItem, EntryBar, ClaimCard, VerdictBadge } from "@seer/design-system";
```

## The styling idiom: CSS custom properties, dark by default

Seer has no utility-class system and no prop-driven theming — components style themselves
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
| `--font-display` | serif, for claim titles and analysis prose (`ClaimCard`) |
| `--font-body` | sans, for UI chrome — buttons, inputs, labels |
| `--font-mono` | monospace, for the eyebrow labels, timestamps, source-pill domains |

There are no light-mode tokens — this system is dark-only by design (`--bg: #12151A`).
Don't invent a light variant.

## The verdict vocabulary is closed

`VerdictBadge` and `LibraryItem`'s `status` prop both take exactly one of four values:
`contradicted` (`--bad`), `disputed` (`--warn`), `corroborated` (`--good`), `insufficient`
(`--muted`). Never introduce a fifth — every consumer of a verdict (badges, status dots,
claim cards) reads this same closed set.

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
