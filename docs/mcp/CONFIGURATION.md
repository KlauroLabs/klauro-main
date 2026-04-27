# Unravl MCP Server - Configuration

## Prerequisites

- Node.js 18+
- npm
- The Unravl proof-of-concept repository cloned locally

## Installation

```bash
cd mcp-server
npm install --legacy-peer-deps
```

The `--legacy-peer-deps` flag is required due to tree-sitter native module peer dependency ranges.

## Running the Server

The server runs directly via tsx with no build step:

```bash
cd mcp-server
npx tsx src/index.ts
```

The server uses stdio transport and waits for JSON-RPC messages on stdin.

## Claude Code Configuration

Add the server to your project-level `.mcp.json` (recommended) or global `~/.claude.json`:

### Project-level (.mcp.json in project root)

```json
{
  "mcpServers": {
    "unravl": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/proof-of-concept/mcp-server/src/index.ts"],
      "cwd": "/absolute/path/to/proof-of-concept/mcp-server"
    }
  }
}
```

### Global (~/.claude.json)

```json
{
  "mcpServers": {
    "unravl": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/proof-of-concept/mcp-server/src/index.ts"],
      "cwd": "/absolute/path/to/proof-of-concept/mcp-server"
    }
  }
}
```

Replace `/absolute/path/to/proof-of-concept` with the actual path on your machine.

## Verification

After configuring, restart Claude Code and run `/mcp` to verify the `unravl` server appears with its tools, resources, and prompts.

## Storage

Analysis results are stored as JSON files at:

```
~/.unravl/analyses/
```

Each analysis produces:
- `{slugified-project-name}.json` - The full CAS output
- `index.json` - Maps project paths to analysis files
- `{project-slug}/incremental-state.json` - Incremental analysis state
- `{project-slug}/file-cache/` - File-level analysis cache
- `{project-slug}/change-history.json` - Incremental change history
- `{project-slug}/snapshots/` - Analysis snapshots for time-travel queries

### Custom Storage Path

Set the `UNRAVL_STORAGE_PATH` environment variable to use a different location:

```json
{
  "mcpServers": {
    "unravl": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/proof-of-concept/mcp-server/src/index.ts"],
      "cwd": "/absolute/path/to/proof-of-concept/mcp-server",
      "env": {
        "UNRAVL_STORAGE_PATH": "/custom/path/to/analyses"
      }
    }
  }
}
```

## Architecture

```
mcp-server/
  src/
    index.ts        # Entry point - stdio transport
    server.ts       # MCP server (tools, resources, prompts)
    analyzer.ts     # CAS analyzer orchestrator wrapper
    storage.ts      # JSON file storage/retrieval
    query.ts        # Query helpers for slicing CAS data
```

The MCP server imports directly from the backend analyzer code via relative paths. No NestJS runtime is involved - the `AnalyzerOrchestrator` and all language/framework/library analyzers are instantiated directly.
