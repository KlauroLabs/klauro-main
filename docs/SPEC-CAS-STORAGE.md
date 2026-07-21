# SPEC: CAS Storage Rearchitecture — Segmented, Queryable Without Full Load

Status: master storage spec. Composes with `ANALYSIS-EXECUTION-ARCHITECTURE.md`
(the execution contract this store persists) and
`SPEC-MATHEMATICAL-INTELLIGENCE.md` (whose derived indexes become first-class
segments here). Examples are shape-based; no client or benchmark product names.

## Executive summary

Every storage/resource incident of 2026-07-20/21 — telemetry flush at 2.8 GB,
`status` at 1.2 GB/20 s, the status endpoint's full decompress, the
coordinator+worker duplicate at 5.9 GB, WAS lookup-map rebuilds, 126 s
historical saves — is one defect: **the CAS is a single monolithic JSON
document, and every consumer that wants any of it must materialize all of
it.** Quotas, caps, and queues manage that symptom; this spec removes the
cause. Containment is explicitly *not* the fix.

**Measured** (streaming byte-attribution of two real stored CASes; method in
Appendix A — the scan itself reads a 339 MB CAS in 2.4 s at ~flat memory,
which is the existence proof for the access model this spec mandates):

| Field | Specimen L (339 MB, 4.6k-file PHP/TS monorepo, ~83k nodes) | Specimen S (90.9 MB, Klauro self-shape TS service, 16k nodes) | Class |
| --- | ---: | ---: | --- |
| `nodes` | 113.0 MB (35.0%) | 22.0 MB (25.3%) | mixed: structural core + inline detail |
| `edges` | 61.0 MB (18.9%) | 12.3 MB (14.1%) | structural core (bloated: ~465 B/edge) |
| `method_calls` | 52.6 MB (16.3%) | 7.7 MB (8.9%) | per-node detail |
| `analysis_facts` | 19.9 MB (6.2%) | 27.1 MB (31.3%) | per-subject detail |
| `index` (by_name/by_type/…) | 18.2 MB (5.6%) | 3.2 MB (3.7%) | derived (recomputable) |
| `domain_concepts` + `intents` | 25.7 MB (7.9%) | 3.7 MB (4.2%) | prose |
| `test_gaps`, `runtime_static_links`, `call_chains`, `flow_graph`, … | ~2–10 MB each | ~0.2–2.4 MB each | derived |
| everything else (~50 fields) | < 4 MB each | < 1 MB each | manifest-tier summaries |

Inside `nodes`, the truly structural fields (id/name/type/level/file/location/
parent/signature) are a minority; `call_graph` denormalization (25.3 MB),
`metadata` (20.5 MB), `source` snippets (8.1 MB), `comments` (8.1 MB),
`perspectives`/`perspective_data` (13 MB) ride along on every load. Node-id
strings are repeated everywhere: `edges` spends 45.3 MB of its 61 MB on
`id`/`source`/`target` strings alone.

**Measured amplification:** decompress+`JSON.parse` of the 86.7 MB specimen
costs ~0.5 s CPU and a **6.5× RSS transient** (564 MB) — buffer + UTF-8 string
+ parse temporaries + object graph. Scaled to the 258 MB production self-CAS:
~1.7 GB transient *per loader*; the coordinator+worker pair reproduces the
5.9 GB incident arithmetic exactly. This is a property of the format, not of
any one call site — which is why fixing call sites one incident at a time
(e.g. the `ef4e29ac` telemetry cache) can never close the class.

**Recommendation:** segmented CAS in a **per-revision immutable directory of
offset-indexed flat segment files under a tiny JSON manifest**, adopted on
next save, with the old monolith readable forever through an adapter. Not
SQLite, not LMDB (§4 has the weighing). Only the building worker ever
materializes the full graph; every other consumer reads the manifest
(status), a named segment (tools), or a single record by offset (telemetry).

**Wave 1 scope (the commit that kills the first incident class):** manifest +
segment writer + `AnalysisHandle` read facade + monolith adapter + the parity
gate (identical answers, monolith vs segmented, across the full MCP tool
surface; byte-stable output). Status and telemetry stop touching CAS bytes
entirely. §7 has the full wave plan and which incident dies at which wave.

---

## 1. Forensics: what the blob actually is

### 1.1 Corrections to the working assumptions

Two things "everyone knows" about the blob turned out to be already solved —
the spec builds on them instead of duplicating:

1. **Embeddings are NOT inline.** `CASOutput.embedding_index` is ~300 bytes of
   metadata (model, dimensions, coverage). The vectors live in a separate
   binary sidecar already: `embedding/file-vector-store.ts` writes
   `embeddings/index.bin` + `manifest.json` next to the analysis. Neither
   specimen contains a vector payload. This is the **existing precedent** for
   the segment model: a heavy, separately-lifecycled artifact referenced from
   the CAS by metadata, loaded only by the consumer that needs it.
2. **An analysis-index sidecar already exists.** `storage.ts` maintains
   `AnalysisEntry` records (name, path, file, analyzed_at, system_type,
   frameworks, node_count, edge_count, cas_version, layers_ready, track,
   base_commit, branch) in an index keyed off `loadIndex()`, plus
   `getAnalysisFileFingerprint()` (mtime:size). Status-class consumers can
   already answer from this without a load — the manifest in §3 is this
   sidecar's per-analysis completion, not a competitor to it.

Also confirmed as designed-for, not new: `reachability_index` (765fc79f) is
9.3 MB = 3.6% of the production self-CAS — a *derived* index that costs every
consumer 9.3 MB of parse whether or not they query reachability. It is the
newest member of a class (`index` by_name/by_type at 18.2 MB, `call_chains`,
`flow_graph`, `communities`) that belongs in derived segments.

### 1.2 The structural bloat levers (measured)

- **Edge encoding:** 131,387 edges cost 61 MB in Specimen L — ~465 bytes/edge.
  `id` (22.9 MB) + `source` (11.1 MB) + `target` (11.4 MB) are long node-id
  strings repeated per edge. With an interned string table and integer refs,
  the same information is ~10–20 B/edge: **~57 MB → ~2–3 MB** on this shape.
  (Wave 3; the segmentation does not depend on it.)
- **Node record mixing:** one node object carries hot structural fields AND
  `source` snippet AND `comments` AND `metadata`/`attributes`/`hierarchy` AND
  perspective decorations. Every graph traversal pays for prose it never reads.
- **Denormalized `call_graph`/`called_by` inside nodes** (38 MB in L)
  duplicates what `edges` already states — derived, recomputable, and the
  first thing agents *don't* need when they asked for a file's node list.
- **`analysis_facts`** is per-subject evidence (32k–41k records) touched
  almost exclusively by fact-oriented tools — 31% of the self-shape CAS that
  status/telemetry/WAS never read.

### 1.3 Consumer inventory (who loads what, and what they actually need)

Verified against the tree at `9e13f705`:

| Consumer | Call path | Actually needs | Frequency | Latency need | Today |
| --- | --- | --- | --- | --- | --- |
| CLI `status` / doctor / revision tracks | `storage.ts loadAnalysis` | name, counts, layers_ready, freshness, track | every session start; polled | < 100 ms | full decompress+parse (the 1.2 GB/20 s incident) |
| Hosted status endpoints (`/analysis`) | `hosted-analysis.ts:249–250` — **two** `loadAnalysis` calls (preferred + main) | manifest tier + `.reanalyze-attempt.json` sidecar | per poll, per client | < 100 ms, must never starve health | 2× full load (cached, but cold after every save) |
| Self-telemetry correlation | `self-telemetry.ts` flush → cached CAS | per-node lookup by static id (`runtime_static_links`, node existence) | every ingest flush | < 10 ms/lookup | full CAS held resident (post-`ef4e29ac`; was the 2.8 GB incident) |
| MCP tool handlers (~160 tools) | `analyzer.ts:1387 getAnalysis` → `query.ts` (40+ functions, all typed `(cas: CASOutput, …)`) | per-tool slices: a node, a file's nodes, edges-for-node, route table, one summary block | interactive, bursty | < 1 s | `getAnalysis` calls `loadAnalysis` **without `preferCache`** — a full decompress+parse per call is possible on this hottest path (defect, wave 0) |
| WAS composition | `cross-codebase-analysis.ts` | per-member: system summary, capabilities, interfaces, entry/exit, links — never `nodes[]`/`method_calls` | per workspace build/refresh | seconds | loads every member CAS fully; rebuilds lookup maps per run (a named instance of the exhaustive-scan defect class, SPEC-MATHEMATICAL-INTELLIGENCE §C.1) |
| Reanalysis coordinator | `analyzer.ts` (6× `loadAnalysis(preferCache)`) | previous manifest + affected sets + freshness | per analysis job | seconds | full previous CAS resident **in the coordinator process while the worker holds its own copy** — the 5.9 GB duplicate incident |
| Build worker (analysis-worker) | orchestrator | the full graph — the one legitimate materializer | per analysis job | n/a | full (correct) |
| Description enrichment | `description-enrichment.ts` | node slices in, prose out | background, per batch | n/a | load-modify-save of the whole blob per enrichment batch — a 258 MB rewrite to add kilobytes of prose |
| Semantic search | `semantic-search.ts` | `embedding_index` metadata + node metadata for rerank | interactive | < 1 s | full CAS for what is metadata + a rerank slice |
| Golden snapshot / gauntlets | `compare_cas_golden_snapshot`, benches | full, by design | CI/proof | n/a | full (correct; becomes the parity oracle) |

The pattern: **exactly one consumer needs the whole graph.** Everything else
needs the manifest tier, one segment, or one record — and pays for 100% of
the bytes today.

---

## 2. Requirements

R1. **Status is O(bytes of metadata).** `status`-class reads touch only the
    analysis index sidecar + the manifest — never a segment.
R2. **Per-record reads.** Telemetry correlation and MCP node/file tools read
    single records or file-groups by offset, without loading a segment into a
    parsed object graph larger than the answer.
R3. **Only the building worker materializes.** No API/coordinator/status/WAS
    process ever holds a full parsed CAS. The coordinator consumes manifests
    and affected sets.
R4. **Concurrent readers during a write.** A reader holding revision N is
    never torn by the writer publishing N+1. Append-or-replace semantics; no
    reader locks.
R5. **Compatibility.** Every stored monolith CAS remains readable (adapter);
    segments are adopted on the next save; no migration job over existing
    analyses is required for correctness.
R6. **Truth invariants hold.** Byte-stable output for the same revision and
    analyzer build (determinism doctrine); an intermediate/segmented CAS is
    explicitly incomplete via `layers_ready`, never silently partial
    (execution-architecture invariants 2/5).
R7. **Cost proportional to change.** Re-analysis writes only segments whose
    content changed; unchanged segments are shared by content hash.
R8. **Boring.** No new database daemon, no native-module ABI surface (this
    repo has a documented history of tree-sitter ABI friction), debuggable
    with `zstd -d | head`.

---

## 3. The segmented CAS

### 3.1 Layout

```
<analysis-storage>/<project-slug><track>/
  rev-<content-hash-12>/            # immutable once manifest is written
    manifest.json                   # tiny; the ONLY always-read file
    core.graph.seg                  # nodes(structural) + edges + entry/exit
    core.graph.idx                  # binary offset tables (by node-id, by file)
    calls.seg  + calls.idx          # method_calls, grouped by caller node
    facts.seg  + facts.idx          # analysis_facts, grouped by subject_id
    prose.seg  + prose.idx          # descriptions, comments, documentation,
                                    #   intents, domain_concepts, perspectives
    detail.seg + detail.idx         # per-node metadata/attributes/hierarchy/
                                    #   source snippets/markers
    derived.<name>.seg              # index(by_name/by_type), reachability_index,
                                    #   flow_graph, communities, call_chains,
                                    #   test_gaps, change_risks, …
  current -> rev-<hash>             # atomic pointer swap (symlink or pointer file)
  embeddings/                       # unchanged — already external (§1.1)
```

Segment file format: **zstd-framed record blocks** — records are JSON (same
serialization as today, unchanged meaning), grouped into blocks of ~256 KB
pre-compression, each block an independent zstd frame; the `.idx` sidecar is
a flat sorted binary table `(key-hash | block-offset | record-offset)`.
Point read = binary-search idx (mmap'd or read whole — idx files are ~1–2%
of segment size), decompress ONE frame, parse ONE record. Full-segment read =
stream frames. Whole-file `zstd -d` still works for humans (R8).

### 3.2 The manifest

`manifest.json` (~5–20 KB) carries everything the status class needs and the
integrity spine:

```jsonc
{
  "manifest_version": 1,
  "cas_version": "1.11.0",            // unchanged semantics
  "analyzer_build": "…", "analysis_id": "…", "analysis_timestamp": "…",
  "base_commit": "…", "branch": "…", "track": "main",
  "system": { /* the existing CASOutput.system block, verbatim */ },
  "counts": { "nodes": 54436, "edges": 61704, "method_calls": 23000, "facts": 41294 },
  "layers_ready": { /* existing shape; progressive availability lives HERE */ },
  "analysis_phases": [ /* existing shape — small */ ],
  "timings": { /* existing shape */ },
  "validation": { /* existing shape */ },
  "segments": {
    "core.graph": { "bytes": 26214400, "sha256": "…", "records": 54436,
                     "inputs_fingerprint": "…" },
    "derived.reachability_index": { "bytes": 9748480, "sha256": "…",
                     "derived": true, "inputs_fingerprint": "sha256-of-core.graph" },
    "…": {}
  }
}
```

- `sha256` per segment = integrity + content-addressed sharing (R7): a
  re-analysis whose `prose.seg` is byte-identical hard-links the previous
  revision's file instead of rewriting it.
- `inputs_fingerprint` on derived segments = the stage-fingerprint contract
  the speed program already established: a derived segment is valid iff its
  inputs' hashes match; otherwise it is rebuilt (never trusted, never
  silently missing — it reports as pending in `layers_ready`).
- The manifest IS the progressive-availability surface: an intermediate CAS
  under the execution architecture's S0–S6 model is a manifest whose
  `layers_ready` marks pending layers and whose corresponding segments are
  absent — explicitly incomplete, exactly invariant 2. **Stage artifacts and
  segments unify**: S1/S2 shards persist as `core.graph` partitions, S5 prose
  lands as `prose.seg`, S6 stamps `layers_ready.complete` and finalizes the
  manifest. The execution architecture's "persist stage artifacts by content
  hash" line and this store are one mechanism, not two.

### 3.3 Segment assignment (from the measured table)

| Segment | Contents | Specimen L bytes | Who reads it |
| --- | --- | ---: | --- |
| manifest | §3.2 | ~20 KB | everyone (status: ONLY this) |
| core.graph | nodes: id, name, type, level, level_name, file, location, parent, namespace, signature, structural_importance, is_test; edges (full); entry_points, exit_points, route_table | ~35–45 MB now; ~15–20 MB after wave-3 interning | graph tools, worker, partitioner |
| calls | method_calls | 52.6 MB | `get_method_calls`, call resolution, worker |
| facts | analysis_facts | 19.9 MB | fact tools, evaluate/validate surfaces |
| prose | comments, documentation, intents, domain_concepts, descriptions, perspectives, perspective_data | ~40 MB | description tools, enrichment writer |
| detail | per-node source, metadata, attributes, hierarchy, markers, analyzer blocks (`typescript-structure` etc.) | ~45 MB | `get_node` deep view, worker |
| derived.* | index(by_name/by_type), reachability_index, flow_graph, communities, call_chains, test_gaps, change_risks, data_lineage, architecture_summary | ~50 MB | the one tool each serves |

The hot structural core lands in the target band (tens of MB), and it is the
only segment most graph work touches.

### 3.4 Write path and concurrency (R4, R7)

1. Worker streams segments into `rev-<hash>.tmp/` **as stages complete** —
   no single 258 MB `JSON.stringify` ever exists (this alone retires the
   historical 126 s save-stage shape: the self-run's 7.7 s save becomes
   overlapped per-stage streaming writes).
2. Per segment: write → fsync → hash → record in the in-progress manifest.
   Unchanged-vs-previous segments hard-link (content hash equality).
3. Manifest written last, then `current` pointer swapped atomically (rename).
   Readers resolve `current` once per open; a handle opened on rev N reads
   immutable files even while N+1 publishes. Old revisions are GC'd when no
   handle lease (mtime-based, generous TTL) references them — the same
   pruning surface `prune_storage_artifacts` already owns.
4. Crash mid-write leaves a `.tmp` dir and an untouched `current` — invariant
   3 (durable, resumable, never partial-as-final) for free.

Post-save enrichment (prose) is the one in-place mutation today. Under
segments it becomes: write new `prose.seg` + new manifest into a new rev dir
where every *other* segment is a hard link — a kilobytes-of-prose update
costs kilobytes plus a manifest, not a 258 MB rewrite.

### 3.5 The read facade: `AnalysisHandle`

One new module (`apps/mcp-server/src/analysis-handle.ts` or analyzer-core
equivalent) that both storage formats hide behind:

```ts
interface AnalysisHandle {
  manifest(): AnalysisManifest;                    // O(manifest)
  node(id: string): CASNode | null;                // one idx probe + one frame
  nodesByFile(file: string): CASNode[];            // one idx range + few frames
  edgesFor(id: string, dir: 'in'|'out'|'both'): CASEdge[];
  segment<T>(name: SegmentName): Promise<T>;       // full named segment, lazy
  methodCalls(nodeId: string): CASMethodCall[];
  factsFor(subjectId: string): CASAnalysisFact[];
  // The ONE full materializer — worker/golden-snapshot/back-compat only:
  materialize(): Promise<CASOutput>;
}
openAnalysis(projectPath, opts): Promise<AnalysisHandle | null>
```

- **Monolith adapter (R5):** when `current` resolves to a legacy
  `*.json.zst`, the handle materializes once through the existing
  `loadedAnalysisCache` and serves every method from the in-memory object.
  Same API, old cost — correctness never depends on the new format.
- `query.ts` functions migrate `(cas: CASOutput, …)` →
  `(handle: AnalysisHandle, …)` mechanically in wave 2; until then a
  `handle.materialize()` shim keeps every tool working through wave 1.

---

## 4. Mechanism choice: why offset-indexed flat segments

| Criterion | Flat segments + idx + manifest | SQLite | LMDB |
| --- | --- | --- | --- |
| New dependency surface | none (zstd already shipped and shelled to; idx is plain binary) | native module (or WASM at ~2× cost); schema migrations become a product surface | native module + mmap semantics |
| Container/ops behavior | plain files on the existing volume; rsync/scp/backup trivially | WAL mode on bind-mounted volumes has documented durability caveats; needs busy-timeout tuning under the lane pool | map-size preallocation tuning; mmap on overlay/bind mounts is host-dependent |
| Concurrent readers during write (R4) | trivial — immutable rev dirs + atomic pointer swap; zero locks | good (WAL), but now the store has a locking model to reason about | good (MVCC), same caveat |
| Access pattern fit | exactly two patterns exist — "whole named segment" and "record by key" — a sorted offset table serves both optimally | general SQL buys nothing: nobody issues ad-hoc relational queries against a CAS revision | ordered KV fits, but so does the simpler thing |
| ABI risk | zero | real: this repo's tree-sitter history shows native-ABI friction is an ongoing tax (`klauro-analyzer-quality` finding) | same class |
| Debuggability (R8) | `zstd -d segment | head`; manifest is JSON | needs sqlite3 tooling in the container | needs mdb_dump |
| Determinism/byte-stability | writer controls every byte; hashes in manifest | page layout not byte-stable across versions | ditto |

**Decision: flat segments.** SQLite is the named runner-up; the revisit
trigger is concrete — if a future consumer genuinely needs ad-hoc multi-key
queries over CAS internals (not "read a slice", but real relational access
patterns arriving faster than we can add idx files), move *segments as-is*
into SQLite blobs+indexes; the manifest/handle contract above survives that
swap untouched, which is precisely why the facade exists.

mmap note: the idx files are small enough (1–2% of segment bytes) to read
whole; we take zero dependence on mmap behavior in containers. Node's plain
`fs.read` at explicit offsets is the entire I/O surface.

---

## 5. Throughput model — "hundreds of analyses"

Three multiplicative levers, all specced or shipped, composed here:

1. **Content-hash extraction cache** (per-file): the worker hooks already
   exist (`tree-sitter-ts-worker.ts` `loadCache/saveCache(contentHash)`,
   orchestrator `computeContentHash` keyed `${analyzer.id}_${contentHash}`) —
   the Codex execution-architecture lane owns making this a persistent
   cross-run store ("persist stage artifacts by content hash", its §Parallelism).
   This spec's contribution: the cache's natural home is the same
   content-addressed layout (`extract-cache/<analyzer-id>/<content-hash>`),
   GC'd by the same pruning surface. **Align, don't duplicate.**
2. **Affected-set incrementality** (765fc79f): `ReachabilityIndex.affectedSet`
   bounds which derived facts a change can invalidate.
3. **Segmented store** (this spec): unchanged segments are hard-linked, not
   rewritten; consumers never pay for what didn't change.

### 5.1 Per-job arithmetic (self-shape repo: 54k nodes, 258 MB monolith)

| Path | Today | Segmented + caches |
| --- | --- | --- |
| Cold analysis | parse 162.5 s + graph 43.2 s + save (258 MB stringify+zstd; 7.7 s best, 126 s incident) | parse unchanged (extraction cache empty) + streamed per-stage segment writes (save cost amortized into stages; no single giant stringify) |
| Re-analysis, 1-file edit | full re-parse or fragile incremental; full 258 MB rewrite; coordinator holds full previous CAS | 1 file parses (~10–50 ms); all other files hit the extraction cache by content hash; `affectedSet(changed)` bounds derived recompute; rewrite = core.graph delta + affected derived segments + manifest; unchanged segments hard-link. **Cost ∝ change: single-digit seconds** (the latency-budget gate's number, now with a mechanism) |
| Warm repo, no edit (freshness poll) | fingerprint check (cheap) but any consumer touch = full load | manifest read, ~KB |
| Status / health during a running job | competes with a 1.7 GB-transient loader on the same host | manifest read; the API tier never maps CAS bytes (R3) — health starvation is structurally impossible, not quota-protected |

### 5.2 Fleet arithmetic (6-core/8 GB box, 100 concurrent projects)

Memory:

- **Today:** any consumer touching K distinct analyses transiently costs
  K × ~6.5 × blob-size. Two 258 MB-class loads = ~3.4 GB + GC headroom — the
  measured incident band (1.2–5.9 GB). 100 projects with even occasional
  cross-project reads (WAS, telemetry, status pollers) cannot fit at any
  quota setting: the format is the ceiling.
- **Segmented:** API/status tier: 100 × manifest ≈ 100 × 20 KB = **2 MB**.
  Telemetry: idx probes, ~0 resident. MCP burst of 10 concurrent slice reads
  ≈ 10 × (frame + record) ≈ 10 × ~1 MB. The only large residents are the
  admitted build workers: 2 lanes × (core.graph working set + stage
  buffers) ≈ 2 × ~0.5–1 GB for the largest shapes. **Total < 3 GB with 5 GB
  headroom on the 8 GB box** — vs. impossible today.

CPU/throughput (hundreds of analyses/day is a *change-stream* workload, not
hundreds of cold runs):

- Cold: unchanged, ~1–3 min per repo, 2 lanes → ~40–100 cold analyses/day
  ceiling on this box; horizontal workers scale it (execution architecture's
  queue-depth scaling), and the extraction cache makes every *re*-cold of a
  known repo warm.
- Warm (the steady state): a commit touching f files costs
  O(f × parse + |affectedSet| × derived + changed-segment bytes). At
  f ≈ 1–5: seconds. A 2-lane box sustains **thousands of incremental
  analyses/day**; the queue holds only cold jobs. That is "hundreds of
  analyses" not as a queue-management problem but as a unit-economics fact.

WAS composition: N members × manifest+capability segments (~1–3 MB each)
instead of N × full CAS — a 17-member workspace refresh drops from
~17 × 1.7 GB transients (serialized by necessity today) to ~30 MB of reads.

---

## 6. What this spec does NOT change

- CAS *semantics*: `cas_version` continues to version the logical schema;
  records inside segments are the same JSON shapes `cas.types.ts` declares.
  This is a storage rearchitecture, not a schema redesign.
- The execution contract: completeness invariants, progressive layers, and
  determinism doctrine are inherited, not re-stated.
- The analyzer's in-worker object model: the worker still builds a full
  `CASOutput`-shaped graph in memory; it just streams it out per-stage.
- Embedding storage (already external) and the analysis-index sidecar
  (already the status fast path) — both are adopted as-is.

---

## 7. Migration waves

Parity oracle for every wave: `save_cas_golden_snapshot` /
`compare_cas_golden_snapshot` plus the full tool-surface dogfood sweep
(`npm run tool-surface-dogfood`) run against the same revision stored both
ways — **every tool answer byte-identical, monolith vs segmented**, and
segment bytes stable across two runs of the same input. Gates run on the VPS
(run-in-prod mandate), and each wave releases immediately when green
(always-be-releasing).

### Wave 0 — stop the bleeding at call sites (effort S; days)

- `analyzer.ts getAnalysis` (line ~1387) passes `preferCache: true` — the
  hottest read path currently opts out of the existing in-memory cache.
- Status commands/endpoints answer from `AnalysisEntry` +
  `getAnalysisFileFingerprint` + `.reanalyze-attempt.json` only; assert (test)
  that no status path calls `loadAnalysis`.
- **Kills:** the 20 s status hang and status-endpoint decompress incidents in
  their common case (cache-warm). Does NOT kill the class — cold processes
  and post-save invalidations still full-load. That death is wave 1's.
- Deletes: nothing yet. Pure call-site discipline, all behind existing tests.

### Wave 1 — manifest + segments + handle + adapter (effort M; the core)

- Segment writer in the save path (§3.4): per-stage streaming, hashes,
  hard-link sharing, atomic manifest swap. Written **alongside** the monolith
  (dual-write) during this wave.
- `AnalysisHandle` + monolith adapter (§3.5). Status/telemetry/semantic-search
  move to `manifest()`/`node()` reads. Everything else rides
  `materialize()` unchanged.
- Parity gate wired as a release gate.
- **Kills:** the telemetry-correlation full-load class (2.8 GB) and the
  status/health-starvation class (1.2 GB/20 s) *structurally* — these
  consumers no longer have a code path that can touch CAS bytes. Save-stage
  monolith stringify cost still exists (dual-write) but is no longer on the
  consumer path.
- Deletes: the telemetry resident-CAS cache (`ef4e29ac`'s mitigation becomes
  dead code); status-path `loadAnalysis` calls.

### Wave 2 — consumers to slices (effort M/L; the fan-out)

- `query.ts` surface migrates `(cas)` → `(handle)`; each tool declares the
  segments it reads (mechanical for ~80% of tools: node/file/edges/route
  lookups; the summary/overview tools read manifest + 1–2 segments).
- WAS composition consumes member manifests + capability/interface segments;
  its lookup maps become once-per-revision derived artifacts keyed by
  segment hash (closing its instance of the exhaustive-scan defect class).
- Reanalysis coordinator consumes previous *manifest* + affected sets; only
  the worker opens segments.
- Description enrichment writes `prose.seg` deltas (§3.4), never the blob.
- **Kills:** the coordinator+worker duplicate class (5.9 GB) and the WAS
  rebuild class; enrichment's 258 MB-rewrite-for-kilobytes write
  amplification.
- Deletes: `materialize()` calls from every non-worker consumer;
  `loadedAnalysisCache` shrinks to the adapter path.

### Wave 3 — encoding levers (effort M; independent, after 2)

- Interned string table per revision (node ids, file paths); edges and idx
  tables become integer/varint records: measured ceiling ~57 MB → ~2–3 MB on
  the edge segment alone; core.graph lands ~15–20 MB even on the 83k-node
  shape.
- `detail.seg` (source snippets, analyzer metadata blocks) becomes
  lazy-per-node everywhere (`get_node` deep view opts in explicitly).
- **Kills:** the heap-amplification class at its root — the residual big
  parses (worker rehydration of core.graph) shrink ~3–5× further.

### Wave 4 — monolith retirement (effort S; the deletion wave)

- Stop dual-writing the monolith once (a) parity gate has been green across
  two releases, (b) the corpus sweep reads every existing stored analysis
  through the adapter cleanly.
- The adapter remains permanently (R5 — old stored analyses stay readable);
  what dies is the monolith *write* path.
- Deletes: `writeCompressedJsonAtomic` for CAS bodies, `ZSTD_MAX_BUFFER` and
  the exec-zstd full-buffer read path for CAS bodies,
  `readJsonMaybeCompressed`'s role as the CAS reader (it survives for small
  JSON sidecars), the save-stage giant stringify.
- **Kills:** the 126 s-save class and the last full-load transients. After
  this wave, "a process OOM'd holding a CAS" is not a bug that can be
  written.

### Incident-class death map

| Incident (2026-07-20/21) | Root | Dies at |
| --- | --- | --- |
| status 1.2 GB / 20 s hang | full load for metadata | W0 (common case) → W1 (structural) |
| status endpoint full decompress | 2× loadAnalysis for a poll | W0 → W1 |
| telemetry flush 2.8 GB | full CAS for per-node lookups | W1 |
| health-check starvation | loaders competing on API host | W1 (R3) |
| coordinator+worker 5.9 GB duplicate | two full materializations per job | W2 |
| WAS map rebuilds | N× full member loads per compose | W2 |
| 126 s saves / giant stringify | monolithic serialize | W1 (off consumer path) → W4 (gone) |

---

## 8. Composition with the sibling specs

**`ANALYSIS-EXECUTION-ARCHITECTURE.md`:** the execution graph (S0–S6) needs
stage artifacts persisted by content hash and progressive availability of
completed layers — §3.2/§3.4 are the persistence mechanism for exactly that:
segments are stage artifacts, `layers_ready` in the manifest is the
progressive surface, and the "API never deserializes a CAS; workers build;
consumers query segments" boundary is R3. The extraction cache (its
parallelism section, the Codex lane's per-file cache hooks) shares this
spec's content-addressed layout and pruning surface (§5, lever 1) — one
store, two artifact kinds.

**`SPEC-MATHEMATICAL-INTELLIGENCE.md`:** every mathematical layer lands as a
`derived.*` segment with an `inputs_fingerprint` (reachability_index and
structural_importance already ship; communities, co-change, critical-path
follow) — rebuilt when inputs change, lazily read by their consumers, and no
longer a parse tax on consumers that don't ask (the 9.3 MB reachability index
stops costing status pollers anything). Its §C.1 standing rule ("the index is
the standard alternative to any full-graph scan") gets its storage-layer
counterpart here: **the handle is the standard alternative to any full-CAS
load** — new code that calls `materialize()` outside the worker/golden paths
is the same defect class and gets flagged in review. Workstream H (submodular
context selection) becomes cheap by construction: candidate facts arrive as
priced slices (bytes known from idx) rather than from a materialized graph.

---

## Appendix A — measurement method (reproducible)

Streaming byte-attribution: a ~100-line Node script walks the raw JSON bytes
tracking string/escape state and container depth, attributing each top-level
(or per-subtree, by key name) value span to its key — no `JSON.parse`, flat
memory. Specimen L (339 MB) scans in 2.4 s. Amplification measurement:
`readFileSync` + `JSON.parse` of the 86.7 MB specimen under `--expose-gc`,
RSS observed 564 MB (6.5×), read 210 ms + parse 288 ms. Specimens: two stored
production-path analyses from the local analysis store (`cas_version 1.11.0`,
analyzer builds 1.0.75/1.0.33): a 4.6k-file PHP/TS monorepo benchmark
specimen and the Klauro self-shape service specimen. Field tables in §Exec
and §1.2 are direct outputs of those scans.
