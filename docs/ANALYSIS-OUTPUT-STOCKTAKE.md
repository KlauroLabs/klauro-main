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

`capabilities[].confidence` and `flows[].confidence` are a number from 0 to 1 saying how well the engine can stand behind the item: how many hops of a flow were resolved by structure rather than by name, whether its trail ran out, whether a capability's described outcome was supported by the code it cites, and whether it traces to a child capability. They tell a reader how much weight to put on one capability or flow against another. `capabilities[].unsettled` and `flows[].unsettled` are present only as `ai-unanswered`, when the AI's reading of the item stayed unanswered after its retries and the item is shown with its structural content alone; its `confidence` is lowered accordingly. A capability with no child behind it carries `parent_originated`.

`comprehension.capabilities[]` holds two levels in one list, and `capabilities[].level` says which: `part` for a capability read from one sub-project (it carries `project`) and `whole` for a capability of the system derived from the parts (it carries no `project`, and its `composition_provenance` names the part capabilities it came from). Ids are unique across the list: a part capability's id is `capability:<sub-project>/<name>`, a whole capability's id is `capability:<name>`, and `composition_provenance[].source_capability_id` is the part capability's id as it appears in the list. A reader that splits the list by `project` being absent, as the desktop and hosted readers do, keeps working unchanged. `capabilities[].stages` lists the modules of one program that a part capability groups, present when a part is a single program read stage by stage; it counts as the capability's members where its flows are one.

`edges[].metadata.attributes.via` carries the engine's `edges[].via` onto the stored analysis, and `flows[].standing`, `flows[].open` and `flows[].cut` carry the flow standing described below. They tell a reader of a route between two functions how each hop was found and where a trail ran out.

`temporal_stability[]` now also arrives from the engine's history read, one entry per source file that was fixed or changed more than once, with `quality_signals.bug_fix_commits`, `bug_fix_percentile` and `churn_percentile`. A commit counts as a fix when its subject says it fixes something and it changed something other than documentation, tests or configuration; the percentiles place the file among this repository's own files, so change risk reads against the repository's own recent commits rather than a fixed rate. `change_risks[].stability_context` carries the same two percentiles. They tell a reader how unusual a file's bug history is here.

`nodes[].metadata.attributes.dead_code` is set on a function or method the engine found unreached, with `reason` (`no-inbound`, `exported-unused`, `only-from-tests`, `only-from-dead-callers`), the number of `callers`, and `open` when a call may still reach it (`unlinked-calls`, `passed-as-value`, `dynamic-dispatch`) with the count of `unlinked` calls. `get_dead_code` reads it and reports each unit as `dead` or `possibly-dead` with plain evidence strings. `dead_code.open` may also be `name-referenced` or `name-in-tests`, with `dead_code.mention` as `file:line`, when the unit's name appears as an identifier or string outside its own declaration (attributes, templates, configuration, reflection-style strings) or only in test code. A unit is `dead` only for reasons `no-inbound` and `exported-unused` with no open end; `only-from-tests` and `only-from-dead-callers` are always `possibly-dead` because they depend on every entry point having been found. Decorated or attributed units, lifecycle names and overrides of a same-named member are never reported. They tell a reader why a unit is called dead and whether an open end could still reach it.

`find_tests` matches carry `basis` (`exact-by-graph`, `graph-with-name-guess`, `explicit-coverage`, `name-based`) and the resolution carries `answer_basis`. They tell a reader whether a selected test reaches the unit through resolved calls or was matched on a name. `get_communities` carries `surprising_links`: a member of a small community reaching a hub of another through one of very few links.

`partition.sub_projects[].owner`, `system` and `depends_on` come from a service catalog descriptor (`catalog-info.yaml`) in the project's directory: `spec.owner`, `spec.system` and the `spec.dependsOn` references as written. They tell a reader who a repository's own metadata says owns a unit, which system groups it and what it declares it depends on. Absent when the project has no descriptor.

**Data**
`entities`, `data_summary`, `data_lineage`, `database_schema`, `domain_concepts`

**What it accomplishes**
`capabilities`, `flows`, `steps`, `behavior_surfaces`, `entry_point_flows`, `intents`, `flow_summary`, `flow_coverage`, `behaviors`, `product_map`

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

`get_communication_seams` and `get_semantic_coverage` now carry `link_coverage[]`, one row per sub-project with `detected`, `linked`, `unlinked_count`, `by_kind` and an `unlinked` sample of up to 5 call sites as `file:line`, read from `composition.links[]`. `composition.links[]` is new: for each sub-project, the outbound calls detected and the calls linked to another sub-project, for each of `http`, `process` and `ipc`, counting product code only. A sub-project whose calls were detected but not linked is one whose links were never followed, which reads differently from an isolated one that makes no such calls. `exit_points[].addressed` now carries `ipc://<channel>` for a call across a desktop or webview bridge, and `composition.seams[].kind` may be `ipc`.

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

The engine record carries `crossings[]` and no journeys. A crossing links a point that sends to the point that receives: an `ipc` crossing is a UI `invoke` addressed by the resolved channel value, through the `#[tauri::command]` or `ipcMain` entry, into the dispatch arm that matches it; an `event` crossing links an emit site to a listener by resolved channel string; a `network` crossing links a sent message tag to the handler matching the same tag across sub-projects joined by at least two tags; a `queue` crossing links a send to the consumer of the same queue. The hosted mapping stores each crossing between two flows as a seam in `communication_seams` whose metadata names the sending flow, the receiving flow, the boundary kind (`via`), the channel, the exit unit and the receiving entry point. `get_user_journeys` and the product map's journeys section chain flows over those seams when requested; nothing is stored as a journey. `composition.seams[]` also carries `event` and `network` seams with communication `message`. Test files are excluded.
