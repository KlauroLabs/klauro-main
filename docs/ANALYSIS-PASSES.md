# The passes

Each tier from `ANALYSIS-TIERS.md` broken into ordered passes, with a budget per pass for a
reference repository of roughly 5,000 source files. Budgets are targets, not measurements.

A pass may read any pass below it. It may not read a pass above it, and it may not read source
after T1.2.

## T1 — Index, ICELOT, graph — 4 s

| Pass | Does | Budget |
|---|---|---|
| 1.1 Discover | One walk, one ignore policy, one file list. Configuration and manifests included | 0.1 s |
| 1.2 Parse | Per-file extraction across workers: symbols, imports, calls, signatures, types, fields | 2.0 s |
| 1.3 Resolve | Cross-file symbol resolution into edges: calls, imports, references, has_field, has_method, extends, implements | 1.0 s |
| 1.4 Entry and exit points | Categorised by kind, each attached to the code it runs | 0.3 s |
| 1.5 ICELOT | The six facets at code-unit granularity | 0.3 s |
| 1.6 Graph | Reachability, call chains, flow paths, structural importance | 0.3 s |

1.2 is the only pass that reads source. Everything after it reads the index.

Flows appear here as paths, not as meaning: the specification places ICELOT at code-unit, step and
flow granularity within Tier 1. What a flow *is for* is T6.

## T2 — Scope — 0.3 s

| Pass | Does | Budget |
|---|---|---|
| 2.1 Ship and run detection | Deployables from manifests, containers, binaries, installers, entry commands, read from T1 | 0.15 s |
| 2.2 Roll-up | Units bundled into another unit merge into it. Image inheritance counts | 0.05 s |
| 2.3 Assignment | Every node, entry point and flow path carries its unit | 0.1 s |

One unit means one analysis. Several means the tiers above run once per unit.

## T3 — Framework, architecture, library — 1 s

| Pass | Does | Budget |
|---|---|---|
| 3.1 Detection | Which frameworks and libraries are present, from T1 imports and manifests | 0.3 s |
| 3.2 Roles | Framework-specific elements: controllers, services, handlers, components, models | 0.5 s |
| 3.3 Architecture | Route table, architectural paradigm, dependency roles | 0.2 s |

3.1 and 3.2 currently cost 4.3 s because 87 analyzers re-read files. Querying T1 is the whole
difference.

## T4 — Verification — 0.5 s

| Pass | Does | Budget |
|---|---|---|
| 4.1 Test structure | Suites, cases, mocks, fixtures, already present in T1 | 0.2 s |
| 4.2 Coverage mapping | Which nodes and flow paths each test exercises | 0.2 s |
| 4.3 Invariants and gaps | Behavioral invariants, what is untested | 0.1 s |

## T5 — Quality and conformance — 1.5 s

| Pass | Does | Budget |
|---|---|---|
| 5.1 Idioms | Conventions the codebase follows, and violations of them | 0.3 s |
| 5.2 Deviation and sprawl | Pattern deviation and framework sprawl, needs T3 | 0.2 s |
| 5.3 History | Change risk, temporal stability, co-change, from S2 | 0.8 s |
| 5.4 Health | Module, implementation and system health rollup | 0.2 s |

5.3 is real I/O against the commit log and is the one pass here that will not compress much.

## T6 — Comprehension — 20 s

| Pass | Does | Budget |
|---|---|---|
| 6.1 Flow chains | Which flows lead into which. Deterministic | 0.3 s |
| 6.2 Terminality | Terminal and proximal-terminal flows: the outcomes. Deterministic | 0.2 s |
| 6.3 Author | One batched request per member — capabilities, flows, steps, entities — issued concurrently | 18 s |
| 6.4 Assemble | Names and descriptions onto the four members, per unit | 0.5 s |

6.1 and 6.2 are deterministic selection. They decide *which* flows are the reason the codebase
exists. 6.3 is where the model states what they mean. Nothing in 6.3 decides what is or is not a
capability; that was settled in 6.2.

The budget for 6.3 is the slowest single request, not the sum, because the four requests are
independent. It is also the number with the least support behind it: the comprehension layer has
never been measured, and this figure should be replaced with a real one at the first opportunity.

## Overlays — 0.5 s

| Pass | Does | Budget |
|---|---|---|
| O1 Telemetry | Attach observed runtime behaviour from S3 to T6 flows and capabilities | 0.3 s |
| O2 Fabric | Stored separately, not part of the analysis | — |

## Totals

| | Budget |
|---|---|
| T1 through T5, deterministic | 7.3 s |
| T6 | 20 s |
| Overlays | 0.5 s |
| **Whole analysis** | **~28 s** |

Against a commodity indexer at 5.7 s for its own T1-equivalent plus history and serialisation, and
against 43 s today with no comprehension layer at all.

## What this implies about the current implementation

The 33 existing passes do not map one-to-one onto these. Several do work belonging to three
different tiers, several run twice, and nine have no tier at all today. The mapping from the current
stage list to this one is the work, and it will collapse passes rather than add them.
