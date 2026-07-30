# Deployable Analysis Specification (DAS)

**Version:** 1.0.0
**Status:** Active (Phase 1-2 implemented; see §10 for what remains)

## 1. Purpose

A single connected repo can itself contain more than one independently
deployable unit. `docs/SPEC-DEPLOYABLE-DETECTION.md` already produces
evidence-gated `DeployableEvidence` rows for exactly this reason: a repo is
not always one product surface.

Without DAS, a multi-deployable repo still gets one flat CAS: one set of
capabilities, flows, entities, and entry/exit points for the whole tree, with
the deployable list bolted on as a rollup fact. That under-serves the case
where a single repo's deployables are as distinct, in practice, as separate
repos would be — different entry points, different comprehension surfaces,
different owners, different blast radii — but happen to share one `.git`
root.

DAS is the per-deployable slice: a repo-scoped, CAS-shaped analysis narrowed
to one shippable unit, derived from the repo's own already-computed CAS facts
rather than a second source-level parse.

CAS is the repo-level truth layer (docs/cas/SPECIFICATION.md). WAS is the
cross-repo composition layer (docs/was/SPECIFICATION.md). DAS sits strictly
between the two: a within-one-repo decomposition that CAS produces and WAS
consumes.

## 2. The Promotion Rule

A CAS promotes to a **Deployable-Analysis Workspace** — a repo that behaves
like a workspace internally — only when its own evidence says so, never when
its folder layout merely looks segmented.

A CAS promotes when it resolves **two or more tier-qualified ship units**
after the evidence-gated bundling/dedup pass in `docs/SPEC-DEPLOYABLE-DETECTION.md`
§3-§4 completes. A "tier-qualified ship unit" is a surviving `DeployableEvidence`
row that is not `bundled_into` another unit, and whose own evidence declares
a ship-or-build artifact:

- a **Tier-1 ship declaration** (`container`, `compose-service`, `k8s`,
  `serverless`, `installer`, `ci-deploy`); or
- a **Tier-2 build-target declaration**: a `bin`-kind row — a target a
  manifest or toolchain convention declares (cargo `[[bin]]`, a package
  manifest `bin` field, a go `package main`, a `src/bin/*` entry).

**Cardinality is not part of the predicate.** A `server-entry` row (a
route-handler entry point INTO a deployable, not a build target of its own)
and a bare `package` identity (publishable, not runnable) never qualify,
regardless of how many other runnable rows exist alongside them in the same
repo. Tier-4 folder-prior evidence never reaches `deployable_evidence` at all
— `DeployableEvidence.tier` is typed `1 | 2 | 3`.

```
PROMOTION_THRESHOLD = 2
shouldPromote(cas) := tierQualifiedShipUnits(cas.deployable_evidence).length >= 2
```

A build-target row that declares the SAME binary through two conventions at
once (e.g. a cargo `[[bin]]` manifest row AND a matching `src/bin/x.rs` row)
MUST be deduplicated to one surviving row before the threshold check, so a
single shipped artifact is never counted twice.

The reported index MUST state **how many units qualified** and the
threshold, whether or not the CAS promoted. "1 qualified unit, below the
threshold of 2" and "no ship evidence found at all" are different answers,
and a caller MUST be able to tell them apart from `das_index.reason` alone —
an empty unit list by itself reads as "found nothing".

A repo that resolves to exactly one ship unit — the overwhelming common case
— MUST NOT promote, regardless of its size, folder count, or internal module
boundaries. Promotion is a gate driven by ship evidence, not a preference
driven by repo size.

## 3. The DAS Unit

A DAS unit is a full, CAS-shaped analysis scoped to one tier-qualified ship
unit inside a promoted repo: nodes, edges, entry points, exit points, data
entities, data lineage, capabilities, and communication seams narrowed to
that unit's own reachability closure — not merely a name and a path.

**No new object model.** A DAS unit is not a new schema. It is a
`CASOutput`-shaped object, restricted to a subset of the parent CAS's own
already-extracted facts. DAS introduces exactly two new shapes of its own —
the rollup index (`DasIndex`/`DasUnitIndexEntry`) and the slice envelope
(`DasUnitSlice`) — and reuses every CAS type (`CASNode`, `CASEdge`,
`CASEntryPoint`, `CASDataEntity`, `SystemCapability`, `CASFlowGraph`, ...)
unchanged for the slice's content.

```typescript
interface DasUnitSlice {
  das_unit_id: string;
  das_unit_name: string;
  root_path: string;
  member_root_paths: string[];
  seed_node_count: number;
  seed_basis: string[];          // 'entry-file:<path>' | 'root:<path>' | 'no-resolvable-seed'
  // CAS-shaped slice — same field names/types the parent CAS uses, restricted
  // to this unit's reachability closure. Fields with no unit-scoped meaning
  // (system, cas_version, ...) are carried through from the parent CAS
  // unchanged; repo-rollup-only fields (§5) are simply absent, not duplicated.
  slice: Pick<
    CASOutput,
    | 'cas_version' | 'analyzer_build' | 'analysis_timestamp' | 'analysis_id'
    | 'system' | 'nodes' | 'edges' | 'entry_points' | 'exit_points'
    | 'data_entities' | 'data_lineage' | 'system_capabilities'
    | 'behavior_surfaces' | 'flow_graph' | 'workflows' | 'user_journeys'
    | 'communication_seams'
  > & { deployable_evidence: DeployableEvidence[] };
}
```

### 3.1 Slicing Rule

A DAS unit is **derived from the repo's own CAS**, never re-analyzed from
source.

1. **Seed set.** Strongest evidence first, and never a bare path prefix:
   (a) the unit's own **declared entry files** — the source entry a build
   target's own evidence names (a cargo `src/bin/x.rs` / `src/main.rs`, a go
   `package main` file), including files declared by the unit's bundled
   members and `ships_paths`-named members; this is the only signal that
   separates two build targets inside one crate. (b) the unit's **concrete
   roots** — its own `root_path` plus member roots — except a root SHARED
   with a sibling unit's entry file, which cannot discriminate between them.
   The repo root (`.`) is admitted only when the unit's own entry file sits
   directly in it, or when the unit has no narrower evidence at all;
   otherwise a repo-root build context (a compose `build: .`, a top-level
   installer script — both normal) would seed every unit with the entire
   codebase. A unit with no resolvable seed reports zero nodes and says so
   (`seed_basis: ['no-resolvable-seed']`).
2. **Reachability closure.** Expand the seeds with the CAS reachability
   index (`affectedSet`, direction `downstream`, non-call edges excluded from
   the walk itself): what does this artifact's code call? Downstream-only —
   following callees into shared libraries but never walking backward from a
   shared library into a sibling unit's callers, which would merge every unit
   touching a common utility into one blob. Then **complete by file**: if any
   node of a file is in the closure, the whole file is, because a source file
   is a compilation unit. Completion runs once and is not a new expansion
   frontier.
3. **Derived-layer projection.** Capabilities, flows, entities, and seams are
   filtered onto the resulting node subset using the fields the repo-level
   CAS already computed — see §3.3 for exactly how this filtering works and
   its known limitation relative to full re-derivation.
4. **No new source reads.** Exactly like WAS relative to CAS
   (docs/was/SPECIFICATION.md §1), a DAS unit MUST be reproducible from its
   parent CAS's own facts. If a boundary decision needs a fact the CAS
   doesn't already expose, that is a CAS analyzer gap to fix, not a reason
   for DAS to read source directly.

### 3.2 Shared-Code Attribution

Code reachable from more than one ship unit's seed set (a shared crate, a
common utils package, a monorepo-wide auth helper) is **not forked** into
each DAS unit as if it were exclusively owned there. It is attributed:

- The code gets **exactly one canonical owner**: the ship unit whose
  Tier-1/2/3 evidence most directly identifies it (longest-prefix physical
  containment under one of the qualified units' own roots), falling back to
  "the unit that imports the largest reachable share of it" (approximated
  per-file: whichever reaching unit's closure includes the most nodes from
  that file), ties broken by declaration order for determinism.
- Every OTHER ship unit that reaches the same code sees it in its own DAS
  unit too, tagged in `metadata.attribution: 'shared'` with
  `metadata.canonical_owner_das_unit_id` pointing at the owner; the owner's
  own copy is tagged `metadata.attribution: 'owned'` with
  `metadata.also_used_by` listing the consumer unit ids.
- A node reached by exactly one unit is `'exclusive'` — not shared code at
  all, and untagged.

**The numbers say this out loud.** A unit's `node_count` INCLUDES its shared
code (a crate five binaries link is part of all five shipped artifacts, and a
slice that omitted it would describe a binary that cannot run), so unit
counts do not partition the graph and may sum to many times the parent CAS's
size. The rollup index (§4) reports the decomposition explicitly rather than
leaving it to be inferred:

- `exclusive_node_count + shared_node_count + orphan_node_count === graph_node_count`
  — an exact partition of the parent CAS's nodes.
- `covered_node_count` / `coverage_ratio` — the union, counted once.
- `sum_of_unit_node_counts` — allowed to exceed the union, by exactly the
  multiplicity of shared code.
- per unit: `exclusive_node_count`, `shared_node_count`, and
  `owned_shared_node_count`, where summing exclusive + owned-shared across
  units reconstructs the union exactly (one canonical owner per shared node).

### 3.3 Slice Scoping and a Known Limitation

A slice contains only its own deployable's comprehension. A flow is in the
slice when its own root (`entry_point`) is; sharing a capability with a flow
rooted in another unit is NOT containment, since capabilities are
cross-cutting by construction. A capability's `operations` and its
`related_flows` references are narrowed to entry points and flows PRESENT in
that slice — a scoped payload MUST never name another deployable's flows.
This applies to every scoped retrieval surface, including a named-section
read (`?sections=...&das_unit_id=...`), which MUST slice rather than accept
the scope parameter and silently return the repo-level rollup.

**Known limitation (documented honestly, not overclaimed).** The current
implementation filters/prunes the parent CAS's ALREADY-COMPUTED capabilities
and flows down to the slice's entry-point/node subset; it does not
re-project them from scratch through the semantic-model construction rules
(docs/SEMANTIC-MODEL.md's capability/flow/step/ICELOT doctrine) applied to
the subgraph. This is a cheaper approximation than full re-derivation and can
under- or over-scope a capability whose entry points and entities span unit
boundaries in a way the parent-CAS capability's shape does not cleanly
decompose. Full re-derivation over the sliced subgraph is tracked as
follow-on work (§10) and is not yet implemented — a consumer should treat a
slice's `system_capabilities`/`flow_graph` as filtered-from-parent, not as
independently re-derived.

## 4. The Rollup Index

Whether a CAS promotes or not, `get_summary` (and any DAS-aware surface)
exposes a `DasIndex` — the list of DAS unit ids/names/tiers/boundary evidence
a reader consults before drilling into any one unit.

```typescript
interface DasUnitIndexEntry {
  id: string;                    // Stable — derived from the owning DeployableEvidence identity (§7)
  name: string;
  root_path: string;
  member_root_paths: string[];
  tier: 1 | 2 | 3;
  kind: DeployableEvidence['kind'];
  node_count: number;            // Includes shared code — see §3.2
  exclusive_node_count: number;
  shared_node_count: number;
  owned_shared_node_count: number;
  entry_point_count: number;
  exit_point_count: number;
  seed_node_count: number;
  seed_basis: string[];
  boundary_evidence: string[];
}

interface DasIndex {
  promoted: boolean;
  units: DasUnitIndexEntry[];
  qualified_unit_count: number;
  promotion_threshold: number;   // 2
  reason: string;                // Always populated, including when promoted === false
  graph_node_count: number;      // Parent CAS's total node count — the coverage denominator
  covered_node_count: number;
  coverage_ratio: number;        // covered_node_count / graph_node_count, 0-1, 4dp
  exclusive_node_count: number;
  shared_node_count: number;
  sum_of_unit_node_counts: number;
  orphan_node_count: number;     // Nodes reached by NO unit at all — reported, never dropped
  orphan_node_ids: string[];
  counts_note: string;           // One-sentence explanation of the counting model above
}
```

A CAS with fewer than 2 qualified units MUST return `promoted: false` with
`units: []` and every count field zeroed — never a synthesized one-entry unit
list — with `reason` distinguishing "0 qualified" from "1 qualified, below
threshold".

## 5. CAS-as-Rollup Semantics

When a CAS promotes, the repo-level CAS analysis does not disappear — it
changes role from "the analysis" to "the rollup plus the things that only
make sense at repo scope":

**Stays at repo level:** repo-wide conventions/idioms/agent rules
(`get_codebase_idioms`, `get_conventions` — these describe how the repo is
written, not what any one deployable does); the test-suite inventory, unless
a test clearly scopes to one ship unit's path; the shared-code
canonical-ownership index (§3.2); cross-unit seams — an integration between
two DAS units in the SAME repo (unit A calls unit B's API, or they share a
message channel) is a repo-level fact, analogous to a
`WorkspaceApplicationLink` but scoped inside one CAS; repo-level
health/risk/activity/freshness that isn't unit-specific; and the rollup
index itself (§4).

**Moves per-unit:** capabilities, flows, entities, and entry/exit points
scoped to that unit's reachability closure (§3.1); the unit's own
communication seams; and unit-local risk/hot-spot findings whose evidence
lives entirely inside the unit's node subset.

A promoted CAS's own `get_summary` becomes, in effect, a miniature WAS: it
reports N deployables with their seams, scoped to one repo's internal ship
units instead of N separate repos.

## 6. Relation to CAS and WAS

- **CAS -> DAS.** DAS slicing runs strictly after CAS completion, over the
  completed CAS's own facts — never in place of it, never re-parsing source.
- **DAS -> WAS.** WAS already consumes `WorkspaceDeployable[]` built from
  `deployable_evidence`/`DeployableEvidence` rows. When a member CAS has
  promoted, WAS MUST consume its DAS units directly as the source of the
  corresponding `WorkspaceDeployable`'s capabilities, flows, entities, and
  seams — the three-hop provenance `workspace -> CAS (codebase_id) -> DAS
  (unit id)`, surfaced on `WorkspaceDeployable.source_das_unit_id` (see
  docs/was/SPECIFICATION.md §7). When a member CAS has NOT promoted, WAS
  falls back to building the deployable from `deployable_evidence` and
  whole-CAS facts, exactly as it does today. This fallback MUST be silent to
  the WAS schema: `WorkspaceDeployable` gains only the optional
  `source_das_unit_id` field and every other field is populated identically
  regardless of provenance.
- Two repos each contributing multiple deployables therefore show ALL of
  them as separate `WorkspaceDeployable` entries in one flat WAS
  `deployables[]` list — a 4-deployable, 2-repo workspace looks like 4
  first-class projects with their repo-of-origin tagged, not 2 projects with
  a nested list each.

## 7. Identity and Storage

- **Stable ids.** A DAS unit id MUST be derived deterministically from its
  owning `DeployableEvidence` row's stable identity (the same
  identity-collision-guarded construction `buildDeployableRoots` already uses
  to derive `deployable_id`) — never freshly minted per analysis run, so
  re-analyzing an unchanged repo yields the same DAS unit ids.
- **Storage posture (current: recompute-on-request).** A DAS unit is a VIEW
  over its parent CAS, not a separately persisted analysis artifact.
  `buildDeployableAnalyses` is a pure function of the parent `CASOutput`; a
  small in-process recency-ordered cache (keyed on `analysis_id`, bounded
  size) avoids repeating the reachability-closure and shared-attribution pass
  on every repeat MCP call against the same analysis, but this is a
  performance cache, not a persistence layer — no DAS-specific storage row
  exists yet. True incremental re-slicing (recomputing only the units whose
  closure intersects a changed file) needs a stored per-unit node-id-set to
  diff against, which does not exist yet either; today a DAS unit
  recomputes in full from its parent CAS on every request that needs it
  freshly. See §10 for the open persistence question.

## 8. Retrieval / MCP Contract

DAS does not introduce a parallel tool family. Existing repo-level tools gain
an optional scope parameter:

```typescript
interface DasScopeParam {
  das_unit_id: string;
}
```

- Omitted `scope` on a promoted CAS returns the rollup view (§5's
  CAS-as-rollup content plus the unit index) — the same shape a caller gets
  from a non-promoted CAS today, so existing callers that don't know about
  DAS keep working unchanged.
- A concrete `das_unit_id` scopes the call to exactly that unit's sliced
  facts. `scopeCasToDasUnit` throws (never a silent empty result) when the
  CAS hasn't promoted, or when `das_unit_id` doesn't match any current unit
  — naming the ids that DO exist in the error.
- As of this specification, `scope` is wired through `get_summary`,
  `get_entry_points`, `get_file_nodes`, `get_data_entities`, and
  `search_nodes` (via `query.ts`). Extending `scope` to the remaining
  repo-level tools (behavioral invariants, security boundaries, flow
  coverage/test gaps, idiom violations scoped to a unit) is tracked in §10 —
  those tools currently only see the repo-level rollup, not a per-unit slice.
- On the WAS side, `get_workspace_agent_context` and `get_workspace_summary`
  drilldown links for a DAS-backed `WorkspaceDeployable` point at
  `{repo-level tool}(scope: {das_unit_id})` on the owning codebase, not at a
  new workspace-level endpoint.

## 9. Invariants and Validation

- **Counts are honest.** The promoted-unit count MUST equal the
  tier-qualified ship-unit count from §2's threshold check — never inflated
  by Tier-4 folder guesses, never deflated by silently dropping a candidate
  into a unit it wasn't evidence-merged into.
- **No phantom units.** Every DAS unit id MUST be derived deterministically
  (§7) — never freshly minted per run.
- **Single-deployable is a valid, common, terminal state.** A CAS resolving
  fewer than 2 tier-qualified ship units MUST NOT promote, MUST NOT carry a
  one-entry DAS-unit list masquerading as a rollup, and validation MUST NOT
  penalize it for having no DAS units — this mirrors
  docs/was/SPECIFICATION.md §9's "zero integration links is valid" rule one
  layer down.
- **Demotion is reportable, not silent.** A repo whose DAS units vanish
  between two analyses (a Tier-1 artifact removed such that the ship-unit
  count drops below 2) MUST be flagged as a boundary-change event, the same
  posture docs/was/SPECIFICATION.md takes toward WAS facts disappearing
  without explanation — never a silent collapse back to a flat CAS with no
  note.
- **Shared-code attribution sums to exactly one canonical owner** — never
  zero (an orphaned shared region) and never more than one (double
  ownership) for any node classified `'shared'`.
- **Slice-local referential integrity.** Every reference a slice's own
  capabilities/flows carry (operations, `related_flows`) MUST resolve to an
  entry point or flow PRESENT IN THAT SLICE — never a dangling reference to
  another unit's flow id. This is the DAS-scoped instance of the CAS edge
  referential-integrity invariant (docs/cas/SPECIFICATION.md §5.32).
- **Reproducibility.** A DAS unit MUST be reproducible from its parent CAS's
  own facts alone — no new source-level parse, matching docs/was/SPECIFICATION.md
  §1's requirement for WAS relative to CAS.

## 10. Open Items (not yet implemented — flagged, not silently assumed)

These are real gaps in the current implementation, stated here so a consumer
does not assume more coverage than exists:

1. **Full semantic re-derivation vs. filter-down approximation** (§3.3). The
   current slice filters the parent CAS's already-computed capabilities/flows
   rather than re-projecting them through the semantic-model construction
   rules over the sliced subgraph. This can under/over-scope a capability
   whose entry points and entities span unit boundaries.
2. **Persistence and true incremental re-slicing** (§7). DAS units recompute
   in full from the parent CAS today; no stored per-unit node-id-set exists
   to diff against for incremental re-slicing, and no DAS-specific storage
   row exists to list DAS units alongside CAS/WAS analyses independently of
   their parent.
3. **Partial `scope` coverage** (§8). `scope` reaches five repo-level tools
   today. Behavioral invariants, security boundaries, flow coverage/test
   gaps, and idiom violations are not yet unit-scoped.
4. **Presentation of a promoted CAS's top-level summary.** Whether a
   promoted repo's `get_summary` should visually/structurally lead with the
   deployables-first miniature-WAS framing by default, or keep the
   repo-level rollup framing primary with DAS units reachable only via
   explicit drilldown, is not yet settled.
