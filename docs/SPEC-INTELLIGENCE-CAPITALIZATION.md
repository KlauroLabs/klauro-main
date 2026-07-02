# SPEC — Intelligence Capitalization Audit

> **Status: IN PROGRESS** as of e1780f62 (2026-07-02) — get_interface_signature (I/L/S/O join, concept #2 + terminal-why #1) SHIPPED; other concepts still latent per the table.

**Date:** 2026-07-02
**Method:** Live dogfood of the deployed Klauro MCP tools against this repo
(proof-of-concept itself), `resolve_agent_analysis` confirmed fresh
(3h-aging, 5 files changed since, none in the audited areas). No product
source edited; no commits made. This is a read-only audit + design doc.

**Founder's question, restated honestly:** for each core intelligence
concept — are we computing it, surfacing it, and is what's surfaced enough
to give an agent a capability it could not have any other way? The answer
varies wildly by concept, and one of the six tools named in the audit brief
(`get_architectural_conflicts`) **does not exist** — that itself is a
finding.

---

## 1. Verdict table

| # | Concept | Computed? | Surfaced on MCP? | Taught to agents? | Verdict | Impact if fully capitalized |
|---|---|---|---|---|---|---|
| 1 | Terminal-node proximity → "why" | Yes — `terminal-signal.ts` is a real, carefully-tuned ranking engine (write>read weighting, user-facing multiplier, noise filters for HTTP verbs/lifecycle names/utility patterns, stage-decay for near-terminal business stages) | Partial — feeds into `get_product_map` domain/description inference and `get_user_journeys` terminal_entities, but the ranked signal itself (`ranked_entities`, `ranked_stages`, `ranked_capabilities` with scores) is **not exposed as its own MCP tool or field** | No — no tool description or server instruction tells an agent "terminal proximity is why this exists, query it directly" | **LATENT** | An agent asks "why does this module exist" and gets the actual ranked terminal-entity evidence with scores instead of inferring purpose from file names — turns "guess the domain" into "read the domain's proof" |
| 2 | I/L/S/O universality (recursive interface signature) | Pieces yes (entry_points=I, exit_points=O, data_lineage external_recipients=S, callers/callees=L), unification no | **No** — four separate tools, four separate ID spaces, four separate call shapes; nothing joins them per-entity | No | **LATENT — the single biggest gap** | This is the thesis of the whole product (composable, recursive interface at every level) and it does not exist as a queryable object anywhere. See §2. |
| 3 | CAS + WAS (the specs) | CAS: yes, mature (v1.11.0, `docs/cas/SPECIFICATION.md` + versioned RFPs v1.0–v1.10). WAS: yes, built (`cross-codebase-analysis.ts`) | CAS: yes, ~160 MCP tools. WAS: yes, `get_cross_codebase_analysis`, `get_cross_repo_contracts`, `get_workspace_*` | Partially — CAS is well-taught via `get_coding_context`/`resolve_agent_analysis` sequencing; WAS discovery is less taught (no single "start here for cross-repo" entry in server instructions comparable to CAS's) | **FULLY-CAPITALIZED (CAS) / LATENT (WAS onboarding)** | WAS is real infrastructure that agents underuse because nothing tells them it's there before they need cross-repo context |
| 4 | Coordination fabric (in-flight) | Partially — claim/collision/presence primitives are coded (`apps/mcp-server/src/coordination/`), tools registered in `server.ts` (`claim_work`, `check_collision`, `heartbeat_work`, `release_work`, `get_active_agents`, `get_in_flight_changes`, `subscribe_workspace`) | **No, not from this session** — none of the 7 coordination tool names resolve via ToolSearch against the live connected `mcp__klauro__*` surface, despite being registered in source. Per the project's own spec (`SPEC-COORDINATION-FABRIC.md`), arbitration (L5) is explicitly marked "❌ greenfield," telemetry fusion (L3) "❌ missing," in-flight cross-machine sync (L4) "⚠️ partial" | Yes in the doc (`COORDINATION-FABRIC.md` teaches the protocol clearly), but moot if the tools aren't reachable | **MISSING (in practice) / LATENT (in code)** | Multi-agent collision prevention — the "fleet coordination" category thesis — is not yet something an agent using this deployed server can rely on |
| 5 | Framework/paradigm detection + alignment | Yes — `get_paradigm_conformance` returned two paradigms at 100% adoption with real evidence files; `get_patterns` returned 21 patterns with instance counts; `get_architecture_context` gives inventory + decision matrix | Yes, well surfaced (3 distinct tools) | Yes — `get_coding_context` folds `related_patterns` and `layer_boundaries` into the single pre-edit call | **FULLY-CAPITALIZED**, with one caveat: **`get_architectural_conflicts` does not exist.** Conflict detection between paradigms/patterns (e.g., "these two modules disagree on layering") is not a tool | Agents currently get "here is the norm" but not "here is where the norm is actively fighting itself" |
| 6 | Telemetry overlay + depth | Scaffolded — `runtime-contract.ts`, `runtime-sdk.ts`, `telemetry-ingestion.ts`, `correlate_runtime_event`, `get_runtime_observations` all exist and are callable | Yes as tools, but **empty on this repo**: `get_runtime_observations(source=all)` returned `ingested_count: 0, simulated_count: 0` — the fusion step (runtime reality merged into live CAS) is explicitly marked "❌ missing — needs L3 build" in the project's own spec | Tool exists, description is clear, but there is nothing to teach because there is no data path exercised in practice on real repos | **LATENT (scaffolded, not fused)** | "Which of these 40 similar-looking endpoints is the hot path in production" — impossible today; would be transformative for prioritization and blast-radius weighting |

---

## 2. Deep-dive: I/L/S/O universality — the recursive interface signature

### The idea, restated precisely
Every unit of the system — function, flow/journey, capability, project,
workspace — has the same four-part shape:

- **I — Input (requires):** what it needs to run (params, upstream calls,
  triggering entry points)
- **L — Logic (blackbox):** the internal call graph / transformation (the
  "how," which the caller should NOT need to know)
- **S — Side-effects (touches 3rd parties):** external writes, API calls,
  DB mutations, message publishes — anything with a blast radius outside
  the unit itself
- **O — Output (produces):** what it returns / hands downstream (return
  value, emitted event, terminal entity written)

This is the shape that determines integration impact, coordination surface,
and change/blast-radius — at every scale, recursively. A function's O often
becomes a flow's I; a flow's S often becomes a capability's boundary
crossing; a capability's I/O often defines a project's public contract; a
project's S is a workspace's cross-repo seam.

### What Klauro actually computes today, mapped to I/L/S/O

| I/L/S/O part | Feeding tool(s) today | Granularity available | Gap |
|---|---|---|---|
| **I** (input) | `get_entry_points` (978 entries: cli/message/test types) | Whole-system entry list, not per-node | No per-function/per-flow "what does THIS thing require" rollup; entry_points is a flat system-level list |
| **L** (logic) | `get_callers`/`get_callees`/`get_call_chain`, `get_coding_context.connected_code` | Per-node, good | This is the best-covered quadrant — but it's never joined to I/S/O for the same target in one call |
| **S** (side-effects) | `get_exit_points` (637 entries: api/database/file/message/cache types), `get_data_lineage.external_recipients` | Whole-system exit list + per-entity recipients | Two different tools with two different notions of "external" (exit_points = code-level call sites; data_lineage = entity-level recipients) that are not reconciled |
| **O** (output) | Return types on nodes (via `get_node`), `terminal_entities` on journeys | Present but scattered | No unified "this function/flow's output contract" view |

**Concrete evidence of the gap**, from this session's dogfooding:
- `get_entry_points` and `get_exit_points` are both **flat, system-wide,
  paginated lists** (978 and 637 items respectively on this repo) — an
  agent cannot ask "what is the I/L/S/O of `WorkspacesService`" and get one
  answer; it must intersect two 1000-item lists by node_id itself.
- `get_coding_context` — "THE essential tool for AI coding" — returns
  `connected_code.callers/callees` (= L) and `layer_boundaries` (partial
  L/I boundary) but does **not** include the target's own entry/exit-point
  membership or its data-lineage role. A coding-context call for
  `WorkspacesService.createOrganizationWorkspace` would not tell you it
  writes to `Organization` (S, confirmed via `get_data_lineage` separately)
  unless you cross-reference by hand.
- `get_user_journeys` computes a *journey-level* O (terminal_entities) and
  S (external_services) but there is no equivalent rollup at the
  *capability* or *project* level — `get_product_map.capabilities` lists
  entities touched but not requires/produces/side-effects distinctly.

This is real, unclaimed territory: the pieces are unusually rich (few
products compute exit_points AND data_lineage AND call chains
deterministically), but nobody has written the join.

### Proposed tool: `get_interface_signature`

```
get_interface_signature(path, target, level?)
```

- `target`: node id, file path, capability name, journey id, or the
  project root itself (workspace root triggers workspace-level rollup)
- `level` (optional, auto-detected from target shape): `function | flow |
  capability | project | workspace`
- Returns, for the resolved target:

```jsonc
{
  "target": { "id": "...", "level": "capability", "name": "Workspaces" },
  "input": {
    "entry_points": [...],       // from get_entry_points filtered to target's subtree
    "upstream_callers": [...],   // from get_callers, deduped to external-to-target only
    "required_params": [...]     // from node signatures, rolled up
  },
  "logic": {
    "internal_call_graph_size": 42,
    "layer": "business",
    "owns_nodes": [...]          // the blackbox boundary — what's inside vs crossing it
  },
  "side_effects": {
    "exit_points": [...],        // from get_exit_points filtered to subtree
    "external_recipients": [...],// from get_data_lineage, entities written/read
    "boundaries_crossed": [...]  // security boundaries from journeys touching this target
  },
  "output": {
    "produces": [...],           // return types / emitted events
    "terminal_entities": [...],  // from terminal-signal.ts scoring, if target is on a journey path
    "downstream_consumers": [...] // from get_callees reversed / journey continuation
  },
  "recursion": {
    "composed_of": [...],        // child-level I/L/S/O targets (function -> flow -> capability -> project)
    "composes_into": [...]       // parent-level targets this rolls up into
  }
}
```

**Where each field is sourced from existing facts** (no new analysis
needed, only a join layer):
- `input.entry_points` ← existing `entry_points` array, filtered by
  file/node subtree membership (already computable — entry points carry
  `source_node`)
- `input.upstream_callers` ← existing `get_callers` graph traversal
- `logic.*` ← existing `get_call_chain`/`get_coding_context.connected_code`
- `side_effects.exit_points` ← existing `exit_points` array, same subtree
  filter as entry_points
- `side_effects.external_recipients` ← existing `get_data_lineage`
  `external_recipients` + `boundaries_crossed`, joined by which entities
  the target's writers/readers appear in
- `output.terminal_entities` ← **directly reuse `terminal-signal.ts`**,
  today only invoked internally for domain inference — this is the same
  ranking engine, just exposed per-target instead of pooled for the whole
  repo
- `recursion.*` ← new, but mechanical: function nodes roll up into the
  file/module; modules into capabilities (`get_product_map.capabilities`
  already has `entities`/journeys links to walk); capabilities into the
  project; projects into workspace via existing WAS cross-repo links

### Agent superpowers this unlocks
1. **Precise change-impact**: "If I change this function's output shape,
   what S (side-effects) and downstream O (consumers) break?" — currently
   requires 4 separate tool calls and manual set intersection; would
   become one call.
2. **Integration coordination**: before touching a capability, an agent
   asks for its I/L/S/O at the capability level and immediately knows its
   full contract surface (what calls in, what calls out, what it's
   allowed to be a blackbox about) — this is exactly what
   `get_architecture_context`'s `layer_boundaries` gestures at today but
   doesn't compute recursively.
3. **Blast radius at any level**: today blast radius is implicitly
   `get_callers` (function-level only). With recursive I/L/S/O, "blast
   radius of touching this capability" becomes `side_effects ∪
   downstream_consumers` rolled up from every function inside it —
   currently impossible without walking the whole subtree by hand.
4. **Coordination-fabric payload**: `claim_work`'s blast-radius overlap
   detection (WS-D, `check_collision`) is *exactly* an I/S comparison
   between two claims' targets — `get_interface_signature` would be the
   natural primitive underneath collision detection, unifying concept #2
   and concept #4.

### Validation test (does this unlock something an agent couldn't do before)
Give two agents the same task: "Agent A changes
`WorkspacesService.createOrganizationWorkspace`'s return shape — will this
break anything downstream, and does it touch any external system?"
- **Without** `get_interface_signature`: agent must call
  `get_coding_context` (misses exit points/data lineage), then
  `get_exit_points` and manually filter, then `get_data_lineage` and
  manually filter, then `get_callers` reversed to estimate downstream
  consumers — 4+ tool calls, manual joins, high chance of missing the
  `Organization` write side-effect (confirmed in this session it is NOT
  in `get_coding_context`'s output for a comparable target).
- **With**: one call, one JSON answer with I/L/S/O explicit.
- Measurable: token count and call count for the same correct answer,
  before/after. Correctness measurable by whether the agent's answer
  includes the `Organization` entity write (ground truth from
  `get_data_lineage` in this session).

---

## 3. Per-concept capitalization plans (LATENT/MISSING only)

### Concept 1 — Terminal proximity (LATENT → capitalize)
- **Compute**: already done, no change needed to `terminal-signal.ts`.
- **Surface**: add a `terminal_signal` section to `get_product_map` (it's
  literally the internal input to `identity.description` already — just
  stop discarding the ranked evidence after using it to write prose) and
  expose the same ranked entities/stages per-target inside the new
  `get_interface_signature.output.terminal_entities` field (see §2).
- **Teach**: one sentence in `get_product_map`'s tool description: "why a
  module exists is evidenced by its terminal entities — see
  `terminal_signal` for the ranked proof, not just the inferred label."
- **Validate**: ask an agent "why does capability X exist" with and
  without the ranked terminal evidence attached; measure whether the
  agent's answer cites concrete evidence (entity names + scores) vs.
  guesses from naming.
- **Effort**: low (data already computed, just needs a pass-through field).

### Concept 2 — I/L/S/O (LATENT → capitalize, highest priority)
- Plan is §2 in full. **Effort: medium** (new tool, but almost entirely a
  join layer over existing computed facts — no new analyzer passes
  required except the recursion rollup table, which is mechanical).
- **This should be built first** — it's the unifying abstraction the
  founder suspected, the facts already exist, and concept #4
  (coordination) directly depends on it for collision/blast-radius
  detection.

### Concept 3b — WAS onboarding (LATENT → capitalize)
- **Surface**: today an agent must already know to call
  `get_cross_codebase_analysis`; there's no equivalent of
  `resolve_agent_analysis` that says "this is a monorepo/workspace, WAS is
  available, call X first."
- **Teach**: extend `resolve_agent_analysis`'s response (it already
  returns `candidates` showing sibling analyses like `apps/mcp-server`,
  `packages/analyzer-core` in this very session) with an explicit
  `workspace_available: true` + `next_tool: "get_cross_codebase_analysis"`
  hint when multiple sibling analyses are detected under one root — which
  is exactly what happened in this audit (14 candidate paths returned,
  no signal to reach for WAS).
- **Effort**: low.

### Concept 4 — Coordination fabric (MISSING in practice → capitalize)
- **Reality check**: this is not a surfacing gap so much as a
  **deployment/reachability gap** — the tools exist in `server.ts`
  (verified via grep: `claim_work`, `check_collision`, `heartbeat_work`,
  `release_work`, `get_active_agents`, `get_in_flight_changes`,
  `subscribe_workspace` are all registered with full zod schemas and
  descriptions at line ~4277+), but none resolve on the live connected
  MCP surface used in this session, and the project's own
  `SPEC-COORDINATION-FABRIC.md` (dated 2026-07-01, one day before this
  audit) self-grades L5 arbitration as "❌ greenfield" and L3 telemetry
  fusion as "❌ missing."
- **Capitalize**: (a) confirm/fix why the coordination tool group isn't
  reaching this session's connected server — likely a build/deploy step
  or a tool-group gating flag; (b) once reachable, the write-side
  (`claim_work` arbitration logic) is the actual remaining engineering
  per WS-C/D in the spec — this doc should not re-litigate that plan,
  it's already scoped in `SPEC-COORDINATION-FABRIC.md`.
- **Validate**: two agent sessions against the same workspace, one with
  coordination tools reachable and used, one without; measure whether the
  first pair avoids a file-clobber that the second pair produces.
- **Effort**: unknown until the reachability gap is diagnosed — flagging
  as a feedback item, not silently fixing (audit is read-only).

### Concept 5b — Architectural conflicts (MISSING → capitalize)
- `get_architectural_conflicts` was named in the audit brief as if it
  exists; it does not. What exists instead: `get_paradigm_conformance`
  (per-paradigm deviations) and `get_patterns` (pattern inventory) — both
  are single-paradigm/single-pattern views. Neither computes
  **cross-paradigm or cross-pattern contradiction** (e.g., "60% of the
  codebase uses Repository, 40% uses direct ORM calls in the same layer —
  these are in active tension" or "this module claims Service Layer but
  its Controller reaches the Repository directly, contradicting
  entry-service-repository-layering elsewhere at 100% adoption").
- **Compute**: partially derivable today — `get_paradigm_conformance`
  already returns `sample_deviations` per paradigm; a conflict is simply
  two paradigms/patterns whose evidence sets overlap on the same file/node
  with contradictory shape. On this repo both paradigms are at 100%
  adoption with 0 deviations, so there's nothing to demo conflict
  detection against here — but the absence of deviations here does not
  mean the detector exists elsewhere; grep confirms no
  `architectural-conflict` or `conflict` logic in
  `packages/analyzer-core/src/analyzer/core/`.
- **Surface**: new tool `get_architectural_conflicts(path)` — cross-join
  `get_paradigm_conformance` deviations against `get_patterns` instances
  on the same node/file; flag nodes that violate paradigm A while
  matching pattern B where A and B are supposed to compose.
- **Effort**: medium (needs a real cross-join pass, not just exposure of
  existing data — this is a genuine MISSING, not LATENT, gap).

### Concept 6 — Telemetry fusion (LATENT/scaffolded → capitalize)
- Confirmed via live call: `get_runtime_observations(source=all)` on this
  repo returns zero ingested and zero simulated observations. The
  ingestion/correlation plumbing (`ingest_telemetry`,
  `record_runtime_event`, `correlate_runtime_event`) is real and callable,
  but nothing in this repo's own operation has exercised it — Klauro does
  not appear to dogfood its own telemetry SDK against its own MCP server
  traffic, which would be the most credible proof this works.
- **Capitalize**: wire `apps/mcp-server`'s own request handling through
  the `klauro-express-middleware`/SDK (already vendored in
  `packages/analyzer-core/src/sdk/javascript/`) so this repo's own
  analysis has non-zero runtime observations — turns this audit's most
  glaring "empty" result into a self-proof.
- **Validate**: after wiring, re-run `get_runtime_observations` and
  confirm non-zero; then test whether `get_hot_spots` or
  `get_coding_context` for a hot MCP tool handler surfaces the fused
  runtime weight vs. static-only ranking.
- **Effort**: low-medium (SDK exists, just needs to be pointed at itself).

---

## 4. Priority ranking (impact per effort)

1. **`get_interface_signature` (concept 2)** — highest impact (the
   unifying abstraction), medium effort (pure join layer over existing
   facts). Build first.
2. **Terminal-signal surfacing (concept 1)** — high impact for "why"
   questions, very low effort (expose data already computed). Trivial
   add, do alongside #1 since `get_interface_signature.output` needs it
   anyway.
3. **Coordination fabric reachability fix (concept 4)** — potentially
   highest strategic impact (the category-thesis feature) but blocked on
   diagnosing a reachability gap outside this audit's read-only scope;
   flag and escalate, don't estimate effort blind.
4. **WAS onboarding hint (concept 3b)** — low effort, meaningful for
   monorepo/workspace-heavy users (which includes Klauro's own repo).
5. **`get_architectural_conflicts` (concept 5b)** — medium effort, real
   gap, but this repo's own paradigms are at 100% adoption so there's no
   local urgency; valuable on messier real-world repos.
6. **Telemetry self-dogfooding (concept 6)** — low-medium effort, high
   credibility value (proves L3 fusion works using Klauro's own traffic
   before asking users to trust it on theirs).

---

## 5. Honesty notes

- The audit brief's tool list assumed `get_architectural_conflicts`
  exists. It does not. This is called out rather than silently
  substituted.
- The coordination fabric's MCP tools are real, documented, and
  registered in source, but were **not reachable from this live session**
  — this is reported as observed, not diagnosed further (out of scope for
  a read-only audit).
- `get_user_journeys` on this repo returns only 4 journeys, all CLI/shell
  entrypoints with `step_count: 1-2` and zero tests/security boundaries.
  This is an honest reflection of what this repo *is* (a monorepo tooling
  product, not a journey-rich CRUD app) — the journey engine is not weak,
  the surface area here is just thin. `get_product_map.health.status:
  "at-risk"` with `score: 48` despite 62/62 passing tests and 98%
  implementation completeness suggests the health scoring formula itself
  may be over-weighting something (worth a separate look, flagged as a
  feedback item, not fixed here).
