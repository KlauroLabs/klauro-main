# Klauro MCP - Getting Started

From zero to first agent context through the hosted product path. The supported customer flow installs the thin CLI/MCP, authenticates, registers the MCP with an agent client, initializes a repository, and submits it to the hosted analyzer.

## Prerequisites

- macOS or Linux with `curl`; Windows customers use the PowerShell installer.
- Node.js 20+ and npm only when no native binary is published for the current platform.
- A local checkout of the repository to analyze.

## 1. Install: one command

```bash
curl -fsSL https://mcp.klauro.com/install.sh | sh
klauro login --register
cd /absolute/path/to/your/repo
klauro install --claude-scope user
klauro init
klauro analyze
klauro doctor
```

The download is checksum-verified and smoke-tested before installation. If the manifest has no native binary for the platform, the installer uses the published npm tarball and requires Node.js 20+.

`klauro install` registers the MCP with supported agent clients and installs repository operating guidance. Restart the agent client after this step. `klauro init` binds the repository and writes the source-transfer policy. `klauro analyze` sends the filtered source snapshot to the hosted analyzer and waits for queryable CAS.

Restart Claude Code and confirm with `/mcp` that the `klauro` server is listed.

Environment health at any later point:

```bash
klauro doctor
```

With no path, `klauro doctor` checks installation, authentication, MCP registration, storage, release compatibility, and running processes. Every warning or failure carries its recovery action. With a path, `klauro doctor /path/to/repo` reports repository analysis readiness.

## Contributor source install

Building the monorepo from source requires Node.js 22. This is a contributor path, not the customer installation path.

```bash
cd /absolute/path/to/proof-of-concept
npm ci --include=dev --legacy-peer-deps
npm --prefix apps/mcp-server run build
node apps/mcp-server/scripts/install.mjs /path/to/your/repo --claude-md /path/to/your/repo
```

The bundled entry (`dist/index.cjs`) is the supported source-built MCP entrypoint. `tsx src/index.ts` is development-only.

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

## 2. Analyze

```bash
klauro analyze /path/to/your/repo --analysis-focus agent-fast
```

`agent-fast` builds the structural graph and requests the system narrative and primary capability summaries. If hosted AI enrichment is unavailable, the result reports degraded narrative provenance instead of presenting deterministic filler as authored comprehension. Use `--analysis-focus full` for deeper enrichment.

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
node dist/cli.cjs init /path/to/your/repo --mode remote --force
node dist/cli.cjs upload-manifest /path/to/your/repo
node dist/cli.cjs analyze /path/to/your/repo
```

For a hosted analyzer, set `KLAURO_ANALYZER_TOKEN` in the agent environment and use the hosted URL:

```bash
export KLAURO_ANALYZER_TOKEN=...
node dist/cli.cjs init /path/to/your/repo --mode remote --force
node dist/cli.cjs upload-manifest /path/to/your/repo
node dist/cli.cjs analyze /path/to/your/repo
```

`upload-manifest` shows exactly what would be transmitted before remote analysis. Dirty working-tree updates use `remote-sync`, so local agents can preview uncommitted changes without waiting for a GitHub push.

## 3. First agent context

```bash
npm --silent run agent-context -- /path/to/your/repo --task-type modify --target "the thing you want to change" --response-profile capsule-only --json
```

The capsule-only context contains the K15 context capsule, K5 execution capsule, selected target, first files, and validation instructions in the smallest prompt-native form. From an agent session, the loop is `resolve_agent_analysis` -> `get_agent_start_context` -> `get_agent_context` with `response_profile: "capsule-only"`; retry with `first-turn` only when the capsules leave a concrete gap (see `.claude/skills/klauro/SKILL.md`).

## Measured timing

The source-exact VPS new-user proof completes customer artifact construction, clean-prefix installation, authentication, hosted full analysis, installed MCP first context, and hosted incremental sync in 19.9 seconds. Real repositories vary with source size and analysis focus.

The release gate for this path is:

```bash
cd /absolute/path/to/proof-of-concept/apps/mcp-server
npm run new-user-e2e
```

It creates a fresh repository, builds and installs the customer artifact, verifies the CLI, authenticates, runs hosted full analysis, queries installed MCP context, edits the repository, and proves hosted incremental sync updates CAS. The beta process runs this gate on the source-exact VPS candidate.

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
