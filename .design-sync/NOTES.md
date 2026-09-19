# design-sync notes — Trase

**Looking for what to push? → [`PUSH-REFERENCE.md`](./PUSH-REFERENCE.md).** That file is the
contract and the live queue. This one is the record of *why* — what was adopted, what was
declined and on what grounds, and which traps have already cost a session.

Kept as a reference rather than a diary: entries are grouped by subject, not by date, so a
decision can be found without reading the history that produced it. Commit hashes are the
audit trail if you need the blow-by-blow.

---

## The shape of the thing

Three hand-maintained copies — the product (`web/public/`), the local mirror
(`web/design-system/src/`), and the remote project. None of them syncs itself. The full
contract, including which is authoritative for what, is in `PUSH-REFERENCE.md`; don't
duplicate it here.

**The project id has moved once.** `9310f352-c8b4-4404-9a33-59321721029b` 404s; the current
project is `87a24e5a-ecbf-4bfa-9a0e-bb61ca5fab17`. If that one goes too, re-resolve by name
via `list_projects` rather than trusting the stored id.

**`[FONT_MISSING]` on render is expected and is not a gap.** "SF Pro Text" and "New York"
are Apple system fonts in `--font-body`/`--font-display`'s stacks. Apple does not license
them for web distribution, so there is nothing to ship via `extraFonts`. The stacks already
carry real fallbacks (`Georgia`/`serif`; `system-ui`/`sans-serif`), so a non-Apple viewer
renders in the register the design intends. Accept the substitute.

---

## Adopted from the design system

| What | Where it landed |
|---|---|
| `Matrix` → the brand HUD | `.brand-hud*` in `index.html`, `brandHudMarkup()` in `app.js`. Renamed from the remote's `.matrix-*`. |
| `MatrixLoader` → the loading dial | `.dial*`, `irisMarkup()`/`dialVariant()`. Three moods (`watching`/`searching`/`compiling`), replacing the old six-blade iris spinner. Renamed from `.mload-*`. |
| `Screens-App Shell-Landing` | `landingMarkup()` — brand block, HUD, entry block, action tiles, feature row, footer. A full page (`data-view="landing"`), not a card: no sidebar, no docked composer. |
| `Screens-App Shell-New Chat` | `.newchat-hero` — the shell sitting idle. Split from the landing: landing while the library is empty, hero once there's something to go back to. |
| `Chat To Shell` | `playLandingExit()` — the landing/hero leaves, the running card arrives. |
| `Mobile Landing to Shell`, in pieces | The video-strip clip-path reveal (`.media-reveal`), the composer's FLIP flight home (`flyEntryBarHome`), and the analyzing overlay (`showAnalyzingOverlay`). |
| `ClaimStack` | `e69073b` — the product moved from a 2-column claim grid to one column. Note this **reverses** an earlier decision below. |
| `SummaryCard`'s pill variant | `.summary-pill` — the DS ships both a full card and an inline pill; the product uses the pill. |
| `ClaimCard`'s verdict card variations | The left rail, tinted border and inset hairline in `index.html`, keyed off `verdict-*` on the pane (`verdictPaneClass` in `app.js`). Four variations, one per verdict. Reversible from settings — see "Legacy mode" below. |
| `Screens-404` | `public/404.html`, standalone. Brought back into line (brand-coloured blades, gradient button, lightning motif, current tokens, light theme) after drifting. |

## Declined, and why

Each of these was weighed at least once, several of them twice. The reasons are still the
reasons.

- **The pixel-cloned morph choreography** (`Screens-Matrix To Watching`, and the hero→dial
  flight in the mobile screens). The demo measures a cloned DOM node and interpolates it
  frame-by-frame on a fixed ~1.7s clock. The product's equivalent wait is real backend
  latency and genuinely unknown. A positional FLIP flight is a fixed-duration UI transition
  and *is* honest, so that part went in; a scripted colour/tick sweep tied to a fake clock
  would misrepresent progress, so it didn't.
- **The analyzing interstitial's full step list.** Ported as layout, but only
  "Fetching the source" ever lights up. At the moment the overlay is on screen the request
  hasn't been sent, so there is no signal behind "Extracting claims" or "Matching evidence".
  Lighting them anyway is the same fake progress declined above. The overlay bridges the
  ~550ms gap and then hands the narrative to the real, stage-driven dial.
- **`VerdictBadge`'s remote redesign** — solid-fill pills plus `misleading`/`false`/`true` as
  extra verdict keys. The vocabulary is closed at four. The remote's README drifts here too
  ("Misleading" for "Disputed"); see `PUSH-REFERENCE.md` §4, it's ours to correct in the DS. The
  same drift is in `ClaimCard.css`, which spells its rail selectors
  `verdict-contradicted`/`misleading`/`corroborated`/`insufficient` *as well as*
  `verdict-bad`/`warn`/`good`/`muted` — for the same four gradients. The rail itself was
  adopted; only the `bad`/`warn`/`good`/`muted` half of each selector came with it, because
  that is what `VERDICTS[key].css` already names and the other half would have quietly
  seeded a fifth spelling. The gradients, the `color-mix` percentages and the 4px/24px
  measurements are the DS's own, copied as written.
- **`tokens.css`'s dropped serif.** The DS sets `--font-display` to the same grotesque as
  body. The product keeps the serif, permanently — a claim card holds prose to be read.
- **The desktop Landing card's 280×340 HUD box.** The product scales the tuned 236×220 mark
  instead. Settled retroactively and on evidence: `Matrix.css` and the *mobile* Landing card
  both use the tuned proportions; only the desktop Landing card hand-rolls the looser one.
  Two of three, so the product agrees with the majority and that card reads as the outlier.

### One reversal worth knowing about

**`ClaimStack` was declined once, then adopted.** The first pass kept the 2-column claim grid
on the grounds that it was a considered decision with its own doc comment, not an oversight.
`e69073b` later moved the product to one column after all. If you find a note elsewhere
saying the grid is deliberate, this supersedes it — and `ClaimGridSplit` in the mirror is now
dead code.

---

## Traps that have already cost a session

These are all "looks fine until you read the numbers" problems. Four of them were found by
measuring live state; none would have shown up in a screenshot diff.

- **An animation beats a plain declaration.** `transform: scale(…)` on `.brand-hud` silently
  did nothing, because `.brand-hud` carries the `rise-in` animation whose last keyframe is
  `transform: none`. This bit **three times** before being designed around rather than worked
  around: the stagger now rides on a `.landing-hud` wrapper, leaving `transform` on
  `.brand-hud` itself free. The wrapper also carries the scaled height, which a transform
  never reserves. Check for an animation on the element before reaching for `transform`
  anywhere in `.lshell-scroll`.
- **A column flex container shrinks its items before it will overflow.** The HUD arrived
  160px tall instead of 340 on any viewport shorter than the composition — i.e. every laptop
  — with its absolutely-positioned rings quietly crushed together.
  `.lshell-scroll > * { flex-shrink: 0 }` is what makes the `overflow-y: auto` above it mean
  anything.
- **`innerHTML` destroys a live descendant; it does not move it.** The composer is one real
  DOM node moved between the landing slot and its dock — so a claims-pane re-render would
  detach its listeners, drop focus and discard the typed value. All seven call sites go
  through `setClaimsPaneHTML`, which redocks first. New render paths get this by
  construction rather than by remembering.
- **Playwright's `addInitScript` re-runs inside same-origin iframes.** The app carries a
  static `<iframe id="videoEmbed">` with no `src`, so it's `about:blank` and same-origin, and
  seeded `localStorage` gets rewritten *after* app.js has already read it. Symptoms look
  exactly like the app never running. Guard every seeding script with
  `if (window.top !== window) return;`.
- **`#checkBtn` is disabled outright with no `GEMINI_API_KEY`.** Real product behaviour, not
  a test artifact, and the cause of several minutes of "the click does nothing". Set a dummy
  key when driving the UI headlessly.
- **A claim box in the desktop grid does not clip.** `.claim-card` sets `overflow: hidden`,
  but `.claims-pane.claim-grid .claim-pane` overrides it to `visible` (`142a0cd`, when the
  per-box scrollers went away), so nothing cuts an absolutely-positioned child to the card's
  own 14px radius. The DS's `ClaimCard` verdict rail is a `::before` rectangle that relies on
  exactly that clip, and ported as written it ran square-cornered straight past the curve at
  the top and bottom of every box — visible only when you zoom a corner, which is why the
  first pass shipped it. The rail is now a `background-image` layer on the card instead
  (`background-origin` is the padding box by default, so `4px 100%` at `left center` sits
  where the pseudo-element did), because a background is clipped to the rounded border box
  for free. Restoring `overflow: hidden` would have been the other fix and is the wrong one:
  the source-pill popovers escape the box deliberately. Anything else ported from the DS that
  assumes the card clips needs the same treatment.

- **The claims pane is not its final width when it is first rendered, and it transitions.**
  `revealIn` measures source-pill overflow the moment new markup lands; at that point the
  split layout is still settling and the pane is ~86px wider than it ends up, so the row was
  cut for a width it never had — a "one line" row on two lines, at a plain 1280px desktop,
  with nothing resized. A viewport change then animates the pane's width frame by frame, so
  anything measuring on `resize` sees a few hundred intermediate widths, none of them the
  answer. Both are now handled by a `ResizeObserver` on the pane feeding one debounced
  settle (`beginResize`/`endResize` in app.js). Two things to know if you add another
  measurement here: observe the **border-box** width, because a scrollbar appearing inside
  the pane moves `contentRect` and the measurement can cause that itself — an endless
  re-measure; and measure only after `data-resizing` comes off, since the guards it applies
  are the thing that would make the measurement wrong.

- **Hardcoded colour constants survive a theme.** A dozen `rgba(79,209,197,…)` (the *old*
  accent) and four `rgba(240,237,230,…)` (the old ink) sat in `index.html` long after the
  tokens moved, invisible in dark mode and wrong in light. The file's idiom is
  `color-mix(in oklab, var(--token) N%, transparent)` — use it. Same for
  `--on-accent`: ink drawn *on* the accent gradient cannot be a literal, because the gradient
  inverts between themes.

---

## Known oddities, not yet resolved

Carried forward because each is a fair thing for someone to call odd, and none has an
obviously right answer.

- **The landing is nearly unreachable.** The split is on `library.length === 0`, so once you
  have checked anything, only clearing the library gets you back. The screen most of the
  design effort went into is the one almost nobody sees twice. (A seven-day inactivity gap
  routes to the *hero*, not the landing — deliberately.)
- **`#landingLibBtn` opens a library that is empty by definition** on the screen it appears
  on. It's in the DS's own landing topbar and it's the only route to sign-in while the page
  is up, which is why it's wired rather than dropped.
- **Inactivity is per browser, not per person.** Signed-in readers get no continuity across
  devices, and clearing site data reads as seven days away. Consistent with how the library
  itself works, so it adds no new limitation — but "inactive for 7 days" really means "this
  browser hasn't been used for 7 days". It is also only ever checked at load, so a tab left
  open for a fortnight still shows what was open.
- **The overlap bite on the landing entry block is a taste value.** 12px of the outer ring,
  chosen because it looks deliberate at both breakpoints. One edit to change.
- **"Legacy mode" is a one-way door that nothing else uses yet.** The switch
  (`settings.legacyCards` → `data-cards="legacy"` on `<html>`) turns off the verdict card
  variations and nothing else, by design — it was scoped to the claim card because that is
  the only thing it introduced. The name is broader than the behaviour, so the next visual
  change either joins it (and the switch stops meaning one specific card) or doesn't (and a
  reader who turned it on has no idea what it now covers). Worth deciding before the second
  thing lands, not after.

- **The phone top bar says "New check" while the desktop bar and sidebar say "New chat".**
  Deliberate at the time (the phone-copy option was offered and not picked), but it is an
  inconsistency and a two-line fix if it wasn't.
