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

## clickables-diagrams lane — interactive-element sweep + full-diagram views

Full data-source brief for everything diagram-shaped: `apps/app/docs/briefs/diagrams.md`.

### Sweep table — every interactive/clickable element across the 5 designed frames

Frames pulled via `get_design_context`/`get_metadata` (file `Ux2aXXgq4jzD9T4TZaDAw8`). Elements
already verified wired by their owning page lane (confirmed here by re-reading their code, not
re-guessed) are marked accordingly rather than re-litigated; this lane's own fixes are marked
**FIXED** with the destination.

| Frame | Element | Wired? | Destination |
|---|---|---|---|
| Home (1698:13626) | "Jump Back In" card arrow (`arrow-narrow-up-right`) | Yes (page-dashboard) | last-opened codebase/workspace route |
| Home | Workspace row arrow (`arrow-narrow-up-right`) x4 | Yes (`WorkspaceCard.tsx`, `RouterLink`) | `/workspaces/:id` |
| Home | Sidebar nav items / "Add Workspace" / settings | Yes (ui-scaffold `AppShell`) | respective routes |
| Home | Search / notifications / avatar dropdown (topbar) | Yes (ui-scaffold) | topbar actions |
| Workspace (1748:6595) | System Map zoom-control row (`cursor`/`grid`/`minus`/`plus`) | **FIXED** (was decorative "not yet interactive") | `/workspaces/:workspaceId/map` (new WorkspaceMapPage) |
| Workspace | Repository card arrow (`arrow-narrow-up-right`) x4+ | Yes (`RepositoryCard.tsx`) | `/codebases/:id` |
| Workspace | Repositories filter badges (tag/type dropdowns) | Yes (page-workspace, `RepositoriesSection.tsx`) | in-page filter |
| Workspace | Breadcrumb / search / notifications / avatar | Yes (ui-scaffold) | topbar actions |
| Repo overview (1647:37709) | Section 01–05 "See all" links | Yes (`SectionHeader` `seeAllHref`, all 5 sections) | `/codebases/:id/<section>` |
| Repo overview | Section 04 Architecture Diagram panel | **FIXED** (was a static dashed placeholder) | real `deployable_evidence` diagram, card preview → opens `/codebases/:id/architecture` on click |
| Repo overview | Architecture panel's 40px icon + 164px labeled button pair (`1742:6106`) | Not wired — label text unresolvable from Figma metadata (component-instance override, file too large to force full code) | see note below |
| Repo overview | Reanalyze button (header) | Yes (page-codebase, `CodebaseHeader.tsx`) | triggers reanalysis |
| Repo overview | Capability/Flow/Entity row click-throughs | Yes (respective section components) | detail routes |
| Flow List (2030:31178) | Row click → flow detail | Yes (page-flows) | `/codebases/:id/flows/:flowId` |
| Flow List | "Tags" filter | Yes (page-flows, reinterpreted as entry-modality filter — see existing note above) | in-page filter |
| Flow List | Search / sort controls | Yes (page-flows) | in-page |
| Flow Overview (1982:5977) | System Connection Map | **FIXED** (was a bespoke static SVG) | now real zoom/pan `GraphCanvas`, same route (no separate full view — see diagrams.md) |
| Flow Overview | System Connection Map's 40px icon + 164px labeled button pair (`1982:8400`) | Not wired — same unresolvable-label issue as the Architecture panel's pair | see note below |
| Flow Overview | Entry Points card link | Yes (page-flows) | `/codebases/:id/entry-points/:epId` |
| Flow Overview | Step inspector row selection | Yes (page-flows) | in-page step switch |
| All frames | Sidebar navigation items, star/favorite icon, notifications bell | Yes (ui-scaffold `AppShell`) | respective routes / no-op placeholders already logged by ui-scaffold |

### Diagram-panel button pair (`1742:6106` Repo overview, `1982:8400` Flow Overview) — unresolved label, not wired
Both the Architecture Diagram panel and the System Connection Map panel carry the same button
pair top-right: a 40×40 icon-only button and a 164×40 labeled button (`Buttons/Button`
instances). Figma's `get_design_context`/`get_metadata` response for these frames is large
enough that both calls fell back to sparse metadata (node tree only, no resolved
component-instance text), so the labeled button's actual text is unrecoverable without a
narrower, per-instance fetch this lane didn't have budget for. What IS verifiable: this same
pair sits in the SAME relative position on every diagram-family panel in the file, while EVERY
confirmed "navigate to a different route" affordance elsewhere in these two frames (the section
"See all" links, the flow-detail entry-point card link) is a distinct, separately-labeled
element — never this icon+button pair. Treating the pair as an in-panel action (e.g. regenerate/
toggle) rather than a hidden second navigation affordance is the reading consistent with the
rest of the file; it was left unwired rather than guessed at, and is flagged here as a genuine
open question for design rather than silently assumed either way.

### SystemMapCard's zoom row wired to the full map, not made a real zoomable preview
The System Map card's chip-list/relationship-list preview (see the existing note above — no
layout coordinates exist for `runtime_components`, so a pixel-faithful in-card diagram was never
buildable) has no spatial canvas to zoom into. Rather than leave the zoom-control row permanently
decorative, it now opens `/workspaces/:workspaceId/map` — the real `GraphCanvas` where zoom/pan
is actually meaningful. This is a deliberate interpretation of LANE-COMMON's "SystemMapCard's
zoom/expand → the full map route" instruction, since Figma shows no separate "expand" icon
distinct from the zoom row itself on this card.

### Architecture diagram — real data, narrower edge set than "communication seams" implies
The previous placeholder's rationale (`apps/app/docs/briefs/architecture.md`, "no live component/
connection topology to draw it from today") undercounted what's actually reachable:
`deployable_evidence` (with its `bundled_into` field) IS on the HTTP `/cas` payload and IS a
real, evidence-backed relationship — just narrower than a full communication-seam graph (see
`apps/app/docs/briefs/diagrams.md`'s "Data realities" for the full accounting of what's still
missing: true service-to-service seam edges, which remain MCP-only via
`get_communication_seams`). This note supersedes that one claim in architecture.md without
editing that file directly (owned by the page-codebase lane).

### Perspective lenses — capability/data/runtime facets left out, not fabricated
Per the user-directed scope addition (`docs/SPEC-CONCEPTUAL-LAYER.md` / `docs/
UNDERSTANDING-MODEL.md` / `get_unified_perspectives`'s facet shape), the two full-diagram views
now carry a Structural (default) lens plus one or two more derived from real fields (Domain and
Exposure on the system map; Exposure on the architecture diagram — see
`apps/app/docs/briefs/diagrams.md` for the full table and field citations). Capability/
conceptual, data/entity, and runtime/telemetry lenses were investigated and left out: each would
need a join key (application-to-capability, application-to-entity-footprint,
per-node runtime metrics) that doesn't exist on the HTTP payloads these diagrams already read.
`get_unified_perspectives` itself (`apps/mcp-server/src/query.ts`) is MCP-only and composes only
two facets (behavioral flows + structural conflicts/paradigms) — not a five-facet node/edge
graph — so it was not a usable data source for a diagram lens as-is.

### Remote coordination fabric degraded to local for this lane's session
`fab_claim_work` and `fab_list_active_work` both returned "Remote fabric responded 521" and
degraded to the local-only awareness tier for the duration of this lane's work — agents on other
machines would not have seen this lane's claim. Flagging as an infrastructure finding, not a
silent gap: the claim itself still succeeded locally and no peer collision was observed.

## data-wiring-repair lane

DATA layer sweep across the whole app: which hooks feed which designed elements, fixing elements
that render empty despite the CAS actually carrying the data, and producing one authoritative
gap table replacing this file's scattered per-lane guesses. Scope: `src/hooks/`,
`src/pages/codebase/`, `src/pages/deployable/`, plus the two `src/pages/dashboard/` files this
required (`JumpBackInCard.tsx`, `CodebasePage.tsx` — no dashboard-lane claim was active this
session; disjoint from the concurrently-active `logo-favicon` lane's `src/assets/`/`Logo.tsx`/
favicon/`index.html` claim).

### CORRECTION — Dependencies section did NOT have "zero API surface"
The page-codebase lane's original entry above ("Dependencies section has NO web-API route at
all — data gap") checked the wrong layer: it grepped `remote-analyzer-service.ts` for a
dedicated `/dependencies` REST route and found none, and concluded from that alone that no HTTP
path reaches external-service/library data at all. But `GET /api/projects/:id/cas` — already
fetched by this same page's Architecture section for `deployable_evidence` — carries
`external_services` and `libraries`/`dependency_manifest` too (`CASOutput`,
`packages/analyzer-core/src/types/cas.types.ts`); the page-integrations lane's
`useExternalServices.ts`/`useLibraries.ts` already read exactly those fields and render real data
on `/codebases/:projectId/integrations`. There was no missing backend route, only a preview
section and a derived full-page route that never called the hooks that already existed.
**Fixed**: `DependenciesSection.tsx` (preview: external-service chips + a library-count caption)
and `CodebaseDependencies.tsx` (full page: now reuses page-integrations' own
`ExternalServicesList`/`LibrariesList` components directly, one source of truth, not a second
rendering of the same facts) both now call `useExternalServices`/`useLibraries`. The permanent
empty state is gone; an honest empty state remains for the real case of a codebase with neither.

### CORRECTION — monorepo/deployable structure was already wired, by a different lane
This lane's task brief named "monorepo understanding missing" as a second gap to fix, citing
`cas.deployable_evidence` + `dasIndex.ts`. Checked `ArchitectureSection.tsx` (Repo overview's
section 04, already reusing `useDasIndex`) and found the clickables-diagrams lane had already
wired `ArchitectureDiagram` to real `deployable_evidence` nodes/`bundled_into` edges, clickable
into `/codebases/:id/deployables/:dasUnitId` for promoted units (see that lane's own entry
above, "Architecture diagram — real data, narrower edge set..."). The Figma "Repo overview" frame
has no separate deployable-count/monorepo-structure element beyond the Architecture section (see
the 4-card stat row's fixed Capabilities/Entry points/Contributors/Codebase age set, and the
element-coverage checklist above) — so per the DESIGN FIDELITY RULE there is nothing left to add
here without inventing a new element the frame doesn't show. No changes made; flagging that the
brief's #2 was already satisfied to avoid a second lane re-deriving the same diagram.

### Fixed — "Jump Back In" Capabilities and Last Opened
Of the four data gaps the page-dashboard lane logged for this card (Lines, Capabilities,
Contributors, Last Opened):
- **Capabilities** — wired. `AnalysisSummary.capabilities` is on the exact same
  `GET /api/projects/:id/analysis` response `useProjectSummary` already fetches for
  `CodebaseOverview`; `JumpBackInCard` now calls the same hook directly (react-query dedupes by
  query key, so opening the featured project doesn't double-fetch).
- **Last Opened** — wired, as real client-side data rather than a repurposed analysis timestamp
  (the page-dashboard lane's note explicitly rejected that repurposing, correctly — an analysis
  timestamp is not "when you looked at it"). New `useRecentProjectViews.ts`
  (`recordProjectOpened`/`getLastOpenedAt`, a thin `localStorage` map keyed by project id).
  `CodebasePage.tsx` (the shell every `/codebases/:projectId/*` child route mounts under) calls
  `recordProjectOpened` once per visit; `JumpBackInCard` reads it back through
  `formatRelativeTime`. Honest "—" for a project this browser has never actually opened
  (first-ever visit, a different device, or a cleared local store) — never a fabricated time.
- **Lines** and **Contributors** — confirmed true gaps, not wired. See the gap table below for
  why (no field exists for Lines anywhere; Contributors exists only as a *workspace*-level
  aggregate that would need a second, heavier fetch this route has no workspace id to make).

### Authoritative gap table
Verified against real field/route definitions (`packages/analyzer-core/src/types/cas.types.ts`,
`apps/mcp-server/src/remote-analyzer-service.ts`, `apps/mcp-server/src/cross-codebase-analysis.ts`,
and `apps/app/src/api.ts`'s response types) rather than re-guessed. The web app's own
`GET /api/projects/:id/*` / `GET /api/workspaces/:id/*` HTTP surface could not be hit directly
this session — the bearer token in `~/.klauro/auth.json` (the one this lane's charter names as
safe to use) returned `"Sign in required"` on every route including `/api/me`, for this account.
Per the standing CARDINAL rule against `klauro login` clobbering the user's session, no re-auth
was attempted; findings below come from reading the served-field definitions and the analyzer
route source directly; a human should re-check `~/.klauro/auth.json` token freshness.

| Element | Screen | Status | Source |
|---|---|---|---|
| Dependencies section (chips) | Repo overview §05 | **Fixed** — fed now | `useExternalServices`/`useLibraries` off `cas.external_services`/`cas.libraries` |
| Full Dependencies page | `/codebases/:id/dependencies` | **Fixed** — fed now | same hooks, reuses page-integrations' list components |
| Architecture diagram (deployable/monorepo structure) | Repo overview §04 | Already fed (prior lane) | `useDasIndex` over `cas.deployable_evidence`, clickable into DAS unit routes |
| Jump Back In — Capabilities | Home | **Fixed** — fed now | `useProjectSummary(project.id).summary.capabilities` |
| Jump Back In — Last Opened | Home | **Fixed** — fed now (client-side) | `useRecentProjectViews.ts`, `localStorage`, recorded by `CodebasePage` |
| Jump Back In — Lines | Home | True gap | no lines-of-code field anywhere in `AnalysisSummary`/`ProjectRevision`/`CASSystem` |
| Jump Back In — Contributors | Home | True gap (access-cost, not absence) | real field exists only workspace-scoped (`WorkspaceActivitySummary.contributors[].projects[]`, `cross-codebase-analysis.ts`); this route has no workspace id and would need a full `GET /api/workspaces/:id/analysis` fetch per card to join it |
| Codebase Stats — Contributors | Repo overview stat row | True gap (same as above) | same workspace-scoped field, same missing-workspace-id problem on `/codebases/:id` |
| Codebase Stats — Codebase age | Repo overview stat row | True gap | no repo-age/commit-history field on `AnalysisSummary`/`CASSystem`; `total_files` (real) is the fallback caption already shown |
| System Complexity score/trend | Workspace | True gap (page-workspace's scope, confirmed not mine to fix) | no `complexity_score`/`complexity_trend` field on the served WAS graph |
| Change Activity itemized feed | Home + Workspace | True gap (page-dashboard's scope, confirmed) | `get_changes_since`/`get_changes_between` are MCP-only, not on REST; no author/title attribution anywhere either |
| Flow List telemetry columns (AVG USER/MONTH, AVG BUGS/MONTH, EXECUTION TIME) | Flow List | True gap (page-flows' scope, confirmed) | `FlowConcept` carries no usage/defect/latency metrics; not joined onto `/conceptual` |
| Entry point telemetry (request_count/error_rate/p50-99) | Entry point detail | True gap (entry-points lane's scope, confirmed) | ingestion exists (`ingest_telemetry`) but isn't joined onto served CAS entry points |

Every "confirmed" row above was re-checked against the cited source this session, not just
copy-forwarded from the earlier entry — none had flipped to available.

## fidelity-repair lane (2026-07-20)

User reviewed the live, signed-in app against the Figma and flagged three concrete violations:
cramped stat rows, missing engineered-geometry icon language (plain MUI icons / colored-box
placeholders instead of Figma's outlined symbol set), and elements added beyond the Figma frame
(a repo-type badge styled where Figma designs something else, on the codebase overview). This
pass re-pulled `get_screenshot` + `get_design_context` for all 5 frames and fixed every concretely
evidenced violation found; each fix cites the exact Figma node it was checked against.

### Icon library added — `src/components/icons/`
Figma's actual vector icon nodes (coins-swap-02, activity, users-03, layers-two-01, etc.) export
through the Figma MCP bridge as rasterized boolean-group PNGs, not path data (confirmed: zero
`<svg>`/`<path>` in any `get_design_context` response pulled this session) — so they can't be
losslessly traced. Following `EntryKindIcon.tsx`'s established precedent (stroke-only, one weight,
`#B7BCC7` wireframe color, engineered fresh at the same visual geometry), added:
- `StatGlyphIcon.tsx` — small (14-20px) stat-row glyphs: lines, capabilities, flows, entities,
  contributors, repositories, workspace. Replaces MUI `LayersIcon`/`FolderIcon`/`GroupIcon` on
  `JumpBackInCard`, `WorkspaceCard` (dashboard), `WorkspaceHeader`'s 5-stat row, `RepositoryCard`,
  `RepositoriesSection`, and `CapabilityCard`'s flow/entity mini-stats.
- `CapabilityGlyphIcon.tsx` — the 6-glyph capability-card rotation (coinsSwap/activity/
  dollarCircle/speedometer/barChart/fileSearch), replacing the MUI Outlined-icon cycle on
  `CapabilityCard.tsx`. Note: the bordered-box + accent-color treatment the build already had
  actually matched Figma (confirmed via `get_design_context` on node 1647:37727) — only the glyph
  rendering itself was wrong, not the surrounding chrome; kept the existing accent rotation since
  no capability-taxonomy field exists to pick a glyph by meaning (see the "Capability cards merge
  TWO independent sources" entry above).
- `DecorativeStatIcon.tsx` — the 4-card Repo-overview stat row's larger (28px) decorative glyphs
  (codepen/file-code-02/bezier-curve-03/intersect-square, confirmed via `get_metadata` on node
  1647:40214), replacing generic MUI `HubOutlined`/`CodeOutlined`/`GroupOutlined`/`HistoryOutlined`.
- `SystemComplexityGlyph.tsx` — a decorative geometric radial/orbit construction for the Workspace
  "System Complexity" card's empty state (Figma node 1748:6595, "Group 294"), replacing a plain
  MUI `HubOutlined` stand-in. This is the "decorative geometric line illustration" LANE-COMMON.md
  calls for and the build previously had none of.
- `UtilityGlyphIcon.tsx` — filter-badge glyphs (tag, sort). Fixes a real defect, not just a
  style gap: `RepositoriesSection.tsx`'s "Tags" filter chip was rendering a raw 🏷 emoji as its
  icon (`icon={<span>🏷</span>}`) — about as far from "engineered outline symbol" as possible.
  Replaced with `tag`/`sort` glyphs matching Figma's tag-03/switch-horizontal-01 (node 1748:6595,
  "Frame 1597881679").
- `GithubMarkIcon.tsx` — built for the GitHub badge fix below; not yet wired everywhere pending
  data (see removal note).

### Removed for fidelity: `CodebaseHeader`'s repo-type badge
`CodebaseHeader.tsx` rendered `<Chip size="small" label={type} />` next to the codebase title
(showing e.g. "service"). `get_design_context` on node 1647:40202 (Repo overview header) shows
Figma designs a bordered rounded-16 pill here containing a GitHub mark + the literal text
"GitHub" — a repo-source link badge, not a type label; `AnalysisSummary.type` doesn't appear
anywhere on this frame. **Removed for fidelity, was:** `{type ? <Chip size="small" label={type} />
: null}` in `CodebaseHeader.tsx`, and the `type={summary.type}` prop passed from
`CodebaseOverview.tsx`. Not replaced with a real GitHub badge yet — data gap: `Project.repo_url`
(api.ts:24) exists but no route this page fetches (`GET /api/projects/:id/analysis`, the only
per-project call `CodebaseOverview` makes) carries it, so there's no honest way to populate the
correct badge today. `GithubMarkIcon.tsx` was still built so a future pass can wire the real pill
the moment `repo_url` is reachable here, rather than leaving the wrong element in place while
that gap closes.

### Spacing fixed to Figma's exact 8px-grid values (was eyeballed)
Every number below was read off `get_design_context`'s Tailwind gap classes for the cited node,
not re-eyeballed:
- `JumpBackInCard.tsx` stat row (node 1864:9867): icon-to-text gap is 8px, value-to-label gap is
  4px (was: no icons at all, flat 4px run for value+label — see icon fix above). Stat-group gap
  (32px) was already correct.
- `WorkspaceCard.tsx` (dashboard, node 1864:9736): stat-group gap corrected 16px -> 24px; icon
  fixed at 8px-to-text, value-label split to 4px (was a flat 8px run with no icon).
- `WorkspaceHeader.tsx` 5-stat row (node 1807:6879, "Frame 1597881835"): stat-group gap corrected
  24px -> **16px** (this is the one Figma actually specifies tighter than the dashboard's — not a
  copy-paste of the Home screen's 32px/24px numbers); icon-to-text 8px, value-to-label 4px (was a
  flat 6px run with a plain MUI icon).
- `CapabilityCard.tsx` mini-stats (node 1647:37735): value-to-label gap corrected 8px -> 4px.
- `CodebaseStats.tsx` 4-card row gap (24px) and `CapabilityCard`'s outer paddings/gaps (32px card
  padding, 16px icon-title gap, 24px description-to-stats gap) were already correct — verified
  against node 1647:37727, no change needed.

### Element-coverage checklist refresh (this pass)

**Home (1698:13626)** — re-verified against `get_screenshot`/`get_design_context`: greeting
header, search bar, Jump Back In card (badge/title/workspace/stat row/Last Opened/open button),
Workspace list (icon/name/domain/stat pair/open button), Change Activity panel — all present,
spacing+icons now match. No elements beyond the frame found this pass.

**Workspace (1748:6595)** — re-verified: status dot, title+badge, description, 5-stat row, System
Map card (shell), System Complexity card (shell, now with the decorative glyph), Change Activity
panel, Repositories section (title/icon/subtitle/Tags+Sort+Add controls/card grid) — all present.
Repository cards' tag chips ARE Figma-designed (confirmed via screenshot: "Jest"/"Flask"/"FastAPI"
pills on every card) — NOT a fidelity violation despite surface resemblance to the codebase-
overview issue; left as-is.

**Repo overview (1647:37709)** — re-verified header, 4-stat row, and Capabilities section (§01)
against `get_design_context`; type badge removed (see above), icons swapped (see above). Sections
02-05 (Critical Flows / Key Entities / Architecture / Dependencies) were NOT re-audited element-
by-element this pass beyond their existing DESIGN-NOTES entries above — `get_metadata` on this
frame surfaced that Figma's Critical Flows section (§02) is actually a full step-pipeline
visualization with per-step badges (a "Badge" component: glyph + text + help-icon, node
1726:5054) that the current `CriticalFlowsSection.tsx` (a simple row list) doesn't build — this is
a diagram-shaped gap, not a spacing/icon-language one, and overlaps the `clickables-diagrams`
peer lane's claimed scope. Flagged here rather than rebuilt, to avoid a collision.

**Flow List (2030:31178) / Flow Overview (1982:5977)** — spot-checked via fresh `get_screenshot`
pulls; the page-flows lane's icon language (engineered network-node title icon, colored role
pills) already reads as faithful to the design language on inspection. Not re-audited element-by-
element (out of this lane's primary evidence — the user's cited examples were dashboard/codebase-
overview) beyond confirming no emoji/MUI-icon-language violations are visible on either screen.

### Verification
`npm run typecheck && npm run build && npm test` all green (190 tests, 0 failures) after every
change in this pass; no existing test asserted on the removed type-chip's text, so none needed
updating for that removal. NUL-byte count on every file touched this pass: 0.

## arch-concepts lane — architecture diagram: concepts as the default lens

**User complaint**: the architecture diagram "shows seemingly everything — it should show
framework CONCEPTS only (5-20 things: Services, Controllers, Repositories, etc.)". The prior
implementation rendered one node per raw `deployable_evidence` row (real ship/runnable
artifacts), which answers "what do we ship" but not "how is this built" — the wrong question for
a diagram sitting under a "How a request moves through the system" subtitle.

**Fix**: `architecture_summary.architectural_inventory` (already on the full CAS payload, GET
`/api/projects/:id/cas`) carries exactly the concept groups the user described — models, views,
controllers, view_models, services, repositories, clients, mediators, unit_of_work, singletons,
scripts, packages — each keyed to an array of **node ids** (the CAS type says `string[]` but
`orchestrator.ts`'s `buildArchitecturalInventory` fills each array with `node.id`, not names).
This is a real, evidence-backed 5-20-ish group set, never fabricated, and was simply never wired
into the app (it also backs `architectural_inventory_counts` on the summary route, but that's
numbers-only — no ids to build edges from, which is why a prior comment in
`architectureDiagramData.ts` said inventory counts "have no known relationships to each other and
would be fabricated edges if drawn as a graph": that comment was true of the *summary's* counts,
not of the raw CAS inventory this lane found underneath it).

Concepts is now the DEFAULT lens (`ArchitectureDiagram.tsx`); Deployables (the prior
`deployable_evidence` view, with its structural/exposure sub-toggle intact) is the second lens via
the same `src/components/diagram/perspectives.ts` pattern. Edges in the Concepts lens are
aggregated call-graph counts between groups (`buildConceptDiagramEdges` in
`architectureDiagramData.ts`) — cheap to derive from the same CAS payload's `edges` array,
counted rather than drawn node-to-node. The `packages` category is excluded as an edge endpoint
(broad file-path-based catch-all — nearly everything would appear to "call" it, which is
membership noise, not a relationship) but still shown as its own concept box, since its count is
real.

**Data gap — concept -> Functions page click-through**: clicking a concept node navigates to
`/codebases/:projectId/functions?concept=<key>&nodeIds=<id1,id2,...>` (capped at 300 ids). As of
this pass, `FunctionsPage.tsx`/`useFilteredNodes` (a different lane's files — field wiring) only
filter by free-text search, node `type`, and `file`; they do not yet read `concept`/`nodeIds` from
the URL. The link is real and deep-linkable today, it just lands on the unfiltered Functions page
until that lane adds an id-list filter — a degrade, not a dead link. Worth a follow-up: extend
`useFilteredNodes`'s `NodeFilter` with an optional `nodeIds: Set<string>` predicate and have
`FunctionsPage` read `concept`/`nodeIds` from `useSearchParams` on mount.

## ui-final-mile lane — honest freshness (analysis age vs. source age)

**User complaint (real incident)**: `CodebaseHeader`'s "Updated 3 days ago" dot described only
when the analysis job last RAN, not how current the analyzed SOURCE was. A live case: the
analysis ran 3 days ago, but the uploaded snapshot it analyzed was last committed ~11 days
earlier — the repo had since diverged by roughly 200 files with no hint anywhere in the UI.

**Fix**: `src/lib/freshness.ts`'s `describeFreshness(analysisTimestamp, sourceAt)` combines the
two into one label — `"Updated 3d ago"` when they coincide (or no source timestamp is available),
`"Updated 3d ago · source as of 11d ago"` when they diverge — and flags `stale: true` past
`STALE_SOURCE_DAYS` (7), which `CodebaseHeader` renders as a warning-colored dot with a tooltip
naming the fix ("...may not reflect the current code — Re-Analyze to refresh it"), the same
tooltip-on-dot pattern `WorkspaceHeader` already uses for enrichment status.

`sourceAt` is `AnalysisSummary.repo_facts.last_commit_at` (client-derived git fact, e9490b69) —
wired into `CodebaseHeader` via `CodebaseOverview`. This is the CODEBASE-level fix only.

**Backend field gap — workspace-level source date**: `WorkspaceHeader`'s own "Updated X ago" dot
(`generatedAt` = when the server-side WAS was last rebuilt) has the identical honesty problem one
level up — a workspace can be freshly rebuilt from stale member analyses — but there is no fix
applied here today. `WorkspaceAnalysisResponse.analysis.codebases[]` (api.ts) carries only
`{id, name, path, primary_domain, system_type, languages, frameworks}` — no `repo_facts` per
member codebase, so there is no per-codebase (let alone aggregate) source date reaching the
workspace graph to compute an honest "source as of" from. Closing this needs a backend change:
stamp each WAS `codebases[]` entry with its member CAS's `repo_facts.last_commit_at` (or at least
the OLDEST one across members, the honest worst-case for a "does this reflect current code"
signal) in `cross-codebase-analysis.ts`'s workspace-graph build. Flagged here rather than faked.

## figma-reconcile lane — render-verified fidelity pass (local fixture + Browser-pane loop)

Per the user's directive that self-certified fidelity review was insufficient ("reviewed the live
app twice, a ton of inconsistencies"), this pass built `apps/app/scripts/fixture-server.mjs` (a
zero-dep node http fixture API — see its header) + `VITE_KLAURO_API_URL=http://localhost:4174 npx
vite build && npx vite preview --port 4173`, then rendered all 5 designed frames in the Browser-
pane MCP tool against real UI code with realistic fixture data, comparing each against a fresh
`get_screenshot` pull of its Figma frame. Fixture identity is fictional ("Meridian" workspace,
`ledger-api`/`checkout-web`/`risk-engine` codebases) per this repo's standing corpus-naming rule —
no real client/benchmark names in fixtures or code.

### Found and fixed: AppShell sidebar/topbar added undesigned "Soon" badges — every screen
`src/layout/AppShell.tsx`'s Inbox/Activity/Add Workspace/Members/Integrations/Billing/Help/
Settings nav items rendered `disabled` + an invented `<Chip label="Soon">` end-adornment, and the
topbar search/bell icons were disabled with an invented "(coming soon)" tooltip. None of this
exists in the Figma frame (`get_screenshot` on Home/Workspace/Repo overview/Flow List/Flow
Overview all show these items in full, undimmed, unbadged) — the DESIGN FIDELITY RULE's "do NOT
add anything the design doesn't show" bars invented badges/dimming as much as it bars invented
sections. **FIXED**: removed `disabled`/`ComingSoonChip` from every nav item and the topbar icon
buttons; they now render exactly as Figma shows (visually normal, functionally inert since no
destination page/data exists yet for them — that remains the real gap, just not decorated).
Because AppShell wraps every route, this one fix changes the rendered appearance of all 5 frames
simultaneously.

### Found and fixed: topbar breadcrumb showed only an icon on Home, generic slugs elsewhere
Figma's Home frame breadcrumb is plain text "Home" (no icon); every other frame shows a home icon
+ the real workspace/codebase NAME + a star/favorite icon — `Breadcrumbs()` rendered neither: Home
showed a bare icon with no text, and non-Home routes showed a capitalized URL segment ("Workspaces"
instead of the workspace's actual name), no star. **FIXED**: Home now renders literal "Home" text;
`/workspaces/:slug` and `/codebases/:slug` resolve to the real name via the same `useWorkspaces()`
aggregate AppShell already fetches (no new network call, via `resolveSlug`); a star icon was added.
Deeper section segments (`/flows`, `/capabilities`, ...) still fall back to a capitalized slug —
an honest approximation, not a further data gap, since no additional fetch is made for them here.

### Found and fixed: Repositories card grid tag chips were uniform, not color-coded — the explicitly flagged card grid
The user named this card grid "not pixel perfect at all." `get_screenshot` on the Workspace frame
(1748:6595) confirms every stack-tag pill (Jest/Flask/FastAPI/NestJS/...) renders in a distinct,
consistent color per tag, not a single neutral chip style. `RepositoryCard.tsx` rendered plain
default `<Chip>`s. **FIXED**: added `src/pages/workspace/stackTagColor.ts` — a fixed muted palette
(green/orange/teal/purple/pink/olive) keyed by a stable string hash of the tag name, so the same
tag always renders the same color across every card without inventing a stack-category taxonomy
the API doesn't provide. Wired into `RepositoryCard.tsx`'s tag chip `sx`.

### Found and fixed (SEVERE — functional, not cosmetic): slug-routing regression broke data fetching on 3 of 5 designed frames
A concurrent lane (this session, fabric-parallel) introduced `name~suffix` slug URLs
(`src/lib/slugs.ts`, `useResolvedProjectId`) so links read human-readable instead of raw ids, with
`CodebasePage.tsx` redirecting any raw-id/stale-slug link to the canonical slug. But most child
routes under `/codebases/:projectId` — `CodebaseOverview.tsx`, `CodebaseCapabilities.tsx`,
`CodebaseArchitecture.tsx`, `CodebaseDependencies.tsx`, `FlowsListPage.tsx`, `FlowDetailPage.tsx`,
plus `DependenciesSection.tsx` and `FlowEntryPointSection.tsx` one level down — still read the RAW
route param via `useParams()` and passed it directly to their data-fetching hooks
(`useProjectSummary`/`useProjectConceptual`/`useProjectCas`/`useExternalServices`/...). Since the
sidebar's own nav links now navigate with the canonical SLUG (not the raw id), and `CodebasePage`'s
redirect converges every direct/legacy link onto that slug too, EVERY visit to Repo overview, Flow
List, or Flow Overview beyond the very first raw-id paint fetched data using a slug string as if it
were the real backend id — silently returning wrong-project or empty data (caught live: navigating
to `ledger-api` rendered `risk-engine`'s "Companion service" fixture data after the slug redirect
fired). This directly broke 3 of the 5 designed frames' actual content, not just their pixels.
**FIXED**: every listed file now resolves `useResolvedProjectId(routeParam) ?? routeParam` for data
fetching, while continuing to build outbound links/hrefs from the route's own `routeParam` (or a
new `projectSlug`/`slug` prop added to `FlowEntryPointSection`/`DependenciesSection`) so emitted
URLs stay in canonical slug form. Caught entirely by the render-verified loop this task mandated —
would not have surfaced from a documentation-only fidelity review.

### Fixture-driven bugs found in-flight (not product bugs, logged for completeness)
Two crashes surfaced while iterating the fixture payload shape itself, not the product: (1) an
early `ChangeActivityPanel` fixture response used `{status, activity}` instead of the real
`{events, next_cursor}` envelope `useChangeActivity.ts` expects, crashing on `.events.length`; (2)
`FlowConcept.contract` (the flow-level ILSO contract, distinct from each step's own) was omitted
from the fixture's flow objects, crashing `FlowSystemEffectsSection`/`FlowDataSection` on
`flow.contract.side_effects`. Both fixed in `scripts/fixture-server.mjs`, not app code — noted here
only because a first-time reader of the crash trace could otherwise mistake either for a product
defect.

### Also fixed in passing (concurrent peer typecheck breakage, blocking the shared gate)
`DeployFreshnessBanner.tsx` (landed by a concurrent lane this session) used MUI v6-era
`<Snackbar TransitionComponent={Fade}>`; this repo's MUI is v9, which moved that prop to
`slots={{transition: Fade}}` — a `tsc --noEmit` failure unrelated to this lane's scope but
blocking the shared `npm run typecheck` gate every lane's report depends on. One-line fix, not a
design/fidelity change.

### Known remaining honest deviations (found, not fixed, with reason)
- **RepositoryCard has no per-repo description text** (Figma shows a 2-line narrative under every
  card's title) — already logged above ("what a codebase row can't carry here: per-repo narrative
  text"); no per-codebase narrative field reaches the Workspace-level WAS graph today.
- **Critical Flows section (Repo overview, §02) is a simple row list, not Figma's full step-
  pipeline visualization** with per-step badges — already logged above by a prior pass as
  overlapping the `clickables-diagrams` lane's claimed scope; not re-litigated or rebuilt this
  pass to avoid a collision.
- **Evidence screenshots**: Figma-side screenshots for all 5 frames were pulled via `get_screenshot`
  and saved to `apps/app/docs/fidelity/<frame>-figma.png`. The BUILT-side half of each pair was
  visually captured and diffed live in the Browser-pane MCP tool during this session (every frame
  listed above was actually rendered and inspected, not inferred), but this sandboxed environment
  has no headless-browser CLI or file-writable screenshot capability to persist those renders to
  disk — only the Figma half of each pair exists as a file. Flagged honestly rather than fabricated
  or silently omitted.

### Verification
`npm run typecheck && npm run build && npm test` all green (217 tests, 0 failures) after every
change in this pass. NUL-byte count on every file touched: 0.
