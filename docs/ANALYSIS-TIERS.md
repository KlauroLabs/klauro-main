# The tier model

Three substrates that are read, six tiers that are derived, two overlays that attach. A tier may
consume any tier below it and MUST NOT consume, or be synthesized from, a tier above it.

## Substrates — read, never derived

| | Substrate | Read from |
|---|---|---|
| S1 | Source | The code at a commit |
| S2 | History | The commit log |
| S3 | Runtime | The installed telemetry SDK |

S2 and S3 are the same kind of thing: observed over time rather than read from a snapshot, one
during development and one at runtime. Modelling history as a substrate rather than a tier is what
gives change risk and temporal stability a home.

## Tiers — derived

| | Tier | Consumes | Character | Contains |
|---|---|---|---|---|
| T1 | Index, ICELOT, graph | S1 | Deterministic | Nodes, edges, symbols, imports, signatures, types and fields, entry and exit points, the six ICELOT facets |
| T2 | Scope | T1 | Deterministic | Deployables and units. Partitions every tier above it |
| T3 | Framework, architecture, library | T1, scoped by T2 | Deterministic | Frameworks present and the roles they confer, dependency roles, architectural paradigm, route tables |
| T4 | Verification | T1, scoped by T2 | Deterministic | Test suites and what each covers, mocks, fixtures, behavioral invariants, gaps |
| T5 | Quality and conformance | T1, T3, T4, S2, scoped by T2 | Deterministic, assessing | Idioms and violations, pattern deviation, framework sprawl, change risk, temporal stability, module and system health |
| T6 | Comprehension | T1 through T5, scoped by T2 | Model-authored | Capabilities, flows, steps, entities. The last stage |

**T2 is the tier everything else hangs off.** Scoping is what makes a capability belong to a product
rather than to a repository. It does not exist in the implementation today, which is unlikely to be
unrelated to it never having had a place in the model.

**T5 is the only tier that assesses rather than describes.** T1 through T4 say what the system is.
T5 says how well it holds together. That difference in character is why those stages never sat
anywhere comfortably.

**T6 is model-authored in full.** The tiers below produce facts read from the source; T6 states what
those facts mean in human, product and business language. There is no version of the analysis
without it.

## Overlays — attached, stored separately, never consumed by a tier

| | Overlay | Over |
|---|---|---|
| O1 | Telemetry | S3 attached to T6: which flows actually run, real latency and error rates, dormant against hot capabilities |
| O2 | Fabric | Everything: proposals, work claims, collision detection, coordination |

## Not tiers

Embeddings, traceability, the lookup index and cross-layer linking. Retrieval and query
infrastructure that makes every tier reachable. Naming them tiers would put plumbing beside product.

## Time budget

For a reference repository of roughly 5,000 source files and 135,000 nodes. Measured figures are
from the current implementation on that repository; budgets are targets.

| Tier | Measured today | Budget | Basis for the budget |
|---|---|---|---|
| T1 Index | ~16 s | **4 s** | A commodity indexer extracts the same repository in 2.1 s across ten workers and finishes everything in 5.7 s. Ours additionally resolves types |
| T2 Scope | not implemented | **0.3 s** | Manifests and ship artifacts read from T1, no traversal |
| T3 Framework | 4.3 s | **1 s** | 87 analyzers querying the index rather than re-reading files; the current cost is almost entirely re-reading |
| T4 Verification | 1.5 s | **0.5 s** | Test structure is already in T1; this is selection, not discovery |
| T5 Quality | ~2 s | **1.5 s** | Dominated by reading the commit log, which is real I/O |
| **Deterministic total** | **~24 s** | **~7 s** | Against a commodity indexer's 5.7 s for a comparable graph |
| T6 Comprehension | never measured | **20 s** | One batched request per member, issued concurrently, so the budget is the slowest single request rather than the sum |
| Overlays | — | **0.5 s** | Attachment only |
| **Whole analysis** | **43 s, without T6** | **~28 s, with T6** | |

Scaling: T1 with source file count, T3 through T5 with node count, T6 with the number of
comprehension members rather than repository size, which is why a large repository should not cost
proportionally more model time.

The rule that follows: **every tier below T6 is held to commodity-indexer speed, and T6 is the only
stage permitted to cost real time.** A deterministic tier over budget is cut or redesigned rather
than tolerated, and the budget is a release gate rather than a note.

## Where the time goes today, and why the budget is reachable

Three explanations for the current 43 s have been measured and dismissed: regular expressions are
3.1 s, redundant traversals 3.8 s, and asynchronous concurrency saves nothing because the analyzers
are compute-bound. What remains is 70.9 s of CPU against a commodity indexer's 26.0 s for a
comparable graph, at 1.64x parallelism against its 4.58x.

So the deterministic budget is reachable by two things and not by tuning: analyzers that consume T1
instead of re-reading source, and real threads. Running today's CPU at the reference tool's
parallelism alone would be 15.5 s.
