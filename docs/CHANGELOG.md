# Changelog

All notable changes to Klauro are recorded here. Entries are grounded in commits, test runs, or
agent-feedback reports (`~/.klauro/agent-feedback/*.md`) — nothing is asserted without a source.
Where an item was still in flight at the time this entry was written, it is marked **pending
final verify** rather than presented as done.

## v1.0.12 — Conceptual understanding layer (2026-07-04, live on `mcp.klauro.com`)

Cut and deployed 2026-07-04 (bumped from v1.0.11 `5292d01f`; tagged `v1.0.12`). Live-verified:
`/health` ok, running version 1.0.12, `/dist/latest.json` 1.0.12 + tarball HTTP 200. **199**
registered tools (`get_flow_concepts` + `get_unified_perspectives` added, up from 197 at v1.0.11).
Converged gate green on the merged tree: tsc clean both packages, analyzer-core **828/828** jest,
coordination **108/108**, `fabric-fleet-proof` all **6** properties. Built in one parallel session
of 7+ agents coordinating through the fabric (co-editing `orchestrator.ts`/`server.ts` clean).

### Added

- **`get_flow_concepts` — the conceptual flow/step tier.** New MCP tool and analyzer
  (`packages/analyzer-core/src/analyzer/core/flow-concepts.ts`) computing the behavioral
  hierarchy Capability → Flow → Step → Function over the existing CAS graph, per
  `docs/SPEC-CONCEPTUAL-LAYER.md`: each Flow and Step carries a uniform I/L/S/O + Constraints
  contract (side-effects split into `state_changes` vs. `external_integrations`), Steps map to
  functions 1:1, 1:many, or a sub-section of one function, and Flows link to
  `system_capabilities`/`data_entities` only via direct structural match — never guessed by name
  similarity. Deterministic-first; the only AI seam (`opts.nameStep`) is inert when omitted.
  7/7 new unit tests passing (`flow-concepts.test.ts`). Verified against a real 11,881-node CAS
  (`~/dev/zerac/zerac-api`): traced two coherent 3-step flows (route → component → hooks).
  Source: `~/.klauro/agent-feedback/2026-07-03-flow-concepts.md`.
- **Fabric conceptual vocabulary — coordination now speaks flow/step/capability/entity.**
  `apps/mcp-server/src/coordination/` gained a `ConceptualCoordinate` type and
  `conceptual-scope.ts`, wired additively into `claim_work`, `check_collision`, and
  `plan_parallel_work`: claims auto-derive their flow/step/capability coordinate from
  paths/symbols via a real `getFlowConcepts` call (declared values still win when supplied), and
  every response now carries `concept`/`concept_awareness` unconditionally, not just on collision.
  The comparison classifier treats same-flow/different-step as `'awareness'` (non-blocking) and
  same-step, or different-flows-same-entity-constraints, as `'conceptual_conflict'` (advisory —
  never gates the literal grant). Verified with a real two-flow CAS (Checkout/Refund sharing an
  `Order.total must be positive` invariant): correctly flagged a cross-file conceptual conflict
  between two agents who never touched the same file. 10 new tests in
  `conceptual-scope.test.ts` + 4 in `partitioner.test.ts`; full coordination suite 113/113 passing,
  zero regressions. Source: `~/.klauro/agent-feedback/2026-07-03-conceptual-vocab-fabric.md`.
- **Conceptual UI.** New "Conceptual" tab in the real app SPA (`apps/app`) — a three-column
  Flows → Steps → Contract drill-down (`ConceptualView`) plus a `StructuralPerspectivePanel`
  showing architectural conflicts, paradigm conformance, and raw perspectives side by side. New
  backend route `GET /api/projects/:id/conceptual` in `remote-analyzer-service.ts`, additive only.
  Verified against real stored analysis for `~/dev/zerac/zerac-api` (e.g. an "Organizations" flow
  → capability → 3 ordered steps, 1:many mapped to 5 hook-usage functions; 4 architectural
  conflicts + 18 principle violations against real controller files). `apps/app` build clean
  (232KB bundle), no existing route/page altered.
  Source: `~/.klauro/agent-feedback/2026-07-03-conceptual-ui.md`.
- **Consumer-teaching surfaces updated for the conceptual layer + parallel-by-default fabric.**
  `SERVER_INSTRUCTIONS` (server.ts), `docs/mcp/CLAUDE-MD-PROMPT.md`, `docs/mcp/USAGE.md`, the
  installed agent skill/bootstrap templates (`agent-bootstrap.ts`, `agent-defaults.ts`,
  `agent-workflow.ts`) all now teach the Capability→Flow→Step→Function drill path
  (`get_summary` → `get_flow_concepts` → `get_coding_context`/`get_call_chain`) and state
  parallel-through-the-fabric as the default coordination posture, not a fallback for when work
  collides. Grep-verified landed in all four surfaces; `createServer()` boots clean; only
  description/prose strings touched, no tool registration changed.
  Source: `~/.klauro/agent-feedback/2026-07-03-consumer-teaching.md`.

### Added (continued) — verified & shipped in v1.0.12

The following were in flight when this entry was first drafted; all landed, were verified, and
ship in v1.0.12.

- **Registration/entry-point → real-handler edge-linking** (`orchestrator.ts`/`react-analyzer.ts`/
  `ai-stack-analyzer.ts`/`mcp-tool-registration-analyzer.ts`) — closes the substrate gap
  `get_flow_concepts` flagged honestly (React `hook_usage` nodes and this repo's own
  `entry_mcp_tool_*` markers had no outgoing call edge to the function they invoke, so flows
  degraded to shallow single steps). Handlers are resolved by exact-name match only; ambiguous or
  unresolved candidates get no edge (never fabricated). Real before/after: Klauro self
  **0/198 → 198/198** mcp-tool entry points with outgoing `calls` edges (system-wide single-step
  flows ~200 → 3); zerac-api **0/24 → 24/24** React Query hooks resolved to real fetchers, 5/8
  flows now with populated `external_integrations`. **822/822** jest, 122/122 node tests.
  Source: `~/.klauro/agent-feedback/2026-07-03-registration-edge-link.md`.
- **Structural-perspective unification** — `get_unified_perspectives` (new tool) plus
  `structural-cross-links.ts`: a Flow/Step now carries its architectural layer + paradigm
  deviations, and an architectural conflict resolves to the flows/steps/capabilities it touches
  (bidirectional, evidence-gated — link omitted when no genuine overlap). 6/6 new tests.
  Source: `~/.klauro/agent-feedback/2026-07-03-structural-unify.md`.
- **Flow entity derivation** — `deriveCapabilityOperationRoots` in `flow-concepts.ts` seeds flow
  roots from `system_capabilities[].operations[]` (the real blocker was call-graph reachability,
  not an id namespace — proven empirically). zerac-api: **0 → 171/1261** lifecycle touchers
  resolved, **0 → 83/206** flows now carry real derived entities (e.g. `setBillingModel` →
  `['Partner','Billing']`) — making the cross-flow same-entity conceptual conflict reachable by
  *derivation* on a real repo. Step-level `entities` added. 13/13 tests.
  Source: `~/.klauro/agent-feedback/2026-07-03-flow-entities.md`.
- **End-to-end fabric fleet proof** — `apps/mcp-server/src/gauntlet/fabric-fleet-proof.ts` +
  `docs/FABRIC-FLEET-PROOF.md`: all 6 properties (ambient awareness, non-blocking parallelism,
  cross-file conceptual-conflict catch, dedup, conceptual partitioning, honest fabric-vs-no-fabric
  contrast) demonstrated on real flow ids from a real analysis. Re-run green on the converged tree.
  Source: `~/.klauro/agent-feedback/2026-07-03-fabric-fleet-proof.md`.
- **`fab` release fix** — `releaseAgent()` in `local-store.ts` releases ALL of an agent's active
  claims by `agent_id` (the CLI `claim`/`release` used mismatched claim_id schemes, so finished
  agents lingered as `active` and produced false-overlap noise). Dogfood-CLI only; the product
  `release_work` path was unaffected. Test added.
- **Hash/id-token domain-naming guard hardening** (`orchestrator.ts`) — continuation of the
  v1.0.11 corpus hash-domain fixes; shipped.

## v1.0.11 — 2026-07-03 (commit `5292d01f`)

Corpus-validation hardening from the `~/dev` real-repo sweep (`docs/CORPUS-VALIDATION.md`):

- Fixed deployable over-count from a route-path-keyed dedupe (`collectServerEntries` now dedupes
  by `rootPath`, not `rootPath::routePath`) — 432→16 evidence rows on the affected repo, 15% of
  the 33-repo corpus was affected. Commit `a257f30b`.
- Fixed a name-corruption bug in distribution-artifact naming (`productNameFromFile`'s unanchored
  regex stripped `install` out of `Uninstall.bat`) plus an NSIS `${VAR}` template-leak fix.
  Commit `a257f30b`.
- Fixed a hash-suffixed garbage domain/deployable name: `isGenericDomainToken` gained a
  hash/id-shape guard (`isHashOrIdShapedToken`) so a content-hash or generated ID surviving as the
  top terminal token no longer composes into `<hash>-management`; a hostname-shaped token guard
  (`isHostShapedToken`) was added alongside it. Commits `8777a22c`, `3a177d4b`.
- `corpus-sweep.ts` harness added (blackbox, resumable): first scorecard 33 repos analyzed
  (5 standalone + 28 sub-repos across 3 workspaces, including an 89 GB workspace with a 61 GB
  `target/` directory correctly excluded), 0 crashes.

See `docs/CORPUS-VALIDATION.md` for full methodology and `docs/COMPETITIVE-PROOF.md` for the
284-win/3-tie/0-loss competitive scorecard shipped in this release line.
