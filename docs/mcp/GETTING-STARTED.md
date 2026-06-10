# Klauro MCP - Getting Started

From zero to a first agent work packet in under two minutes on a mid-size repository. The path is: install the MCP server, analyze the repo with the fast agent profile, ask for a work packet.

## Prerequisites

- Node.js 20+
- A local checkout of this repository (`proof-of-concept`)
- Dependencies installed once: `npm install` inside `apps/mcp-server/`
- Bundled server built once: `npm run build` inside `apps/mcp-server/`

## 1. Install: register the MCP server with Claude Code

The bundled entry (`dist/index.cjs`) starts in well under a second, so the server connects inside the Claude Code init window and its tools are visible to the agent from the first turn. The `src/index.ts` + tsx entry remains the development path (`npm run dev`), but registering it with clients is not recommended: its slower startup can leave the server pending at session init.

Add Klauro to the target project's `.mcp.json` (or `~/.claude.json` for global use):

```json
{
  "mcpServers": {
    "klauro": {
      "command": "node",
      "args": ["/absolute/path/to/proof-of-concept/apps/mcp-server/dist/index.cjs"],
      "cwd": "/absolute/path/to/proof-of-concept/apps/mcp-server"
    }
  }
}
```

Equivalent one-liner:

```bash
claude mcp add klauro -- node /absolute/path/to/proof-of-concept/apps/mcp-server/dist/index.cjs
```

Restart Claude Code and confirm with `/mcp` that the `klauro` server is listed.

## 2. Analyze: build the CAS graph with the fast agent profile

```bash
cd /absolute/path/to/proof-of-concept/apps/mcp-server
npm --silent run analyze -- /path/to/your/repo --analysis-focus agent-fast
```

`agent-fast` skips AI narrative generation, AI element descriptions, and embeddings, producing the structural graph agents need at full speed. Run `--analysis-focus full` later if you also want the UI narrative layers.

From inside an agent session the equivalent is the `analyze_codebase` tool with `analysis_focus: "agent-fast"`.

## 3. First work packet

```bash
npm --silent run agent-work-packet -- /path/to/your/repo --task-type modify --target "the thing you want to change" --compact --json
```

The packet contains the resolved target node, change risk, covering tests, call context, behavioral invariants, and the first files to inspect. From an agent session, the loop is `resolve_agent_analysis` -> `get_agent_start_context` -> `get_agent_work_packet` (see `.claude/skills/klauro/SKILL.md`).

## Measured timing

Measured on a mid-size production Angular repository (truckspyui, ~800 TypeScript files) on an Apple Silicon laptop, full rebuild from scratch (`--force`):

- `analyze --analysis-focus agent-fast --force`: MEASURED_ANALYZE
- `agent-work-packet --task-type modify`: MEASURED_PACKET
- Total install-to-first-packet (excluding one-time `npm install`): MEASURED_TOTAL

## Optional: workspace instructions

Run `klauro install-agent /path/to/your/repo` to write agent default instructions into the repo, or copy the operating-loop block from `docs/mcp/CLAUDE-MD-PROMPT.md` into the project's `CLAUDE.md`. Adoption measurement (`npm run agent-adoption-measurement`) shows agents use Klauro tools far more reliably when the operating loop is present in workspace instructions.

## Troubleshooting

- `klauro doctor /path/to/your/repo` checks analysis readiness.
- Analyses are stored under `~/.klauro/analyses/` unless `KLAURO_STORAGE_PATH` is set.
- Set `KLAURO_TOOL_CALL_LOG=/path/to/log.jsonl` in the server env to append one JSON line per tool call (tool name + timestamp) for adoption auditing.
