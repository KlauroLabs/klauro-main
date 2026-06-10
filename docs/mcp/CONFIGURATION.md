# Klauro MCP Server - Configuration

## Prerequisites

- Node.js 18+
- npm
- The Klauro proof-of-concept repository cloned locally

## Installation

```bash
cd apps/mcp-server
npm install --legacy-peer-deps
```

The `--legacy-peer-deps` flag is required due to tree-sitter native module peer dependency ranges.

## Running the Server

The server runs directly via tsx with no build step:

```bash
cd apps/mcp-server
npx tsx src/index.ts
```

The server uses stdio transport and waits for JSON-RPC messages on stdin.

## Remote Analyzer Mode

For commercial deployments where the analyzers should run off the developer machine, keep the MCP server local and point it at a remote analyzer service:

```bash
docker build -f apps/mcp-server/Dockerfile.analyzer -t klauro-remote-analyzer .
docker run --rm -p 8787:8787 klauro-remote-analyzer
```

Then analyze or sync through the hosted analyzer while caching returned CAS locally:

```bash
cd apps/mcp-server
npm run init -- /absolute/path/to/repo --mode remote --server-url http://127.0.0.1:8787
npm run upload-manifest -- /absolute/path/to/repo
npm run remote-analyze -- /absolute/path/to/repo --server-url http://127.0.0.1:8787
npm run remote-sync -- /absolute/path/to/repo --server-url http://127.0.0.1:8787
```

MCP clients can call `initialize_klauro_project`, `get_upload_manifest`, `analyze_codebase_remote`, and `sync_codebase_remote` directly. Set `KLAURO_ANALYZER_URL` and optional `KLAURO_ANALYZER_TOKEN` in the MCP server environment to avoid passing the URL each time. See `REMOTE-ANALYZER.md` for the deployment model and source-transfer rules.

## AI Description Providers

The core graph does not require AI, but the system narrative, primary capability descriptions, and manually generated element descriptions need a configured AI provider to avoid deterministic fallback text.

Supported hosted provider environment variables:

```bash
# OpenAI-compatible local servers (Ollama, LM Studio, OpenCode, vLLM, llama.cpp)
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_MODEL=llama3.1
OPENAI_API_KEY=local

# Ollama shorthand
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_THINK=false

# OpenAI
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini

# Anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-3-haiku-20240307

# Azure OpenAI
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
AZURE_OPENAI_API_VERSION=2024-10-21
```

When `OLLAMA_BASE_URL` is set, Klauro uses Ollama's native chat endpoint with `think: false` by default so Qwen3-style reasoning models return concise description text instead of hidden reasoning blocks. Set `OLLAMA_THINK=true` only for ad hoc experimentation, not normal analysis.

`AZURE_OPENAI_API_KEY` alone is not enough; Klauro needs the endpoint and deployment name to call Azure OpenAI. If no AI provider is configured, `analysis_phases` reports `ai-system-narrative` as deferred and description provenance remains explicit.

## Claude Code Configuration

Add the server to your project-level `.mcp.json` (recommended) or global `~/.claude.json`:

### Project-level (.mcp.json in project root)

```json
{
  "mcpServers": {
    "klauro": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/proof-of-concept/apps/mcp-server/src/index.ts"],
      "cwd": "/absolute/path/to/proof-of-concept/apps/mcp-server"
    }
  }
}
```

### Global (~/.claude.json)

```json
{
  "mcpServers": {
    "klauro": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/proof-of-concept/apps/mcp-server/src/index.ts"],
      "cwd": "/absolute/path/to/proof-of-concept/apps/mcp-server"
    }
  }
}
```

Replace `/absolute/path/to/proof-of-concept` with the actual path on your machine.

## Verification

After configuring, restart Claude Code and run `/mcp` to verify the `klauro` server appears with its tools, resources, and prompts.

## Storage

Analysis results are stored as JSON files at:

```
~/.klauro/analyses/
```

Each analysis produces:
- `{slugified-project-name}.json` - The full CAS output
- `index.json` - Maps project paths to analysis files
- `{project-slug}/incremental-state.json` - Incremental analysis state
- `{project-slug}/file-cache/` - File-level analysis cache
- `{project-slug}/change-history.json` - Incremental change history
- `{project-slug}/snapshots/` - Analysis snapshots for time-travel queries

Snapshot retention is bounded for local development. By default Klauro keeps at
most 10 analysis snapshots per project and prunes a project's snapshot directory
once retained snapshots exceed 512 MB. Incremental edit snapshots are throttled
to at most once per 60 seconds by default; the latest CAS file and change history
are still updated for every changed analysis. Override these with:

```bash
export KLAURO_MAX_SNAPSHOTS=20
export KLAURO_MAX_SNAPSHOT_BYTES=1073741824
export KLAURO_INCREMENTAL_SNAPSHOT_INTERVAL_MS=0
```

Agent work packets are token-bounded by default. Large repositories receive a
compact packet with a focused file plan, idiom guidance, invariants, capability
memory, and follow-up MCP calls instead of a broad context dump. For local
debugging only, override the packet profile with:

```bash
export KLAURO_AGENT_PACKET_PROFILE=standard
```

Valid values are `token-minimal`, `tiny`, `micro`, and `standard`. Do not set
`standard` in production agent defaults unless the quality gain has been measured
and the token cost is acceptable.

Routine analyzer logging is quiet by default. Set these only when debugging local
analysis behavior:

```bash
export KLAURO_LOG_LEVEL=info
export KLAURO_DEBUG_ANALYSIS_TIMINGS=1
export KLAURO_DEBUG_INCREMENTAL_TIMINGS=1
```

Generated proof, preview, and live-trial workspaces can be inspected and pruned
without touching durable analyses:

```bash
cd apps/mcp-server
npm run storage-report -- --include-temp-artifacts --max-bytes 1073741824
npm run storage-prune -- --include-temp-artifacts --max-bytes 1073741824 --confirm
```

Use `--include-analyses` only when you explicitly want analysis snapshot files to
be eligible for pruning.

### Custom Storage Path

Set the `KLAURO_STORAGE_PATH` environment variable to use a different location:

```json
{
  "mcpServers": {
    "klauro": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/proof-of-concept/apps/mcp-server/src/index.ts"],
      "cwd": "/absolute/path/to/proof-of-concept/apps/mcp-server",
      "env": {
        "KLAURO_STORAGE_PATH": "/custom/path/to/analyses"
      }
    }
  }
}
```

## Architecture

```
apps/mcp-server/
  src/
    index.ts        # Entry point - stdio transport
    server.ts       # MCP server (tools, resources, prompts)
    analyzer.ts     # CAS analyzer orchestrator wrapper
    storage.ts      # JSON file storage/retrieval
    query.ts        # Query helpers for slicing CAS data
    remote-analyzer-service.ts # HTTP analyzer service for hosted/self-hosted analyzer deployments
    remote-sync-client.ts      # Local source snapshot and dirty-tree sync client
```

The MCP server imports directly from the backend analyzer code via relative paths. No NestJS runtime is involved - the `AnalyzerOrchestrator` and all language/framework/library analyzers are instantiated directly.
