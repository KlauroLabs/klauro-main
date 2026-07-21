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
6. Workspace analysis begins only from completed member CAS revisions. WAS may
   publish its own explicit intermediate layers, but it never fills missing
   project facts by reading source or guessing.

## One Product, Split Execution

Klauro has one analysis contract. Client and hosted components execute different
parts of that contract; they do not produce competing local and remote analyses.

- The installed client discovers files, applies standard and configured ignore
  rules, hashes content, watches IDE-style file changes, packages changed source,
  and uploads encrypted revision material.
- Klauro infrastructure owns parsing, graph construction, framework and library
  semantics, comprehension, remote AI enrichment, validation, and canonical CAS
  persistence.
- A customer laptop must never become an analyzer host implicitly. Full local
  execution exists only behind `KLAURO_ALLOW_LOCAL_ANALYSIS=1` for analyzer
  development and controlled proof runs.
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
| S0 Source snapshot | revision, files, hashes, languages, project/deployable roots | uploaded or local source | immediate |
| S1 Program inventory | declarations, signatures, imports, registrations, raw entry points | S0 | streamed by deterministic file shard |
| S2 Relationship graph | calls, routes, exits, effects, entities, lineage, tests, topology | relevant S1 shards and framework facts | streamed by project/deployable partition |
| S3 Comprehension | capabilities, flows, steps, function mappings, ICELOT, semantic coverage | stable S2 partition plus required framework semantics | available per partition, reconciled globally |
| S4 Deep intelligence | patterns, idioms, risks, invariants, architecture health, telemetry joins | S2 and S3 | independent partitions where possible |
| S5 Narrative enrichment | system and primary-capability descriptions, then lazy element descriptions | evidence packets from S2-S4 | remote AI, parallel with unrelated deterministic work |
| S6 Final validation | graph integrity, provenance, coverage, CAS contract, equivalence | all required stages | marks CAS complete |
| W1 Workspace composition | WAS connections, capabilities, flows, entities, infrastructure, narrative | completed member CAS revisions | after S6 for every included member |

The existing L0-L5 public vocabulary may remain for compatibility with stored
analysis manifests, but its implementation must map to these real stage
checkpoints. L1-L4 cannot remain one atomic orchestration block.

## Parallelism Without Nondeterminism

- Build one immutable source inventory and one content cache per revision.
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

The production runtime remains Node 22 LTS with TypeScript orchestration and
native tree-sitter parsers. Rewriting orchestration in another language is not a
performance strategy. Native or Rust components are appropriate only at stable,
pure parse/IR boundaries after golden equivalence proves identical CAS meaning.

On the initial 8 GB host, the service admits one heavy analysis job at a time and
uses two parser workers inside that isolated job. This protects interactive API
traffic and avoids turning parallelism into CPU contention. Larger deployments
scale analysis workers horizontally by queue depth; they do not increase
unbounded per-repository fan-out.

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
stage retries. Benchmarks cover cold, warm, incremental, in-flight, and WAS
composition paths through the deployed customer API. A timing regression fails
the benchmark. Production continues until S6 or an explicitly visible retryable
failure; it never silently returns less analysis.

Current service objectives are approximately sub-second first inventory, about
10 seconds for an average repository's usable structural context, no more than
60 seconds for an ordinary complete analysis, and no more than 180 seconds for a
very large cold repository. These are architecture and regression targets, never
completeness cutoffs.
