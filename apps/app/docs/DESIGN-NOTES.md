# Design Notes

Log of design-fidelity decisions per apps/app/docs/LANE-COMMON.md's DESIGN FIDELITY RULE. Figma is
the bible, and fidelity is bidirectional: nothing goes into a **designed** route (see
SCREEN-MAP.md) that the Figma frame doesn't show, and every element the Figma frame DOES show must
exist in the build — including a designed element with no live API data yet, which still gets
built with an honest empty/placeholder state rather than omitted. Two kinds of entries belong here
instead of silent improvisation:

1. **Data gaps** — a designed (or self-evidently-implied) element is built, but the live API
   doesn't supply data for it yet. Log: screen, element, why the gap exists, data field(s) affected.
2. **API-offers-more** — the live API has data a designed screen's Figma frame doesn't show. Per
   the rule that data is NOT added to the UI; log it here so design can decide later whether the
   Figma should grow to include it.
3. **Derived-screen notes** — for routes with no Figma frame at all (see SCREEN-MAP.md's "Derived
   routes" table), note which designed screen(s) they were derived from; the full design contract
   for a derived route lives in its own DESIGN BRIEF at `apps/app/docs/briefs/<section>.md`
   (following the entry-points brief exemplar), not here.

Each page lane's report also carries an element-coverage checklist (Figma element -> built Y/N) for
its designed route(s) — this file is the durable log, the report is the point-in-time proof.

## entry-points lane (page-entry-points)

### No Figma design exists for these routes
Checked the 5 screens named in LANE-COMMON.md's Figma section (file `Ux2aXXgq4jzD9T4TZaDAw8`):
node-ids 1698-13626 ("Home"/dashboard), 1748-6595 ("Workspace"), 1647-37709 ("Repo overview"),
1982-5977 ("Flow Overview"), 2030-31178 ("Flow List"). None is an entry-points list or detail
screen. `/codebases/:projectId/entry-points` and `.../entry-points/:entryPointId` are therefore
**undesigned** — derived from the design language (LANE-COMMON.md's binding tokens/stroke
system/geometry system) plus the two closest designed screens:
- **Flow List** (2030-31178): the catalog pattern I mirrored for the entry-points list —
  breadcrumb row, search bar with a shortcut hint, a row of filter badges (Tags/Type/Sort ->
  mine: Family/Kind/Deployable), a bordered "Table" card with a header row (title + count badge)
  and per-row chevron affordance into the row's detail.
- **Flow Overview** (1982-5977): the detail pattern I mirrored for the entry-point detail page —
  header block (name + status badge + a primary "jump to X" button), a horizontal quick-stat pill
  row directly under the header (Flow Overview's Functions/Entities/Services/Systems/Contributors
  counts -> mine: kind, family, deployable, protected/open), then stacked bordered card sections
  each with a title + one-line description, closing with an "External systems" style card
  (Flow Overview's "System Effects") that I use for the capabilities-lens list.
  Flow Overview also has an actual `Entry Points` section at its own bottom (a card titled
  "Entry Points" with subtitle "External services and stage changes present in this flow" — the
  same placeholder subtitle text as the "System Effects" card above it, i.e. a copy-paste
  placeholder in the mock, not real designed copy). That section's card shape (bordered list of
  named rows) is what I reused for two of my own cards: the input/output field lists and the
  capabilities list.
Per LANE-COMMON's rule for undesigned pages, no new design brief was written for these
routes — the existing canonical `apps/app/docs/briefs/entry-points-design-brief.pdf` already
serves that role for this exact page; writing a second brief for the same page would duplicate it.

### Deployable switcher has no Figma precedent
Neither designed screen scopes data by deployable (Flow List scopes by codebase only, one
workspace at a time via the left nav). The brief is explicit that entry points are per-deployable
with a switcher (`apps/app/docs/briefs/entry-points-design-brief.pdf`, "the viewer is always
looking at *one* deployable, with the ability to switch to another"). Built as a compact select
control beside the page title, matching the badge/dropdown visual weight used for Flow List's
Tags/Type/Sort badges (same bordered-pill affordance) since no closer analog exists.

### Family mix summary has no Figma precedent
Neither designed screen shows a "shape before the rows" summary. Built as three stat cards above
the table (count + label), reusing the exact quick-stat-pill visual language from Flow Overview's
header row (bordered pill, number + label, one line) since the brief calls this the single most
important structure in the dataset ("a reviewer reads the shape before reading a single row").

### Telemetry is present-sometimes, absent-others (brief, "The live layer")
No designed screen shows a telemetry block. Built as an optional fourth section on the detail
page using the same quick-stat-pill pattern as the family mix / header stats, and it is fully
omitted (not rendered as empty) when the entry point carries no telemetry, per the brief's "design
the entry-point row to look complete without them, and better with them."

### Telemetry has no wired data source yet — data gap
`CASEntryPoint` (packages/analyzer-core/src/types/cas.types.ts) carries no `request_count` /
`error_rate` / `p50/95/99` fields, and `GET /api/projects/:id/cas` does not join runtime telemetry
onto entry points today (telemetry ingestion exists — `ingest_telemetry`/`get_runtime_observations`
MCP tools — but nothing joins it onto the served CAS entry-point records). `useEntryPoints.ts`
reads it defensively from `entry_point.metadata.telemetry` (metadata is a free-form
`Record<string, any>` already on the type) so the UI is forward-compatible the moment a backend
lane wires it in; until then `TelemetryCard` never renders for any entry point (the honest
"absent" state the brief calls for, not a fake zeroed panel). Affected fields: request_count,
error_rate, p50_ms, p95_ms, p99_ms.

### Flow linking is best-effort — data gap
The brief's "every entry point opens into a flow" pairing has no direct `flow_id` on
`CASEntryPoint` — the only link is `FlowConcept.entry_point` (a string on the flow, pointing back).
`useEntryPointFlow.ts` matches by entry point id / source node against
`getProjectConceptual(...).flows.flows[].entry_point`; when no flow matches, `FlowCard` shows an
honest "no flow linked yet" state rather than guessing. The flows lane (page-flows, unclaimed as
of this build) may want a sturdier id-based join later.

## page-workspace lane

Element-coverage checklist for the Workspace screen (node 1748:6595) is in the lane report; this
section is the durable data-gap/API-offers-more log per the rule above.

### Sidebar/topbar/breadcrumb are AppShell's scope, not this page's
The Figma frame's left nav, top breadcrumb ("Home > [icon] Soon > star"), and search/bell/avatar
row repeat identically across all 5 designed screens and are built once in AppShell (ui-scaffold) —
same boundary CodebaseHeader documents for the Repo overview screen. `WorkspacePage` renders the
content region only.

### No designed surface for applications/deployables, merged_into folding, or DAS badges — API-offers-more
The WAS graph's `applications[]` (with `merged_into`/`also_declared_by`/`source_das_unit_id`) is
real, richer data the Figma "Workspace" frame does not show anywhere — the frame's only repository-
shaped section is "Repositories", which reads as the codebases list (WAS `codebases[]`), not
per-application rows. Per the DESIGN FIDELITY RULE nothing is added to the UI beyond the frame, so
this page renders codebases only; `applications[]` (merged_into exclusion, DAS badge linking to a
deployable route) is unused here. Logged so design can decide whether the Repositories card (or a
new section) should grow to carry per-application/deployable detail and DAS provenance.

### System Map has no coordinate data — built as chips + a relationship list, not a spatial diagram
The Figma "System Map" card lays nodes at fixed x/y canvas positions with drawn connector arrows.
The WAS graph's `runtime_components`/`runtime_links` carry no layout coordinates, so a pixel-
faithful diagram isn't data-driven buildable. Built as: the exact card shell (title, subtitle, zoom
control row, all non-interactive placeholders) with components as a wrapped chip row and
`runtime_links` as a compact "A -> B" list — this is where the brief's "runtime_links as a
first-class relationship list" requirement lives, inside the one designed element for system
topology rather than as a second, undesigned section.

### System Complexity has no scoring data — data gap
No field in the served WAS graph computes a complexity score, 0-100 scale, or a trend delta. Built
as the exact card shell (title, subtitle, icon) with an honest empty state in place of the metric.
Affected: a workspace-level `complexity_score`/`complexity_trend` field would need to exist on the
graph (or `health.score` would need to be repurposed and relabeled, which was avoided here since
"complexity" and "health" are not the same claim).

### Change Activity has no itemized event feed — data gap, component reused from page-dashboard
Same gap page-dashboard logged for the "Home" screen: no REST surface serves discrete change events
(actor + title + relative time) to the web app. `ChangeActivityPanel` (page-dashboard) is imported
and reused here as-is rather than duplicated — the Figma title/subtitle text is byte-identical
across both screens, and the empty-state shell is generic. Adopted, not forked.

### GitHub badge next to the title has no workspace-level analog — data gap
The mock pairs the title with a "GitHub" badge/link. A workspace has no single source repository
(it aggregates N member codebases), so this is built as a generic non-interactive "Workspace" chip
rather than a fabricated or arbitrarily-chosen link to one member's repo.

### Contributors stat and per-repository "Assignees" use an untyped-but-real graph field
`api.ts`'s `WorkspaceAnalysisResponse` type doesn't declare `analysis.activity.contributors`, but
the served envelope is `record.graph` verbatim (the full `CrossCodebaseSystemGraph` from
`apps/mcp-server/src/cross-codebase-analysis.ts`, which does carry `activity.contributors[]`).
`workspaceHelpers.getGraphExtras` reads it defensively (grounded in the server source, not guessed)
rather than duplicating it into `api.ts`. Same pattern for `summary.workflows` (backs the header's
"Flows" stat) and `inputs[]` (backs per-repository freshness/"Last analyzed").

### No designed Rebuild/reanalyze action on this screen
The brief calls for a "Rebuild via reanalyze mutation" affordance for degraded/errored enrichment.
The Figma frame shows no such control anywhere on the Workspace screen (unlike the Repo overview
screen's header, which has an explicit "Re-Analyze" button). Per the DESIGN FIDELITY RULE, no button
was added. The one liberty taken: the existing "Updated X ago" status dot's color reflects
`enrichment.status` (success/warning/error/neutral) and its tooltip text explains why, since that
enriches an EXISTING element's information rather than adding a new one. `useReanalyzeWorkspace`
(ui-scaffold) is not wired to anything here. Flagged because a past live incident (per
LANE-COMMON.md) came from a failure being invisible in the UI — design should decide where a
rebuild affordance belongs on this screen.

### merged_into folding has no UI surface to test directly
Because applications/deployables aren't rendered on this screen (see above), there is no
merged_into-folding UI behavior to assert. `WorkspacePage.test.tsx`'s "excludes merged_into
application rows" test instead asserts the *absence* of any application-derived content — the
fixture includes a merged_into row and the test proves only the two real codebases render as
repository cards.

## page-dashboard lane (page-dashboard)

Route `/`, Figma "Home" (file `Ux2aXXgq4jzD9T4TZaDAw8`, node 1698:13626) — a **designed** screen
per SCREEN-MAP.md. Sidebar navigation and topbar (breadcrumb/search-bell/avatar) are the
ui-scaffold lane's AppShell (node 1698:14082 / 1698:13629); this lane owns the content region only
(node 1698:13654 onward): greeting header, global search input, Jump Back In, Workspace list, and
the Change Activity panel.

### "Jump Back In" stats have no data source — data gap
The Figma card shows a Lines / Capabilities / Contributors stat row and a "Last Opened Xh ago"
timestamp for the most recently touched project. None of these exist in the API surface consumed
by the web app:
- **Last Opened** implies per-user view/click history — no such tracking exists anywhere
  (`api.ts` has no "viewed_at"/"opened_at" concept). The card instead targets the project with the
  most recent successful analysis (`ProjectRevision.generated_at`, from `loadAppData`'s
  `revisionsByProject`) as the closest honest substitute for "the thing you were just working on,"
  but the "Last Opened" field itself renders as an honest "—" rather than repurposing an analysis
  timestamp under a label that implies something it isn't.
- **Lines** (lines of code) has no matching field — `ProjectRevision` has `files`/`bytes`/`nodes`/
  `edges`, none of which is a line count.
- **Contributors** has no matching field anywhere in `api.ts` (no VCS-author aggregation exposed).
- **Capabilities** IS available (`AnalysisSummary.capabilities` via `getProjectAnalysis`) but
  wiring it in means an extra per-project fetch scoped to just this one card; deferred rather than
  adding an ad hoc hook no other lane declared. Renders "—" for now alongside the other two.

Affected fields: `lines`, `capabilities`, `contributors`, `last_opened_at` — none of which exist on
`Project` / `ProjectRevision` / `AnalysisSummary` in a directly consumable shape except
`capabilities` (partially, see above).

### Workspace card domain subtitle depends on a per-card analysis fetch
Figma shows a one-line "domain" under each workspace name (e.g. "Commerce Platform",
"Cybersecurity", "SaaS"). `Workspace` (the `/api/workspaces` list response) has no domain field;
the closest real source is `WorkspaceAnalysisResponse.analysis.workspace_narrative.domains[0]`,
which requires one `GET /api/workspaces/:id/analysis` call per card (`useWorkspaceAnalysis`,
bounded by however many workspaces the account has). `WorkspaceCard.tsx` renders the subtitle only
when that analysis has resolved with a domain; while pending or absent, the subtitle line is simply
omitted (not a fake placeholder) — an honest partial-data state, not a data gap requiring backend
work, since the field does exist, it's just a second round trip away.

### "Change Activity" panel has no backing data source — data gap
Figma's right-column panel (node 1859:9587, "Change Activity" / "Recent changes across your
system") shows a timeline of change events: title, author, an accent-highlighted impacted-scope
line (e.g. "Payment service - 3 impacted services"), and a relative timestamp, grouped per
workspace. Nothing in `api.ts` serves this. `apps/mcp-server` has `get_changes_since` /
`get_changes_between` as MCP tools (analysis-to-analysis diffing) but they are not exposed over
REST for the web app, and none of them carry human-authored change titles or author attribution —
that would need a real changelog/audit-event backend, not just a diff computation. Built the
panel's exact shell (title + subtitle from Figma) with the shared `EmptyState` component in place
of the timeline rather than fabricating sample activity. Affected: the entire timeline — change
title, author, workspace badge, impacted-scope description, and relative timestamp.

### Global search has no backend — data gap
Figma's search input ("Search workspace, repositories, entities...") implies a real search index
across workspaces/repos/entities. No `/api/search`-shaped endpoint exists. Built the input and the
⌘K/Ctrl+K focus shortcut for real (both are genuinely functional), backed by a stub hook
(`useGlobalSearch`) that tracks the query and always returns zero results — the component contract
won't need to change once a real search endpoint exists.

## integrations lane (page-integrations)

### No Figma design exists for this route
Checked the same 5 screens (file `Ux2aXXgq4jzD9T4TZaDAw8`, node-ids 1698-13626, 1748-6595,
1647-37709, 1982-5977, 2030-31178). None is a dependencies/exit-points/integrations screen.
`/codebases/:projectId/integrations` is **undesigned** — derived from the design language plus the
Entry Points screen's own layout (itself derived, per that lane's note above, from Flow List/Flow
Overview): a page header, a row of family-count chips ("shape before the rows", mirroring the
entry-points family mix), then bordered card sections per data area. A full design brief
(`apps/app/docs/briefs/integrations.md`, following the entry-points brief exemplar) is the design
contract for this page, per LANE-COMMON's rule for undesigned pages that aren't already covered by
an existing brief.

### Exit-point family taxonomy has no Figma or brief precedent
LANE-COMMON.md's Dependencies-rung instruction names four families (db/sdk/api/messaging) but the
analyzer's `CASExitPointType` union has 11 kinds, several of which (navigation, client_storage,
analytics, file) don't cleanly fit any of the four. Rather than force them into an existing family
or drop them, `exitPointFamilies.ts` adds a fifth "Device & client" family — same fixed-and-complete
discipline as the entry-point family vocabulary (every kind has exactly one family, a family with
zero members simply doesn't render). This repo's analysis has zero exits in that family today.

### Communication seams render only sync/async, not the full seam model — data gap
`mcp__klauro__get_communication_seams` computes a richer server-side model (sync/async/**passive**
shared-state coupling, confidence scores, component-to-component rollups) but that computation
isn't joined onto `GET /api/projects/:id/cas` — the route returns the analyzer's raw CAS output,
which carries `CASExitPoint.operation.async` per exit point and nothing else seam-shaped.
`CommunicationSeamsSummary` derives a sync/async count from that one field only; the passive
shared-state modality (e.g. two services both writing the same DB table with no direct call) is
invisible to this page until a backend lane joins the seam computation onto the CAS response.
Affected: the whole "passive" modality and its evidence/confidence fields.

### "Internal vs external" libraries reframed as "Runtime vs Development" — data reality
LANE-COMMON's brief for this lane says libraries should distinguish "internal vs external." Neither
`CASLibrary` nor `CASDependencyManifest` (packages/analyzer-core/src/types/cas.types.ts) carries a
same-workspace/local-package flag — the only evidence-backed split in the data is `CASLibrary.type`
/ `CASDeclaredDependency.scopes` (production/development/peer/optional/runtime/dev/peer/optional/
build). `LibrariesList` labels this split "Runtime" vs "Development" rather than "Internal" vs
"External" so the UI never claims a distinction the analyzer doesn't actually make. A monorepo-
workspace-package detector would need to ship in the analyzer before this page could label true
internal (first-party, same-repo) dependencies separately from third-party ones.

## page-functions lane (page-functions)

Routes `/codebases/:projectId/functions`, `.../functions/:nodeId`, `.../functions/file/*` —
**derived**, per SCREEN-MAP.md's "Derived routes" table (Flow List / Flow Overview as the closest
designed screens). Full design contract: `apps/app/docs/briefs/functions.md`.

### The file view has no SCREEN-MAP.md entry at all
`/codebases/:projectId/functions/file/*` (a file's nodes grouped by type) isn't listed in
SCREEN-MAP.md's derived-routes table — it's this lane's own addition, needed to serve the "file's
other nodes" relationship the task specification calls for as a first-class link target from the
node detail page, not just an inline list. Derived from the same Flow Overview bordered-card-of-
named-rows pattern the entry-points lane already established for its own relationship lists
(`RelationshipList` here deliberately mirrors that shape). If SCREEN-MAP.md is updated by a later
pass, this route should be added to it.

### No server-side node search endpoint — data gap
`GET /api/projects/:id/cas` (`apps/mcp-server/src/remote-analyzer-service.ts`) is the only route
serving node data; it returns the entire analysis (49,492 nodes / 57,469 edges on this repository's
own analysis) in one response. There is no `?search=`/`?type=`/`?file=` route. `useFilteredNodes`
(`src/hooks/useFileNodes.ts`) is written as a thin client-side selector over the one cached payload
specifically so a real search endpoint can be swapped in underneath its call sites later without
changing `FunctionsPage`. Until then, every codebase this view is opened against pays the full
payload's network cost once (react-query-cached thereafter) — an honest, real limitation, not a
design choice. See `docs/briefs/functions.md`, "The shape of the real data," fact 01.

### Change risk and temporal stability are per-node, sparse, and read from sibling arrays
`CASChangeRisk` and `CASTemporalStability` (packages/analyzer-core/src/types/cas.types.ts) are NOT
nested on `CASNode` — they're separate top-level CAS arrays keyed by `node_id`. `useNode.ts` joins
them client-side (`changeRiskById`/`stabilityById` maps built once in `useFileNodes.ts`). Most
nodes have neither field computed; `RiskStabilityCard` renders nothing at all when both are absent
— the same "absent is a real, honest case" stance `TelemetryCard` takes for entry points, not a
fake "not computed" panel.

### Callers/callees can point at nodes that aren't independently browsable
A `calls` edge's source or target sometimes resolves to a synthetic exit-point node (e.g. an
external `fetch()` call) rather than a node in the browsable set (`type: 'file'` nodes and any id
not present in the loaded node index). `useCallers.ts`/`useCallees.ts` keep the row and its edge
metadata (id, line, method name) either way; `RelationshipList` renders it without a chevron/click
target when it can't resolve to a real node, instead of silently dropping a real edge.

### No custom per-type icon system, unlike EntryKindIcon
The entry-points lane built `EntryKindIcon` against a small, fixed, ~20-value kind vocabulary
(`ENTRY_POINT_TYPES`). Node `type` here has no equivalent fixed vocabulary — it's open, analyzer-
authored free text across 45+ languages (docs/briefs/functions.md, "The mental model"). Building a
bespoke outlined-geometry icon per type doesn't fit an open vocabulary the way it fits a closed
one, so this lane renders `type` as a plain outlined `Chip` label instead. If a future pass
introduces a normalized, closed node-kind taxonomy, a shared `NodeKindIcon` could follow
`EntryKindIcon`'s pattern at that point.

## entities lane (page-entities)

### No Figma design exists for these routes
Checked the same 5 screens (file `Ux2aXXgq4jzD9T4TZaDAw8`, node-ids 1698-13626, 1748-6595,
1647-37709, 1982-5977, 2030-31178). None is an entities list or detail screen — SCREEN-MAP.md marks
`/codebases/:projectId/entities` and `.../entities/:entityId` **derived**, from Flow List's table
pattern and Flow Overview's detail pattern respectively (the same two screens the entry-points lane
mirrored). Reused that lane's own already-mirrored shapes directly rather than re-deriving from the
raw Figma frames a second time: the bordered "Table" card with header row + count + per-row
click-into-detail (`EntryPointTable` -> this lane's `EntityTable`), and the stacked bordered
card-section detail layout (header block, then sectioned cards each answering one question).
Per LANE-COMMON's rule for undesigned pages, a full design brief was written:
`apps/app/docs/briefs/entities.md`, following the entry-points brief exemplar (plain language, what
the data IS, ICELOT-style progressive disclosure, who-looks-and-why, data realities).

### ERD is built from `database_schema`, not a graph library or a new endpoint
`get_erd` (the MCP tool) reshapes `cas.database_schema` server-side; no HTTP route reshapes it the
same way, but `GET /api/projects/:id/cas` already returns the full CAS including the raw
`database_schema.entities[].relationships[]` (OneToOne/OneToMany/ManyToOne/ManyToMany, evidence-
gated — every edge is a real ORM relation, never a guessed one from a field name). `ERDCanvas` reads
that directly, avoiding both a second backend route and a client-side reimplementation of the
edge-extraction walk `buildEntityRelationIndex` does server-side (which would be the "second flow
algorithm" LANE-COMMON.md's sibling deployable-lane note warns against). Layout is a small pure
function (`erdLayout.ts`) — no graph library — clustering into module columns once past 10 entities.

### Semantic role (core/supporting/infrastructure) is intentionally not shown — not a gap
`get_data_entities` (MCP tool) and its REST mirror `GET /api/projects/:id/entities` both compute a
per-entity `role`/`role_evidence` classification, but that classification is NOT stored on the CAS
itself — it's derived on the fly in `query.ts`'s `classifyEntityRole`, which needs
`cas.domain_concepts` plus a relation index this lane would have to rebuild client-side to
reproduce. Since this lane reads `cas.data_entities` directly (not the paginated `/entities` REST
route — see below) and the task brief doesn't ask for role, it's simply not shown, rather than
half-reproducing a classifier. A future lane wanting role would need either a dedicated endpoint
that reuses `getDataEntities`'s server-side computation, or to accept the `/entities` route's
pagination cap.

### Reading raw `cas.data_entities` instead of `GET /api/projects/:id/entities` — data reality
The REST `/entities` route exists and mirrors the `get_data_entities` MCP tool, but its per-entity
projection (`query.ts` `getDataEntities`) omits `kind`/`kind_source` entirely (dropped when
building the summarized response) even though `CASDataEntity.kind` — the ORM/DTO/API-response/
value-object evidence this lane's "evidence kind" column needs — is present on the raw entity. It
also samples `lifecycle_summary.*_sample` to 3 entries and `relations` to 10, and pages at a 100-
entity ceiling. This lane instead reads `cas.data_entities` / `cas.database_schema` straight off
`useProjectCas` (the same whale-payload convention the entry-points lane established for
`cas.entry_points`), which carries `kind` and the FULL lifecycle arrays with no sampling — better
fidelity than the paginated route today, at the cost of no server-side pagination (mitigated
client-side per docs/briefs/entities.md's data-reality notes on repos with 100+ entities).

## page-codebase lane (page-codebase)

Route `/codebases/:projectId` (CAS home) and its children. SCREEN-MAP.md's "Repo overview"
(node 1647:37709) is the Figma frame for the Overview destination (`CodebaseOverview.tsx`,
rendered at the index/`overview` child route); `/capabilities`, `/architecture`, `/dependencies`
are **derived** from it. `/flows` and `/flows/:flowId` are the **designed** "Flow List"
(2030:31178) and "Flow Overview" (1982:5977) screens — this lane built a first version under the
SCREEN-MAP.md fallback ("page-flows (if claimed) / page-codebase", unclaimed at the time) at
`pages/codebase/CodebaseFlows.tsx`/`FlowDetailPage.tsx`. A dedicated `page-flows` lane then
claimed the route and landed real implementations at `src/pages/flows/FlowsListPage.tsx` /
`FlowDetailPage.tsx`; `router.tsx` was repointed there (see its own comment on the `CodebaseFlows`
import). This lane's fallback files were deleted once superseded, per the fabric protocol's "do
not create a duplicate" — no functionality was lost, `/flows` and `/flows/:flowId` now render
page-flows' build.

### Router shape: a shell + child routes, not a single scrolling page
The Figma "Repo overview" frame renders header + stat row + all five numbered sections
(Capabilities/Critical Flows/Key Entities/Architecture/Dependencies) as one continuous scroll with
no visible tab bar. But `router.tsx` (landed mid-build by ui-scaffold) nests
`CodebaseOverview`/`CodebaseCapabilities`/`CodebaseFlows`/`CodebaseEntities`/`CodebaseArchitecture`/
`CodebaseDependencies` as SEPARATE child routes of `CodebasePage`, matching LANE-COMMON's original
brief for this lane ("SECTION NAV implementing the progressive-disclosure ladder"). Reconciled by
building `CodebaseOverview.tsx` as the literal Figma page (all five sections, each a PREVIEW linking
to its own full route via a "See all" affordance the Figma frame itself shows at the top-right of
each section header) and adding `CodebaseSectionNav.tsx`, a tab bar with no Figma precedent —
derived from the design language's `MuiTabs` theme overrides (already defined in `src/theme/index.ts`)
since the router contract requires SOME way to reach the child routes and no designed screen shows
one for this exact shell.

### Element-coverage checklist — "Repo overview" (node 1647:37709)
- Status badge "Updated X ago" — built (`CodebaseHeader.tsx`, from `summary.analysis_timestamp`).
- Title + type badge — built (`summary.name`, `summary.type`).
- Description — built (`summary.description`).
- Edit Summary / Re-Analyze buttons — built; Edit Summary has no wired action yet (no
  edit-description endpoint exists in `api.ts` — data gap, see below); Re-Analyze calls
  `useReanalyzeProject` (ui-scaffold's hook).
- 4-card stat row (Capabilities/Entry points/Contributors/Codebase age) — built
  (`CodebaseStats.tsx`); Contributors and Codebase age render an honest "—" (data gap, below).
- Section 01 Capabilities (icon/name/description/flow-count/entity-count cards, "See all") — built
  (`CapabilitiesSection.tsx`/`CapabilityCard.tsx`).
- Section 02 Critical Flows (name/role/entry-point/step-count rows, "See all") — built
  (`CriticalFlowsSection.tsx`).
- Section 03 Key Entities (name cards, "See all") — built (`KeyEntitiesSection.tsx`), name-only
  (data gap, below).
- Section 04 Architecture (system type + diagram + pattern chips, "See all") — built
  (`ArchitectureSection.tsx`); diagram is an honest placeholder (data gap, below).
- Section 05 Dependencies (external-service chips, "See all") — built (`DependenciesSection.tsx`)
  as an honest empty state (no data source at all, below).

### Capability cards merge TWO independent, non-overlapping API sources — not a UI choice
Figma's capability card shows an icon, name, description, flow count, and entity count. No single
API response carries all of that: `ConceptualResponse.capabilities` (`GET /api/projects/:id/conceptual`)
has `id`/`name`/`category`/`criticality`/`related_flows` but NO description or entity list;
`ProjectAnalysisResponse.product_map.capabilities` (`GET /api/projects/:id/analysis`) has
`name`/`description`/`category`/`criticality`/`entities: string[]` but NO flow linkage. `casSummary.ts`'s
`mergeCapabilities` joins the two by case-insensitive name so a card can show both real description
and real flow/entity counts; when a capability only exists on one side, the missing fields render as
an honest "No description available yet." / "—". Icon assignment itself is a fixed rotating decorative
palette (`CapabilityCard.tsx`) — Figma assigns a distinct hue per card with no visible data mapping
(6 cards, 6 different colors, no repeats), so there is nothing to join it to.

### Contributors and Codebase age stat cards — data gap
Figma shows "67 · Active in last 90 days" and "2y 3m · 48.2k Lines - 443 files". Nothing in `api.ts`
carries a contributor count, a commit-derived repo age, or a lines-of-code total — `AnalysisSummary`
(`query.ts` `buildSummary`) has no such fields, and `ProjectRevision` (`/v1/projects/:id/revisions`)
has `files`/`bytes`/`nodes`/`edges` but no author/VCS-history aggregation. `CodebaseStats.tsx` renders
both cards with an honest "—" value; Codebase age's caption falls back to `{total_files} files` (real,
from `architecture_summary.total_files`) when the line-count/age themselves aren't available, rather
than omitting the whole card. Affected fields: contributor_count, active_in_90_days, repo_age,
lines_of_code.

### Key Entities preview is names-only — data gap
`AnalysisSummary.database_entities` (the only entity data on `GET /api/projects/:id/analysis`) is a
flat `string[]` of names — no kind, field count, or reader/writer counts, which the entities lane's
richer `GET /api/projects/:id/entities` route or the raw `cas.data_entities` carry. Since the full
entity model is that lane's owned surface (`/entities`, see "entities lane" notes above), this
section stays a lightweight name-chip preview rather than duplicating their fetch; "See all Entities"
links to their route for the real detail.

### Architecture / Flow-detail diagrams are honest placeholders — data gap
Figma's "System Connection Map" / "Architecture Diagram" (node-link visualizations, both on the Repo
overview's Architecture section and the Flow Overview screen) have no live component/connection graph
served over HTTP — `AnalysisSummary.architecture_summary` carries pattern/inventory/layer data but no
node-link topology, and `FlowConcept` carries `steps`/`contract`/`entities` but no visual layout graph.
Both `ArchitectureSection.tsx` and `FlowDetailPage.tsx` render a bordered dashed panel with an icon and
an explanatory caption in the diagram's place — built, not omitted, per the DESIGN FIDELITY RULE's
"honest empty/placeholder state" allowance — rather than fabricating a fake node graph.

### Dependencies section has NO web-API route at all — data gap
Neither `GET /api/projects/:id/analysis` nor `/conceptual` nor `/cas` (checked
`apps/mcp-server/src/remote-analyzer-service.ts` for `external_services`/`external-services`/
`/dependencies`/`getExternalServices`/`getDependencies` — zero matches) exposes external-service or
dependency data over HTTP; `get_external_services`/`get_dependencies` exist as MCP-only tools today.
Both the preview section and the full `/dependencies` page render a genuine, permanent-until-wired
empty state (`EmptyState`/a dashed panel) rather than fabricating Stripe/Postgres/Auth0-style chips
from nothing. A future backend lane would need a new `GET /api/projects/:id/dependencies` route
wrapping those MCP tools before this section can show real data.

### Flow List table omits three Figma columns with no data source — data gap
Figma's "Flow List" screen (2030:31178) shows NAME / TYPE / CAPABILITIES / # OF STEPS / AVG
USER/MONTH / AVG BUGS/MONTH / EXECUTION TIME. `FlowConcept` (the only flow data model reachable over
HTTP, via `/conceptual`) has no per-flow usage, defect, or timing telemetry — those would require a
runtime/observability join (`get_runtime_observations`-shaped) that doesn't exist for flows today.
`CodebaseFlows.tsx` renders Name/Type/Capabilities/# of steps only; the three missing columns are
omitted rather than shown as fabricated zeros.

### Edit Summary action has no backend endpoint — data gap
The button exists on the Figma header (next to Re-Analyze) but no `PATCH`/`PUT` route on
`/api/projects/:id` accepts a description/summary edit. Rendered but inert (no `onClick`) until such
a route exists.

## page-deployable lane (page-deployable)

### No Figma design exists for this route
Checked the same 5 screens (file `Ux2aXXgq4jzD9T4TZaDAw8`, node-ids 1698-13626, 1748-6595,
1647-37709, 1982-5977, 2030-31178). None covers a DAS unit picker or drilldown.
`/codebases/:projectId/deployables/:dasUnitId` is **undesigned** — derived from the design
language plus the entry-points lane's per-deployable switcher (`DeployableSwitcher.tsx`, itself
undesigned): a page header with a bordered-pill `Select` switcher in the actions slot
(`DasUnitPicker.tsx`, hidden below 2 units, same as its precedent), then stacked bordered card
sections in disclosure order (overview -> ship evidence -> bundled members -> entry points &
capabilities -> entities & files -> orphan notice), reusing the entry-points catalog's
`EntryPointTable` directly for the entry-points section. A full design brief
(`apps/app/docs/briefs/deployables.md`, following the entry-points brief exemplar) is the design
contract for this page.

### The true DAS-scoped surface is MCP-only — data gap
`GET /api/projects/:id/cas` returns the full, repo-wide `CASOutput` — it does not expose
`das_index`, per-unit `node_count`/`entry_point_count`/`exit_point_count`, or orphan-node
accounting, all of which `apps/mcp-server/src/deployable-analysis.ts`'s
`buildDeployableAnalyses` computes via a call-graph reachability closure (and only the MCP
`get_summary` tool's `scope` parameter can retrieve). This lane does NOT reimplement that
closure client-side (that would be the "second flow algorithm" LANE-COMMON.md forbids). Instead:
- `src/pages/deployable/dasIndex.ts` reproduces the much smaller, purely evidence-based
  **promotion rule + id scheme** (`tierQualifiedShipUnits`/`shouldPromote`/`buildDeployableRoots`)
  against `cas.deployable_evidence`, which the HTTP payload DOES carry in full — so the picker's
  units and ids are exact, not approximate.
- `src/pages/deployable/dasScope.ts` scopes entry points/capabilities/files/entities to a unit by
  **existing root-path attribution** (`EntryPoint.deployable_id`, already computed server-side by
  `entry-point-deployable.ts` and present on the HTTP payload's entry points) and by matching
  `CASNode.source.file` against the unit's root paths — an honest approximation of the true
  slice, not the slice itself. Counts can differ from the MCP-scoped view for code genuinely
  shared between two units, which only the real closure algorithm tags.
- `src/pages/deployable/DasOrphanNotice.tsx` renders an explicit "not available over HTTP yet"
  notice rather than a fabricated or omitted orphan count.
Affected fields: `das_index` (server has it, HTTP doesn't expose it), `DasUnitSlice.slice.nodes/
entry_points/exit_points` (reachability-closure-scoped), `DasIndex.orphan_node_count`/
`orphan_node_ids`. A future backend lane adding a `GET /api/projects/:id/cas?scope=<das_unit_id>`
(or dedicated `/deployables` HTTP route) would let this page drop its approximation layer
entirely in favor of the real slice, using the same unit ids it already computes today.

## page-flows lane

Routes `/codebases/:projectId/flows` (Figma "Flow List", node 2030:31178) and
`/codebases/:projectId/flows/:flowId` (Figma "Flow Overview", node 1982:5977) — both **designed**
per SCREEN-MAP.md. Claimed after page-codebase had already shipped a minimal fallback
(`src/pages/codebase/CodebaseFlows.tsx` + `src/pages/codebase/FlowDetailPage.tsx`, built while
page-flows was unclaimed, per their own header comments). `src/router.tsx`'s `flows`/`flows/:flowId`
routes were repointed to `src/pages/flows/FlowsListPage.tsx` / `FlowDetailPage.tsx`; the
page-codebase fallback files are left in place as dead code for that lane to remove, rather than
deleted outside this lane's claimed paths. Both routes stay nested under `CodebasePage`'s
`CodebaseSectionNav` (Overview/Capabilities/Flows/Entities/Architecture/Dependencies tab strip) —
that nav is page-codebase's own already-derived, undesigned chrome (see their entry below/above),
analogous to AppShell's sidebar/topbar: shared navigation around a designed screen's content, not
part of the designed frame's own element inventory, so keeping it does not violate bidirectional
fidelity for the content beneath it.

`useFlows.ts`/`useFlow.ts` deliberately do not issue their own fetch — they select over
page-codebase's already-shipped `useProjectConceptual` (GET `/api/projects/:id/conceptual`), so the
flows pages and the CAS-home Capabilities/Critical-Flows sections share one react-query cache entry
per project rather than two identical requests.

### Element-coverage checklist — Flow List (2030:31178)
Header title/icon + freshness pill + description ✓ · search bar ✓ (placeholder adapted to
"Search flows…") · Tags/Type/Sort filter badges ✓ (Tags → entry-modality filter, see below) ·
table card with title+count badge ✓ · NAME column (icon + name) ✓ · TYPE column (role badge) ✓ ·
CAPABILITIES column ("N linked") ✓ · # OF STEPS column ✓ · AVG. USER/MONTH, AVG. BUGS/MONTH,
EXECUTION TIME columns — built, honest "—" (data gap, see below) · trailing row-action column —
built as row-click-to-navigate (no distinct dropdown menu affordance; see below).

### Element-coverage checklist — Flow Overview (1982:5977)
Freshness pill + flow name ✓ · description — adapted (flow.intent, not the codebase description
the mock shows; see below) · header stat row — adapted (role badge + 4 real pills, not the mock's
ambiguous 5-pill "42" row; see below) · step chain with per-step side-effect count ✓ · Current Step
legend dot ✓ · High/Medium Impact legend — omitted, data gap (see below) · System Connection Map ✓
(simplified static SVG, see below) with Entities/Used by/Services/External Systems/Downstream Flows
legend groups ✓ (Entities, External Systems real; Used by/Services/Downstream Flows honest-empty,
data gap) · Data card (Inputs/Outputs/Constraints) ✓ · System Effects card ✓ (generic icon tiles,
not brand logos — see below) · Entry Points card ✓ (real entry point + link, not the mock's
copy-paste placeholder body) · right-hand step inspector (Step N of M, description, Functions,
Inputs/Outputs) ✓.

### Tags filter interpreted as entry-modality filter — a design decision, not a data gap
The Flow List "Tags" filter badge has no bound content in the Figma mock. LANE-COMMON's task brief
asks for flows "grouped by entry modality"; rather than add a grouped-sections layout the Figma
doesn't show, this build wires "Tags" to filter by the entry-point kind derived from the flow's own
`entry_point` id prefix (`entry_<type>_...`) — delivering the modality requirement through an
existing filter slot instead of new UI.

### Row-action column has no clear precedent — data/interaction gap
Figma's trailing 80px column shows only a `Dropdown` instance with no visible menu items. No
per-row action is specified. Built as whole-row-click-to-navigate (matching the entry-points
table's convention) with no additional dropdown, since inventing menu items would be exactly the
kind of "add anything the design doesn't show" the fidelity rule forbids.

### AVG. USER/MONTH, AVG. BUGS/MONTH, EXECUTION TIME — data gap
`FlowConcept` (api.ts) carries no usage, defect, or latency metrics. Runtime telemetry exists
elsewhere in the system (`get_runtime_observations`, entry-point-level `telemetry` facet) but is
not joined onto flow or step contracts by the HTTP `/conceptual` route today. Built as an honest
"—" per cell with a tooltip explaining the gap, rather than omitted columns or fabricated numbers.

### Header description and stat row — adapted, not literal
The mock's description text under the flow name is the CODEBASE's own description (identical
wording to the Repo overview/Workspace screens' sample copy), not flow-specific content — a mock
authoring artifact, not intended design. This build shows `flow.intent` instead, the real
flow-scoped equivalent. The mock's stat-pill row repeats "42" across four of five pills (Figma
sample content, not distinct real metrics) — replaced with four pills this flow's own data
actually supports: steps, entities touched, capabilities linked, external integrations.

### High/Medium Impact step legend — data gap
`FlowStep` carries no impact/severity/complexity classification. Only the "Current Step" legend
dot is rendered; the Impact dots are omitted rather than invented.

### System Connection Map — reduced to a static SVG, and three legend groups have no backing field
Figma's map is the same interactive node-diagram pattern as the Workspace screen's System Map
(pan/zoom controls, draggable nodes). Built as a static, construction-stroke SVG (flow node with
entity/external-system satellites) per LANE-COMMON's own "simple SVG/flex chain" guidance for the
step-graph — no pan/zoom/drag interaction. Of the five legend groups Figma shows alongside the map,
only Entities (`flow.entities`) and External Systems (`contract.side_effects.external_integrations`)
have a backing field; "Used by" (flows that call into this one), "Services" (internal
service-to-service calls), and "Downstream Flows" (flows this one leads to) have no flow-to-flow or
flow-to-internal-service relationship anywhere in the API today — rendered with an honest
"not available yet" note per group, not hidden.

### System Effects tiles use generic icons, not brand logos
Figma's tiles show real brand marks (Stripe, PostgreSQL). The design language is explicit that
icons are "engineered symbols, outlined... never filled illustrations" — a brand logo is exactly
the filled-illustration case that rules out, so this build uses one consistent outlined icon per
integration tile instead of brand-specific art.

### Entry Points card body — mock content is a copy-paste artifact, already flagged once
The entry-points lane's own DESIGN-NOTES entry (above) already identified this card's mock body (a
Constraints-style bullet list, same placeholder subtitle text as the System Effects card above it)
as leftover component-reuse content, not real designed copy. This build reuses the card's SHAPE (a
titled bordered section) and fills it with the flow's real entry point — name, kind, address,
and a link to `/codebases/:projectId/entry-points/:entryPointId` — instead of replaying that
placeholder text.

### Capability M:N roles/rationale — task-brief requirement with no Figma coverage, flagged not dropped
LANE-COMMON's task brief for this lane explicitly asks for "capability M:N roles with rationale"
and a capability→flows lens. Neither Flow List nor Flow Overview shows such a section (checked via
`get_metadata`/`get_design_context` on both full frames — no "Capabilit*" text anywhere in either).
Per the binding DESIGN FIDELITY RULE ("do NOT add anything the design doesn't show"), no new section
was added for it. The data is fully computed and available (`useFlow.ts`'s `capabilityLinks`, and
the List page's "N linked" CAPABILITIES column already surfaces the count with one/many/none held
honest), just not rendered as its own role/rationale panel. Flagging this as a real conflict between
the task brief and the binding design-fidelity directive for design to resolve — not silently
dropped and not silently added.
