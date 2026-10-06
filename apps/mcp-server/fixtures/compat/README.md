# Version compatibility fixtures

## testing-utilities-net-1.10.0.json

A real stored analysis artifact, not a synthetic one.

- Provenance: produced by a cas_version 1.10.0 (pre-pillar) analyzer build on 2026-06-09
  against `/Users/michaelshattuck/dev/soon/testing-utilities-net`, a small C# testing
  utilities library. Taken verbatim from the local store at
  `~/.klauro/analyses/testing-utilities-net-aac217d5bafe.json.zst` and decompressed
  (zstd decompression is lossless; no fields were trimmed, the artifact was already
  small at 11 nodes / 10 edges / 1 entry point, ~80KB of JSON).
- Why it exists: `version-compat.test.ts` previously exercised version handling only
  against synthesized analyses. The 1.10.0 line is the one historical version real
  stores hold (VERSIONING.md notes its pillar fields are ambiguous in the wild), so the
  load path, classification, core-tool degradation, and pillar-tool version notices are
  tested against this real file.
- Shape notes: contains `codebase_idioms`, `embedding_index`, `flow_graph`, and
  `analysis_facts`, but none of the 1.11.0 pillar fields (`entry_point_flows`,
  `paradigm_conformance`, `data_lineage`, `product_map`), making it a genuine
  `older-compatible` artifact under a 1.11.0 server.

Do not regenerate or "fix up" this file; its value is that it is exactly what a
pre-1.11 build wrote to disk.
