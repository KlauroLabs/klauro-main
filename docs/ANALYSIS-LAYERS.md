# Every layer of the analysis

A complete inventory of what runs, taken from the orchestrator's own stage list and analyzer
registry, mapped onto the tiers in `cas/SPECIFICATION.md` §0.5. 211 analyzers and 33 distinct passes.

The tier rule is normative: a tier may consume any tier below it and must not consume, or be
synthesized from, a tier above it.

## Analyzers — 211 registered

| Kind | Count | What they contribute |
|---|---|---|
| Language | 35 | Symbols, calls, imports, types, per-language structure |
| Framework | 87 | Framework-specific roles: controllers, services, routes, components, handlers |
| Library | 88 | Which libraries are present and what role they confer |
| Pattern | 1 | Analyzer packs |

## Tier 1 — Index, ICELOT, graph

The substrate. Deterministic: the same source produces byte-identical facts. Nothing below it.

| Stage | Produces |
|---|---|
| `detectAnalyzers` | Which analyzers apply, and the project roots they apply to |
| `languageAnalyzers` | Nodes, edges, symbols, imports, signatures, per-language structure |
| `pp_linkRouteHandlers` | In-repo call resolution, entry-point to handler linkage, entry-point dedupe |
| `pp_buildIndex` | The lookup index |
| `pp_callGraph` | Call chains |
| `pp_methodCalls` | Method calls |
| `pp_reachabilityIndex` | Reachability index |
| `pp_nodeRoles` | A role for every node |
| `pp_structuralImportance` | Structural importance ranking |
| `pp_enrichNodes` | Node call graphs, perspectives |
| `pp_progressiveLevels` | The onboarding ladder |

**ICELOT** — Input, Constraints, Effects, Logic, Output, Telemetry — is specified as six facets of
Tier 1 at code-unit, step and flow granularity. Its `T` is statically declared telemetry capacity
(log sites, metric registrations, span creation), which is not the same thing as Tier 4.

## Tier 2 — Framework, architecture, library

Deterministic. Consumes Tier 1 only.

| Stage | Produces |
|---|---|
| `frameworkAnalyzers` | Framework-specific elements and the roles they confer |
| `pp_architecture` | Architecture summary, route table, manifest libraries |
| `pp_detectPatterns` | Design patterns and their variations |
| `pp_dependencyManifest` | Dependency manifest, unanalyzed-language scan |
| `pp_liftValidation` | Validation lifted onto entry points, conventions applied |
| Idioms and conventions | Codebase idioms, idiom violations, consistency model |

Pattern deviation and framework sprawl are exposed here. The specification notes they inform the
analysis without necessarily appearing in the output.

## Tier 3 — Comprehension

Exactly four members: **Capabilities, Flows, Steps, Entities**. Not three, not five. Journeys,
workflows, scenarios and use cases are read-time projections over flows, never separate stored
members. Authored by the model, anchored to Tier 1 and 2 facts. The last stage, and the one the rest
exists to make possible.

| Stage | Produces |
|---|---|
| `pp_dataEntities` | Data entities, messaging emission lifecycle |
| `pp_domainConcepts` | Domain concepts from nodes, entities and capability names |
| `pp_userJourneys` | The comprehension graph, flows, journeys |
| `pp_flowGraph` | Flow graph |
| `pp_flowSummary` | Flow summary |
| `pp_dataSummary` | Data summary |
| `pp_buildIntents` | Intents |
| `pp_capabilities` | System capabilities, behavior surfaces, system purpose |
| `pp_entryPointContractCapability` | Final capability names, comprehension graph rebuild |
| `pp_enhancedPurpose` | Behaviors from journeys, entry-point summary, display name |
| `pp_aiInterpretation` | Selects and ranks the facts the model reasons over |

Outcomes enter here through terminality and proximal terminality: the flows at the end of a chain,
or near it, are the reasons the codebase exists.

## Tier 4 — Realtime telemetry

Observed runtime behaviour attached to Tier 3: which flows actually execute, real latency and error
rates, dormant against hot capabilities. Arrives from the installed SDK. Optional, and absent rather
than zero-filled when no telemetry exists.

## Tier 5 — Action and Fabric

Proposals, work claims, conflict and collision detection, multi-agent coordination. An overlay,
stored separately, not part of the CAS structure. Depends on Tiers 1 to 3 and is materially better
with 4.

## Layers the tier table does not place

These run and are surfaced. The specification's tier overview does not assign them a tier, which is
itself worth resolving.

| Stage | Produces |
|---|---|
| `pp_gitAnalysis` | Change risks and temporal stability from history |
| `pp_enhanceRisks` | Enhanced change risks, chain criticality, enhanced flow summary |
| `pp_flowCoverage` | Test suites, flow coverage, test gaps |
| `pp_testData` | Mocks, fixtures, test summary, behavioral invariants |
| `pp_securityBoundaries` | Security boundaries |
| `pp_securitySummary` | Security summary |
| `pp_traceability` | Analysis facts, the cross-layer trace between findings |
| `pp_finalMetadata` | Decorators, documentation and todo summaries, security contexts, configuration |
| `pp_embeddingAndFinalize` | Dependency roles, module health, build identity, embeddings, assembly |

## Recursion and composition

The same tiers exist at every depth. A leaf — a deployable, or a repository with no sub-analyses —
is the only place source is read. A repository with sub-analyses is mostly its children plus the
repository-level residue only it can see. Above that, entirely children.

Tier 1 and 2 facts union upward and a parent cannot contradict a child, because it has no
independent source to contradict it with. Tier 3 does not inherit that guarantee: two analyses over
the identical code can correctly reach different answers about what is a capability, because they
are answering at different scope.

## Where the whole thing is surfaced

All of it, queryable in sections through the APIs and MCP endpoints: the graph, the semantic layer,
the framework layer, the comprehension layer, and the telemetry overlay. Fabric depends on all of
it. No layer exists only to feed another.
