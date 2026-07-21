# Diagrams: the node/edge views (system map, architecture, flow connections)

A plain-language guide to a family of views, written so you can decide how and where to present
it. It describes what the information *is* and the shape it comes in — the presentation is
yours to design.

`Audience: design` · `Scope: workspace-wide (system map) and per-codebase (architecture, flow
connections)` · `Tests: out of scope` · `Numbers: from a live analysis` ·
`Node counts: 0 (a fresh/simple codebase) to dozens (a multi-service workspace)`

This is the ONE brief covering the diagram family the clickables-diagrams lane built: the
Workspace System Map full view (`/workspaces/:workspaceId/map`), the Codebase Architecture
diagram (`/codebases/:projectId/architecture`, and its card preview on the Repo overview), and
the Flow Overview's System Connection Map (upgraded in place, no new route). All three share one
rendering component (`src/components/diagram/GraphCanvas.tsx`) and one deterministic layout
util (`src/components/diagram/graphLayout.ts`, generalized from the entities lane's
`erdLayout.ts`) — same visual language, three different data sources.

---

## Start here: what a "diagram" is, in this system

None of these three diagrams draw a fabricated or force-directed graph. Each is a deterministic
column layout (nodes grouped into columns, optionally clustered by a field, laid out
top-to-bottom within a column) over a REAL node/edge set already present in the API. When a
relationship the design implies isn't actually in the payload, the diagram omits it rather than
inventing it — see "Data realities" below for what's missing and why.

### 1. Workspace System Map (`/workspaces/:workspaceId/map`)
- **Nodes**: `WorkspaceApplication[]` (`analysis.applications` on the workspace analysis
  envelope) — one per detected deployable/application across every member codebase, minus
  `merged_into` duplicates (a cross-member identity fold, not a second real node).
- **Edges**: `WorkspaceRuntimeLink[]` (`analysis.runtime_links`), joined from their
  component-level `source_component_id`/`target_component_id` through
  `analysis.runtime_components[].application_id` to get to application-level edges — the actual
  join the WAS payload offers; there is no direct application-to-application link with
  per-edge evidence. An edge without any `evidence` entries is drawn de-emphasized (dashed) —
  a declared relationship distinct from an observed one, never hidden. Falls back to
  `analysis.application_links` (already application-scoped, no `evidence` array) only when the
  component/link join produces nothing, so a workspace with `application_links` but no
  `runtime_components` still gets a real map instead of an empty one.
- **Click**: a node navigates to `/codebases/:codebaseId` (the application's own codebase).
- **Superseded card note**: `SystemMapCard` (the Workspace overview screen) previously showed
  its zoom-control row as decorative ("not yet interactive"); it now opens this full map — see
  DESIGN-NOTES.md for why the row itself, not a separate "expand" icon, is the affordance.

### 2. Codebase Architecture diagram (`/codebases/:projectId/architecture`, and the Repo
   overview's Architecture card preview)
- **Nodes**: every row of `deployable_evidence` off the full CAS payload (`GET
  /api/projects/:id/cas`) — real ship/runnable artifacts (a Dockerfile, a compose service, a
  binary, a package...), not just the ones that qualify for DAS promotion. Deliberately NOT
  `architectural_inventory_counts` (layers/interfaces/boundaries) — those are unrelated counts
  with no known relationships to each other; drawing them as connected nodes would be a
  fabricated graph, so they stay in their existing "Architectural inventory" panel as plain
  counts, untouched by this lane.
- **Edges**: `bundled_into` relationships between evidence rows — the one real composition link
  this array carries (e.g. a client bundles its client-service via an installer). True
  communication-seam edges (service A calls service B over HTTP/queue/etc) are computed
  server-side (`mcp__klauro__get_communication_seams`) but not exposed on `GET
  /api/projects/:id/cas` today — see "Data realities" below.
- **Click**: a node navigates to `/codebases/:projectId/deployables/:dasUnitId` ONLY when it
  corresponds to a promoted DAS unit (2+ qualified ship units in this repo); a bundled member or
  a single, non-promoted deployable has no detail route to open and renders as a real,
  non-clickable node rather than a dead link.

### 3. Flow Overview's System Connection Map (upgraded in place — same route, no new page)
- **Nodes**: the flow itself (center/first column) plus `flow.entities` and
  `flow.contract.side_effects.external_integrations` (two more columns) — unchanged data source
  from the page-flows lane's original build.
- **Edges**: flow → each entity, flow → each external integration.
- **Click**: none. `entities`/`external_integrations` are plain name strings on `FlowConcept`,
  not ids — there's nowhere real to navigate without a second lookup this view doesn't have.
- This panel was already rendered at full width inline on the Flow Overview page; Figma shows no
  separate "expand" route for it (unlike the Architecture section's clearly-labeled "See full
  Architecture" link). What changed is the RENDERING — from a bespoke static SVG to the same
  real zoom/pan `GraphCanvas` every other diagram in the app now uses — not a new route.

> **Who looks at these, and why**
> An engineer joining a workspace asking *"what actually talks to what, and where does each
> piece live?"* (system map) · Someone weighing a refactor asking *"what ships together, and
> what's bundled into what?"* (architecture) · Someone reading one flow asking *"what data and
> outside systems does this touch?"* (flow connections).

## Perspectives — same nodes/edges, different lens

Per the user-directed scope addition covering `docs/SPEC-CONCEPTUAL-LAYER.md` /
`docs/UNDERSTANDING-MODEL.md` and `get_unified_perspectives`' facet shape
(`apps/mcp-server/src/query.ts`): `get_unified_perspectives` itself is MCP-only (composes
`behavioral` flows + `structural` architectural-conflicts/paradigm-conformance — it is NOT
exposed on `GET /api/projects/:id/cas` or the workspace analysis envelope), and even its own
facet set is two, not the five the spec's broader vocabulary names (structural, conceptual/
capability, data/entity, runtime/telemetry, security). Rather than fabricate facets this
payload can't back, each diagram exposes ONLY the lenses its own real fields support — same
node/edge set, re-clustered:

| Diagram | Perspective | Groups by | Field |
|---|---|---|---|
| System map | Structural (default) | Application kind | `WorkspaceApplication.kind` |
| System map | Domain | Owning codebase's primary domain | `codebases[].primary_domain`, joined via `application.codebase_id` |
| System map | Exposure | Whether the application declares any listening port | `WorkspaceApplication.ports.length > 0` |
| Architecture | Structural (default) | Ship-artifact kind | `DeployableEvidence.kind` |
| Architecture | Exposure | Whether the artifact declares any listening port | `DeployableEvidence.ports.length > 0` |

**"Exposure" is deliberately not called "Security".** A listening port is real, evidence-backed
network-reachability signal — it is NOT an authentication/authorization read, and this payload
carries no per-application or per-deployable auth posture today. Calling it "Security" would
overclaim; "Exposure" states exactly what the one available field supports.

**Left out, and why** (data gaps, not oversights):
- **Capability/conceptual lens** — would need each node's capability/flow linkage.
  `ConceptualCapability`/`FlowConcept` are keyed by codebase, not by application or deployable
  artifact; joining a workspace-level application node to a capability computed inside one
  member codebase's conceptual layer has no join key on the HTTP payload today.
- **Data/entity lens** — would need each node's entity read/write footprint.
  `WorkspaceAnalysisResponse.analysis.summary.entities` is a single workspace-wide total, not
  per-application or per-codebase; `DataEntity.lifecycle` (created_by/read_by/...) is keyed by
  function/node id, several hops from an application or deployable-evidence row.
  Per-codebase, `useDasUnitSlice` DOES scope entities to a promoted DAS unit — but that's a
  slice of ONE unit at a time (the DAS drilldown page), not a cross-node lens over the whole
  diagram.
- **Runtime/telemetry lens** — the system map's edge `evidence` field is the closest real
  runtime signal available (used to mute edges with no observed evidence, above); there is no
  richer per-node runtime metric (request volume, error rate) on either payload today.

## Data realities

- **Node counts are small by construction.** A workspace system map's node count equals its
  live (non-duplicate) application count — typically a handful, not hundreds; a single-repo
  workspace draws one node. A codebase architecture diagram's node count equals its
  `deployable_evidence` length — 0 for a library with no ship artifacts, 1 for a typical single-
  service repo, 2+ only for a genuine multi-service monorepo. **Zero and one-node diagrams are
  the common, correct case**, not a broken analysis — both diagrams render an honest empty/
  single-node state rather than padding with invented nodes.
- **Edge sparsity is real, not a bug.** Most codebases have no `bundled_into` relationships
  (nothing ships bundled with anything else) and most workspaces have thin `runtime_links`
  coverage (the WAS's cross-repo topology detection is evidence-gated, not exhaustive) — a
  diagram with nodes and zero edges is a correct rendering of "no detected relationships yet."
- **True communication-seam edges are a known gap, not fabricated as a stand-in.**
  `mcp__klauro__get_communication_seams` computes a richer seam graph (including a `passive`
  shared-state modality) server-side, but it isn't wired into `GET /api/projects/:id/cas` — the
  same gap `CommunicationSeamsSummary.tsx` (integrations lane) already documented for its own
  sync/async summary. Until a backend lane exposes it, the Architecture diagram's only real
  edge type is `bundled_into`.
- **`application_links` and `runtime_links` are two independent, only-sometimes-overlapping
  sources.** A workspace can have one without the other; the system map tries the
  evidence-richer `runtime_links` join first and falls back to `application_links` only when
  that join yields nothing — never both merged (that would double-draw the same relationship
  under two different ids).
