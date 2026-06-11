# Security and Privacy: Data Inventory and Egress

This document is the authoritative answer to two questions for teams running Klauro on proprietary codebases:

1. What does Klauro persist on disk, and where?
2. What can leave the machine, and under exactly which configuration?

Everything below is verified against the current code. Implemented behavior and planned behavior are strictly separated.

## Local-Only Guarantee (Default Configuration)

With no `.klaurorc`, no AI provider API keys, no embedding API key, no S3 bucket variables, and no explicit remote commands, Klauro makes **zero network calls**. Analysis runs locally (`analyzer.mode` defaults to `local`), embeddings use the local hash provider (`klauro-local-hash-v1`), and all artifacts are written under `~/.klauro/` (or `KLAURO_STORAGE_PATH`). Specifically, the following NEVER leave the machine with default config:

- Source code text (including `node.source.raw` snippets stored in the CAS)
- File paths and directory names
- Git history, commit hashes, author names
- The CAS graph, snapshots, incremental state, embeddings, telemetry observations

There is no background phone-home, crash reporting, or usage analytics anywhere in the analyzer or MCP server.

## Data Inventory: What Is Stored On Disk

All paths are relative to the storage root: `~/.klauro/analyses/` unless `KLAURO_STORAGE_PATH` is set. `<slug>` is `<project-basename>-<sha256(project-path)[0:12]>`.

| Artifact | Contents | Location | Retention |
|---|---|---|---|
| Analysis index | Project absolute paths, names, frameworks, node/edge counts, timestamps | `index.json` | Until project entry deleted |
| CAS analysis | Full relationship graph: node names, qualified names, signatures, **code snippets** (`node.source.raw`, capped at 2,000 chars per node; omitted entirely above 10,000 nodes), file paths (project-relative; `system.root_path` stays absolute as the resolution anchor), doc comments, TODO/FIXME text, entry/exit points, **sensitive-field NAMES by design** (data entity field names, security boundary mechanisms — never field values), architectural intent, idioms with code examples | `<slug>.json.zst` | Overwritten on each analysis |
| Snapshots (time travel) | Full copies of past CAS outputs (same contents as above) | `<slug>/snapshots/snapshot-*.json.zst` | Last 10 (`KLAURO_MAX_SNAPSHOTS`), max 512 MB/project (`KLAURO_MAX_SNAPSHOT_BYTES`) |
| Incremental state | Per-file relative paths, content hashes (sha256 prefix), mtimes, node/edge IDs, imported files, exported symbol names. No file contents. | `<slug>/incremental-state.json` | Overwritten; discarded on version mismatch |
| File cache | Per-file analysis results keyed by content hash (nodes/edges for that file, including raw snippets) | `<slug>/file-cache/<hash>.json` | Until `clearFileCache` / manual delete |
| Embeddings | Binary vectors plus manifest (node IDs, doc hashes). The embedded *text* (which includes code) is not stored — only vectors. | `<slug>/embeddings/index.bin`, `manifest.json` | Overwritten per analysis |
| Change history | Change IDs, timestamps, git commit **hash**, changed node/file lists, impact analysis. `gitCommitMessage`/`author` fields exist in the type but are **not populated** (planned). | `<slug>/change-history.json` | Last 1,000 entries |
| Element descriptions (AI enrichment out-of-band store) | AI-generated description text, target IDs/names/files, fingerprints. No code text. | `<slug>/element-descriptions.json` | Until invalidated/deleted |
| Ingested telemetry | Runtime events you POST in via MCP: routes, status codes, durations, **error messages and stack frames** (file/line/function), service/env names, custom attributes | `<slug>/ingested-telemetry/<YYYY-MM-DD>.json` | 14 days, max 5,000 events/day |
| Runtime observations (simulated + legacy) | Same event shape as above | `<slug>/runtime-observations.json` | Last 5,000 |
| Golden snapshot | A pinned CAS comparison snapshot | `<slug>/cas-golden-snapshot.json` | Until replaced |
| AI response cache | AI-generated description/interpretation **responses** keyed by prompt hash (prompts themselves are not stored) | `~/.klauro/ai-cache/<sha>.json` | TTL-based (default 24 h metadata; files until pruned) |
| Proposal previews | Plan text, optional diff text, proposed file contents, baseline/proposed CAS, comparisons | `proposal-previews/<id>/` | Until deleted |
| Workspace graphs, benchmark reports, gauntlet workspaces | Cross-repo link metadata; benchmark/proof artifacts (may contain code copies of *benchmark fixture* repos) | `workspace-graphs/`, `agentic-benchmarks/`, `~/.klauro/<benchmark dirs>` | Benchmarks pruned at 50 reports / 256 MB |

### Git metadata: exactly what is collected

The git analyzer runs `git log --format=%H|%an|%aI|%s` (hash, author **name**, date, subject) in-process to compute churn metrics. **Author emails are never read** (`%ae` is not used). Author names and commit subjects are used only in memory for aggregate metrics (unique-author counts, bug-fix-rate pattern matching on subjects); what persists in the CAS is counts, rates, and dates — not names, not messages. The only git identifier persisted is the commit hash (incremental state and change history).

### File paths

As of this release the analyzer relativizes absolute project paths throughout the CAS output before it is stored (`relativizeProjectPaths`, applied in the orchestrator finalize phase). `system.root_path` intentionally remains absolute so tools can resolve relative paths back to files. Residual absolute paths can still appear inside free-text analyzer error messages and inside raw code snippets (code text is never rewritten). Analyses stored before this release retain absolute paths until re-analyzed. The storage index (`index.json`) keys analyses by absolute project path by design.

## Egress Audit: Every Code Path That Can Make a Network Call

Ordered worst-first by payload sensitivity.

### 1. Remote analyzer mode — sends source code (explicit opt-in)

- Code: `apps/mcp-server/src/remote-sync-client.ts`, `remote-source.ts`
- Active when: `.klaurorc` sets `analyzer.mode: "remote"`, or you run `klauro remote-analyze` / `remote-sync`, or MCP tools `analyze_codebase_remote` / `sync_codebase_remote`. **The default mode is `local`; plain `klauro analyze` and the MCP `analyze_codebase` tool never upload anything.**
- Payload: full filtered source snapshot (file contents + sha256 hashes + relative paths), or dirty-tree packets (changed file contents, deleted paths, `git diff` against HEAD, HEAD commit hash), plus project name, absolute project root path, and project/organization IDs. Filtering: `.klaurorc` include/exclude, `.klauroignore`, safe defaults (`.env*`, `*.pem`, `*.key`, `secrets/**`, dependency/build dirs), 1 MB per-file cap.
- Destination: `serverUrl` from config / `--server-url` / `KLAURO_ANALYZER_URL` (defaults to `http://127.0.0.1:8787`, i.e., loopback).
- Controls: `policy.allowRemoteAnalyzer=false` blocks all remote calls; `policy.allowedAnalyzerHosts` pins hosts; `policy.requireSelfHosted=true` blocks non-self-hosted servers; `upload.sendGitDiff=false`, `upload.sendDeletedPaths=false`, `upload.allowDirtyTreeSync=false`. These policies are enforced on every remote call regardless of configured mode. Preview with `klauro upload-manifest`.
- Documented: `docs/mcp/REMOTE-ANALYZER.md`, `docs/mcp/SECURITY-PACKET.md`.

### 2. Cloud AI providers — send structural facts and bounded code excerpts (opt-in via API key)

- Code: `packages/analyzer-core/src/ai/providers/{openai,claude}-provider.ts`, `ai-service.ts`; callers in `analyzer/core/orchestrator.ts` and `apps/mcp-server/src/description-enrichment.ts`
- Active when: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is set (or `OPENAI_BASE_URL`/`LOCAL_OPENAI_BASE_URL`/`AZURE_OPENAI_*` point at a server you choose). No key, no calls. `KLAURO_AI_INTERPRETATION=false` disables the analysis-time pass even with a key.
- Payload classes (exact):
  - **Analysis-time interpretation pass** (`orchestrator.applyAIInterpretation` and element-description batches): structural facts only — system name, framework names, entry-point type counts, entity names, external service names, capability names, domain concept names, plus a short *derived* summary of project text (synthesized from package.json description / README / agent guide files — not raw excerpts). No code text.
  - **On-demand element descriptions** (`generate_element_description` MCP tool): the above context plus a **code excerpt of the target element, capped at 6,000 characters** (`readSourceExcerpt`), edge names, and the element's file path.
  - **AI code-analysis prompts** (`ai-prompts.ts`, used by legacy `ai-analyzer` paths): when a caller supplies code, it is truncated to **4,000 characters** (`truncateCode`).
- Destinations: `api.openai.com` / Azure endpoint / custom `baseURL`, or `api.anthropic.com`.
- Local alternatives (no cloud egress): `OLLAMA_BASE_URL` (local Ollama), `AI_LOCAL_ENABLED=true` (in-process transformers model — note: the model itself is **downloaded from the Hugging Face hub on first use**, which is a network call that sends no project data).

### 3. API embedding provider — sends embedding documents including code (opt-in via config + key)

- Code: `packages/analyzer-core/src/analyzer/embedding/api-embedding-provider.ts`, document text composed in `embedding-document.ts`
- Active when: `.klaurorc` sets `embedding.provider: "api"` AND the env var named by `embedding.apiKeyEnv` (default `KLAURO_EMBEDDING_API_KEY`) is set. **Default provider is `local`** (deterministic hash embeddings, no network).
- Payload: per-node documents containing type, qualified name, signature, tags, doc comments, and **raw code** (`node.source.raw`), each truncated to `embedding.maxDocumentChars` (default 8,000).
- Destination: `https://api.voyageai.com/v1/embeddings` (hardcoded).
- Related: `embedding.store: "pgvector"` sends vectors + node IDs (no code) to the Postgres at the env var named by `embedding.databaseUrlEnv`; only active when that env var is set.

### 4. Proposal-preview S3 mirroring — sends plans, diffs, and CAS (opt-in via env)

- Code: `apps/mcp-server/src/s3-artifacts.ts`, called from `storage.saveProposalPreviewArtifact`
- Active when: `KLAURO_PROPOSAL_ARTIFACT_BUCKET` or `KLAURO_ARTIFACT_BUCKET` is set. Unset (default) = no-op.
- Payload: proposal plan markdown, diff text, proposed file contents, baseline/proposed CAS JSON (which includes code snippets), comparison and visualization JSON.
- Destination: your configured S3 bucket (AES256 server-side encryption requested).

### 5. Runtime telemetry SDK — sends runtime events (opt-in by embedding the SDK)

- Code: `packages/analyzer-core/src/sdk/javascript/klauro-sdk.ts` (legacy SDK; not part of the analyzer or MCP server runtime)
- Active when: a customer application explicitly constructs the SDK with `projectId` + `apiKey`. Nothing in Klauro's analyzer/MCP/CLI initializes it.
- Payload: traces, metrics, error reports (message + stack trace), runtime events; metadata includes SDK version, Node version, `HOSTNAME` env value, and environment name.
- Destination: `config.endpoint`, defaulting to `https://api.klauro.io` (path `/api/telemetry/ingest`). **Planned/aspirational endpoint — the hosted ingestion service is not part of this release.** The implemented telemetry path is local-only: MCP `ingest_telemetry` writes to `~/.klauro/analyses/<slug>/ingested-telemetry/` and never forwards anywhere.

### 6. GitHub App import — planned, no egress implemented

- Code: `apps/mcp-server/src/github-import.ts` builds an import *plan* only; it performs no HTTP calls. There is no Octokit/fetch usage. Documented as the future hosted-import path.

### Not egress (for completeness)

- `apps/mcp-server/src/remote-analyzer-service.ts` is the *server side* (inbound listener) of remote mode; it binds locally/where you deploy it.
- Benchmark/gauntlet scripts (`agent-*`, `*-benchmark`) may invoke `claude`/`codex` CLIs against configured repos; these are developer proof tools, not customer-facing analysis paths.
- `zstd` and `git` invocations are local subprocesses.

## Cloud-AI Opt-In Semantics (Summary)

Setting an AI provider API key opts you into sending, per analysis or per description request: structural metadata (names of files, functions, entities, capabilities, frameworks, external services), short derived project-text summaries, and — only for on-demand element descriptions — a code excerpt of the targeted element bounded at 6,000 characters. Klauro never sends whole files or the full repository to AI providers. To use AI features without cloud egress, point `OPENAI_BASE_URL`/`OLLAMA_BASE_URL` at a self-hosted model or set `AI_LOCAL_ENABLED=true`.

## Deletion Story: Fully Purging a Project

All local state for one project (everything: CAS, snapshots, caches, embeddings, telemetry, descriptions):

```bash
# 1. Remove the per-project directory and analysis files
rm -rf ~/.klauro/analyses/<slug> ~/.klauro/analyses/<slug>.json.zst ~/.klauro/analyses/<slug>.json ~/.klauro/analyses/<slug>.json.br
# 2. Remove the project's entry from the index (or delete the index; it is rebuilt)
#    index.json maps absolute project paths to entries.
```

To purge everything Klauro has ever stored locally, including AI caches and benchmark artifacts:

```bash
rm -rf ~/.klauro
```

If you used opt-in egress, local deletion does not delete remote copies: remote analyzer server storage, S3 artifact buckets, AI provider/data-retention policies, and pgvector rows must be purged on those systems. Hosted retention controls (delete project / delete uploaded source / retention periods / audit trail) are **planned** — see `docs/mcp/SECURITY-PACKET.md`.

## Implemented vs Planned

Implemented: local analysis default, path relativization in stored CAS, remote analyzer with policy gates and upload manifests, cloud AI opt-in with bounded prompts, local/file embeddings default with opt-in Voyage API, local telemetry ingestion with 14-day retention, S3 mirroring behind env vars.

Planned (not active in this release): hosted telemetry ingestion endpoint (`api.klauro.io`), GitHub App import execution, change-history author/commit-message capture, hosted retention/deletion controls, SOC 2 program items listed in the security packet.
