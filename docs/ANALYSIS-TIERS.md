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

Pass 1.3 reads an import five ways. A relative specifier is a path, resolved against the importing
file. A specifier that names a module — dots, colons or backslashes between its segments — is the
path of the file that declares it, matched against the repository's own files where the name picks
out exactly one and that one is written in the same language; a source root between the segments,
`src` or `main` or the language's own, belongs to the layout rather than to the name. A specifier
that names something wider than a file is read as what that thing is. A package is compiled whole,
so an import of one reaches every file it is written across, its own tests excepted: a package's
tests are not what importing it gives you. A namespace is a lookup scope, so an import of one
reaches the files in it whose declarations the importer names, and a file records the namespace it
declares for both to be found by. A specifier that names a directory the repository holds and
nothing more precise is still the repository's own rather than something it depends on. A
specifier that begins with an alias the repository declares — a compiler's path mapping, a
package's own subpath import, a module path, a bundler's configured alias, a test runner's module
map, or the one a framework's configuration file gives it — is what that alias maps to, and stays
the repository's own even where the file it names is generated rather than committed. An alias
counts only where it maps onto something the repository holds: one that points into installed
packages renames a dependency rather than declaring code. Where the alias is written as a pattern,
it is read only as far as it reads as a path — a literal prefix, and at most one capture standing
for the rest. Everything else is a package, and its name is what a unit reaches.

Pass 1.5 emits a facet only where something was observed, per the semantic model: a unit that
takes nothing carries no Input, and one that reaches nothing carries no Effects. Effects names
the packages and runtimes a unit reaches, read from the resolved edges.

1.2 is the only pass that reads source. Flows appear here as paths, not as meaning: the
specification places ICELOT at code-unit, step and flow granularity within this tier. What a flow is
*for* is T6. ICELOT's Telemetry facet is statically declared capacity — log sites, metric
registrations, span creation — which is not the same thing as O1.

**Measured today: 1.2 s** — discover 23 ms, parse 533 ms, resolve 266 ms, entry and exit 76 ms,
ICELOT 51 ms, graph 234 ms — in `native/klauro-index`, against a budget of 4 s.

A file is routed to an extractor before it is read, from its size and whether its language declares
anything. Code that declares gets 8 MiB, so a large generated module still indexes; markup and data
get 64 KiB, because a document that declares rather than records is small. A saved web page cost
77 seconds on its own before this, and one file that slow is a floor no amount of parallelism lifts.

A structured document contributes its schema. One that overflows the schema budget is records rather
than declarations, and yields a single node carrying its size.

**Where T1 stands.** Discovery and parse hold across the corpus: every language with a grammar reads
at or above 95%, and the seven without one are named in `analyzer-core/scripts/corpus-sweep.mjs`,
which fails on a language below that floor, a repository over its time allowance, or an index that
differs between two runs.

The bar for the rest is a commodity indexer measured on the same repositories, not a percentage
chosen here:

| Repository | Language | Its nodes | Ours | Its calls | Ours | Its wall | Ours |
|---|---|---|---|---|---|---|---|
| 4,579 files | TypeScript | 59,237 | 85,390 | 61,815 | 198,801 | — | 1.79 s |
| 2,551 files | C# | 42,992 | 45,129 | 17,034 | 17,624 | 5.76 s | 0.56 s |
| 806 files | Rust | 18,605 | 19,966 | 24,534 | 14,028 | 2.12 s | 0.38 s |

Five to ten times faster, ahead on declarations everywhere, three times ahead on TypeScript, level on
C#, behind on Rust. The two gaps are therefore specific: the languages whose call graph it resolves
more completely than we do, and breadth, where it carries 158 grammars against our 63.

Resolution reads a receiver path, walks it through declared members, and gives a name an origin of
declared, package, runtime, indirect or unknown. Receiver-heavy, chained call styles — Rust's
`index.get_task(id).await.succeeded()` — need the return type of each link, and that inference exists
for TypeScript alone. Bare-call languages score highest without it, because a name declared once
resolves on its own.

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

**Measured today: 73 ms.** Ship and run detection, roll-up and assignment run over T1 in
`native/klauro-index/src/scope.rs`. A container's root is its build context rather than the
directory holding its Dockerfile, so packaging variants of one product are one unit; a compose
service that pulls an image ships none of this repository's code. A compose file that names
several services declares several units even where they build from one context, because a named
service is a deployable and a build context is packaging. Every node carries its unit by
containment, and otherwise by the units whose imports reach it, so shared code belongs to each.

An `install*` script under a continuous integration directory prepares a job rather than the
product, and declares nothing.

Every unit carries the category its strongest declaration earns — `shipped` for a ship artifact,
`runnable` for an entry the repository can start, `library` for a named package with neither.
A runnable is not a deployable: repositories hold sample and utility binaries that build and
never ship, and counting those as ship units buries the few that matter.

What a container alone ships is what tells it apart. Two services built from one repository-wide
context each root at the code only they copy, while a single container that copies the repository
roots at the repository; a container that copies nothing roots where its Dockerfile sits, because
nothing says it builds anything wider. A unit whose root another unit ships — an installer inside
a container's build — is a member of it rather than a unit beside it.

Every declaration carries the unit whose root holds it, and otherwise the units whose imports
reach it, so shared code belongs to each. A repository that declares no unit over the code it
builds leaves that code to the repository itself, which 2.1 partitions; a C program built by a
hand-written makefile is the shape that does this.

A separate TypeScript implementation of ship and run detection predates this one
(`analyzer-core/src/analyzer/core/deployable-evidence/`, 14 providers, and `resolveDeployables` in
the MCP server). It reads the old CAS rather than T1 and is the thing this replaces.

A project manifest names a project whatever its ecosystem — `pom.xml`, a Gradle build, a `.csproj`,
a `.cabal`, `go.mod`, `CMakeLists.txt`, `Package.swift`, `composer.json`, `mix.exs`, a gemspec —
and a build file sitting where a program's entry point is declares that the project runs. A build
file that names the artifact it produces declares a ship without a container to read: a project
whose framework builds an executable or hosts other projects, a manifest declaring a launchable
application, a packaging of `war` or `ear`. A test project builds an executable and ships nothing.

---

## T3 — Framework, architecture, library

From T1, scoped by T2. Deterministic.

| Pass | Does | Budget |
|---|---|---|
| 3.1 Detection | Which frameworks and libraries are present, from T1 imports and manifests | 0.3 s |
| 3.2 Roles | Framework-specific elements: controllers, services, handlers, components, models | 0.5 s |
| 3.3 Architecture | Route table, architectural paradigm, dependency roles | 0.2 s |
| | **Tier total** | **1 s** |

**Measured today: 26 ms** — dependencies 5 ms, roles 19 ms, architecture 2 ms — in
`native/klauro-index`, per sub-project. Querying T1 is the whole difference: the analyzers re-read
files, and none of this does.

Detection is derived rather than catalogued: every import that reaches no file the repository
holds resolves to a package, so the dependency set is complete and a catalog only supplies the
role and category. A package the catalog does not know is reported with its usage rather than
dropped.

Three things are not dependencies. Code the repository holds is its own, whether a module path
names the file, a directory holds it, or a manifest declares the package it is imported by. The
language's own library is the language, recorded as a runtime rather than as something chosen.
And a specifier that does not read as a module — a fragment of markup, a keyword standing where
a module goes — is not one.

Roles come from a declarative table over annotations, inheritance and registration, and each role
records what made it one. A declaration's own name is the weakest of these and is read only where
the declaration is code the repository wrote, so an item in a build file never reads as a
controller. The 267 analyzer files under `analyzer/frameworks` and
`analyzer/libraries` (103,412 lines) hold per-framework depth — React props, hooks and event
handlers — that this does not reproduce and does not attempt to.

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

T1 through T3 measure 1.3 s together today, against a commodity indexer at 5.7 s for its own T1
equivalent plus history and serialisation.

The index is emitted as one string table followed by the index that references it. Every string in
the index — values, and the field names of flattened records alike — is written once and referred to
by position, which is a third of the bytes the same facts took as JSON and is the same facts: the
plain form round-trips from the emitted one exactly.

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
