# Fabric Fleet Proof

**What this proves:** a fleet of agents coordinating through the conceptual
fabric (`coordination/conceptual-scope.ts` + `coordination/partitioner.ts`,
§4 of `SPEC-CONCEPTUAL-LAYER.md`) is more formidable than the same fleet
coordinating on files/symbols alone — with real, asserted output, on real
flow/step ids computed from this repo's own cached analysis, not a synthetic
fixture.

**Harness:** `apps/mcp-server/src/gauntlet/fabric-fleet-proof.ts`

**Run it:**

```bash
cd apps/mcp-server
npx tsx src/gauntlet/fabric-fleet-proof.ts
```

It prints a full narrated transcript (real flow/step ids, real verdicts) and
exits non-zero if any property fails — nothing here is asserted-then-hidden.

**Blackbox posture:** the harness drives the same public coordination API
`server.ts`'s MCP tools call — `arbiter.ts`'s `arbitrate`,
`coordination/local-store.ts`'s `appendClaim`/`getActiveClaims`,
`conceptual-scope.ts`'s `buildConceptIndex` / `deriveConceptualCoordinate(s)`
/ `compareConceptualCoordinates`, and `partitioner.ts`'s `partitionTasks` /
`groupTasksByConcept` — plus one read through the already-cached analysis
(`analyzer.ts`'s `getAnalysis` + `query.ts`'s `getFlowConcepts`, the exact
same read path `server.ts`'s `conceptIndexForWorkspace` uses). It never calls
`createOrchestrator`/`orchestrateAnalysis`/`analyzeProject` — no engine
internals, no AI, no new analysis run. Each invocation uses an isolated
`KLAURO_COORD_DIR` temp dir (same pattern as `coordination-demo.ts`), so it
never touches a real `~/.klauro/coordination/` store and is safe to re-run
any number of times.

**Repo analyzed:** `/Users/michaelshattuck/dev/unravl/proof-of-concept`
(this repo), via its own already-cached CAS — 37,907 nodes, 36,361 edges,
**1,003 real flows** computed by `getFlowConcepts`. The harness picks a real
multi-step flow and two further real, distinct flows from that set at
runtime and prints the exact ids used, e.g.:

```
flow::entry:main:packages/analyzer-core/native/klauro-parse/src/main.rs
  ::step0 -> function:...main.rs:main
  ::step1 -> function:...main.rs:emit
flow::entry_file_apps_marketing_site_deploy_sh
flow::entry_file_apps_mcp_server_scripts_install_sh
```

(zerac-api was also probed — 11,881 nodes, 10,741 edges, 12 real flows — and
used during the harness's construction to confirm the corpus-wide entities
finding below; the shipped harness runs against proof-of-concept because it
has far richer flow structure, 1,003 vs 12.)

## The 6 properties, with real output

### 1. Always-on ambient awareness

Five agents claim work declaring **only** paths/symbols — no `flow_id`/
`step_id` at all. `deriveConceptualCoordinate` maps 4 of them onto real
flow/step coordinates with zero manual annotation and zero required overlap
between them:

```json
{ "agent_id": "agent-1", "symbol": "...main.rs:main",
  "concept": { "flow_id": "flow::entry:main:...main.rs", "step_id": "...::step0", "source": "derived" } }
{ "agent_id": "agent-2", "symbol": "...main.rs:emit",
  "concept": { "flow_id": "flow::entry:main:...main.rs", "step_id": "...::step1", "source": "derived" } }
{ "agent_id": "agent-3", "symbol": "file_apps_marketing_site_deploy_sh",
  "concept": { "flow_id": "flow::entry_file_apps_marketing_site_deploy_sh", ... } }
{ "agent_id": "agent-4", "symbol": "file_apps_mcp_server_scripts_install_sh",
  "concept": { "flow_id": "flow::entry_file_apps_mcp_server_scripts_install_sh", ... } }
```

The 5th agent names a symbol that matches no real flow in the index; it
**honestly degrades to `undefined`** — no fabricated coordinate. This is the
harness enforcing the module's own cardinal rule (`conceptual-scope.ts`'s
"DETERMINISTIC-FIRST": no derivation without a real backing FlowConcept).

### 2. Non-blocking parallelism

Agent A claims real step `...main.rs::step0`, Agent B claims real step
`...main.rs::step1` of the **same** real flow. Both `arbitrate()` calls
return `granted` (block-time = 0), and `compareConceptualCoordinates`
independently reports `awareness` — informational, not a gate:

```json
{ "verdict": "awareness",
  "reason": "Both agents are working within flow \"flow::entry:main:...main.rs\" but on DIFFERENT steps (...step0 vs ...step1) — safe to proceed in parallel, but worth knowing about each other.",
  "shared_flow_id": "flow::entry:main:...main.rs" }
```

### 3. Real conceptual-conflict catch

**3a (same step, same flow):** two agents both anchored on the real step
`...main.rs::step0` of the real flow `flow::entry:main:...main.rs` produce
`conceptual_conflict` with `shared_step_id` populated — real overlap, not
mere file/symbol collision.

**3b (cross-flow, same entity — the §4 case a file/line tool structurally
cannot see):** Agent C is on real flow A, Agent D is on real flow B — a
genuinely different flow with zero shared files or symbols. Both declare
they touch the same entity's constraints (`entities: ["Order"]`).
`compareConceptualCoordinates` returns:

```json
{ "verdict": "conceptual_conflict",
  "reason": "Both agents touch the SAME entity's constraints (Order) even though their flows/files differ — semantic overlap a textual/file diff would miss.",
  "shared_entities": ["Order"] }
```

See **Honest limits** below for why 3b uses *declared* entities rather than
derived ones.

### 4. Dedup

Agent E claims real step `...main.rs::step0` under capability label
`"flow-work"`. Agent F is independently dispatched the identical step (a
fleet-scheduling mistake) under the *same* capability label — `arbitrate()`
returns `duplicate` referencing Agent E's claim, before Agent F does any
work. The conceptual comparison independently confirms it's the same
flow+step, not just a matching label — both signals agree.

### 5. Conceptual partitioning

Four tasks, three with distinct real `flow_id`s (task-1 and task-2
deliberately share the flow from property 2 — same flow, different steps;
task-3 and task-4 are each alone on their own real flow).
`groupTasksByConcept` produces exactly 3 conceptual groups:

```json
[
  { "kind": "flow", "concept_id": "flow::entry:main:...main.rs", "task_ids": ["task-1", "task-2"] },
  { "kind": "flow", "concept_id": "flow::entry_file_apps_marketing_site_deploy_sh", "task_ids": ["task-3"] },
  { "kind": "flow", "concept_id": "flow::entry_file_apps_mcp_server_scripts_install_sh", "task_ids": ["task-4"] }
]
```

Two of those three groups are safe to route to fully separate agents/waves
purely on conceptual grounds, independent of whatever the file/symbol
`batches` coloring computed.

### 6. The fabric-vs-no-fabric contrast (measured, not asserted-then-hidden)

The same two hard cases (3b's cross-flow entity conflict, and a
relabeled-duplicate variant of property 4 where Agent G declares a
*different* capability label so the literal-label dedup can't fire) are
re-run through **file/symbol-only** `arbitrate()` — no concept passed at
all:

```json
{
  "cross_flow_entity_conflict":   { "missed_by_file_symbol_only": true, "caught_by_conceptual_fabric": true },
  "relabeled_duplicate_work":     { "missed_by_file_symbol_only": true, "caught_by_conceptual_fabric": true }
}
```

Both cases are **silently granted** by file/symbol-only coordination (no
path, symbol, or capability-label overlap exists to catch) and both are
caught by the conceptual layer. This is the honest, quantified before/after:
not an inflated number, just "0 signals vs 1 signal" on two concrete,
reproducible cases, using real flow ids from this repo's own analysis.

## Honest limits (what's demonstrated vs still aspirational)

- **Derived `entities` do not materialize on either real corpus tested.**
  `flow-concepts.ts` derives a flow's `entities` by matching flow node ids
  against `cas.data_entities[].lifecycle` toucher ids. On both this repo
  (1,003 flows, 79 data entities, 494 total entity-lifecycle touchers) and
  zerac-api (12 flows), **zero** entity touchers resolved to a flow through
  `deriveConceptualCoordinates` — 0 of 494 on this repo. The two id
  namespaces don't overlap in practice: this repo's flow index is keyed on
  frontend `route_.../component_.../hook_usage_...` ids (React route ->
  component -> hook traversal), while `data_entities` lifecycle touchers are
  backend `method_class_...` service-method ids. So property 3b/6's
  cross-flow-entity case is demonstrated with **declared** entities
  (`entities: [...]` passed directly to `claim_work`, a first-class,
  already-documented, already-unit-tested input — see
  `conceptual-scope.test.ts`), not a derived hit. The derivation path itself
  is correct and tested; it simply has no real, populated example to point
  to yet on either corpus in this fleet's reach. Closing this gap is a
  flow-concepts follow-on (e.g. keying `data_entities` lifecycle by a
  namespace the flow walker also produces, or extending the flow walker to
  also traverse backend service-method call chains), not a fix to the
  coordination layer proven here.
- **Same-machine only.** Every scenario runs through the LOCAL tier
  (`coordination/local-store.ts`'s file-backed `claims.jsonl`), matching
  `coordination-demo.ts`'s existing scope note. Cross-machine sync is a
  separate, already-tracked workstream (remote-store.ts exists but isn't
  exercised here).
- **Two real repos probed, one shipped.** zerac-api's 12 real flows were
  used to independently confirm the entities finding above but are too thin
  (mostly single-step shell-entrypoint flows) to carry properties 2/3a/4/5
  convincingly; the harness ships against this repo's 1,003 flows instead
  and says so rather than picking whichever repo made the numbers look best.
- **Property 3a's "same step, different symbols" framing is a simplification.**
  The real step (`...main.rs::step0`) in this repo's selected flow has a
  single function member, so the demonstrated same-step conflict uses the
  same anchor symbol for both agents rather than two literally-different
  symbols that both happen to belong to the same step. The verdict logic
  (`compareConceptualCoordinates`) is exercised identically either way — it
  compares flow_id/step_id, not the underlying symbol set — but a reader
  wanting the "two different symbols, same step, still a conflict" case in
  its purest form should look at `conceptual-scope.test.ts`'s dedicated
  fixtures rather than this harness's real-flow selection.

## Bottom line

Properties 1, 2, 4, and 5 are demonstrated end-to-end with fully **derived**
conceptual coordinates from real flow data — no fixture, no hand-authored
concept. Property 3/6's cross-flow-entity case is real and correctly
classified by the fabric, but currently reachable only via **declared**
entities on both real corpora tested — a genuine, now-documented gap between
what the API supports (and is unit-tested for) and what today's
`flow-concepts.ts` output naturally produces. That gap is flagged as a
product finding, not smoothed over.
