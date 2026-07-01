# Klauro Product Runtime Budget

Klauro's proof gauntlet is allowed to be heavy. The customer-facing product is not.

The product architecture is split into three separately managed paths. These
paths are implementation and deployment responsibilities; customers should
experience one Klauro analysis flow.

| Path | Purpose | Weight expectation |
| --- | --- | --- |
| Thin local client / MCP | Account-gated agent entrypoint, commit/source packaging, in-flight context packaging, cache lookup, compact agent-context retrieval | Small, fast, near-idle when unused |
| Hosted analyzer workers | Shared project CAS/WAS analysis, language/framework/library analyzers, AI enrichment, embeddings, telemetry correlation, commit history | Heavy, server-side, horizontally scalable |
| Gauntlet / evaluation tooling | Competitor benchmarks, copied repos, live trials, 100-repo proof, quality reports | Heavy by design, never shipped as product runtime |

## Source Handling

Klauro has one shared project truth: analyzed revisions for selected branches.
Those revisions can be created from connected Git providers or from signed-in
local CLI submissions.

| Path | What it means | Where analysis runs | Local machine role |
| --- | --- | --- | --- |
| Local commit submission | The customer signs in, installs Klauro, runs `klauro init`, picks a branch, commits locally, and submits the committed tree to the hosted project. If a Git remote is detected, Klauro recommends connecting it but does not require it. | Klauro-hosted analyzer workers | Source packaging, manifest review, compression, commit submission |
| Connected Git provider | The customer creates a workspace/project in Klauro, connects the Git provider repo, selects a branch, and Klauro analyzes each pushed commit on that branch. | Klauro-hosted analyzer workers | Login, MCP, cache reads, optional pre-push commit submission |
| Self-hosted | The customer runs the same analyzer service inside their own network. | Customer-hosted analyzer service | Same connector flow, pinned to the customer's analyzer host |

Both hosted paths converge to the same project state:

```text
project + selected branch + commit SHA/source revision -> shared CAS/WAS analysis
```

Connecting a Git provider is automation and verification, not a different
analysis product. It lets Klauro re-run automatically on selected-branch pushes
and verify submitted commits against provider history. Local commit submission
lets a team share analyzed revisions before a provider is connected, or before a
commit has been pushed.

When `klauro init` runs in an outer folder and Klauro detects multiple child Git
repositories or existing Klauro project configs, the CLI/API should recommend
workspace setup with those child projects attached. A workspace cannot contain
another workspace.

## Shared Revisions And Local Working Copies

Klauro's commercial source of truth is hosted:

- The UI shows shared project and workspace analysis for analyzed commits on selected branches.
- With a connected Git provider, the hosted service re-analyzes selected-branch pushes automatically.
- Without a connected Git provider, a signed-in CLI can submit committed local source for the same shared project analysis.
- Uncommitted changes are never durable project truth.

In-flight context exists so Claude, Codex, Cursor, humans, and other agents can
understand active edits before Git has a durable commit or push. It captures
repo identity, Git remote, branch, base commit, dirty status, session/author
metadata when available, file hashes, filtered changed files, deleted paths, and
optional diff text. That context is provisional and can be scoped to the
signed-in developer/device or shared with authorized workspace members so teams
can prevent duplicate work, likely merge conflicts, overlapping migrations, and
stale assumptions before the work becomes project truth.

```text
durable project analysis + incoming revisions + in-flight context + task = agent context
```

In-flight context is therefore allowed and useful, but it must always be marked
as provisional and kept separate from accepted project truth.

## Account And Subscription Gate

Every useful local connector action requires a Klauro account and active/trialing
entitlement:

- `klauro index`
- `klauro remote-sync`
- `klauro remote-analyze`
- MCP calls that need hosted context or in-flight context

Diagnostics such as `klauro doctor`, install help, and manifest dry-runs can
remain available for setup, but the local connector should not provide useful
agent context without an authenticated Klauro account. The local connector reads
`KLAURO_ACCOUNT_TOKEN` / `KLAURO_AUTH_TOKEN` and validates it against
`/api/me`.

## AI Placement

AI enrichment is hosted-only in the product architecture. Customer machines do
not need DeepInfra, OpenAI, Anthropic, Ollama, LM Studio, or local model keys.

Allowed locally:

- deterministic commit/source packaging
- Git and dirty-tree state
- source filtering and secret exclusion
- local cache reads
- compact MCP context serving

Not allowed locally in the product path:

- AI descriptions
- primary capability/narrative enrichment
- workspace narrative generation
- local model inference
- embedding-heavy semantic enrichment
- authoritative CAS/WAS generation as the default customer flow

## Runtime Budgets

The local product path should meet these default budgets:

| Budget | Default | Enforcement |
| --- | ---: | --- |
| Bundled MCP/runtime `dist/` | 75 MB | `npm run product-footprint` fails when exceeded |
| Local install estimate | 350 MB | `npm run product-footprint` fails when exceeded |
| Local Klauro storage warning | 512 MB | `npm run product-footprint` warns when exceeded |
| MCP initialize latency | 600 ms | `klauro doctor` / install self-check |
| Idle CPU | effectively 0% | no analyzer loop or watcher unless explicitly started |

The install target is intentionally stricter than the development repo. The development checkout can contain `node_modules`, native grammars, fixtures, gauntlet outputs, and local analysis corpora. The shipped local product must not depend on those artifacts.

Environment overrides:

```bash
KLAURO_PRODUCT_BUNDLE_MAX_BYTES=78643200
KLAURO_PRODUCT_INSTALL_MAX_BYTES=367001600
KLAURO_PRODUCT_STORAGE_WARN_BYTES=536870912
KLAURO_SMOKE_MAX_STARTUP_MS=600
```

## Packaging Rules

The local package may ship:

- `dist/` bundled MCP server, CLI, and analysis worker entrypoints.
- Installer/uninstaller scripts.
- Environment and footprint check scripts.
- Minimal package metadata.
- Native runtime dependencies that the local fast path actually needs.

The local package must not ship:

- Gauntlet reports, copied repos, or benchmark workspaces.
- `cas-tests` fixture corpora.
- Legacy UI/API prototypes.
- Source-only development fixtures.
- Analyzer training/evaluation artifacts.
- Local analysis history from `~/.klauro`.

The npm `files` allowlist in `apps/mcp-server/package.json` enforces this direction for package output.

## Storage Rules

Local storage is a cache, not the product database.

Default local storage lives under `~/.klauro/analyses` unless `KLAURO_STORAGE_PATH` is set. CAS/WAS artifacts should be compressed, and MCP/API callers should retrieve targeted slices rather than whole analysis blobs. Generated gauntlet/proof artifacts are intentionally separate from durable product analyses and should be prunable.

Recommended cleanup for generated proof artifacts:

```bash
cd apps/mcp-server
npm run storage-prune -- --include-ephemeral-analyses --include-temp-artifacts --max-bytes 536870912
```

Add `--confirm` only when the dry run looks right.

## Remote Analyzer Direction

The default customer shape should be:

1. Install a thin local Klauro client/MCP.
2. Sign in to Klauro.
3. Run `klauro init` in any folder, pick the selected branch, and either connect a Git provider or submit committed local source.
4. Register it with Claude/Codex/Cursor or another MCP-capable agent.
5. The hosted service analyzes selected-branch commits and produces shared CAS/WAS for the team.
6. The local client can separately prepare in-flight context for active human or agent work.
7. Hosted analyzers generate merged task context, AI descriptions, embeddings, and telemetry overlays.
8. Local agents query compact agent contexts, idioms, risks, tests, flows, and workspace edges from cache or remote.

Local full analysis remains useful for Klauro development and explicit
self-hosted deployments, but the primary commercial path keeps heavyweight
analyzer implementation and AI enrichment server-side.

## CI / Release Gate

Run before release packaging:

```bash
cd apps/mcp-server
npm run product-check
npm run smoke:bundle
```

Run locally when diagnosing machine weight:

```bash
cd apps/mcp-server
npm run product-footprint
npm run storage-report
```

The intended outcome is simple: gauntlets can be massive, but a normal user should experience Klauro like a small agent utility with heavyweight intelligence available remotely and on demand.
