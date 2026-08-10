# Remote Analyzer Deployment

Klauro can keep proprietary analyzers off the developer machine while still
giving AI agents fast MCP context. This is one Klauro analysis flow, not two
separate products. The installed client, hosted analyzer service, CAS
storage (repo- and workspace-level), MCP server, and UI cooperate to produce durable and in-flight
understanding.

The deployment shape is:

```text
Developer machine
  repo working tree
  Klauro CLI, commit/source packer, in-flight context builder, and MCP cache
  Claude / Codex / Cursor

Klauro analyzer service
  account + entitlement check
  closed analyzer runtime
  shared project CAS generation (repo- and workspace-level)
  hosted AI enrichment
  selected-branch commit history
```

Klauro tracks shared project truth as analyzed revisions for selected branches.
A revision can come from a connected Git provider checkout or from a signed-in
CLI submission of a committed local tree. Both produce the same CAS project
state (repo- or workspace-level). If a Git remote is detected during local setup, Klauro recommends
connecting it in the UI for automatic push-triggered analysis, but the
connection is not required.

Uncommitted, branch, and agent-session changes are in-flight analysis. They are
not durable project truth, but they are not merely local throwaway context
either. Klauro can publish them as provisional workspace context for authorized
users and agents so teams can see duplicate work, likely conflicts, overlapping
migrations, and stale assumptions before Git has a commit or push to reason
about.

## Source Transfer

| Path | Use it when | Heavy work | Wire behavior |
| --- | --- | --- | --- |
| Local commit submission | User commits locally and submits the committed tree to Klauro | Klauro VPS/cloud analyzes the filtered committed source context | Filtered manifests and gzip-compressed JSON payloads |
| Connected Git provider | A GitHub/GitLab/Bitbucket/Azure DevOps repo is connected to a hosted Klauro project | Klauro VPS/cloud pulls and analyzes selected-branch pushed commits | Local MCP fetches/cache context; optional pre-push commit submission |
| In-flight branch/session context | User, teammate, or agent has uncommitted, not-yet-pushed, or non-mainline work | Klauro processes scoped provisional context and can share it with authorized workspace members | Dirty-tree deltas, deleted paths, branch/session metadata, optional diff text |
| Self-hosted | Source cannot leave customer infrastructure | Customer analyzer service | Same protocol against a pinned customer host |

`upload-manifest` and the MCP `get_upload_manifest` tool report the detected
Git provider and a transfer recommendation. A detected provider remote should
surface a UI recommendation to connect the repo, but local commit submission
remains valid. When the folder is already connected to a hosted project,
committed source can be submitted before push and later deduped against provider
webhook analysis by commit SHA/content hash.

## Start The Analyzer Service

Local development:

```bash
cd apps/mcp-server
npm run analyzer-server
```

Docker:

```bash
docker build -f apps/mcp-server/Dockerfile.analyzer -t klauro-remote-analyzer .
docker run --rm -p 8787:8787 \
  -e KLAURO_ANALYZER_PORT=8787 \
  -e KLAURO_ANALYZER_TOKEN=optional-shared-secret \
  -e KLAURO_ANALYZER_RATE_LIMIT_PER_MINUTE=120 \
  klauro-remote-analyzer
```

The service exposes:

- `GET /health`
- `GET /app` for the bare hosted alpha account UI
- `POST /api/auth/register` and `POST /api/auth/login`
- `GET /api/me`
- `GET /api/workspaces` and `POST /api/workspaces`
- `GET /api/workspaces/:workspaceId/users` and `POST /api/workspaces/:workspaceId/users`
- `GET /api/workspaces/:workspaceId/projects` and `POST /api/workspaces/:workspaceId/projects`
- `POST /v1/analyze` for full filtered source snapshots
- `POST /v1/sync` for incremental working-tree changes

If `KLAURO_ANALYZER_TOKEN` is set, analyzer clients must send `Authorization:
Bearer <token>` for `/v1/*` calls. Account registration and login remain
available, and signed-in users can also call the hosted analyzer with their
session token.

For the product connector, set `KLAURO_ACCOUNT_TOKEN` or `KLAURO_AUTH_TOKEN` to
the signed-in account token. Local overlay indexing and remote sync validate the
token against `/api/me` and require an active or trialing entitlement before
doing useful work.

## Hosted Alpha Accounts

The hosted analyzer includes a small file-backed account layer for early
customer trials. It is intentionally separate from the stale legacy API surface.

The active entities are:

- `User`: signs in with email/password and can belong to many workspaces.
- `Workspace`: a group of projects with many users.
- `Project`: a single repo/codebase attached to one workspace.

Account data is stored under the analyzer data directory at
`accounts/accounts.json`. Passwords are hashed with scrypt. Browser sessions use
random bearer tokens stored server-side as token hashes. This is enough for
prototype and internal beta hosting; billing, SSO, org policies, and external
database persistence are later control-plane concerns.

## Analyze And Sync From A Local Repo

In-flight working context, before commit:

```bash
cd apps/mcp-server
KLAURO_ACCOUNT_TOKEN=ks_... npm run start -- index /absolute/path/to/repo \
  --dirty-tree \
  --server-url http://127.0.0.1:8787
```

Shared committed-source analysis:

```bash
cd apps/mcp-server
npm run remote-analyze -- /absolute/path/to/repo \
  --server-url http://127.0.0.1:8787
```

In-flight sync for agent assistance and collaboration:

```bash
cd apps/mcp-server
npm run remote-sync -- /absolute/path/to/repo \
  --server-url http://127.0.0.1:8787
```

Equivalent MCP tools:

- `analyze_codebase_remote`
- `sync_codebase_remote`
- `get_upload_manifest`
- `get_klauro_project_config`
- `initialize_klauro_project`
- `get_github_import_plan`

Use Git provider connection for automatic selected-branch analysis when the
project exists in Klauro. Use `analyze_codebase_remote` to submit committed
local source when a repo is not connected or when a commit has not been pushed
yet. Use `sync_codebase_remote` for in-flight work so agents and authorized
teammates can reason about active edits before they are durable.

The UI should show durable project revisions by default and make in-flight
overlays explicit. The MCP path can combine durable project analysis, incoming
analyzed changes, and in-flight branch/session context so agents know what they
are changing and what other work may collide.

## Source Transfer Rules

The local source packer includes source, tests, migrations, docs, and config files that CAS needs for behavior-level analysis. It excludes dependency trees, generated outputs, caches, local tool state, Git internals, and common secret files such as `.env`.

Shared analysis snapshots send filtered file contents for the committed tree.
In-flight context sends scoped changed file contents, deleted file paths, the
current Git remote, branch, base commit, dirty status, session/author metadata
when available, and the working-tree diff when enabled by policy.

## Product Boundary

This mode protects analyzer IP because the analyzer runs in the service, not inside the npm package. The local install remains thin:

- source packer
- in-flight context builder
- remote sync client
- local CAS cache writer
- local MCP server

The local install does not run AI enrichment. Customers should not need Ollama,
DeepInfra, OpenAI, Anthropic, or model API keys on their machine. Hosted Klauro
owns those provider credentials and applies budgets, retries, caching, and
quality gates server-side.

It must not include gauntlet workspaces, proof reports, fixture corpora, legacy
UI/API prototypes, or the hosted analyzer's private runtime dependencies. The
runtime budget and release gate are defined in [`../PRODUCT-RUNTIME.md`](../PRODUCT-RUNTIME.md).

Enterprise/self-hosted deployments can run the same service image inside the customer's network, including with private AI models, while preserving the same local-agent workflow.

## Customer Onboarding And Security

See:

- `docs/mcp/CUSTOMER-ONBOARDING.md`
- `docs/mcp/SECURITY-REVIEW.md`
