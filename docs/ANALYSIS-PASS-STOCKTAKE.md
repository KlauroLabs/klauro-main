# Analysis pass stocktake

Every stage the analysis runs, what it computes, what it costs, and why it exists. The companion
to `ANALYSIS-OUTPUT-STOCKTAKE.md`: that document takes stock of the output, this one takes stock
of the work.

Measurements are one cold analysis of a real repository of 134,921 nodes with AI enrichment off,
so every number below is deterministic work. AI enrichment is measured separately and is not
included here.

Status: measured 2026-09-12.

## Where the time goes

| Stage | ms | Share |
|---|---|---|
| Language analyzers | 15,407 | 29% |
| Post-processing passes (33) | 20,402 | 38% |
| Framework analyzers (87) | 6,344 | 12% |
| Analyzer detection | 4,527 | 8% |
| Save and everything else | ~6,900 | 13% |
| **Total** | **53,600** | |

TypeScript alone is 11,588 ms of the language total. The 33 post-processing passes together are
the largest block, and no single pass dominates: the top five are 10,124 ms of the 20,402 ms.

## The passes

Ordered by measured cost.

| Pass | ms | What it computes |
|---|---|---|
| `pp_flowCoverage` | 2,890 | Test suites, flow coverage, test gaps |
| `pp_traceability` | 2,478 | Analysis facts, the cross-layer trace between findings |
| `pp_capabilities` | 1,932 | System capabilities, behavior surfaces, system purpose |
| `pp_linkRouteHandlers` | 1,822 | Resolves in-repo calls, links routes to handlers, dedupes entry points |
| `pp_enhancedPurpose` | 1,494 | Behaviors from journeys, entry-point summary, display name |
| `pp_nodeRoles` | 1,262 | Assigns a role to every node |
| `pp_aiInterpretation` | 1,157 | Ranks and selects evidence for the model |
| `pp_userJourneys` | 1,138 | Builds the comprehension graph, flows and journeys |
| `pp_embeddingAndFinalize` | 776 | Dependency roles, module health, build identity, final assembly |
| `pp_domainConcepts` | 761 | Domain concepts from nodes, entities and capability names |
| `pp_entryPointContractCapability` | 685 | Finalizes capability names, rebuilds the comprehension graph |
| `pp_architecture` | 675 | Architecture summary, route table, manifest libraries |
| `pp_dataEntities` | 597 | Data entities, messaging emission lifecycle |
| `pp_testData` | 400 | Mocks, fixtures, test summary, behavioral invariants |
| `pp_reachabilityIndex` | 314 | Reachability index |
| `pp_gitAnalysis` | 284 | Change risks and temporal stability from git history |
| `pp_securityBoundaries` | 274 | Security boundaries |
| `pp_enrichNodes` | 274 | Change-risk and stability summaries, node call graphs, perspectives |
| `pp_finalMetadata` | 264 | Decorators, documentation and todo summaries, security contexts, configuration |
| `pp_enhanceRisks` | 220 | Enhanced change risks, chain criticality, enhanced flow summary |
| `pp_structuralImportance` | 185 | Structural importance ranking |
| `pp_flowGraph` | 136 | Flow graph |
| `pp_methodCalls` | 118 | Method calls |
| `pp_buildIntents` | 82 | Intents |
| `pp_buildIndex` | 71 | The lookup index |
| `pp_callGraph` | 56 | Call chains |
| `pp_dependencyManifest` | 34 | Dependency manifest, unanalyzed-language scan |
| `pp_progressiveLevels` | 12 | The onboarding ladder |
| `pp_liftValidation` | 6 | Lifts validation onto entry points, applies conventions |
| `pp_securitySummary` | 5 | Security summary |
| `pp_detectPatterns` | 0 | Design patterns |
| `pp_flowSummary` | 0 | Flow summary |
| `pp_dataSummary` | 0 | Data summary |

## What this says

**`pp_buildIndex` is 71 ms and runs eighth.** The index is not the foundation the rest is derived
from. It is a lookup table assembled after the findings already exist. Every pass above it in the
list built its own view of the code instead. This is the single largest deviation from the north
star, and it is why the work below it is as expensive as it is.

**The comprehension graph is built twice.** `pp_userJourneys` builds it, then
`pp_entryPointContractCapability` builds it again to apply finalized capability names. The same
double build exists on the incremental path. That is roughly 1,800 ms of duplicated work on this
repository, and the second build exists only because naming happens after the first.

**`structural_capability_candidates` is a `structuredClone` of the capabilities.** It is not a
separate computation and it is not evidence of anything. It is the capability array copied before
the model names it, then shipped in the output. Deleting it removes a deep clone of the entire
capability set from every analysis and removes the field the customer should never have seen. Nine
call sites read it, all of them internal tooling: truth review, readiness scoring, inference
benchmark, spot-read quality, dogfood proof, and the query counter. None of them is a product
surface.

**Three passes cost nothing measurable.** `pp_detectPatterns`, `pp_flowSummary` and
`pp_dataSummary` are 0 ms. They are either no-ops on this repository or trivially cheap. They are
not a speed problem; they are a question about whether their output is real.

**Detection costs 4,527 ms before any analysis begins.** Analyzers answer "should I run?" by
scanning the repository themselves. Two measured attempts to make that scanning cheaper at the
glob layer failed (see below). The cost is structural: detection asks 211 analyzers a question
that an index would answer in microseconds, and it asks before the index exists.

## Two quadratic scans

The profile after the ignore work exposed two loops that scan every node for each item they
process. Both are on the hot path of a large repository and both were invisible at small scale.

`structural-ownership.ts` gave every unreached file node an owner by filtering the whole node array
and re-normalising every path, once per file node. On a repository with 134,921 nodes that is tens
of millions of path normalisations. It now groups nodes by normalised path in a single pass.

`node-roles.ts` resolved each entry point's handler with a linear search of the node array, once per
entry point. With 471 entry points that is roughly 63 million comparisons. It now builds an
identifier map once.

A third, in test-suite matching: comparing a test file against every existing suite normalised both
paths on every comparison, which means `path.relative` and two regular expressions per pair. The
normalisation is a pure function of the project root and the file, so it is now memoised, and the
comparison moved out of the orchestrator into a module of its own.

| Pass | Before | After |
|---|---|---|
| `pp_nodeRoles` | 1,135 ms | 517 ms |
| `pp_flowCoverage` | 2,756 ms | 1,170 ms |
| `pp_securityBoundaries` | 252 ms | 159 ms |

All three are behaviour-preserving. `structural-ownership.ts` had no tests; it has five now, and
they pass against the previous implementation as well as the new one, so they pin the behaviour
rather than describing the rewrite. `project-relative-path.ts` carries eight, including the loose
suffix rule that test-suite deduplication depends on.

Running total on the same repository, all output byte-identical throughout:

| | Start | Now |
|---|---|---|
| Whole analysis | 52,813 ms | 39,205 ms |
| Wall clock | 58.2 s | 44.1 s |
| User CPU | 74.2 s | 61.3 s |

## The CPU profile

A sampled CPU profile of the same analysis, 60.6 s wall, 77.0 s user CPU and 6.7 s system CPU.
More CPU than wall time means the work is compute-bound and already spread across threads, not
waiting on disk. Peak resident memory was 5.1 GB.

Self time by area:

| Area | s | What it is |
|---|---|---|
| Glob and path matching | 10.5 | `minimatch` plus `node:path`, of which 5.7 s is evaluating ignore patterns |
| Garbage collector | 2.1 | Allocation pressure |
| `node-roles.ts` | 2.8 | Assigning a role to every node |
| `orchestrator.ts` | 6.2 | Spread across the whole file |
| Reading and writing files | 2.1 | `readdir`, `readFileUtf8`, `writeFileUtf8` |

The largest single identifiable cost in the analysis is not parsing, not the graph algorithms and
not the model. It is deciding whether a path is ignored. One analysis performs 510 glob traversals
under 121 distinct ignore policies, and each traversal tests every path it reaches against roughly
twenty patterns. Canonicalising the policies does not help: sorting and deduplicating them reduces
121 to 117, because they are genuinely different. They are different because each analyzer brings
its own, which is what having no shared index forces.

Reading the directory tree itself is cheap. `readdir` is 0.85 s. The expense is entirely in the
repeated filtering that follows.

## The ignore census, and the first fix

Counting what the 510 traversals actually ask, across one analysis:

| Shape | Distinct patterns | Instances passed to the engine |
|---|---|---|
| Directory name, `**/name/**` | 132 | 35,620 |
| File suffix, `**/*.min.js` | 8 | 1,164 |
| Everything else | 41 | 12,908 |
| **Total** | **181** | **49,692** |

Nearly three quarters are a plain directory name, and most of the remainder are a directory name
with a wildcard in it (`dist-*`, `.venv*`, `env[0-9]*`, `*.egg-info`). Only about fifteen are
genuinely path-shaped. All of that was being handed to a glob pattern engine and evaluated against
every path the walk reached.

The run-shared `Ignore` now compiles those patterns once into a segment test: a set of directory
names, one regular expression for the wildcard names, and a residue that still goes to the engine.
The semantics it has to preserve are narrow and now pinned by tests. `**/name/**` ignores the
directory itself as well as its contents, because glob probes each path a second time with a
trailing slash appended. `**/name/**/*` does not ignore the directory itself. `name/**` applies at
the root only. Matching is on the path relative to the walk root, so a repository that lives under
a directory called `build` is not entirely ignored.

Measured on the same repository, output byte-identical on three repositories:

| | Pattern engine | Compiled |
|---|---|---|
| Analyzer detection | 4,123 ms | 2,185 ms |
| Language analyzers | 16,119 ms | 13,570 ms |
| Framework analyzers | 6,085 ms | 4,432 ms |
| Whole analysis | 52,813 ms | 47,423 ms |
| Wall clock | 58.2 s | 52.9 s |
| User CPU | 74.2 s | 67.7 s |

`KLAURO_GLOB_FAST_IGNORE=off` restores the old path.

The synchronous call sites were then routed through the same run-shared compiled ignore. Deployable
evidence, idiom detection and several orchestrator scans used `globSync` directly, so they bypassed
the run cache entirely and paid the pattern engine on every path. `cachedGlobSync` deliberately does
not sort, because some of those callers take the first match and their order is part of today's
behaviour.

Cumulative effect of the two changes on the same repository:

| | Before | Compiled ignore | Plus sync callers |
|---|---|---|---|
| Analyzer detection | 4,123 ms | 2,185 ms | 2,076 ms |
| Framework analyzers | 6,085 ms | 4,432 ms | 4,358 ms |
| `pp_traceability` | 2,423 ms | 2,399 ms | 1,236 ms |
| `pp_enhancedPurpose` | 1,419 ms | 1,443 ms | 522 ms |
| Whole analysis | 52,813 ms | 47,423 ms | 43,338 ms |
| Wall clock | 58.2 s | 52.9 s | 48.3 s |
| User CPU | 74.2 s | 67.7 s | 64.5 s |

Output stayed byte-identical across all three repositories at every step.

This is a floor, not a ceiling. It makes each of the 510 traversals cheaper. It does not remove
them, and removing them is what the index is for. The profile after both changes shows the next
targets: 10.8 s of idle time waiting on file I/O that a worker pool would hide, and roughly 3 s of
path-string work in node role assignment and structural ownership.

## What the existing Rust does

`packages/analyzer-core/native/klauro-parse` is 85 lines. It takes one file's source on stdin,
parses it with tree-sitter, serialises the entire concrete syntax tree to JSON, prints it, and
exits. One operating-system process per file, and the JSON tree is then parsed again on the
JavaScript side.

This is the least favourable possible arrangement. Rust does the cheap part, parsing, and hands
back the expensive part, a large tree to allocate and deserialise. Any move toward Rust should
start by fixing this shape: one long-lived process or an in-process binding, and a compact symbol
record rather than a full syntax tree.

## Reproducibility defect

Two analyses of the same commit, on the same code, with AI off, do not produce the same output.
Four fields differ every time:

- `analyzer_contributions`
- `behavior_surfaces`
- `enhanced_system_purpose`
- `structural_capability_candidates`

Confirmed on two repositories by running the identical arm twice. This is a defect in its own
right. It also blocks incremental reuse, makes any before-and-after verification unreliable, and
means two customers analyzing the same commit can get different answers.

## Measured dead ends

Recording these so they are not retried.

**A shared per-run file inventory.** One directory walk per root, every later pattern matched in
memory. Measured 49,218 ms against 4,748 ms for the current per-pattern walks, a tenfold
regression. The reason is that glob prunes directories during traversal and a flat in-memory list
cannot; matching a pattern against a flat list of 127,987 paths costs more than a pruned walk.
Precompiling the matcher brings the pattern cost down to 11 ms each, but 244 patterns plus the
walks still lose to the current behavior.

**Excluding installed dependencies from every in-run glob.** Correct in principle and
output-neutral in practice: identical analysis output on two repositories, identical detected
analyzer sets on eight. It made isolated detection 6% to 16% faster, but end-to-end analysis time
was unchanged at 53.6 seconds either way. Not shipped, because a lever that does not move the
measurement is not a lever.

The lesson both share: the glob layer is not where the time is. The time is in what runs after the
walk, and in the fact that the index is built last.
