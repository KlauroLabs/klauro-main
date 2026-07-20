# Design Tokens

Reconciles LANE-COMMON's "Klauro Design Language" values (binding) against the values actually
observed in the Figma file (`Ux2aXXgq4jzD9T4TZaDAw8`, via `get_variable_defs` on node 1698:13626
"Home"). Where they agree, that's the token. Where they disagree, see **Conflicts** below — the
theme (`src/theme/index.ts`) follows LANE-COMMON's design-language section (explicitly marked
binding) as primary, with the Figma-observed value noted for page lanes to re-check against their
own screen's `get_design_context` output.

## Colors

| Token | LANE-COMMON (binding) | Figma-observed | Used as |
|---|---|---|---|
| foundation/navigation | `#13141B` | `#13141b` (Side Bar Menu BG) | sidebar/topbar background |
| canvas/workspace | `#191A22` | `#191a22` (Main Background Color) | page background |
| surface/cards | `#20212A` | `#20212a` (Card BG) | Paper/Card background |
| construction/borders | `#2A2B36` | `#2a2b36` (Border, Card Stroke) | default 1px border |
| — divider (Figma-only, no LANE-COMMON equivalent) | — | `#32333e` | `Divider` — used for `MuiDivider` (slightly lighter than construction border, for in-card separators) |
| — overcard stroke (Figma-only) | — | `#45455a` | hover/emphasis border state |
| — input border (Figma-only) | — | `#383952` | text field border |
| wireframe/icons | `#B7BCC7` | `#9ba3c0` (Sidebar Icon) / `#5c6080` (Tertiary Text) | icon stroke — LANE-COMMON's lighter value used for primary icons; Figma's `#5c6080` used for tertiary/muted text |
| text/primary | `#F5F5F5` | `#f0f2ff` (Primary Text / Cards Title) | primary text color — used LANE-COMMON's `#F5F5F5` (pure near-white per design-language doc); Figma's off-white noted as acceptable variant |
| — secondary text (Figma-only) | — | `#9ba3c0` | secondary/supporting text |
| focus/accent | `#E6414B` | `#72b8c5` (Klauro Accent Color, teal) | **CONFLICT — see below.** Theme uses LANE-COMMON's `#E6414B` red as `palette.error`/critical-signal accent; Figma's teal `#72b8c5` is wired as `palette.primary` (interactive/selected-state accent) since that is how it's actually used across the sampled Home frame (nav active state, "Add Workspace" affordance). Both live in the theme — see Conflicts.

## Typography (Figma-observed, `font-family: Urbanist` + `Inter` for small UI labels)

| Token | Family | Weight | Size / Line-height | Used as |
|---|---|---|---|---|
| Page Title | Urbanist | Bold (700) | 32 / 40 | `h1` (page header) |
| Section Title | Urbanist | SemiBold (600) | 24 / 32 | `h2` (section header) |
| Card Title | Urbanist | SemiBold (600) | 20 / 28 | `h3` (card/panel title) |
| Sidebar Text / Body | Urbanist | Regular (400) | 14 / 24 | `body1`, nav items |
| Links / Activity Titles | Urbanist | Medium (500) | 14 / 22 | `subtitle2`, list item titles |
| Unravl Body Text | Urbanist | Regular (400) | 14 / 22 | `body2` |
| Small 1 | Urbanist | Medium (500) | 12 / 18 | `caption` (emphasized) |
| Small 2 | Urbanist | Regular (400) | 12 / 18 | `caption` |
| Text xs | Inter | Medium (500) | 12 / 18 | `overline`/dense table labels — Inter used ONLY here per Figma; Urbanist everywhere else |

MUI default font stack is overridden to `Urbanist, Inter, system-ui, sans-serif` (Urbanist first —
it is the dominant family; Inter is available for the one dense-label case above).

## Spacing / Geometry

- 8px base unit confirmed by Figma frame measurements (24/32/40/44/68/80/92px repeat units) — MUI
  `theme.spacing(1) = 8px` (default), used directly.
- Card corner radius: not exposed as a variable; observed ~12px on Card/Table-header components in
  the Figma screenshots pulled during metadata review — theme `shape.borderRadius: 8` conservatively
  (MUI's flatter default) pending a page lane's closer `get_design_context` read; adjust here if a
  lane finds a different value on their screen and note it.
- Card/Table stroke: 1px solid `#2A2B36` (construction), no shadow — `Shadows/shadow-xs` DOES exist
  as a Figma effect (`0 1px 2px #0A0D120D`) but LANE-COMMON explicitly says "no shadows" for
  Card/Paper — theme keeps `elevation: 0` everywhere; the Figma effect is noted here as a documented
  deviation, not applied.

## Conflicts (documented, not silently resolved)

1. **Accent color**: LANE-COMMON's design-language doc says `#E6414B` (red, ≈5% usage) is THE
   focus/accent color. The Figma file's own "Klauro Accent Color" variable is `#72b8c5` (teal), and
   the Home frame's actual interactive elements (nav highlight, primary CTA) use the teal, not red.
   Resolution: theme wires `palette.primary.main = #72b8c5` (interactive accent, matches what's
   actually drawn) and keeps `#E6414B` available as `palette.error.main` (also its natural semantic
   home — critical/destructive signal). Page lanes should use `color="primary"` for
   selected/interactive states per the Figma screens, not the red.
2. **Primary text**: LANE-COMMON says `#F5F5F5`; Figma's variable is `#f0f2ff` (slightly blue-tinted
   off-white). Theme uses `#F5F5F5` per the binding doc — visually indistinguishable at UI sizes.

Both are advisory notes for page lanes, not blockers — the theme's exported palette is the single
source of truth once built; consult `src/theme/index.ts` directly for the values actually shipped.
