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

**Data**
`entities`, `data_summary`, `data_lineage`, `database_schema`, `domain_concepts`

**What it accomplishes**
`capabilities`, `flows`, `steps`, `behavior_surfaces`, `user_journeys`, `intents`, `flow_summary`, `flow_coverage`, `behaviors`, `product_map`

**What ships**
`distribution_units`, `deployable_evidence`, `dependencies`, `dependency_manifest`, `dependency_roles`, `libraries`, `configuration`, `runtime`

**Quality and risk**
`change_risks`, `change_risk_summary`, `test_coverage`, `test_suites`, `test_summary`, `test_gaps`, `mocks`, `fixtures`, `behavioral_invariants`, `behavioral_invariant_summary`, `temporal_stability`, `stability_summary`, `module_health`, `implementation_health`, `system_health`, `documentation_summary`, `todos_summary`, `architectural_conflicts`, `principle_violations`

**Conventions the codebase follows**
`codebase_idioms`, `idiom_summary`, `idiom_violations`, `idiom_examples`

`idiom_examples` is the supporting evidence for an idiom — the actual places the convention appears. It is a finding, not scaffolding. It belongs attached to its idiom rather than as a parallel top-level array.

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
| `codebase_types`, `codebase_type_signals` | The ranked alternatives and the evidence behind the type call, alongside the single `codebase_type` |
| `consistency_model` | Whether the codebase is internally consistent |
| `subsystems` (was `communities`) | Groups of code more connected to each other than to the rest. Renamed from `communities`; a graph term became a product term |

### Subsystems need names

Renaming the field is half the work. Today each entry is `{id: 7, member_ids: [...], size, internal_edges}` — a numbered set. "Subsystem 7" tells a reader nothing. Each subsystem takes a name derived from what its members already say: their dominant directory, the domain concept most of them touch, or the capability they serve. An unnamed subsystem is not shipped.

---

## Capability generation

The current pipeline generates structural candidates, then runs up to eight sequential AI cycles that reject, repair, re-judge and approve them. The candidates leak into the output. The repair machinery is the most expensive part of the analysis.

The intended shape is simpler: take the terminal and proximal-terminal flows, entities and outcomes, submit them to the model as one batched request, and get capabilities back. Validate lightly — that names are authored, that claims trace to evidence — and accept. Deterministic validation of an interpretive result buys very little.

Consequences:
- `structural_capability_candidates` is deleted from the output and from `CASOutput` (done 2026-09-13). `flow_graph.capability_candidates` remains for now: it is load-bearing inside the catalog machinery and goes with that machinery.

Removing it exposed something the field was hiding. The capability-inference benchmark graded those candidates whenever the published capability set was empty, and on its own fixture the published set **is** empty: it scored 89 on scaffolding while shipping zero capabilities. It now scores 44 and says so. The benchmark was already failing before the change; it is now failing honestly. Its structural comparison needs a real home in internal state beside the analysis, not in the customer's output.
- The cycle, repair and approval machinery is removed.
- The AI layer becomes one batched request per layer, with a single retry pass for items that fail grounding.
