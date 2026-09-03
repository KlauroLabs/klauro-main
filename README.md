# Klauro

Klauro is the software-understanding platform for any codebase. It builds a trustworthy CAS relationship graph, turns that graph into behavior-level comprehension for people and AI agents, enables real-time collaboration through Fabric even when participants work on overlapping concepts, and correlates static understanding with runtime evidence.

Software produced heavily with AI may benefit disproportionately from that visibility, but it is not a separate product category and does not define Klauro's scope.

## What you can do

- Understand what a codebase actually built.
- Onboard to an unfamiliar system without reading every file.
- Know what will break before changing something.
- Verify AI-generated code beyond the demo path.
- Work alongside other people and agents on one codebase without duplicating or colliding.

## Layout

- `apps/mcp-server/` - MCP server, CLI, hosted analyzer HTTP service, proof gauntlets, proposal preview tooling, remote sync, and agent contexts.
- `packages/analyzer-core/` - CAS analyzer engine, CAS types, language/framework analyzers, incremental analysis, idiom/invariant extraction, embeddings, telemetry schema, and SDK source.
- `legacy/web/` - old Next.js prototype UI. Keep as reference only until the designed Klauro UI is rebuilt.
- `legacy/database/` - old SQL/database reference material. Do not treat it as current production schema without a current migration.
- `docs/` - CAS, MCP, customer onboarding, and architecture documentation.
- `infrastructure/` - deployment and hosted analyzer infrastructure when present at the repository parent.

See [docs/mcp/ANALYZER-COVERAGE.md](docs/mcp/ANALYZER-COVERAGE.md) for the current language, framework, and architecture-defining library coverage.

## Current Product Center

The current non-UI product center is `apps/mcp-server` plus `packages/analyzer-core`.
The previous API and web app are intentionally no longer top-level surfaces because they are stale relative to the analyzer/MCP direction.

## Common Commands

```bash
npm run mcp:typecheck
npm run mcp:test
npm run analyzer:build
npm run analyzer:test
npm run proof
```

## Performance Budget Gate

`npm run perf:budget` is a named gate step, separate from `npm run proof` and the default test suite because it is too slow to run on every `npm test`. Run it before landing analyzer-performance-sensitive changes (analyzer detection, language/framework analyzers, incremental analysis, orchestrator phases) and as part of the convergence/release gate alongside `npm run proof`.

It analyzes two pinned, committed reference fixtures (`apps/mcp-server/fixtures/perf-budget/small` ~150 files, `medium` ~500 files — realistic TS/Express+React apps, deterministic, no network) through the real product path (`analyzeProjectLayered`, the same layered L0→L4 path the MCP server and CLI use) and checks the results against `apps/mcp-server/fixtures/perf-budget/budgets.json`: time-to-L0, deterministic-pass wall time, and per-phase ceilings (the same phase names `KLAURO_DEBUG_ANALYZER_PHASES=1` prints). Any exceeded budget prints an actual-vs-budget table and exits nonzero.

Every run — pass or fail — appends a record to `~/.klauro/logs/perf-budget.jsonl` (or `$KLAURO_LOG_DIR/perf-budget.jsonl`) so trends are visible over time.

Budgets in `budgets.json` currently reflect measured reality (prevent backslide), not aspirational targets. Tighten them as analyzer speed work lands; see the `notes` field in that file for the ratchet plan. If the fixtures ever need regenerating (only if their shape needs to change — do not regenerate to "refresh" them), run `npm --prefix apps/mcp-server run perf:budget:fixtures` from `apps/mcp-server/scripts/generate-perf-fixtures.ts`, which is deterministic and reproduces the same tree.

Package-local equivalents:

```bash
cd apps/mcp-server
npm run typecheck
npm test

cd packages/analyzer-core
npm run build
npm test
```
