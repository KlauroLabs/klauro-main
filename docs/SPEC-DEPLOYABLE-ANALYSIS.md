# SPEC: Deployable Analysis Specification (DAS)

**Version:** 0.1.0
**Status:** DRAFT — for review, not implemented
**Last Updated:** 2026-07-17

## 1. Purpose

A single connected repo can itself contain more than one independently
deployable unit. `docs/SPEC-DEPLOYABLE-DETECTION.md` already produces
evidence-gated `DeployableEvidence` / `SystemApplication` rows for exactly
this reason: a repo is not always one product surface.

Today, a multi-deployable repo still gets one flat CAS: one set of
capabilities, flows, entities, and entry/exit points for the whole tree, with
the deployable list bolted on as a rollup fact inside the workspace layer.
That under-serves the case where a single repo's deployables are as
distinct, in practice, as separate repos would be — different entry points,
different ICELOT contracts, different owners, different blast radii — but
they happen to share one `.git` root.

**The promotion rule.** A single-repo CAS becomes a **Deployable-Analysis
Workspace** — a repo that behaves like a workspace internally — when its own
detection evidence says so, never when its folder layout merely looks
segmented:

> A CAS promotes when it resolves **two or more tier-qualified ship units**
> after the evidence-gated bundling/dedup pass in
> `SPEC-DEPLOYABLE-DETECTION.md` §3–§4 completes. A "tier-qualified ship
> unit" is a surviving `SystemApplication` that is not `bundled_into`
> another unit and carries either (a) its own Tier-1 ship declaration, or
> (b) Tier-2/3 evidence that passed the §5b shipped-gate (sole-runnable
> exemption included). Tier-4 folder-prior evidence never counts toward the
> threshold by itself — a repo with two folders under `apps/` and no
> Tier-1/2/3 evidence for either does not promote.

This is the same count already computed for `WorkspaceDeployable[]` today —
DAS does not invent a new counting pass, it reacts to the existing one and
changes what happens *after* the count crosses the threshold: instead of
listing N names, the CAS spins up N full analyses.

The promotion rule is a gate, not a preference. A repo that resolves to
exactly one ship unit (the overwhelming common case) MUST NOT promote,
regardless of its size, folder count, or internal module boundaries. See
§7 and §8.

## 2. The DAS unit

A **DAS unit** is a full, first-class analysis scoped to one tier-qualified
ship unit inside a promoted repo. It carries the same semantic surface a
standalone CAS would: capabilities, flows (with steps and ICELOT), entities,
entry points, exit points, seams, a description, and semantic coverage — not
a name and a path.

### 2.1 Slicing rule

A DAS unit is **derived from the repo's own CAS**, never re-analyzed from
source. Given a tier-qualified `SystemApplication` A:

1. **Seed set.** Start from A's `ships_paths` (its own root plus any bundled
   member roots) and A's `entrypoint_member` — the CAS entry points and exit
   points whose file falls under those paths.
2. **Reachability closure.** Walk the CAS call graph forward from the seed
   entry points and backward from the seed exit points until the walk stops
   producing new nodes. Everything reached is IN A's DAS; nothing reached
   only from another ship unit's seed set is IN A's DAS, unless it is also
   reachable from A's own seeds (see §2.2, shared code).
3. **Derived layers.** Capabilities, flows, entities, and seams are then
   filtered/reprojected onto that node subset using the same construction
   rules the repo-level CAS already uses (semantic-model.md's
   capability/flow/step/ICELOT doctrine, applied to the subgraph instead of
   the whole graph). DAS does not invent a second semantic algorithm — it
   runs the existing one with a restricted evidence set.
4. **No new source reads.** Exactly like WAS relative to CAS
   (`docs/was/SPECIFICATION.md` §1), a DAS unit MUST be reproducible from its
   parent CAS's own facts. If a DAS boundary decision needs a fact the CAS
   doesn't already expose (e.g. finer-grained reachability), that is a CAS
   analyzer gap to fix, not a reason for DAS to read source directly.

### 2.2 Shared code attribution

Code reachable from more than one ship unit's seed set (a shared crate, a
common utils package, a monorepo-wide auth helper) is **not forked** into
each DAS unit as if it were owned there. It is attributed as follows:

- The code gets **one canonical owner**: the ship unit whose Tier-1/2/3
  evidence most directly identifies it (e.g. the `libs/*` package a
  Dockerfile's build context explicitly copies, or — absent that — the ship
  unit that imports the largest reachable share of it, ties broken by
  declaration order for determinism). This mirrors the existing
  `deployable: false` roll-up-to-importer semantics in
  `SPEC-DEPLOYABLE-DETECTION.md` §6's multi-service example; DAS just makes
  the attribution explicit and stable instead of implicit.
- Every OTHER ship unit that reaches the same code sees it in its own DAS
  unit too, but tagged `attribution: 'shared'` with a pointer to the
  canonical owner's DAS unit id. Capabilities/flows/entities built partly
  from shared code carry that tag transitively so a reader always knows
  "this behavior is not exclusive to this deployable."
- Shared-code facts are never double-counted in coverage or health metrics
  at the repo-CAS-rollup level (§3) — they are counted once, against the
  canonical owner, with `also_used_by` cross-references to the consumers.

## 3. CAS-as-rollup semantics

When a CAS promotes, the repo-level CAS analysis does not disappear — it
changes role from "the analysis" to "the rollup + the things that only make
sense at repo scope":

**Stays at repo level (CAS-as-rollup):** repo-wide conventions/idioms/agent
rules (`get_codebase_idioms`, `get_conventions` — these describe how the
repo is written, not what any one deployable does); the test-suite
inventory, unless a test clearly scopes to one ship unit's path (in which
case it MAY also be surfaced in that unit's DAS as a drilldown pointer, not
duplicated content); the shared-code canonical-ownership index (§2.2);
cross-unit seams — an integration between two DAS units in the SAME repo
(unit A calls unit B's API, or they share a message channel) is a
repo-level fact, analogous to a `WorkspaceIntegrationLink` but scoped inside
one CAS instead of across CASes; repo-level health/risk/activity/freshness
that isn't unit-specific (a stale dependency shared by all units, an
org-wide CI gate); and the list of DAS unit ids/names/tiers/boundary
evidence itself — the rollup index a reader consults before drilling into
any one unit.

**Moves per-unit (into each DAS unit):** capabilities, flows, steps,
ICELOT, entities, and entry/exit points scoped to that unit's reachability
closure (§2.1); the unit's own description and semantic coverage numbers;
and unit-local risk/hot-spot findings whose evidence lives entirely inside
the unit's node subset.

A promoted CAS's own `get_summary` becomes, in effect, a miniature WAS: it
reports N deployables with their seams, the way `get_workspace_summary`
reports N codebases with theirs, but scoped to one repo's internal ship
units instead of N separate repos.

## 4. WAS composition

WAS already consumes `WorkspaceDeployable[]` built from
`deployable_evidence` / `SystemApplication` rows
(`cross-codebase-analysis.ts` `buildApplications` / `resolveDeployables`,
per `SPEC-DEPLOYABLE-DETECTION.md` §5). DAS changes what WAS finds
*underneath* those rows when it looks, not the row shape:

- **When a member CAS has promoted** (produced DAS units for its
  tier-qualified ship units), WAS MUST consume those DAS units directly as
  the source of each corresponding `WorkspaceDeployable`'s capabilities,
  flows, entities, and seams. Provenance is three-hop:
  `workspace → CAS (repo) → DAS (unit)`, and every `WorkspaceDeployable`
  built this way MUST carry both the owning CAS's `codebase_id` and the
  DAS unit id so a reader can tell which repo a deployable came from even
  when several repos each contribute several deployables.
- **When a member CAS has NOT promoted** (single ship unit, or evidence too
  thin to slice), WAS falls back to today's behavior: build the
  `WorkspaceDeployable` from `deployable_evidence` rows and the whole-CAS
  facts, exactly as `SPEC-DEPLOYABLE-DETECTION.md` describes now.
- This fallback MUST be silent to the schema — `WorkspaceDeployable` does
  not grow a variant field per source. It gains an optional
  `source_das_unit_id` (present only in the DAS-backed case) and keeps
  every other field populated the same way regardless of which path built
  it, so a WAS consumer never has to branch on provenance to read a
  deployable's facts, only to decide how much to trust drilldown depth.
- Two repos each contributing multiple deployables therefore show ALL of
  them as separate `WorkspaceDeployable` entries in one flat WAS
  `deployables[]` list — this is the concept's headline requirement: a
  4-deployable, 2-repo workspace looks like 4 first-class projects with
  their repo-of-origin tagged, not like 2 projects with a nested list each.

## 5. Analysis order + freshness

```
1. Run CAS analysis for a repo (unchanged, docs/was/SPECIFICATION.md §2 step 1).
2. Evaluate the promotion rule (§1) against that CAS's resolved deployables.
3. If promoted: slice DAS units (§2) from the completed CAS — this is a
   derivation pass over existing CAS facts, not a second source-level parse.
4. If not promoted: no DAS units; CAS stands alone as today.
5. Run WAS composition (docs/was/SPECIFICATION.md §2 step 3) over all
   member CASes, consuming DAS units where present (§4).
```

DAS slicing sits strictly between CAS completion and WAS generation. It MUST
NOT block on WAS, and WAS MUST NOT block on AI enrichment of individual DAS
units (same lazy-enrichment posture as `docs/was/SPECIFICATION.md` §2 step 5
and §7's AI-required-at-summary-level / lazy-below-that split).

**Incremental re-slicing.** A file change re-runs repo-level CAS
incrementally as today. After that, only the DAS units whose reachability
closure (§2.1) intersects the changed file's node set need to re-slice —
this is the same "only affected subgraph recomputes" principle the
call-graph-incremental work already uses elsewhere, applied to DAS
boundaries instead of whole-CAS boundaries. A change inside one ship unit's
exclusive code re-slices one DAS unit; a change inside canonically-owned
shared code (§2.2) re-slices the owner AND touches the `also_used_by`
cross-reference on every consumer unit (a cheap pointer-freshness check, not
a full re-slice of each consumer). A change that flips the promotion
decision itself (a Tier-1 artifact added/removed such that the ship-unit
count crosses the ≥2 threshold in either direction) forces a full
promote/demote transition: freshly promoting builds DAS units for the first
time; demoting collapses DAS units back into a single flat CAS and MUST be
reported as a boundary change, not a silent disappearance.

## 6. Retrieval / MCP contract sketch

DAS does not introduce a parallel tool family. Existing repo-level tools
(`get_summary`, `get_flow_concepts`, `get_entry_points`, `get_data_entities`,
`get_capability_memory`, etc.) gain an optional **scope parameter**:

```
scope?: { das_unit_id: string } | { das_unit_id: 'all' } | undefined
```

- Omitted `scope` on a promoted CAS returns the rollup view (§3's
  CAS-as-rollup content plus the unit index) — the same shape a caller gets
  from a non-promoted CAS today, so existing callers that don't know about
  DAS keep working unchanged.
- A concrete `das_unit_id` scopes the call to exactly that unit's sliced
  facts, the same request shape a caller already uses to scope a WAS call to
  one workspace deployable via `get_agent_context`'s optional workspace-id
  parameter (`docs/was/SPECIFICATION.md` §10's last bullet) — DAS mirrors
  that pattern one level down.
- `scope: {das_unit_id: 'all'}` is an explicit multi-unit fetch for tools
  that need to compare units (e.g. a caller building its own cross-unit
  view) — bounded and paginated the same way `list_workspace_analyses`
  bounds cross-repo calls, so it can't silently balloon into a full-workspace
  payload.
- On the WAS side, `get_workspace_agent_context` and `get_workspace_summary`
  drilldown links for a DAS-backed `WorkspaceDeployable` point at
  `{repo-level tool}(scope: {das_unit_id})` on the owning codebase, not at a
  new workspace-level endpoint.

## 7. Validation

- **Counts must be honest.** `validate_cas_contract` (or its DAS-aware
  successor) MUST verify the promoted-unit count equals the tier-qualified
  ship-unit count from §1's threshold check — never inflated by Tier-4
  folder guesses, never deflated by silently dropping a `possible_bundle`
  candidate into a unit it wasn't evidence-merged into.
- **No phantom units.** Every DAS unit id MUST be derived deterministically
  from its owning `SystemApplication`'s stable identity (the same
  identity-collision-guarded id construction `buildApplications` already
  uses for `SystemApplication.id`, per the `IDENTITY-COLLISION GUARD`
  invariant in `cross-codebase-analysis.ts`) — never freshly minted per
  analysis run, so re-analyzing an unchanged repo yields the same DAS unit
  ids and a diff tool can tell "same unit, updated facts" from "unit
  disappeared, new unit appeared."
- **A single-deployable CAS is a valid, common, terminal state.** It MUST
  NOT promote, MUST NOT carry a one-entry DAS-unit list masquerading as a
  rollup, and validation MUST NOT penalize it for having no DAS units — this
  mirrors `docs/was/SPECIFICATION.md` §9's "zero integration links is valid"
  rule one layer down.
- **Demotion is a reportable event, not silent data loss** (§5's promote/
  demote transition) — a repo whose DAS units vanished between two analyses
  without an accompanying boundary-change note MUST be flagged as a
  quality-flag-worthy regression, the same posture §7 of
  `docs/was/SPECIFICATION.md` takes toward WAS facts disappearing without
  explanation.
- **Shared-code attribution must sum to one canonical owner** — never zero
  (an orphaned shared region) and never more than one (double ownership) —
  checked the same way deployable-evidence bundling checks that
  `bundled_into` is acyclic and single-parented.

## 8. Acceptance examples (shape-based)

- **Multi-binary workspace with installer bundling.** A repo has 8 runnable
  binaries; one installer script (Tier-1) bundles 2 of them into one shipped
  product, the other 6 have no Tier-1 evidence and fail the shipped-gate.
  Tier-qualified ship-unit count = 1 (the bundle). This CAS does **not**
  promote — one ship unit, regardless of 8 runnable candidates underneath
  it. This is the `SPEC-DEPLOYABLE-DETECTION.md` §6 "Rust multi-binary
  workspace" shape reused: DAS's threshold is about surviving ship units
  after bundling, not raw runnable-candidate count.
- **Microservices monorepo.** A repo has 4 top-level service folders, each
  with its own Dockerfile and no `ships_paths` cross-references to the
  others. Tier-qualified ship-unit count = 4. This CAS **promotes**: 4 DAS
  units, each with its own capabilities/flows/entities sliced from the one
  CAS's call graph via each service's entry points; a shared internal
  library imported by all 4 rolls up as `attribution: shared` with one
  canonical owner; the repo-level CAS becomes the rollup reporting all 4
  units plus their pairwise seams (e.g. service A calls service B over
  HTTP, observed in the shared graph as an intra-repo integration link).
- **Single-service repo that must not promote.** A repo has one Dockerfile,
  one deployable process, and an internal `modules/` folder split for code
  organization only (no Tier-1/2/3 evidence for any module as an
  independent ship unit). Tier-qualified ship-unit count = 1. This CAS does
  **not** promote, regardless of how many internal module folders exist —
  module-level code organization is not deployable-level segmentation, and
  DAS must not be triggered by folder depth or file count.

## 9. Open questions for the user

1. **Cost/latency of N full slices.** Slicing is described as graph-derived,
   not re-parsed from source (§2.1 step 4), but N full capability/flow/ICELOT
   projections still cost more than one flat pass over the same graph. Is
   there a size/count ceiling above which DAS should defer full slicing for
   the smaller/less-central units and keep them at deployable_evidence-only
   fidelity until requested (a lazy-DAS tier), similar to how WAS already
   defers deep entity/flow AI descriptions?
2. **Storage identity across re-analysis.** §7 requires stable DAS unit ids
   derived from `SystemApplication` identity. Should DAS units be persisted
   as genuinely separate analysis artifacts (their own storage row,
   queryable independent of the parent CAS) or purely as a derived/cached
   view recomputed from the parent CAS on read? This affects incremental
   re-slicing cost (§5) and whether `list_analyses` should list DAS units
   alongside CAS/WAS analyses or keep them nested.
3. **UI/API presentation of a promoted CAS.** Should a promoted repo's
   top-level `get_summary` visually/structurally look like a miniature WAS
   (deployables-first) by default, or should the repo-level rollup framing
   stay primary with DAS units reachable only via an explicit drilldown, so
   a caller who queries a promoted repo without knowing about DAS still
   gets a coherent single-repo answer instead of an unexpected
   multi-deployable list?
