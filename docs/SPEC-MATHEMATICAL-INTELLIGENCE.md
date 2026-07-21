# SPEC: Mathematical Intelligence

Status: master spec. Goal: make Klauro significantly more intelligent about
analysis, fabric coordination, and optimization via mathematical methods —
each grounded in data the CAS verifiably stores today.

Doctrine (non-negotiable):

1. **Deterministic-first.** Every layer below is a deterministic fact computed
   from stored structure. AI interprets on top; it never produces these
   numbers. No keyword/vocabulary hardcoding anywhere.
2. **Budgets are never completeness cutoffs.** Math serves architecture and
   ranking; it never truncates analysis (see
   `ANALYSIS-EXECUTION-ARCHITECTURE.md` invariant 4).
3. **Reordering cannot change truth.** All algorithms here must be
   deterministic (fixed iteration order, fixed seeds) so the same CAS revision
   always yields the same scores.
4. **Examples are shape-based.** No client or benchmark product names in this
   doc or in product source.

## Verified data inventory

Checked against `packages/analyzer-core/src/types/cas.types.ts` and the live
self-CAS (54,436 nodes / 61,704 edges / 4,846 entry points, 4,259 of them
tests):

| Data | Where | Status |
| --- | --- | --- |
| Call graph (typed edges, weight/confidence/occurrences/locations) | `CASEdge.metadata`, `edges[]` | stored, complete |
| Entry/exit points (typed, per-deployable) | `CASEntryPoint`/`CASExitPoint` | stored |
| Louvain communities (one-level, deterministic) | `CASCommunity`, `core/community-detection.ts` | stored, underused |
| Per-node churn from git (30d/90d commits, authors, lines) | `CASTemporalStability`, `core/git-analyzer.ts` | stored |
| Per-commit changed-file sets | `git-analyzer.ts` `commitsByFile` | parsed in-process, **not aggregated pairwise** |
| Per-phase wall-clock timings | `CASAnalysisTimings.stages`, `CASAnalysisPhase.duration_ms` | stored (self-run: scan 6.9s, parse 162.5s, graph 43.2s, decorators 2.5s, ai_enrichment 303.1s, save 7.7s) |
| Semantic coverage ratios + unmapped lists | `get_semantic_coverage` | live: reachable→steps **0.4744**, flows→capabilities 0.849 |
| AI decision records (evidence digest, gate verdict, confidence) | `ai/semantic-dataset.ts` (schema e1.1) | module shipped, **env-gated OFF — volume ≈ 0** |
| Description prose + provenance | `description_source`, `description_generation` | stored |
| Complexity metrics (cyclomatic/cognitive) | `CASNode.metadata.complexity` | stored |

Known defects these workstreams target:

- **D1 core-flow ranking**: `core/flow-scorer.ts` ranks capabilities with three
  hardcoded keyword sets and `centrality_score: 0` (literally never computed) —
  a cardinal-rule violation, and the reason UI click handlers surface as flows
  (visible live: the unmapped-flow list is dominated by `* Click` / `* Change`
  event chains).
- **D2 step coverage**: 47.4% of reachable code participates in no step.
- **D3 catalog variance (#33)**: capability catalog differs across identical
  runs of the AI pass.
- **D4 latency**: ai_enrichment is 57% of a 526s self-run; 3-minute budget.
- **D5 fabric collisions**: overlap detection is one undirected call-graph hop
  (`coordination/partitioner.ts` `expandOneHop`) — transitive collisions are
  invisible.

---

## Workstream A — Graph centrality layer (FLAGSHIP)

**Feeds:** `edges[]` filtered to call-ish types; `entry_points[]` excluding
`type: 'test'` (mandatory — 88% of self entry points are tests and would
poison the seed set); `exit_points[]` for absorption-aware variants later.

**Algorithm:** Personalized PageRank, power iteration, seeded uniformly over
non-test entry points, damping 0.85, fixed node order, convergence at L1 <
1e-8 or 100 iterations. Complexity O(iters × E): ~6M edge-ops at 62k edges,
sub-second; ~50M at 500k edges, still seconds. Plus approximate betweenness by
Brandes sampling with k deterministic pivot sources (k=256, seeded by node-id
hash), O(kE) — exact Brandes O(VE) is ruled out at 500k nodes.

**Stored as:** two new optional per-node fields, `centrality: { ppr: number;
betweenness_approx: number }`, computed in the graph stage (deterministic,
no AI), plus a `centrality_meta` block (seed count, iterations, converged).

**Consumers / expected gain:**
1. `flow-scorer.ts`: delete the three keyword pattern sets; rank capabilities
   by aggregate PPR mass of their operation nodes (fixes D1 at the root — a
   UI change-handler chain has near-zero PPR mass; a chain through the graph
   core does not).
2. Semantic-step eligibility: a reachable node with PPR above a percentile
   threshold and no step is a *ranked* coverage gap — turns D2's flat 47.4%
   into a prioritized worklist instead of an undifferentiated number.
3. `get_hot_spots` / risk: churn × centrality is the canonical hotspot
   definition; today hotspots use churn alone.
4. AI-description spend targeting: enrich high-PPR elements first — same spend,
   visibly better coverage of what agents actually ask about (D4-adjacent).

**Gate:** on the self-CAS and 3 corpus repos of different shapes, (a) zero UI
event-handler chains in the top-10 capability ranking (today: present), (b)
rank correlation of top-50 PPR nodes vs. agent-queried nodes from telemetry
≥ baseline keyword ranking, (c) byte-stable across two runs.

**Effort:** M. **Deps:** none. Pure graph stage addition.

## Workstream B — Community upgrade + architecture score

**Feeds:** existing call edges + existing `CASCommunity` output.

**Algorithm:** upgrade one-level Louvain to full multi-level with Leiden's
refinement step (guarantees connected communities — one-level Louvain can emit
disconnected ones). Same deterministic ordering. O(E log V) in practice.
Then a **layered-vs-monolith architecture score** from the community graph:
modularity Q plus mean community conductance, both cheap given the partition.
Spectral eigengap is explicitly rejected (below).

**Consumers / gain:** capability grounding — a capability whose operations
span many low-cohesion communities is a smell the catalog AI should see as
evidence (helps D3 by giving the AI stable structural anchors instead of
letting it re-cluster from prose every run); `get_communities` quality;
a measurable architecture-health number replacing prose-only judgment in
`CASSystemHealth`.

**Gate:** communities are connected subgraphs (property test); modularity on
self-CAS ≥ current one-level result; architecture score reproduces the obvious
ordering on shape-based fixtures (a layered fixture scores > a big-ball
fixture).

**Effort:** S (Louvain already exists; Leiden refinement + two formulas).
**Deps:** none; A and B compose but don't depend.

## Workstream C — Reachability index (FLAGSHIP)

**Feeds:** call edges (directed). Today's blast radius is one undirected hop
with a full edge-list scan per expansion (`partitioner.ts`), and
`assess_change_risk` walks per query.

**Algorithm:** condense the call graph to its DAG of strongly connected
components (Tarjan, O(V+E)), then a 2-hop labeling (pruned landmark labeling)
over the condensation. Build cost O(E·√V)-ish empirically; label size small on
sparse call DAGs; query "can X reach Y" and "all nodes reachable from X within
the label cover" in effectively O(1) / O(answer). At 500k nodes this is the
standard published regime for pruned landmark labeling. Rebuilt per CAS
revision in the graph stage; incremental runs rebuild only when call edges
changed (stage fingerprints already exist).

**Consumers / gain:**
1. Fabric (D5): `partitionTasks` / `check_collision` replace 1-hop expansion
   with true transitive blast radius at the same latency — collisions between
   tasks three hops apart on one call chain become visible.
2. Product: `assess_change_risk`, `get_call_chain`, impact analysis get
   O(1)-ish transitive queries instead of per-query walks.
3. A's PPR and B's communities can consume the same condensation for free.

**Gate:** (a) equivalence test — index answers match brute-force BFS on 10k
random pairs across self + 3 corpus repos; (b) fabric gauntlet scenario where
two tasks collide only transitively flips from missed to flagged; (c) query
p95 < 5ms on the self-CAS; build < 10% of graph-stage time.

**Effort:** M. **Deps:** none. Unblocks the strongest version of F.

### C.1 — The index is the standard alternative to any full-graph scan (SHIPPED)

Status: built (`packages/analyzer-core/src/analyzer/core/reachability-index.ts`,
persisted as `CASOutput.reachability_index`, rehydrated via
`ReachabilityIndex.from`). Wired consumers: `assess_change_risk` transitive
impact + `getAffectedSet` in `apps/mcp-server/src/query.ts` (traversal
fallback kept for older CAS, parity-tested identical), and the fabric
partitioner's blast-radius expansion (`coordination/partitioner.ts` — bounded
transitive closure over the SCC condensation, default depth 4 / 200-node cap,
advisory-only; replaces the one-undirected-hop full-edge-list scan).
`ReachabilityIndex.affectedSet(changedIds, {direction})` is the affected-set
API for incremental recompute (upstream = blast radius, downstream =
dependents-of-change; O(answer)).

**Standing rule — the exhaustive-scan defect class:** any code that answers a
reachability/impact/membership question by re-walking or re-scanning the full
node/edge list per query is an instance of this defect class (three found so
far: call-resolver quadratic fallback, telemetry CAS re-parse, WAS lookup-map
rebuild; the partitioner one-hop edge scan was the fourth). The fix is never
a local cache hack: consume the reachability index (reachability/impact) or a
once-per-CAS derived map keyed by the same stage fingerprints. Self-CAS
measurements (54k nodes / 61k edges / 23k method_calls; 11.5k call-graph
participants): build 0.8s, stored size 3.6% of the CAS, `canReach` p95 1.9us
(brute BFS: 52us/query), affected-set answers byte-identical to BFS.

## Workstream F — Fabric co-change prediction + partitioning (FLAGSHIP, co-change half)

**Feeds:** `git-analyzer.ts` already parses full `git log --numstat` into
per-commit changed-file sets (`commitsByFile`). The pairwise aggregation is
absent — this workstream adds it.

**Algorithm:** conditional co-edit probability P(B changes | A changes) =
count(A,B co-commits) / count(A commits), with Laplace smoothing, computed
over the last N=500 commits, keeping only pairs with lift > 2 and support ≥ 3
(keeps the matrix sparse — real co-change matrices are; complexity is
O(Σ per-commit files²), bounded by capping commits touching > 50 files as
non-informative bulk edits). Stored as a sparse `co_change` edge kind with
`probability` and `support` in metadata — deterministic facts from history.

**Consumers / gain:**
1. Predictive collision warnings: when agent 1 claims file A and P(B|A) = 0.8,
   warn the agent claiming B *before* either edits — history-based, catches
   coupling the call graph can't see (config ↔ code, schema ↔ migration,
   parallel-language twins).
2. `plan_parallel_work` batching upgrade: build the task-conflict graph with
   edge weights = structural overlap (via C's index) + co-change probability,
   then partition by greedy modularity on the weighted conflict graph
   (minimize expected cross-batch conflict mass). True min-cut (Stoer–Wagner
   O(VE + V²logV)) is overkill for ≤ dozens of tasks; the weighted greedy
   partition is exact enough and O(T² · footprint).

**Gate:** backtest on this repo's own history — hold out the last 100 commits,
predict co-changed files from the prior window, report precision@5 (target:
beats the directory-prefix baseline by ≥ 2×); fabric gauntlet adds a
"history-coupled, graph-disjoint" scenario that flips missed → warned.

**Effort:** M (aggregation S, fabric wiring M). **Deps:** best with C; the
co-change half is independent.

## Workstream G — Latency math (critical path + Amdahl)

**Feeds:** `timings.stages`, per-analyzer `timings.analyzers`,
`analysis_phases[].duration_ms` — all stored per run. Aligns with the S0–S6
execution graph in `ANALYSIS-EXECUTION-ARCHITECTURE.md` (authoritative; this
workstream instruments it, never reorders truth).

**Algorithm:** classical critical-path method over the stage DAG once stages
are real checkpoints: longest path = latency floor; per-stage slack = free
parallelism. Amdahl per lever: speedup ceiling from optimizing stage s is
1 / (1 − f_s + f_s/k). Trivial computation; the value is making it a stored
artifact (`timings.critical_path`) and a regression signal per invariant 4 —
timing targets page and fail benches, never truncate.

**Current numbers (self-run):** ai_enrichment 303.1s = 57.6% of 526s wall.
Amdahl: infinite speedup of *everything else* floors at ~303s — the 3-minute
budget (D4) is unreachable without overlapping AI with deterministic stages,
exactly what the S5-parallel design mandates. Parse (162.5s, 30.9%) is the top
deterministic lever; its Amdahl ceiling alone is 1.45×.

**Gate:** critical-path artifact present on every CAS; predicted wall time
from the DAG within 10% of measured on cold/warm/incremental bench paths;
each speed-program lever states its Amdahl ceiling before work starts.

**Effort:** S. **Deps:** stage checkpoints from the execution-architecture
work (Codex lane); degrades gracefully to today's 6 coarse stages.

## Workstream D — Information-theoretic description quality

**Feeds:** all stored description prose + `description_source` provenance;
the rule-based validator (`ai/element-description-validator.ts`) with its
enumerated reject reasons stays as the floor.

**Algorithm:** distinctiveness scoring — build a corpus unigram/bigram model
over all descriptions in the CAS (plus a global cross-repo prior shipped with
the analyzer), score each description by (a) mean token self-information
−log p(token), (b) KL divergence of the description's distribution from the
corpus model, (c) overlap of its informative tokens with the subject's own
evidence (names of callees, entities, routes). A placeholder ("manages the X
lifecycle") scores near-zero distinctiveness and near-zero evidence overlap
*regardless of vocabulary* — generalizing the bare-noun/template guards
(ba7f915a, 13f9c597) with no pattern list to maintain. O(total tokens).

**Consumers / gain:** description gate (reject/regenerate below threshold);
`get_description_enrichment_targets` ranking (low-distinctiveness × high-PPR
first — composes with A); a corpus-wide description-quality score per repo.

**Gate:** on a labeled set of 200 descriptions (accepted/rejected by the
existing rule guards + manual audit), the score achieves ≥ 0.9 AUC separating
placeholders from grounded prose; zero regressions on the guard test suite.

**Effort:** S/M. **Deps:** none (better with A for spend targeting).

## Workstream E — AI variance reduction + calibration (GATED — prerequisite first)

**Verified state:** `ai/semantic-dataset.ts` (E1, schema e1.1) records
evidence digest, gate verdict, confidence, outcome per comprehension call —
but is **off by default** (`KLAURO_SEMANTIC_DATASET`), and no local dataset
exists. Calibration has no data yet.

**Prerequisite (S, do immediately):** enable E1 on the production analyzer
(`KLAURO_SEMANTIC_DATASET=1` on the VPS). Purely observational by design;
zero product risk. Every week it stays off is calibration data lost.

**Then:**
1. **Self-consistency for the capability catalog (D3):** sample the catalog
   N=3 times at temperature, align capabilities across samples by operation-set
   Jaccard (deterministic alignment), keep those appearing in ≥ 2 samples,
   record agreement as a stored confidence. Cost: ~3× one call type, not 3×
   the whole AI stage; bounded, and B's community anchors reduce the variance
   the ensemble must absorb.
2. **Calibration:** once E1 has volume (≥ 5k decisions), fit isotonic
   regression from model-reported confidence to observed gate-acceptance rate;
   store calibrated confidence. Standard, cheap, honest.

**Gate:** catalog run-to-run Jaccard similarity on the self repo rises from
current measured baseline to ≥ 0.9 (measure baseline first — #33 has no
number attached yet); calibration Brier score improves over identity mapping.

**Effort:** M (prereq S). **Deps:** E1 data volume; B helps.

---

## Build order

**First wave (flagship): A, C, F-co-change.**

1. **A — centrality layer.** Highest consumer fan-out, fixes a live cardinal
   violation (keyword ranking), pure deterministic graph work, no deps.
2. **C — reachability index.** One index serves product blast-radius queries
   and fabric collision truth; upgrades D5 from 1-hop to transitive.
3. **F (co-change aggregation + predictive warnings).** Data already parsed;
   the fabric moat feature no static-analysis competitor has.

Plus the E1 production enable (S, day one — it's a config flag).

**Second wave:** B (Leiden + architecture score — S, composes with A),
G (critical path — S, coordinates with the execution-architecture lane),
D (distinctiveness gate — composes with A's spend targeting).

**Third wave:** E ensembling + calibration, once E1 volume exists and B's
anchors are in.

## Rejected / deferred (with reasons)

- **Spectral eigengap for architecture scoring (part of B): rejected.**
  Eigen-decomposition on 50k–500k-node graphs needs Lanczos iteration, is
  numerically fragile on ragged sparse call graphs, and the eigengap is
  unstable under small edge perturbations — while modularity + conductance on
  the (already computed) partition give the same layered-vs-monolith signal
  for ~zero cost. No consumer needs eigenvalues themselves.
- **Exact betweenness (part of A): rejected.** Brandes exact is O(VE) —
  ~3×10⁹ ops on the self-CAS and hopeless at 500k nodes. Sampled Brandes with
  fixed pivots keeps determinism and is accurate enough for ranking.
- **Queueing model for analysis lane pools (part of F): rejected.** The lane
  pool is 2 lanes with SJF and a watchdog already shipped; an M/G/1 model
  would predict what the watchdog directly observes. Revisit only if lane
  count grows past ~8, where admission control needs a model.
- **True min-cut (Stoer–Wagner) for work partitioning (part of F):
  deferred.** Task counts in `plan_parallel_work` are tens, not thousands;
  weighted greedy partitioning on the conflict graph is within noise of
  optimal at that scale. Keep the interface so the algorithm can be swapped.
- **Self-consistency over the whole AI stage (part of E): rejected.**
  N× the entire 303s enrichment pass violates the latency program. Ensembling
  is scoped to the capability catalog only, where variance (#33) actually
  hurts.
