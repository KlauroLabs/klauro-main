# Proposal: speed, accuracy, depth and breadth, from a survey of the field

Status: proposal, revised 2026-10-04 after an audit of what the repository already has, and after a correction from the owner: the goal is a good analysis, not layers of validation and verification; gates are tests, not product. Nothing here is built. Open-source code-understanding tools were surveyed from their public documentation; none was run. This document is generic by design (see `docs/KLAURO-PRODUCT-MODEL.md`) and names no outside product. It complements `docs/PROPOSAL-ANALYSIS-TRUST-AND-REVIEW.md`.

## Why this matters for the differentiator

Every surveyed tool indexes structure and sells token savings. None derives purpose-level capabilities, flows with terminality, or a parent analysis derived from child sub-projects. That comprehension layer is the differentiator, and it sits on the index: a call resolved wrongly, a framework entry point missed, or a flow cut short becomes a wrong terminality, a wrong capability and a wrong parent. Improving the foundation improves the differentiator.

## How this proposal is shaped

Every item improves what the engine computes: a resolver that finds more of the right edges, an extractor that covers more frameworks, a query that answers more, a run that finishes sooner. No item adds a pass to the pipeline. Measurement against independent answer keys is offline development testing that tells us where to improve; it is not part of the product and does not run in the analysis. Everything extends something that exists.

## Speed to result

What exists: the structural layer serves in seconds; AI answers are memoized on the facts text (`memory.rs`) with a shared cache and a part filter; the facts cache; stage fingerprints; response budgets; freshness (`docs/SPEC-FRESHNESS.md`, implemented); a cgroup-aware worker pool and memory limit on the Node side.

- **Serve the structural answer first: already so.** `publishStructuralLayer` (`structural-layer.ts`) runs the engine with `KLAURO_ENRICH=0` before the full analysis, stores that structural analysis with L4 and L5 pending, and the enriched run replaces it only when it completes; a failed ask fails the enriched run and publishes nothing, so no partial model output is ever stored. The cost is that the structural phase runs twice, the second time with a warm extraction cache. The time to the first useful answer is therefore the structural run: 0.2 to 3 s on the corpus, 7 s on this repository, and about 23 s on the largest corpus repository, of which 11 s is `comprehend::derive` (structural, no model). Publish that number per stack with commit and hardware; the lever left is that derive step, not the sequencing.
- **Resumable indexing: measured, mostly present.** The extraction cache is keyed on file content and engine identity, and is written before the slow phases. Measured warm and one-file-edited runs re-extract 0 and 1 files. Extraction is 3 s of 24 s on the largest corpus repository, so a killed run loses at most that, and a killed AI stage resumes from the memoized asks. Per-batch checkpoints inside extraction would buy seconds and cost segment files; not built.
- **Memory bound.** A budget read from the container memory limit (`KLAURO_MEMORY_BUDGET_MB` overrides) narrows the worker pool; the retained index, about two thirds of the peak, is the floor and is not bounded by it.
- **Publish our own large-repository time and peak memory** next to the survivability log. Others publish hours and tens of GiB for the largest repositories; we need our own honest number, not a target.
- **Freshness stays as designed.** A per-query hash pass and a stored graph snapshot were dropped: they are below the hotness-adaptive read-through design and would put analysis state in the repository. The per-node staleness line exists: `get_coding_context` attaches `may_be_stale` to a target whose file changed since the last completed analysis (`server.ts`, from `summarizeAnalysisFreshness`).

## Accuracy

What exists: truth fixtures and the audit loop (`KLAURO_AUDIT`, missed-fixture proposals, 101 fixture directories); `rust_call_resolution.rs`; type-aware resolution for TypeScript; a `guessed` set of name-only edges; a development benchmark (`gauntlet/primitive-bench.ts`, `real-camp-arms.ts`) that scores callers against a compiler-grade TypeScript indexer already installed on the gate image, with a scope-graph arm.

- **Find the misses, then fix the resolver.** Extend that development benchmark from file-level callers on fixtures to edge-level scores on real repositories, add Go and Java, then C#, C and C++, Rust and Python through their compiler indexers and type resolvers. Report precision and recall together, per stack, with confidence intervals, split into development and held-out repositories before tuning. Ground truth never comes from our own graph. Hand-labelled per-feature call-graph datasets for Python and Rust add detail where indexers are weak. This runs offline on the VPS; its value is the list of resolver misses it produces.
- **Type-aware resolution for more languages**, one stack at a time, where the benchmark shows resolution is the limiter: generics, return-type propagation, narrowing, trait and extension calls, with textual resolution as the fallback. This is the largest accuracy gain and the most work.
- **Resolver kind on every edge** (section 2 of the companion): the cheapest accuracy gain, because terminality can then trust what it should.
- **Route prefixes across files.** Router and mount handling exists in `entry_exit.rs`; verify and extend it for a prefix passed across files into another function (Express routers, FastAPI routers, Axum nests, Rails scopes, Swift route groups).
- **Keep the claims honest.** One line of process: fix the sampling frame before a benchmark run, block the control arm from the tool under test, and fix the competitor scorecard's boolean-only verdicts, which count an uncontested scenario as a win.

## Depth

What exists: flows, steps, terminality, entities and data lineage; reach and blast radius; `find_tests`, `get_dead_code`, `get_hot_spots`, `get_stability`, `get_communities`, `history.rs`; the comparison and fabric tools.

- **Open ends** (section 1 of the companion): a flow stops being "read-only" merely because its trail ran out. This is the largest depth gain.
- **A route query** between two steps (companion, section 4).
- **Change impact by entity.** Extend the existing comparison so changed entities are matched by name, kind and scope including renames, and report the impacted entities and tests. Give `BreakingChange` its producer: each changed export breaking or not, with named consumers.
- **Better answers from existing analytics, not new tools.** Dead code with the reason it is dead; test selection from the graph (this test reaches that file); change risk relative to the repository's own recent commits, with documentation, test and configuration commits excluded from the bug-fix history; coupling that is surprising (cross-community, cross-language, a peripheral module reaching a hub). The history layer has churn and co-change but no bug-fix classification yet.
- **Entities from migrations and declarative ORM schema files** in the engine's entity layer, which today has no such inference. A SQL parser with column-level lineage is the candidate component.
- **Later:** calls recorded from a test run, merged into the graph, to expose dynamic dispatch (`ingest_telemetry` and `get_runtime_static_links` are the starting point).

## Breadth

What exists: a language registry and tables (`language.rs`, `language_tables.rs`), data tables for services and frameworks (`tables.rs`, `service_catalog.rs`), ten stacks perfected on a corpus, the labelled entry-point corpus, the paradigm conformance check.

- **Seams between sub-projects, completed.** The known gaps are base-URL calls from the UI, spawn through a resolved path constant, and Tauri IPC invokes. Report, per sub-project, the calls detected, resolved and unresolved, so an isolated service looks different from one whose links were never followed (today the seam tools list unmapped items with reasons but no figure).
- **Framework rules as data.** Express per-framework entry-point rules as declarative rules over the syntax tree, so adding a framework is data, not code. The existing tables are the seed.
- **A maintained language table** (extensions, filenames, heuristics) feeding the registry.
- **Standard exports and declared units.** Export sub-projects as container and component diagrams in a model-as-code format, and read a service catalog descriptor as a declared-unit signal, consistent with the rule that a sub-project is a declared unit.

## Fit with the Rust engine

The engine is one Rust binary, about 43,000 lines, tree-sitter 0.26 with some seventy grammars, rayon, serde and MessagePack.

- **Compute stays in the engine; Python and JVM tools stay in offline testing.** Compiler indexers, the Python type resolver, the SQL lineage parser and the datasets are oracles for development. None becomes an engine dependency.
- **Rust components worth evaluating** (permissive licenses per the survey, to be verified first): the structural-search crates from the syntax-tree rule tool, whose rule format fits framework rules as data over the trees the engine already holds; a Rust SQL lineage engine for the entity layer; the scope-graph crates as references for rule-based name resolution.
- **The tree-sitter version wall.** The engine pins one tree-sitter, and a crate built against another version cannot link beside it. The scope-graph crates are older and archived, so adopting the idea may mean reimplementing it over our own trees. Check this before evaluating any crate.
- **Where changes land:** edge kind on `IndexEdge` in `model.rs` with a version bump in `wire.rs` and a stocktake line; open ends in `resolve.rs`, `steps.rs`, `comprehend.rs` and the standing match in `capabilities.rs`; checkpoints in `facts_cache.rs`.
- **The engine is also a benchmark subject:** a Rust analyzer is a compiler-grade oracle for Rust call edges, and our own repository is a Rust corpus entry.
- **Build and test on the VPS, not a developer machine; production source stays comment-free;** a change to the index layer is measured on four repositories across three language families.

## Leave alone

- Per-file model-written indexes committed to the repository.
- Token-saving headlines without a stated sampling frame or a quality result.
- Heavy database or vector-store requirements.
- New validation or verification passes, run ledgers, confidence scores and readiness stages (see the companion's "Not doing").
- A second comparison, reach or test-selection tool beside the ones that exist.
- Copying code from copyleft or commercial-licensed projects; take ideas and permissively licensed data only.

## Order

1. Open ends and edge kinds: more correct analysis for little work.
2. The edge-level development benchmark, which says which resolver to improve first.
3. Type-aware resolution, route prefixes and seams, stack by stack, driven by the benchmark and the corpus misses.
4. Time to first useful answer and resumable indexing.
5. Change impact by entity, the analytics answers and entities from migrations.
6. Framework rules as data, the language table and standard exports.

## Open questions

- Which stacks the first held-out set covers.
- Whether the compiler-index toolchains run in the existing gate image or a separate one.
- Which audit items are already built (cross-file route prefixes, a per-node staleness field).
