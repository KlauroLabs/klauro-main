# Security and Privacy: Data Inventory and Egress

This document is the authoritative answer to two questions for teams running Klauro on proprietary codebases:

1. What does Klauro persist on disk, and where?
2. What can leave the machine, and under exactly which configuration?

Everything below is verified against the current code. Implemented behavior and planned behavior are strictly separated.

## Default Local Connector Behavior

The customer product path is account-gated. The local connector can keep a
lightweight deterministic cache and in-flight context for MCP, but
shared CAS analysis (repo- and workspace-level), hosted AI enrichment, telemetry correlation, and
durable history live in the Klauro service. Local developer-only full analysis
exists for Klauro engineering and self-hosted evaluation, but it is not the
commercial default.

With no `.klaurorc`, no account token, no embedding API key, no S3 bucket
variables, and no explicit remote commands, Klauro makes **zero network calls**
and does not upload a repository. The connector cannot produce commercial
hosted value until it has an account token and analyzer URL. The following
NEVER leave the machine unless you explicitly run a remote sync/analyze path or
configure an egress provider:

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
| AI response cache | AI-generated description/interpretation **responses** keyed by prompt hash (prompts themselves are not stored). Entries written by this release carry the originating project slug and live in a per-project subdirectory; entries written by earlier releases sit unassociated in the cache root and cannot be attributed to a project after the fact. | `~/.klauro/ai-cache/<slug>/<sha>.json` (current); `~/.klauro/ai-cache/<sha>.json` (pre-association legacy) | TTL-based (default 24 h metadata; files until pruned or purged) |
| Proposal previews | Plan text, optional diff text, proposed file contents, baseline/proposed CAS, comparisons | `proposal-previews/<id>/` | Until deleted |
| Workspace graphs, benchmark reports, gauntlet workspaces | Cross-repo link metadata; benchmark/proof artifacts (may contain code copies of *benchmark fixture* repos) | `workspace-graphs/`, `agentic-benchmarks/`, `~/.klauro/<benchmark dirs>` | Benchmarks pruned at 50 reports / 256 MB |
| Analysis run log | Per-run diagnostics: project path/name, phase timings, analyzer IDs with node/edge counts, AI call outcomes (provider names, status, reason — never prompt contents or responses), warning/error codes and messages (truncated, max 50/run), failure messages with top stack frames. No code text. | `~/.klauro/logs/analysis-runs.jsonl` (or `KLAURO_LOG_DIR`) | Last 50 runs, max 50 MB (`KLAURO_RUN_LOG_MAX_RUNS`/`KLAURO_RUN_LOG_MAX_BYTES`); disable with `KLAURO_RUN_LOG=false` |
| Support bundle (`klauro support-bundle`) | A `.tar.gz` created explicitly for support: environment snapshot (secret env values redacted to `[set]`), the analysis run log, analysis metadata (versions, counts, phases, contributions, `analysis_errors`) without nodes/edges/source text, MCP tool-call log (tool names + timestamps) if enabled. The command prints what is included and excluded. | Path you choose (default: `klauro-support-bundle-<timestamp>.tar.gz` in the working directory) | Until deleted; never uploaded automatically |

### Git metadata: exactly what is collected

The git analyzer runs `git log --format=%H|%an|%aI|%s` (hash, author **name**, date, subject) in-process to compute churn metrics. **Author emails are never read** (`%ae` is not used). Author names and commit subjects are used only in memory for aggregate metrics (unique-author counts, bug-fix-rate pattern matching on subjects); what persists in the CAS is counts, rates, and dates — not names, not messages. The only git identifier persisted is the commit hash (incremental state and change history).

### File paths

As of this release the analyzer relativizes absolute project paths throughout the CAS output before it is stored (`relativizeProjectPaths`, applied in the orchestrator finalize phase). `system.root_path` intentionally remains absolute so tools can resolve relative paths back to files. Residual absolute paths can still appear inside free-text analyzer error messages and inside raw code snippets (code text is never rewritten). Analyses stored before this release retain absolute paths until re-analyzed. The storage index (`index.json`) keys analyses by absolute project path by design.

## Egress Audit: Every Code Path That Can Make a Network Call

Ordered worst-first by payload sensitivity.

### 1. Hosted analyzer source paths — account-gated

- Code: `apps/mcp-server/src/remote-sync-client.ts`, `remote-source.ts`
- Active when: `.klaurorc` sets `analyzer.mode: "remote"`, or you run `klauro remote-analyze` / `remote-sync`, or MCP tools `analyze_codebase_remote` / `sync_codebase_remote`. Local `klauro index` builds a manifest and in-flight context but does not publish durable shared project analysis by itself. All product connector commands require a Klauro account token with an active or trialing entitlement unless `KLAURO_CONNECTOR_AUTH_DISABLED=true` is explicitly set for Klauro development.
- Connected-provider payload: when a Git provider repo is connected, Klauro's hosted service pulls and analyzes selected-branch commits on the VPS/cloud side. The developer laptop sends no full source snapshot for those provider-triggered analyses.
- Local committed-source payload: full filtered committed source snapshot (file contents + sha256 hashes + relative paths), plus project name, absolute project root path, Git remote/provider, branch, commit hash, transfer recommendation, and project/workspace IDs. This creates the same shared project revision as provider checkout analysis.
- In-flight payload: dirty-tree or branch/session contexts (changed file contents, deleted paths, `git diff` against HEAD, HEAD commit hash), plus project name, absolute project root path, Git remote/provider, branch, base commit, dirty flag, transfer recommendation, project/workspace IDs, and session/author metadata when available. This is provisional context, not durable project truth. Product policy may scope it to one developer/device or share it with authorized workspace members for deduplication and conflict avoidance.
- Filtering: `.klaurorc` include/exclude, `.klauroignore`, safe defaults (`.env*`, `*.pem`, `*.key`, `secrets/**`, dependency/build dirs), 1 MB per-file cap. JSON request bodies above 1 KB are gzip-compressed in transit.
- Destination: `serverUrl` from config / `--server-url` / `KLAURO_ANALYZER_URL` (defaults to Klauro Cloud).
- Controls: `policy.allowRemoteAnalyzer=false` blocks all remote calls; `policy.allowedAnalyzerHosts` pins hosts; `policy.requireSelfHosted=true` blocks non-self-hosted servers; `upload.sendGitDiff=false`, `upload.sendDeletedPaths=false`, `upload.allowDirtyTreeSync=false`. These policies are enforced on every remote call regardless of configured mode. Preview with `klauro upload-manifest`; build in-flight context with `klauro index --dirty-tree`.
- Documented: `docs/mcp/REMOTE-ANALYZER.md`, `docs/mcp/SECURITY-REVIEW.md`.

### 2. Hosted AI providers — send structural facts and bounded code excerpts (server-side only)

- Code: `packages/analyzer-core/src/ai/providers/{openai,claude}-provider.ts`, `ai-service.ts`; callers in `analyzer/core/orchestrator.ts` and `apps/mcp-server/src/description-enrichment.ts`
- Active when the hosted analyzer service has `DEEPINFRA_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, hosted `OPENAI_BASE_URL`, or `AZURE_OPENAI_*` configured. Customer laptops do not need model runtimes or provider API keys. Loopback `OPENAI_BASE_URL`, `OLLAMA_BASE_URL`, and `LOCAL_OPENAI_BASE_URL` are ignored by the product AI configuration.
- Payload classes (exact):
  - **Analysis-time interpretation pass** (`orchestrator.applyAIInterpretation` and element-description batches): structural facts only — system name, framework names, entry-point type counts, entity names, external service names, capability names, domain concept names, plus a short *derived* summary of project text (synthesized from package.json description / README / agent guide files — not raw excerpts). No code text.
  - **On-demand element descriptions** (`generate_element_description` MCP tool): the above context plus a **code excerpt of the target element, capped at 6,000 characters** (`readSourceExcerpt`), edge names, and the element's file path.
  - **AI code-analysis prompts** (`ai-prompts.ts`, used by legacy `ai-analyzer` paths): when a caller supplies code, it is truncated to **4,000 characters** (`truncateCode`).
- Destinations: `api.openai.com` / Azure endpoint / custom `baseURL`, or `api.anthropic.com`.

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

### 5. Installable runtime telemetry SDK — sends runtime events (opt-in by embedding the SDK)

- Code: `packages/klauro-sdk-js` (published as `@klauro/telemetry`) and its Python counterpart `packages/klauro-sdk-py`. This is the SDK `get_runtime_sdk_package` / `get_runtime_event_contract` generate install and init snippets for.
- Active when: a customer application explicitly constructs the client with `projectId` (+ `apiKey` for hosted mode). Nothing in Klauro's analyzer/MCP/CLI initializes it on a customer's behalf.
- Payload: `CasRuntimeEvent` batches (`{ events: [...] }`) — request/error/exit/log/custom events carrying, when the caller supplies them, direct correlation ids (`static_id`, `node_id`, `entry_point_id`, `exit_point_id`, `call_chain_id`) plus trace/span ids, route/method/path, status/duration, and error message + stack trace.
- Destination: `config.endpoint`, defaulting to `https://mcp.klauro.com`, path `/api/telemetry/runtime-events/:projectId` — implemented in `apps/mcp-server/src/remote-analyzer-service.ts`, which authorizes the request and routes the batch (via `mapSdkEvent`) into the same ingest/correlation path as the local `ingest_telemetry` MCP tool. Events land in `~/.klauro/analyses/<slug>/ingested-telemetry/` on the receiving side, same retention as the local path above.
- There is also an older, **unpublished** client at `packages/analyzer-core/src/sdk/javascript/klauro-sdk.ts` (`KlauroSDK`) — excluded from this package's TypeScript build (`src/sdk/**/*` is in `tsconfig.json`'s `exclude`), not imported by anything else in this repo, and not what any install/init generator emits. It previously pointed at a nonexistent host (`api.klauro.io`) and route (`/api/telemetry/ingest`) with an envelope shape the backend never parsed — that was a real defect (a document like this one describing egress that could not happen), now corrected to POST to the same real route and body shape as `@klauro/telemetry` above, so that anyone who does end up using or copying it gets a working request rather than a silent failure. It still offers heavier auto-instrumentation (raw `http`/`https` patching, `console`/timer/DB interceptors) that `@klauro/telemetry` deliberately does not; if that auto-instrumentation is ever wanted for real customers it should be folded into `@klauro/telemetry` as an opt-in module, not shipped as a second competing package. Nothing currently builds, exports, publishes, or references this file as an integration path — treat it as an internal reference implementation, not a supported product surface.

### 6. GitHub App import — planned, no egress implemented

- Code: `apps/mcp-server/src/github-import.ts` builds an import *plan* only; it performs no HTTP calls. There is no Octokit/fetch usage. Documented as the future hosted-import path.

### Not egress (for completeness)

- `apps/mcp-server/src/remote-analyzer-service.ts` is the *server side* (inbound listener) of remote mode; it binds locally/where you deploy it.
- Benchmark/gauntlet scripts (`agent-*`, `*-benchmark`) may invoke `claude`/`codex` CLIs against configured repos; these are developer proof tools, not customer-facing analysis paths.
- `zstd` and `git` invocations are local subprocesses.

## Cloud-AI Opt-In Semantics (Summary)

Configuring an AI provider on the hosted analyzer opts the Klauro service into
sending, per analysis or per description request: structural metadata (names of
files, functions, entities, capabilities, frameworks, external services), short
derived project-text summaries, and — only for on-demand element descriptions —
a code excerpt of the targeted element bounded at 6,000 characters. Klauro never
sends whole files or the full repository to AI providers. Local connectors do
not run AI enrichment.

## Deletion Story: Fully Purging a Project

The supported path is the CLI:

```bash
klauro purge /path/to/repo
```

This removes, for that project: the stored CAS analysis (`<slug>.json` / `.json.zst` / `.json.br`), the per-project directory (snapshots, incremental state, file cache, embeddings, change history, element descriptions, ingested telemetry, runtime observations, golden snapshot), the project's `index.json` entry, the project's records in the analysis run log (`~/.klauro/logs/analysis-runs.jsonl`), and the project's AI response cache subdirectory (`~/.klauro/ai-cache/<slug>/`).

**Known limitation — pre-association AI cache entries.** AI cache entries written before this release live unassociated at the cache root (`~/.klauro/ai-cache/<sha>.json`) with no project attribution, so a per-project purge cannot identify which of them describe the purged project. `klauro purge` reports how many such entries remain and how to remove them:

```bash
klauro purge /path/to/repo --all-ai-cache   # also deletes the entire shared AI cache
```

Entries written by this release are project-associated, so for projects analyzed only with this release the per-project purge is complete on its own.

The manual equivalent of the per-project purge, if you prefer raw commands:

```bash
rm -rf ~/.klauro/analyses/<slug> ~/.klauro/analyses/<slug>.json.zst ~/.klauro/analyses/<slug>.json ~/.klauro/analyses/<slug>.json.br
rm -rf ~/.klauro/ai-cache/<slug>
# Remove the project's entry from index.json (keyed by absolute project path),
# and the project's lines from ~/.klauro/logs/analysis-runs.jsonl.
# Pre-association ai-cache entries at the cache root are not attributable; remove
# them all with: rm -rf ~/.klauro/ai-cache
```

To purge everything Klauro has ever stored locally, including all AI caches, logs, and benchmark artifacts:

```bash
klauro purge --all        # equivalent to rm -rf ~/.klauro, with confirmation
```

Purging data does not reverse the installation itself. `klauro uninstall` removes the Claude Code MCP registration and the Klauro operating-loop block from CLAUDE.md files written by `klauro install`.

If you used opt-in egress, local deletion does not delete remote copies: remote analyzer server storage, S3 artifact buckets, AI provider/data-retention policies, and pgvector rows must be purged on those systems. Hosted retention controls (delete project / delete uploaded source / retention periods / audit trail) are **planned** — see `docs/mcp/SECURITY-REVIEW.md`.

## Implemented vs Planned

Implemented: local connector/cache behavior, path relativization in stored CAS,
remote analyzer with policy gates, account entitlement checks, upload manifests,
hosted AI opt-in with bounded prompts, local/file embeddings default with opt-in
Voyage API, local telemetry ingestion with 14-day retention, S3 mirroring behind
env vars.

Planned (not active in this release): hosted telemetry ingestion endpoint (`api.klauro.io`), GitHub App import execution, change-history author/commit-message capture, hosted retention/deletion controls, SOC 2 program items listed in the security context.
