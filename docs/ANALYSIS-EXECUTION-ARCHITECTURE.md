# Complete Progressive Analysis

Status: authoritative execution contract.

Klauro must make useful understanding available quickly without weakening the
analysis. Progressive means that completed facts become queryable while later
work continues. It does not mean a smaller analysis.

## Invariants

1. A final CAS is complete. No analyzer, framework semantic, relationship,
   comprehension unit, ICELOT facet, description, or validation is omitted to
   meet a time target.
2. An intermediate CAS is explicitly incomplete. `layers_ready.complete` is
   false until every required layer is ready. Pending and failed layers are not
   represented as empty facts.
3. Failures are durable and resumable. A failed phase retains the last good
   completed layers, records its failure, and retries from its checkpoint. It
   never publishes partial work as final.
4. Timing targets are regression signals. They may fail tests, page operators,
   or change scheduling. They must never abort analysis, truncate output, skip
   work, or authorize a partial result as complete.
   Worker recovery is progress-based: a monotonically advancing phase counter
   distinguishes slow work from a process that has genuinely stopped advancing.
   A stalled worker is retried from its last durable checkpoint; its partial
   output is never promoted to complete.
5. Reordering cannot change truth. The final CAS produced by progressive
   execution must be semantically equivalent to a clean complete execution for
   the same source revision and analyzer build.
6. Workspace analysis begins only from completed member CAS revisions. The
   workspace-level CAS may publish its own explicit intermediate layers, but
   it never fills missing project facts by reading source or guessing.

## One Product, Split Execution

Klauro has one analysis contract. Client and hosted components execute different
parts of that contract; they do not produce competing local and remote analyses.

- The installed client discovers files, applies standard and configured ignore
  rules, hashes content, watches IDE-style file changes, packages changed source,
  and uploads encrypted revision material. Packaging and upload are streamed
  through bounded temporary artifacts; memory scales with the largest active
  file or Git batch, not total repository size.
- Klauro infrastructure owns parsing, graph construction, framework and library
  semantics, comprehension, remote AI enrichment, validation, and canonical CAS
  persistence.
- A customer laptop is never an analyzer host. The shipped MCP/CLI artifact
  does not contain analyzer workers, parser grammars, framework analyzers, graph
  construction, embeddings, or AI execution. Analyzer development and proof
  runs execute against the hosted development gate, using the same worker
  artifact deployed in production.
- Committed revisions update shared project truth. Uncommitted revisions are
  explicitly in-flight and may be shared as provisional collaboration context;
  they never silently replace committed truth.
- Runtime SDK events are independent inputs. They are retained even before a CAS
  exists, then correlated and backfilled against the canonical uploaded CAS.
  Telemetry ingestion never triggers source analysis.

## Execution Graph

The execution model is a dependency graph, not one monolithic function with
labels applied afterward.

| Stage | Produces | Depends on | Availability |
| --- | --- | --- | --- |
| S0 Source snapshot | revision, files, hashes, languages, project/deployable roots | uploaded snapshot or hosted Git checkout | immediate |
| S1 Program inventory | declarations, signatures, imports, registrations, raw entry points | S0 | streamed by deterministic file shard |
| S2 Relationship graph | calls, routes, exits, effects, entities, lineage, tests, topology | relevant S1 shards and framework facts | streamed by project/deployable partition |
| S3 Comprehension | capabilities, flows, steps, function mappings, ICELOT, semantic coverage | stable S2 partition plus required framework semantics | available per partition, reconciled globally |
| S4 Deep intelligence | patterns, idioms, risks, invariants, architecture health, telemetry joins | S2 and S3 | independent partitions where possible |
| S5 Narrative enrichment | system and primary-capability descriptions, then lazy element descriptions | evidence packets from S2-S4 | remote AI, parallel with unrelated deterministic work |
| S6 Final validation | graph integrity, provenance, coverage, CAS contract, equivalence | all required stages | marks CAS complete |
| W1 Workspace composition | workspace-level CAS connections, capabilities, flows, entities, infrastructure, narrative | completed member CAS revisions | after S6 for every included member |

The existing L0-L5 public vocabulary may remain for compatibility with stored
analysis manifests, but its implementation must map to these real stage
checkpoints. L1-L4 cannot remain one atomic orchestration block.

## Parallelism Without Nondeterminism

- Build one immutable source inventory and one content cache per revision.
- Build one language-neutral evidence corpus per revision. It owns immutable
  source text, newline offsets, imports by language flavor, parsed manifests,
  path categories, and other reusable file evidence. Language, framework,
  library, and pattern analyzers consume this corpus instead of maintaining
  private repository scans. Language-specific evidence can extend the corpus,
  but cannot replace the shared contract.
- Parse files in bounded worker-parallel shards. Each shard emits facts keyed by
  stable file and symbol IDs.
- Run only analyzers whose dependency, manifest, import, decorator, or syntax
  signals are present. Applicable analyzers consume shared parsed facts instead
  of rescanning the repository.
- Merge results in stable analyzer, file, symbol, and edge order. Scheduling
  order must not affect final IDs or serialized meaning.
- Build reusable indexes once per CAS revision: node by ID, edges by endpoint,
  entries/exits by node, facts by file, entities by operation, and telemetry by
  static ID. Every downstream pass consumes these indexes.
- Persist stage artifacts by content hash. A retry or incremental run reuses
  every artifact whose source and analyzer fingerprints are unchanged.
- Persist each analyzer contribution under a key containing its exact relevant
  source-set hash, analyzer id/type/version, analyzer implementation
  fingerprint, applicable configuration, semantic-pack identity, and cache
  schema. Analyzers that declare relevant files invalidate only for those
  files; analyzers without a trustworthy declaration conservatively key on the
  complete source inventory. Cache hits preserve contribution ordering and
  logical CAS meaning exactly.
- Incremental invalidation computes the complete reverse dependency closure.
  It is cycle-safe and has no propagation-depth cutoff. Every directly changed
  or transitively affected file is reanalyzed; unchanged contributions are
  made cheap by content-addressed reuse, never skipped on an assumption.
- Test suites, cases, fixtures, mocks, and coverage relationships remain
  first-class graph facts in the test perspective. They are not production
  entry points and cannot seed product flows, runtime instrumentation, or
  capability/domain ranking.

## Logical CAS And Physical Storage

The CAS — repo-level and workspace-level alike — remains the complete logical contract. Its physical persistence
is segmented by immutable analysis revision so ordinary MCP/API calls can read
only the identity, graph, calls, facts, comprehension, tests, runtime, quality,
or supplemental sections they require.

- Section hydration must reproduce the exact logical CAS object.
- The hosted service keeps a byte-bounded LRU of parsed sections; it does not
  retain an unbounded collection of complete parsed analyses.
- Installed MCP clients cache bounded section responses and never mirror the
  complete customer graph as their normal query path.
- A complete CAS remains available as an explicitly requested compressed,
  streamed export for compatibility, audit, and parity proof. It is not an
  interactive query transport.
- Physical normalization or derived-view materialization may evolve without
  changing CAS semantics at any nesting level. Golden hydration parity and byte-equivalent MCP
  answers are release gates.

The production runtime remains Node 22 LTS with TypeScript orchestration and
native tree-sitter parsers. Rewriting orchestration in another language is not a
performance strategy. Native or Rust components are appropriate only at stable,
pure parse/IR boundaries after golden equivalence proves identical CAS meaning.

On the initial 8 GB host, analysis runs outside the interactive API process.
Larger deployments scale analysis workers horizontally by queue depth; they do
not increase unbounded per-repository fan-out. Isolation and scheduling protect
availability, but they do not satisfy the performance bar: each analysis must
also meet CPU-time and wall-time targets through shared indexes, cached source
facts, incremental recomputation, and algorithmic work elimination.

## Comprehension And ICELOT

Comprehension is an early product layer, not a tail report. It starts as soon as
a deployable or bounded project partition has stable entry, graph, effect, and
framework evidence. Global reconciliation may revise ranking and relationships,
but it cannot discard provenance.

Every meaningful flow must satisfy the semantic doctrine in `SEMANTIC-MODEL.md`:

- A flow is an end-to-end behavior, not every raw entry point.
- A step is a human-meaningful action, not automatically one function.
- Capability-to-flow relationships are evidence-backed and many-to-many.
- Each flow and step carries evidence-gated ICELOT facets. Missing evidence is
  an explicit gap, never an invented value.
- Internal imports/hooks are not external integrations.
- Collection helpers such as `Array.find` are not database effects without
  receiver/framework evidence.
- Test and fixture behavior is indexed and linked to what it covers, but it is
  excluded from product capability, flow, domain, deployable, and narrative
  ranking unless explicitly requested as a test perspective.

Final validation must report semantic coverage and facet provenance. Coverage
regressions fail the proof suite, but do not remove code or stop the production
analysis from completing.

## AI Execution

AI is required for system descriptions, primary capability comprehension, and
the interpretive parts of flow/step descriptions. It runs remotely from compact,
versioned evidence packets.

- Required AI work is not placed inline between deterministic graph phases.
- Independent description and capability requests run concurrently.
- Provider retries, repair prompts, and stronger-model escalation continue to a
  valid grounded result; failure remains visible and retryable.
- Element descriptions below the default summary tier are lazily requested and
  persisted with evidence fingerprints and invalidation timestamps.
- Entity, flow-detail, and individual-node prose is lazy enrichment and never
  extends the required cold-analysis critical path. Their structural facts and
  relationships remain complete before S6; the prose state is explicitly
  `manual-trigger-only` until requested.
- AI latency can delay final S6 completion, but cannot delay access to already
  completed deterministic layers.

## Performance Proof

Measure four clocks independently:

1. first truthful inventory;
2. first usable structural context;
3. first grounded comprehension partition;
4. final complete CAS and required narrative.

Record CPU time, wall time, peak RSS, bytes read, parse-cache hit rate, analyzer
applicability and contribution, AI request count/latency, persisted bytes, and
stage retries. Benchmarks cover cold, warm, incremental, in-flight, and
workspace-level-CAS composition paths through the deployed customer API. A timing regression fails
the benchmark. Production continues until S6 or an explicitly visible retryable
failure; it never silently returns less analysis.

Current service objectives are approximately sub-second first inventory, about
10 seconds for an average repository's usable structural context, no more than
60 seconds for an ordinary complete analysis, and no more than 180 seconds for a
very large cold repository. These are architecture and regression targets, never
completeness cutoffs.

Production reserves CPU and memory for the API/control plane by running analysis
in isolated workers. Resource isolation is a failure-containment mechanism, not
a performance strategy and not proof that analysis is efficient. Acceptance is
based on complete-output parity, CPU-seconds, peak RSS, bytes read, and wall
time. When demand exceeds available worker capacity, complete jobs queue or run
on additional hosted workers; no work moves to a customer machine.
