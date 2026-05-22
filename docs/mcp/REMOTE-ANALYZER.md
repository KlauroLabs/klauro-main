# Remote Analyzer Deployment

Unravl can keep proprietary analyzers off the developer machine while still giving local AI agents fast MCP context.

The deployment shape is:

```text
Developer machine
  repo working tree
  Unravl CLI and local MCP cache
  Claude / Codex / Cursor

Unravl analyzer service
  closed analyzer runtime
  CAS generation
  incremental dirty-tree sync
```

The local client sends filtered source snapshots or dirty-tree change packets to the analyzer service. The analyzer returns CAS output, and the local client stores that CAS in the normal MCP cache under `~/.unravl/analyses` unless `UNRAVL_STORAGE_PATH` is set. Agent tools continue to query local cache, so agent reads stay fast after sync.

## Start The Analyzer Service

Local development:

```bash
cd mcp-server
npm run analyzer-server
```

Docker:

```bash
docker build -f mcp-server/Dockerfile.analyzer -t unravl-remote-analyzer .
docker run --rm -p 8787:8787 \
  -e UNRAVL_ANALYZER_PORT=8787 \
  -e UNRAVL_ANALYZER_TOKEN=optional-shared-secret \
  -e UNRAVL_ANALYZER_RATE_LIMIT_PER_MINUTE=120 \
  unravl-remote-analyzer
```

The service exposes:

- `GET /health`
- `POST /v1/analyze` for full filtered source snapshots
- `POST /v1/sync` for incremental working-tree changes

If `UNRAVL_ANALYZER_TOKEN` is set, clients must send `Authorization: Bearer <token>`.

## Analyze And Sync From A Local Repo

Full remote analysis:

```bash
cd mcp-server
npm run remote-analyze -- /absolute/path/to/repo \
  --server-url http://127.0.0.1:8787
```

Dirty-tree incremental sync after local agent edits:

```bash
cd mcp-server
npm run remote-sync -- /absolute/path/to/repo \
  --server-url http://127.0.0.1:8787
```

Equivalent MCP tools:

- `analyze_codebase_remote`
- `sync_codebase_remote`
- `get_upload_manifest`
- `get_unravl_project_config`
- `initialize_unravl_project`
- `get_github_import_plan`

Use `analyze_codebase_remote` once to establish the remote workspace. Use `sync_codebase_remote` after local changes so the hosted analyzer updates CAS and the local MCP cache receives the new graph.

## Source Transfer Rules

The local source packer includes source, tests, migrations, docs, and config files that CAS needs for behavior-level analysis. It excludes dependency trees, generated outputs, caches, local tool state, Git internals, and common secret files such as `.env`.

Full snapshots send filtered file contents. Incremental sync sends only changed file contents, deleted file paths, the current Git base commit when available, and the working-tree diff.

## Product Boundary

This mode protects analyzer IP because the analyzer runs in the service, not inside the npm package. The local install remains thin:

- source packer
- remote sync client
- local CAS cache writer
- local MCP server

Enterprise/self-hosted deployments can run the same service image inside the customer's network, including with private AI models, while preserving the same local-agent workflow.

## Customer Onboarding And Security

See:

- `docs/mcp/CUSTOMER-ONBOARDING.md`
- `docs/mcp/SECURITY-PACKET.md`
