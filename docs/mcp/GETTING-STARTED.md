# Klauro MCP - Getting Started

From zero to a first agent work packet in under two minutes on a mid-size repository. The path is: install the MCP server, analyze the repo with the fast agent profile, ask for a work packet.

## Prerequisites

- Node.js 20+
- A local checkout of this repository (`proof-of-concept`)

## 1. Install: one command

```bash
node /absolute/path/to/proof-of-concept/apps/mcp-server/scripts/install.mjs /path/to/your/repo --claude-md /path/to/your/repo
```

(Equivalent once dependencies exist: `npm --prefix apps/mcp-server run setup -- ...` or `klauro install ...`.)

The installer is idempotent and does all of the following, printing a PASS/WARN/FAIL line with a concrete fix for every step:

1. Verifies Node.js 20+ and npm.
2. Runs `npm install` in `apps/mcp-server/` if dependencies are missing.
3. Locates the bundled server (`dist/index.cjs`) and builds it only when missing (`--rebuild` to force).
4. Creates `~/.klauro/analyses` (or `KLAURO_STORAGE_PATH`) and verifies it is writable.
5. Registers the server with Claude Code (`claude mcp add --scope user klauro -- node .../dist/index.cjs`; `--no-register` to skip, `--claude-scope` for project/local scope) and prints the project-scoped `.mcp.json` snippet plus exact Codex CLI registration commands.
6. With `--claude-md <repo>`, appends the Klauro operating loop to that repo's `CLAUDE.md` (idempotent; without the flag it prints the snippet to copy).
7. Self-check: spawns the bundle, asserts the MCP initialize handshake answers within 600ms, then calls `resolve_agent_analysis` end to end — reporting either the selected analysis or a clear "no analyses yet" message with the exact analyze command to run next.

Restart Claude Code and confirm with `/mcp` that the `klauro` server is listed.

Environment health at any later point:

```bash
npm --prefix apps/mcp-server run doctor
```

With no path, `klauro doctor` checks the machine: Node version, bundle presence and freshness against the sources, handshake latency, `~/.klauro` writability and disk usage, AI provider availability (none configured means analysis runs fully deterministic — the agent-fast profile is unaffected), zstd, stored-analysis versions against the 1.6.0 compatibility floor, and running Klauro server processes. Every WARN/FAIL carries its fix. With a path, `klauro doctor /path/to/repo` reports per-repository analysis readiness instead.

## Manual install (what the installer automates)

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

- `analyze --analysis-focus agent-fast --force`: 12.9s
- `agent-work-packet --task-type modify`: 2.4s
- Total install-to-first-packet (excluding one-time `npm install`): ~15s after a one-time npm install and build

## Optional: workspace instructions

Run `klauro install-agent /path/to/your/repo` to write agent default instructions into the repo, or copy the operating-loop block from `docs/mcp/CLAUDE-MD-PROMPT.md` into the project's `CLAUDE.md`. Adoption measurement (`npm run agent-adoption-measurement`) shows agents use Klauro tools far more reliably when the operating loop is present in workspace instructions.

## Troubleshooting

- `klauro doctor` (no path) checks the environment: Node version, bundle freshness, handshake latency, storage, AI providers, analysis version floor, running servers.
- `klauro doctor /path/to/your/repo` checks analysis readiness for that repository.
- Analyses are stored under `~/.klauro/analyses/` unless `KLAURO_STORAGE_PATH` is set.
- Set `KLAURO_TOOL_CALL_LOG=/path/to/log.jsonl` in the server env to append one JSON line per tool call (tool name + timestamp) for adoption auditing.
