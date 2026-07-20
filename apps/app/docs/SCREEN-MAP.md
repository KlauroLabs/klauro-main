# Screen Map

Figma file `Ux2aXXgq4jzD9T4TZaDAw8`. Maps each Figma screen node to the route(s) it governs and
which lane owns the build. Per LANE-COMMON's DESIGN FIDELITY RULE: **designed** routes require
BIDIRECTIONAL fidelity (nothing added beyond the Figma frame, nothing in the Figma frame missing
from the build) plus an element-coverage checklist in that lane's report. **Derived** routes have
no Figma frame — build from the design language + closest designed screen, and ship a full DESIGN
BRIEF at `apps/app/docs/briefs/<section>.md` following the entry-points brief exemplar.

| Node ID | Figma frame name | Route(s) | Regime | Owning lane |
|---|---|---|---|---|
| 1698:13626 | Home | `/` (dashboard) | **Designed** — bidirectional fidelity + element checklist required | page-dashboard |
| 1748:6595 | Workspace | `/workspaces/:workspaceId` | **Designed** — bidirectional fidelity + element checklist required | page-workspace |
| 1647:37709 | Repo overview | `/codebases/:projectId` (overview section) | **Designed** — bidirectional fidelity + element checklist required | page-codebase |
| 2030:31178 | Flow List | `/codebases/:projectId/flows` | **Designed** — bidirectional fidelity + element checklist required | page-flows (claimed — supersedes page-codebase's interim fallback) |
| 1982:5977 | Flow Overview | `/codebases/:projectId/flows/:flowId` | **Designed** — bidirectional fidelity + element checklist required | page-flows (claimed — supersedes page-codebase's interim fallback) |

## Derived routes (no Figma frame — brief required)

All of these derive from the design language + the closest designed screen above (Repo overview
for CAS-section pages; Flow List/Overview for other drilldown tables/detail pages). Each needs a
full DESIGN BRIEF at `apps/app/docs/briefs/<section>.md` (ICELOT + progressive disclosure,
following the entry-points brief exemplar) before/alongside build.

| Route | Closest designed screen to derive from | Owning lane |
|---|---|---|
| `/auth` | Design-language only (no dashboard chrome) | ui-scaffold |
| `/codebases/:projectId/capabilities` | Repo overview | page-codebase |
| `/codebases/:projectId/entities` | Flow List (table pattern) | page-entities |
| `/codebases/:projectId/entities/:entityId` | Flow Overview (detail pattern) | page-entities |
| `/codebases/:projectId/architecture` | Repo overview | page-codebase |
| `/codebases/:projectId/dependencies` | Repo overview (Repositories/external services block) | page-codebase |
| `/codebases/:projectId/entry-points` | Flow List (table pattern) — CANONICAL BRIEF EXISTS: `apps/app/docs/briefs/entry-points-design-brief.pdf` | page-entry-points |
| `/codebases/:projectId/entry-points/:entryPointId` | Flow Overview (detail pattern) — see canonical brief above | page-entry-points |
| `/codebases/:projectId/functions` | Flow List (table pattern) | page-functions (if claimed) / page-codebase |
| `/codebases/:projectId/functions/:nodeId` | Flow Overview (detail pattern) | page-functions (if claimed) / page-codebase |
| `/codebases/:projectId/integrations` | Repo overview (Repositories/external services block) | page-codebase |
| `/codebases/:projectId/deployables/:dasUnitId` | Flow Overview (detail pattern) | page-deployable |

## Notes

- Sidebar navigation, topbar (breadcrumb + search/notifications/avatar), and card/table primitives
  repeat across every designed screen — build them ONCE in `src/layout/` (AppShell, PageHeader) and
  `src/components/` (shared cards/tables), not per-page.
- `1647:37709` (Repo overview) and `1982:5977` (Flow Overview) are large frames (3311px tall) —
  page lanes should pull `get_design_context` scoped to sub-frames within them rather than the
  whole frame at once to avoid oversized tool responses.
- Screens/regimes above are current as of this scaffold pass. If a page lane discovers an
  additional Figma frame not listed here, update this table rather than silently diverging.
