# Proposal: speed, accuracy, depth and breadth, from a survey of the field

Status: proposal, revised 2026-10-04 after an audit of what the repository already has. Nothing here is built. Open-source code-understanding tools were surveyed from their public documentation; none was run. This document is generic by design (see `docs/KLAURO-PRODUCT-MODEL.md`) and names no outside product. It complements `docs/PROPOSAL-ANALYSIS-TRUST-AND-REVIEW.md`, which holds the rules these proposals must respect (determinism boundary, output contract, read-through local store, unshipped-is-tagged, four repositories across three language families).

## Why this matters for the differentiator

Every surveyed tool indexes structure and sells token savings. None derives purpose-level capabilities, flows with terminality, or a parent analysis derived from child sub-projects. That comprehension layer is the differentiator, and it sits on top of the index: a call resolved wrongly, a framework entry point missed, or a flow cut short by a silent bound becomes a wrong terminality, a wrong capability and a wrong parent. So improving the foundation is improving the differentiator. The field's real gap is that almost none of it measures accuracy against an independent answer key; we can be the one that does, at the structural layer and at the comprehension layer.

Everything below extends an existing mechanism, named in each item. Items that already exist were cut; items that would weaken an existing rule were reshaped.

## Speed to result

What exists: the structural layer serves in seconds (the index, scope, sub-project partition and flows run in tens of milliseconds to seconds); AI answers are memoized on the facts text (`memory.rs`), with `KLAURO_AI_CACHE_PATH` and `KLAURO_ONLY_PARTS`; a cgroup-aware parse worker pool (`parse-worker-pool-size.ts`), cgroup-aware analysis memory (`analysis-memory.ts`), a peak-memory gate (`scale-survivability-gate.sh`); freshness checks (`docs/SPEC-FRESHNESS.md`, implemented); stage fingerprints; response budgets.

Additions:

- **Time to first useful answer, measured and gated.** The latency budgets are already a release gate; add the figure that matters to a person: seconds from a cold start to the first correct answer to a navigational question, per stack, published with commit and hardware. The comprehension layer is bound by AI generation rate, so show the structural-first order explicitly: the structural answer is served while capabilities are still being asked for.
- **Resumable engine batches.** Analysis layers already checkpoint and retry (`docs/ANALYSIS-EXECUTION-ARCHITECTURE.md`); add per-batch checkpoints inside the Rust engine's indexing so a killed run resumes instead of restarting, and size its thread pool from the container limit as the Node side already does (verify the engine does).
- **Memory trajectory in the ledger.** Record resident memory, descriptors and page faults every few seconds on large runs, as internal state beside the analysis, so a bug report carries the trajectory.
- **Publish large-repository time and peak memory** with the commit and hardware, alongside the existing survivability log. Others publish hours and tens of GiB for the largest repositories; we need our own honest number, not a target to match.
- **Freshness stays as designed.** An earlier idea of a stat-and-hash pass on every query and a stored graph snapshot bootstrapped from the repository was dropped: it is lower than the hotness-adaptive read-through design and would put analysis state in the repository. Two small additions fit: a per-file staleness line in a response that touches a file whose update is pending (the per-node `may_be_stale` already planned in `docs/SPEC-FRESHNESS.md`), and a cheap hash compare on connect, only if it stays cheap.

## Accuracy

What exists: truth fixtures and the audit loop (`KLAURO_AUDIT`, the vetting step, missed-fixture proposals, 101 fixture directories); `rust_call_resolution.rs`; measured accuracy in `docs/ANALYSIS-NORTH-STAR.md`; type-aware resolution for TypeScript, on by default; a `guessed` set of name-only edges that comprehension already distrusts; a gate image that already installs a compiler-grade indexer for TypeScript and a benchmark (`gauntlet/primitive-bench.ts`, `real-camp-arms.ts`) that already scores file-level callers against it, plus a scope-graph arm.

Additions:

1. **Edge-level precision and recall against independent answer keys.** Extend the existing benchmark from file-level callers on fixtures to edge-level scoring on real repositories, add Go and Java, and then C#, C and C++, Rust and Python through their compiler indexers and type resolvers. Precision and recall are reported together, per stack, with 95% confidence intervals, and an edge matches when caller and callee land on the same declaration line. Ground truth is never derived from our own graph (a recall scored against the graph that produced it proves nothing). Hand-labelled per-feature call-graph datasets for Python and Rust (decorators, inheritance, imports, dynamic features) add per-feature numbers where indexers are weak. Run on the VPS, honor the four repositories across three language families rule, split repositories into development and held-out sets before tuning, and publish losses beside wins.
2. **The same discipline for the comprehension layer.** Score what others cannot: entry-point and route extraction against our labelled corpus (no public dataset exists, so publishing ours is an asset), flow terminality against hand-checked flows, and capability descriptions by decomposing each into atomic claims and verifying each against its evidence (the extension of `Grounding` and the vetting step described in section 2 of the trust proposal).
3. **Persist edge provenance.** Promote the `guessed` set to a persisted authority field per edge, with the resolving strategy and a confidence tier, and split resolved calls from uses with no uniquely proven target as different edge kinds (sections 8 and 10 of the trust proposal). This is cheap, needs no type system, and gives the benchmark in item 1 something to score by tier.
4. **Evaluation hygiene for every published claim.** Fix the sampling frame before the run and commit it (one survey found four defensible samplings gave 21% to 67% on the same build). Block the control arm from the tool under test and prove it held (the live trial uses a separate control directory and command template; no enforcement check was found). Score mechanically where a mechanical check exists. Report answer quality beside cost. Fix the competitor scorecard's boolean-only verdicts, which report "0 loss" from a validator that counts an uncontested scenario as a win, before claiming that losses are published.
5. **A self-check after every index.** Compare the highest-risk files against the repository's own history: how many of the top twenty had a recent bug fix, against the base rate. It is cheap and catches silent breakage. The engine's history layer has churn and co-change but no bug-fix classification yet; classify fixes by commit message and exclude documentation, test and configuration commits.

## Depth

What exists: flows, steps, terminality, entities and data lineage; reach and blast radius (`get_callers`, `get_callees`, `getAffectedSet`, `get_interface_signature`, `assess_change_risk`); `find_tests`, `get_dead_code`, `get_hot_spots`, `get_stability`, `get_communities`, change history in `history.rs`; the delta tools and fabric collision tools; schema and ORM entities in TypeScript analyzers.

Additions:

- **Open ends** (section 8 of the trust proposal) are the biggest depth gain: a flow stops being "read-only" merely because its trail ran out.
- **A route query** between two steps, with per-hop evidence and bounds (trust proposal, section 4).
- **Entity-matched change analysis.** Build on `diff_behavior` and the change tools: match changed entities by name, kind and scope including renames; report impacted entities and tests; produce a review certificate listing static callers a change does not touch. Public-surface certification (each changed export breaking, non-breaking or potentially breaking, with named consumers, and a flag when a diff opens a path into a declared sensitive boundary) gives `BreakingChange` its missing producer. Pin a baseline and report only regressions introduced since the pin; treat missing evidence as unknown.
- **Deterministic merge gates for concurrent agents.** Refuse a merge that drops either side's changes, undoes them, duplicates a key or case, or no longer parses. `plan_intent_merge` is intent-based and `fab_check_collision` is advisory; a deterministic gate is new and is directly relevant to several agents in one checkout.
- **Tier stamps on analytics.** Extend `find_tests`, `get_dead_code` and `assess_change_risk` rather than adding parallel tools: stamp each answer measured or inferred (an empty answer is unknown), give dead code a confidence tier with its evidence, express change risk as a percentile against the repository's own recent commits, and surface unexpected coupling (cross-community, cross-language, a peripheral module reaching a hub). Calibrate any risk weights on a real defect corpus scored at a commit before the bug window, with file size as a control, or they are opinions.
- **Entities from migrations and declarative ORM schema files** in the engine's entity layer, which today has no migration or schema-file inference. A SQL parser with column-level lineage is the candidate component; a standard lineage vocabulary can name the relations.
- **Runtime evidence.** Calls recorded from a test run, merged into the graph, expose dynamic dispatch that static analysis cannot see. `ingest_telemetry` and `get_runtime_static_links` are the starting point; defer the full overlay.

## Breadth

What exists: a language registry and tables (`language.rs`, `language_tables.rs`), data tables for services and frameworks (`tables.rs`, `service_catalog.rs`), router and mount-prefix handling (`entry_exit.rs`), ten stacks perfected on a corpus, the entry-point labelled corpus and audit loop, the paradigm conformance check (`conform.rs`).

Additions:

- **Per-sub-project link coverage.** Report, per sub-project, calls detected, resolved and unresolved (today `get_communication_seams` and `get_semantic_coverage` give unmapped lists with reasons but no figure), so an isolated service looks different from one whose links were never followed. The known seam gaps are the same class: base-URL calls from the UI, spawn through a resolved path constant, and Tauri IPC invokes. Verify and extend route-prefix resolution for a prefix passed across files into another function.
- **Framework rules as data.** Express per-framework entry-point rules as declarative rules over the syntax tree, so adding a framework is data, not code; the existing tables are the seed. Verify against the corpus per stack.
- **A maintained language table** (extensions, filenames, heuristics) as a feed into the registry, and a record of where a compiler-grade indexer exists for a language, which also says where a higher-authority source is available.
- **Standard exports and declared units.** Export sub-projects as container and component diagrams in a model-as-code format, and read or emit a service catalog descriptor as a declared-unit signal, consistent with the rule that a sub-project is a declared unit. User-declared layers with violations as first-class output extend the conformance check; verify whether declared layers already exist.
- **Runtime topology as validation.** Traffic-derived service maps validate static topology on a demonstration system.

## Tool surface

Already in place and not to be weakened: the core profile with gateway, `get_agent_tool_plan`, `get_agent_start_context`, `orient_capsule`, the summary to flow to coding-context ladder, response budgets and the start hook. Remaining gaps (a reason per hidden tool, a list-changed notification) are in section 11 of the trust proposal. A policy-gated source window as the last rung of the ladder is to be verified.

## Leave alone

- Per-file model-written indexes committed to the repository: too slow, and against the compute-once design and the read-through local store.
- Token-saving headlines without a stated sampling frame or a quality result.
- Heavy database or vector-store requirements; take the batching and checkpoint ideas, not the stack.
- Any "degraded but published" analysis (see the trust proposal's first section).
- Copying code from copyleft or commercial-licensed projects: take ideas and permissively licensed data only, and verify the license of anything with unclear terms.
- Building a second comparison, reach or test-selection tool beside the ones that exist.

## Order

1. Edge-level answer keys (accuracy 1), with evaluation hygiene (accuracy 4) fixed first so the numbers can be trusted. It makes every later change measurable and is mostly an extension of the existing benchmark.
2. Edge provenance (accuracy 3), open ends and link coverage: cheap, and they feed everything above them.
3. Comprehension-layer scoring (accuracy 2) and the self-check (accuracy 5).
4. Time to first useful answer and the memory trajectory (speed), so speed claims have numbers.
5. Entity-matched change analysis, tier stamps and deterministic merge gates (depth).
6. Framework rules as data, migration and schema entities, standard exports (breadth), driven by the corpus misses the benchmark reveals.
7. Type-aware resolution for more languages and compiler-index ingestion, only for the stacks where the benchmark shows resolution recall is the limiter; scope-graph resolution only if the numbers demand it (an arm already exists to compare it).

## Open questions

- Which stacks the first held-out set covers, and who chooses it.
- Where link coverage and edge-tier counts live in the stored analysis, with the stocktake line each needs.
- Whether the compiler-index toolchains run in the existing gate image or a separate verification image.
- Which of the audit's UNVERIFIED items are already built (cross-file route prefixes, declared layers, a policy-gated source window, a per-node staleness field).
