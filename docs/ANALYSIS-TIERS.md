# Tiers and passes

Three substrates that are read, six tiers that are derived, two overlays that attach, and the
ordered passes within each tier.

A tier may consume any tier below it and MUST NOT consume, or be synthesized from, a tier above it.
A pass may read any pass below it, and no pass after T1.2 reads source.

Budgets are for a reference repository of roughly 5,000 source files and 135,000 nodes. Measured
figures come from the current implementation on that repository; budgets are targets.

## Substrates — read, never derived

| | Substrate | Read from |
|---|---|---|
| S1 | Source | The code at a commit |
| S2 | History | The commit log |
| S3 | Runtime | The installed telemetry SDK |

S2 and S3 are the same kind of thing: observed over time rather than read from a snapshot, one
during development and one at runtime. Modelling history as a substrate rather than a tier is what
gives change risk and temporal stability a home.

---

## T1 — Index, ICELOT, graph

From S1. Deterministic: the same source produces byte-identical facts. The substrate everything
else is derived from.

| Pass | Does | Budget |
|---|---|---|
| 1.1 Discover | One walk, one ignore policy, one file list. Configuration and manifests included | 0.1 s |
| 1.2 Parse | Per-file extraction across workers: symbols, imports, calls, signatures, types, fields | 2.0 s |
| 1.3 Resolve | Cross-file resolution into edges: calls, imports, references, has_field, has_method, extends, implements | 1.0 s |
| 1.4 Entry and exit points | Categorised by kind, each attached to the code it runs | 0.3 s |
| 1.5 ICELOT | Input, Constraints, Effects, Logic, Output, Telemetry at code-unit granularity | 0.3 s |
| 1.6 Graph | Reachability, call chains, flow paths, structural importance | 0.3 s |
| | **Tier total** | **4 s** |

1.2 is the only pass that reads source. Flows appear here as paths, not as meaning: the
specification places ICELOT at code-unit, step and flow granularity within this tier. What a flow is
*for* is T6. ICELOT's Telemetry facet is statically declared capacity — log sites, metric
registrations, span creation — which is not the same thing as O1.

**Measured today: ~16 s.** The budget is set against a commodity indexer whose discover, parse,
registry and resolve stages total 3.08 s on this repository across ten workers; 4 s allows about 30%
for resolving types more deeply than it does.

---

## T2 — Scope

From T1. Deterministic. Partitions every tier above it.

| Pass | Does | Budget |
|---|---|---|
| 2.1 Partition | Sub-projects from workspace membership, module manifests, nested repositories | 0.1 s |
| 2.2 Ship and run detection | Deployables from containers, compose, installers, build targets, entry commands | 0.15 s |
| 2.3 Assignment | Every node, entry point and flow path carries its project and its ship unit | 0.05 s |
| | **Tier total** | **0.3 s** |

One project means one analysis. Several means the tiers above run once per project, and the
repository level runs afterwards over its children. This is what makes a capability belong to a
product rather than to a repository.

What a repository is made of and how it ships are different questions. A monorepo of 35 workspace
members at 98% import cohesion ships as one container: 35 projects, one deployable. Eight services
sharing one parameterised container are eight projects and eight deployables. The partition follows
what the repository declares about itself; shipping is recorded beside it, never as its gate.

**Measured today: 37 ms.** Ship and run detection, roll-up and assignment run over T1 in
`native/klauro-index/src/scope.rs`. A container's root is its build context rather than the
directory holding its Dockerfile, so packaging variants of one product are one unit; a compose
service that pulls an image ships none of this repository's code. Every node carries its unit by
containment, and otherwise by the units whose imports reach it, so shared code belongs to each.

A separate TypeScript implementation of ship and run detection predates this one
(`analyzer-core/src/analyzer/core/deployable-evidence/`, 14 providers, and `resolveDeployables` in
the MCP server). It reads the old CAS rather than T1 and is the thing this replaces.

Not yet read: JVM and .NET project manifests, so a repository whose services ship through a shared
parameterised Dockerfile plus `pom.xml` resolves to its containers rather than its services. An
installer's bundled paths are not read either, since call arguments are not carried in T1.

---

## T3 — Framework, architecture, library

From T1, scoped by T2. Deterministic.

| Pass | Does | Budget |
|---|---|---|
| 3.1 Detection | Which frameworks and libraries are present, from T1 imports and manifests | 0.3 s |
| 3.2 Roles | Framework-specific elements: controllers, services, handlers, components, models | 0.5 s |
| 3.3 Architecture | Route table, architectural paradigm, dependency roles | 0.2 s |
| | **Tier total** | **1 s** |

**Measured today: 4.3 s**, because 87 analyzers re-read files. Querying T1 is the whole difference.

---

## T4 — Verification

From T1, scoped by T2. Deterministic.

| Pass | Does | Budget |
|---|---|---|
| 4.1 Test structure | Suites, cases, mocks, fixtures, already present in T1 | 0.2 s |
| 4.2 Coverage mapping | Which nodes and flow paths each test exercises | 0.2 s |
| 4.3 Invariants and gaps | Behavioral invariants, what is untested | 0.1 s |
| | **Tier total** | **0.5 s** |

**Measured today: 1.5 s.** This is selection over T1, not discovery.

---

## T5 — Quality and conformance

From T1, T3, T4 and S2, scoped by T2. Deterministic, and the only tier that assesses rather than
describes.

| Pass | Does | Budget |
|---|---|---|
| 5.1 Idioms | Conventions the codebase follows, and violations of them | 0.3 s |
| 5.2 Deviation and sprawl | Pattern deviation and framework sprawl, needs T3 | 0.2 s |
| 5.3 History | Change risk, temporal stability, co-change, from S2 | 0.8 s |
| 5.4 Health | Module, implementation and system health rollup | 0.2 s |
| | **Tier total** | **1.5 s** |

T1 through T4 say what the system is. T5 says how well it holds together. That difference in
character is why these stages never sat anywhere comfortably.

**Measured today: ~2 s.** 5.3 is real I/O against the commit log and will not compress much.

---

## T6 — Comprehension

From T1 through T5, scoped by T2. Model-authored. The last stage, and the one the rest exists to
make possible.

Exactly four members: **Capabilities, Flows, Steps, Entities.** Journeys, workflows, scenarios and
use cases are read-time projections over flows, never separate stored members.

| Pass | Does | Budget |
|---|---|---|
| 6.1 Flow chains | Which flows lead into which. Deterministic | 0.3 s |
| 6.2 Terminality | Terminal and proximal-terminal flows: the outcomes. Deterministic | 0.2 s |
| 6.3 Author | One batched request per member, issued concurrently | 18 s |
| 6.4 Assemble | Names and descriptions onto the four members, per unit | 0.5 s |
| | **Tier total** | **20 s** |

6.1 and 6.2 decide *which* flows are the reason the codebase exists. 6.3 is where the model states
what they mean in human, product and business language. Nothing in 6.3 decides what is or is not a
capability; that was settled in 6.2. There is no candidate stage, no validation pass, no confidence
score and no approval cycle, because a capability is not a claim that might be wrong.

The 6.3 budget is the slowest single request, not the sum, because the four are independent. **It is
the weakest number here**: the comprehension layer has never been measured, so this is reasoning
about batched model calls in general rather than about this system. Replace it with a real figure at
the first opportunity.

---

## Overlays — attached, stored separately, never consumed by a tier

| | Overlay | Over | Budget |
|---|---|---|---|
| O1 | Telemetry | S3 attached to T6: which flows actually run, real latency and error rates, dormant against hot capabilities | 0.3 s |
| O2 | Fabric | Everything: proposals, work claims, collision detection, coordination | stored separately |

---

## Not tiers

Embeddings, traceability, the lookup index and cross-layer linking. Retrieval and query
infrastructure that makes every tier reachable. Naming them tiers would put plumbing beside product.

---

## Totals

| | Budget |
|---|---|
| T1 through T5, deterministic | 7.3 s |
| T6 | 20 s |
| Overlays | 0.5 s |
| **Whole analysis** | **~28 s** |

Against 43 s today with no comprehension layer at all, and against a commodity indexer at 5.7 s for
its own T1 equivalent plus history and serialisation.

**The rule:** every tier below T6 is held to commodity-indexer speed, and T6 is the only stage
permitted to cost real time. A deterministic tier over budget is cut or redesigned rather than
tolerated, and the budget is a release gate rather than a note.

---

## Recursion and composition

The same tiers exist at every depth. A leaf — a deployable, or a repository with no sub-analyses —
is the only place source is read. A repository with sub-analyses is mostly its children plus the
repository-level residue only it can see. Above that, entirely children.

T1 and T2 facts union upward and a parent cannot contradict a child, because it has no independent
source to contradict it with. T6 does not inherit that guarantee: two analyses over identical code
can correctly reach different answers about what is a capability, because they are answering at
different scope.

---

## What exists today

211 analyzers: 35 language, 87 framework, 88 library, 1 pattern. 33 distinct passes.

Those 33 do not map one-to-one onto the 22 above. Several do work belonging to three different
tiers, `pp_aiInterpretation` appears twice on two paths, three measure zero milliseconds on a
5,315-file repository, and nine have no tier at all today: git history, change risk, flow coverage,
test data, security boundaries and summary, traceability, final metadata, and the finalize pass.

The mapping from the current stage list to this one collapses passes rather than adding them.

Half of the 136,928 nodes emitted today are analyzer observations rather than code symbols, and
those belong in T3 rather than T1. Once they move, T1's node count lands near the commodity
indexer's 59,237 and its budget gets easier rather than harder.
