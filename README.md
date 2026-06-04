# Klauro Proof Of Concept

This repository is now organized around the parts of Klauro that remain product-critical:
CAS analysis, agent-facing MCP context, hosted analyzers, proposal previews, incremental analysis, idiom intelligence, and future SDK/local install surfaces.

## Layout

- `apps/mcp-server/` - MCP server, CLI, hosted analyzer HTTP service, proof gauntlets, proposal preview tooling, remote sync, and agent work packets.
- `packages/analyzer-core/` - CAS analyzer engine, CAS types, language/framework analyzers, incremental analysis, idiom/invariant extraction, embeddings, telemetry schema, and SDK source.
- `legacy/web/` - old Next.js prototype UI. Keep as reference only until the designed Klauro UI is rebuilt.
- `legacy/database/` - old SQL/database reference material. Do not treat it as current production schema without a current migration.
- `docs/` - CAS, MCP, customer onboarding, and architecture documentation.
- `infrastructure/` - deployment and hosted analyzer infrastructure when present at the repository parent.

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

Package-local equivalents:

```bash
cd apps/mcp-server
npm run typecheck
npm test

cd packages/analyzer-core
npm run build
npm test
```
