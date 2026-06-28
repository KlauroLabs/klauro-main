# Klauro MCP - Getting Started

From zero to a first agent work packet in under ten minutes on a mid-size repository. The path is: install the MCP server, analyze the repo with the fast agent profile, ask for a work packet. On a warm developer machine this is usually under two minutes; the ten-minute bar includes dependency install and bundle build.

## Prerequisites

- Node.js 20+
- A local checkout of this repository (`proof-of-concept`)

## 1. Install: one command

```bash
node /absolute/path/to/proof-of-concept/apps/mcp-server/scripts/install.mjs /path/to/your/repo --claude-md /path/to/your/repo
```

To prove immediate value in the same command, add `--first-value`:

```bash
node /absolute/path/to/proof-of-concept/apps/mcp-server/scripts/install.mjs /path/to/your/repo --first-value --claude-md /path/to/your/repo
```

Equivalent once dependencies exist: `npm --prefix apps/mcp-server run setup -- ...` or `klauro install ...`.

The installer is idempotent and does all of the following, printing a PASS/WARN/FAIL line with a concrete fix for every step:

1. Verifies Node.js 20+ and npm.
2. Runs `npm install` in `apps/mcp-server/` if dependencies are missing.
3. Locates the bundled server (`dist/index.cjs`) and CLI (`dist/cli.cjs`) and builds them only when missing (`--rebuild` to force).
4. Creates `~/.klauro/analyses` (or `KLAURO_STORAGE_PATH`) and verifies it is writable.
5. Registers the server with Claude Code (`claude mcp add --scope user klauro -- node .../dist/index.cjs`; `--no-register` to skip, `--claude-scope` for project/local scope) and prints the project-scoped `.mcp.json` snippet plus exact Codex CLI registration commands.
6. With `--claude-md <repo>`, appends the Klauro operating loop to that repo's `CLAUDE.md` (idempotent; without the flag it prints the snippet to copy).
7. Self-check: spawns the bundle, asserts the MCP initialize handshake answers within 600ms, then calls `resolve_agent_analysis` end to end — reporting either the selected analysis or a clear "no analyses yet" message with the exact analyze command to run next.
8. With `--first-value`, runs `agent-fast` analysis and prints the first agent work-packet summary: system name, graph size, selected task, and first files to inspect.

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

`agent-fast` includes the required AI system narrative and primary capability summaries, but skips lazy entity/flow/node descriptions and embeddings so agents get the structural graph and product orientation without paying for heavy enrichment. Run `--analysis-focus full` later if you also want every deeper enrichment layer.

From inside an agent session the equivalent is the `analyze_codebase` tool with `analysis_focus: "agent-fast"`.

## Hosted or self-hosted analyzer path

Local mode keeps analysis on the developer machine. Remote mode keeps analyzer implementation on a hosted or self-hosted Klauro analyzer while still letting local agents sync uncommitted changes.

Start a self-hosted analyzer locally:

```bash
cd /absolute/path/to/proof-of-concept/apps/mcp-server
npm run build
node dist/cli.cjs analyzer-server --host 127.0.0.1 --port 8787
```

Point a repo at the analyzer:

```bash
node dist/cli.cjs init /path/to/your/repo --mode remote --server-url http://127.0.0.1:8787 --force
node dist/cli.cjs upload-manifest /path/to/your/repo
node dist/cli.cjs analyze /path/to/your/repo
```

For a hosted analyzer, set `KLAURO_ANALYZER_TOKEN` in the agent environment and use the hosted URL:

```bash
export KLAURO_ANALYZER_TOKEN=...
node dist/cli.cjs init /path/to/your/repo --mode remote --server-url https://analyzer.klauro.dev --force
node dist/cli.cjs upload-manifest /path/to/your/repo
node dist/cli.cjs analyze /path/to/your/repo
```

`upload-manifest` shows exactly what would be transmitted before remote analysis. Dirty working-tree updates use `remote-sync`, so local agents can preview uncommitted changes without waiting for a GitHub push.

## 3. First work packet

```bash
npm --silent run agent-work-packet -- /path/to/your/repo --task-type modify --target "the thing you want to change" --response-profile capsule-only --json
```

The capsule-only packet contains the K15 context capsule, K5 execution capsule, selected target, first files, and validation instructions in the smallest prompt-native form. From an agent session, the loop is `resolve_agent_analysis` -> `get_agent_start_context` -> `get_agent_work_packet` with `response_profile: "capsule-only"`; retry with `first-turn` only when the capsules leave a concrete gap (see `.claude/skills/klauro/SKILL.md`).

## Measured timing

Measured on a mid-size production Angular repository (truckspyui, ~800 TypeScript files) on an Apple Silicon laptop, full rebuild from scratch (`--force`):

- `analyze --analysis-focus agent-fast --force`: 12.9s
- `agent-work-packet --task-type modify`: 2.4s
- Total install-to-first-packet (excluding one-time `npm install`): ~15s after a one-time npm install and build

The release smoke test for this path is:

```bash
cd /absolute/path/to/proof-of-concept/apps/mcp-server
npm run new-user-e2e
```

It creates a fresh temporary repo, runs the deterministic installer with `--first-value`, verifies the installed CLI, starts a local hosted analyzer, runs remote full analysis, edits the repo, and proves incremental remote sync updates CAS. It writes `.klauro-new-user-e2e/latest-report.json`, and `npm run agent-proof-full` now requires that report through `agent-vision-acceptance`.

## Operations: analysis memory

`analyze_codebase` runs in a separate worker process, not in the MCP server itself. The server stays at roughly 250 MB regardless of repository size; all analysis memory lives in the worker, whose heap is bounded:

- Worker heap default: 8192 MB on machines with at least 16 GB RAM; on smaller machines the default is capped at 50% of total RAM. Set `KLAURO_ANALYSIS_HEAP_MB` in the MCP server environment to override (minimum 256). `klauro doctor` reports the resolved value under the `analysis-heap` check.
- If an analysis exceeds the worker heap, the worker dies but the MCP server and the agent session survive. The tool call returns an error naming the `KLAURO_ANALYSIS_HEAP_MB` value to raise, and the aborted run is recorded as `run-failed` in `~/.klauro/logs/analysis-runs.jsonl`.
- Measured envelope through the installed bundle with no NODE_OPTIONS (Apple Silicon, 32 GB RAM, `agent-fast` focus): a 51,357-node / 93,950-edge production repository fully analyzes in 26 s with a peak worker RSS of 1.6 GB — well inside the default heap. A 48,575-node repository peaks at 1.1 GB. Repositories substantially larger than this (for example the 163k-file synthetic benchmark) need `KLAURO_ANALYSIS_HEAP_MB=12288` or higher.
- Incremental refreshes reuse a persistent worker, so no-change incremental runs stay at the in-process speed (about 1.0 s on the 51k-node repository; about 0.3 s on a 15k-node repository). Only the first incremental after server startup pays a one-time worker spawn and load cost (about 1.4 s extra on the 51k-node repository).
- `KLAURO_ANALYSIS_IN_PROCESS=1` forces the old in-process analysis path; it is intended for tests and small fixtures only, because it puts analysis memory back inside the MCP server process.
- The `klauro analyze` CLI command runs analysis in the CLI process itself (an OOM there exits the command without affecting any MCP session); for very large repositories invoke it with `NODE_OPTIONS=--max-old-space-size=<MB>`.

## Optional: workspace instructions

Run `klauro install-agent /path/to/your/repo` to write agent default instructions into the repo, or copy the operating-loop block from `docs/mcp/CLAUDE-MD-PROMPT.md` into the project's `CLAUDE.md` or `AGENTS.md`. The install command also writes a portable skill at `.klauro/skills/klauro/SKILL.md`; copy or symlink that skill into Claude, Codex, or another agent skill directory when the agent supports skills. Adoption measurement (`npm run agent-adoption-measurement`) shows agents use Klauro tools far more reliably when the operating loop is present in workspace instructions.

## Troubleshooting

- `klauro doctor` (no path) checks the environment: Node version, bundle freshness, handshake latency, storage, analysis worker heap, AI providers, analysis version floor, running servers.
- `klauro doctor /path/to/your/repo` checks analysis readiness for that repository.
- Analyses are stored under `~/.klauro/analyses/` unless `KLAURO_STORAGE_PATH` is set.
- Set `KLAURO_TOOL_CALL_LOG=/path/to/log.jsonl` in the server env to append one JSON line per tool call (tool name + timestamp) for adoption auditing.
