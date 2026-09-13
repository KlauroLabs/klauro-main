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
