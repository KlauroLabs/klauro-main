# Analysis output stocktake

Every field the analysis currently produces, what it is, and why it exists. The test applied to each one: **is this a finding about the customer's code, or is this the pipeline talking about itself?**

Findings stay, whether or not a page shows them today. Pipeline talk moves to internal state stored beside the analysis, where the incremental engine and the caches can still use it.

Status: decided 2026-09-13.

---

## Findings about the code — keep

**What the system is**
`system`, `system_purpose`, `enhanced_system_purpose`, `architecture_summary`, `codebase_type`, `codebase_type_confidence`, `patterns`, `paradigm_conformance`, `perspectives`, `categories`, `tags`

**How it is reached and where it goes**
`entry_points`, `exit_points`, `route_table`, `external_services`, `communication_seams`, `security_contexts`, `security_boundaries`, `security_summary`

**The graph**
`nodes`, `edges`, `method_calls`, `call_chains`, `decorators`, `reachability_index`

`edges[].via` records how the engine found a call: absent when it was proven from structure (imports,
declared types, a typed receiver), `name` when it was matched on the name alone, and `rule` when a
framework or dispatch rule supplied it. It tells a customer whether "A calls B" was shown or
inferred from a shared name, and it is what the engine itself uses to decide which calls to follow.

`nodes[].signature` and `nodes[].metadata.is_exported` and `access_modifier` now carry what the engine read: the parameters with their declared types, whether each is optional or has a default, the return type, and whether the declaration is exported or narrowed to private or protected. They tell a customer what an entity's contract is, and they are what a comparison of two revisions reads to say whether an exported change breaks its callers.

`edges[].metadata.attributes.via` carries the engine's `edges[].via` onto the stored analysis, and `flows[].standing`, `flows[].open` and `flows[].cut` carry the flow standing described below. They tell a reader of a route between two functions how each hop was found and where a trail ran out.

**Data**
`entities`, `data_summary`, `data_lineage`, `database_schema`, `domain_concepts`

**What it accomplishes**
`capabilities`, `flows`, `steps`, `behavior_surfaces`, `user_journeys`, `intents`, `flow_summary`, `flow_coverage`, `behaviors`, `product_map`

`flows[].effects` is new. A flow used to be one path from an entry point to one exit point, so a
command became as many flows as it had reachable effects: one voice-call command appeared five
times, differing only in which tunnel command it ended at, and a database search appeared 48 times.
A flow is now one behaviour, and `effects` lists everything it reaches. It tells a customer what a
single action actually does to the outside world, which is the question `terminus` could only answer
one path at a time.

Each effect carries `hops`, the distance from the entry point to where the effect happens, and
`via_shared_helper`, whether the path crossed code that three or more other callers also use. Both
are facts about how the effect was reached, not judgements. They exist because a
command was being reported as spawning network tunnels that belong to a different command, reached
four to seven hops away through shared runtime setup. The effects are still listed, because they are
genuinely reachable, but a reader can now see which ones the flow reaches on its own. On the
measured repository 102 of 158 flows have a primary effect they reach directly and 56 inherit one.

`flows[].standing` gains a fourth value, `open`. A flow is `terminal` when its trail reaches something
that changes the outside world, `proximal` when it only leads into another flow, `reading` when the
trail was followed to its end and found nothing that changes anything, and `open` when the trail
runs out in our own code the engine could not follow, or was cut at the depth it follows. It tells a
customer that nothing was found, which is not the same as nothing being there: an `open` flow is
unknown, never read-only. A call into a library or the language's own runtime is a known boundary and
does not make a flow open.

`flows[].open` is the number of calls along the flow's trail that name something declared in this
repository but could not be resolved to one place, and `flows[].cut` is set when the trail was cut
at the depth or length the engine follows. Both are omitted when zero or false. They tell a customer
how much of a flow's trail is unfollowed and why, so a reader knows which flows to check by hand.

**What ships**

`units` is new. It is the answer to step 2 of the flow: the units this repository ships, derived
from the index by grouping entry points by the code they reach. Each carries its name, how much code
it reaches, which entry points belong to it and of what kinds, and its root paths. It tells a
customer what separate things live in their repository, which for a monorepo is the only honest
answer at the repository level. It replaces artifact scanning as the definition of a unit;
`deployable_evidence` remains as evidence of how a unit is delivered.
`distribution_units`, `deployable_evidence`, `dependencies`, `dependency_manifest`, `dependency_roles`, `libraries`, `configuration`, `runtime`

**Quality and risk**
`change_risks`, `change_risk_summary`, `test_coverage`, `test_suites`, `test_summary`, `test_gaps`, `mocks`, `fixtures`, `behavioral_invariants`, `behavioral_invariant_summary`, `temporal_stability`, `stability_summary`, `module_health`, `implementation_health`, `system_health`, `documentation_summary`, `todos_summary`, `architectural_conflicts`, `principle_violations`

**Conventions the codebase follows**
`codebase_idioms`, `idiom_summary`, `idiom_violations`, `idiom_examples`

`idiom_examples` is the set of places an idiom actually appears. It is a finding, not scaffolding. It belongs attached to its idiom rather than as a parallel top-level array.

**Cross-repository**
`repository_links`, `cross_repository_links`, `runtime_static_links`

**Identity and honesty**
`cas_version`, `analysis_id`, `analysis_timestamp`, `base_commit`, `branch`, `analyzed_track`, `diff_only`, `analysis_errors`, `layers_ready`, `ai_enrichment`, `ai_enrichment_error`, `total_files`, `languages`, `top_level_dirs`

**Composition (workspace analyses)**
`id`, `label`, `children`, `member_reference`

---

## Pipeline talking about itself — move to internal state

**Our own performance**
| Field | What it actually is |
|---|---|
| `analysis_phases` | Our pipeline's stage list |
| `timings` | How long our stages took |
| `duration_ms` | Same |

**Our cache keys**
| Field | What it actually is |
|---|---|
| `analyzer_build` | Which build of our analyzer ran |
| `parser_fingerprint` | Hash used to decide if we can reuse a parse |
| `derived_fingerprint` | Hash used to decide if we can skip recomputation |
| `ai_cache_reuse` | `{hits, misses, bypassed}` — our AI cache hit rate |

**Our algorithm's tuning knobs**
| Field | What it actually is |
|---|---|
| `structural_importance_meta` | `{algorithm: 'seeded-random-walk-power-iteration', damping, epsilon, max_iterations, iterations, converged, seed_count}` — the convergence parameters of our ranking algorithm |

**Our intermediate steps**
| Field | What it actually is |
|---|---|
| `structural_capability_candidates` | DELETED 2026-09-13. A `structuredClone` of the capability array taken before the model named it, then shipped. Not a separate computation and not evidence of anything |
| `flow_graph.capability_candidates` | The same concept, nested one level down |
| `analysis_facts` | Working notes the passes leave for each other |
| `validation` | Our own self-check results |
| `coverage_gaps` | What our analyzers could not reach |
| `conventions_applied` | Which of our convention rules matched |
| `index` | Our internal lookup table |
| `embedding_index` | Our vector index for search |
| `analyzer_contributions` | Per-analyzer ledger of which files each analyzer read. Load-bearing for incremental analysis, so it must persist — just not in the customer's output |

**Presentation decisions baked into the analysis**
| Field | What it actually is |
|---|---|
| `disclosure` | `{default_perspective, important_nodes, suggested_paths, summaries}` — hints telling a UI what to show first |
| `progressive_levels` | An onboarding ladder including `time_to_understand` estimates |

These are the analysis telling a product surface how to present itself. The surface should decide that from the findings.

**Composition bookkeeping**
`parent_id`, `composition_mode` — how a child analysis was attached during composition.

---

## Decided — keep

| Field | Why it stays |
|---|---|
| `terminality` | The signal that identifies outcomes: which flows, entities and nodes sit at the end of a chain. Published as the explanation of why a capability exists |
| `codebase_types`, `codebase_type_signals` | The ranked alternatives and the signals behind the type call, alongside the single `codebase_type` |
| `consistency_model` | Whether the codebase is internally consistent |
| `subsystems` (was `communities`) | Groups of code more connected to each other than to the rest. Renamed from `communities`; a graph term became a product term |

### Subsystems need names

Renaming the field is half the work. Today each entry is `{id: 7, member_ids: [...], size, internal_edges}` — a numbered set. "Subsystem 7" tells a reader nothing. Each subsystem takes a name derived from what its members already say: their dominant directory, the domain concept most of them touch, or the capability they serve. An unnamed subsystem is not shipped.

---

## Capability generation

The current pipeline generates structural candidates, then runs up to eight sequential AI cycles that reject, repair, re-judge and approve them. The candidates leak into the output. The repair machinery is the most expensive part of the analysis.

The intended shape is simpler: take the terminal and proximal-terminal flows, entities and outcomes, submit them to the model as one batched request, and get capabilities back. Accept them. There is nothing to validate, because a capability is not a claim that could be wrong: it is the model stating in product language what the facts below it already are.

Consequences:
- `structural_capability_candidates` is deleted from the output and from `CASOutput` (done 2026-09-13). `flow_graph.capability_candidates` remains for now: it is load-bearing inside the catalog machinery and goes with that machinery.

Removing it exposed something the field was hiding. The capability-inference benchmark graded those candidates whenever the published capability set was empty, and on its own fixture the published set **is** empty: it scored 89 on scaffolding while shipping zero capabilities. It now scores 44 and says so. The benchmark was already failing before the change; it is now failing honestly. Its structural comparison needs a real home in internal state beside the analysis, not in the customer's output.
- The cycle, repair and approval machinery is removed.
- The AI layer becomes one batched request per layer, with a single retry pass for items that fail grounding.
