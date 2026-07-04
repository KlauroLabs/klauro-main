# Changelog

All notable changes to Klauro are recorded here. Entries are grounded in commits, test runs, or
agent-feedback reports (`~/.klauro/agent-feedback/*.md`) — nothing is asserted without a source.
Where an item was still in flight at the time this entry was written, it is marked **pending
final verify** rather than presented as done.

## v1.0.12 — Conceptual understanding layer (in progress at time of writing)

Status note: this entry describes work present in the working tree as `git status` showed it at
write time (uncommitted/untracked — see `docs/RAISE-DECK.md` §7). v1.0.11 (commit `5292d01f`) is
the latest **tagged/released** version; v1.0.12 has not yet been cut. Tool count at write time:
**199** registered tools (`grep -c registerTool( apps/mcp-server/src/server.ts`), up from 197 at
v1.0.11.

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

### In progress — pending final verify

These were active (claimed but not yet released in the parallel work-fabric) at the time this
changelog entry was written. Do not treat them as shipped until independently re-verified against
a later commit.

- **Registration/entry-point → real-handler edge-linking** (`edgelink` claim,
  `orchestrator.ts`/`react-analyzer.ts`/`server.ts`) — intended to close the exact gap
  `get_flow_concepts` flagged honestly above (React `hook_usage` nodes and this repo's own
  `entry_mcp_tool_*` markers have no outgoing call edge to the function they actually invoke,
  so flows degrade to correct-but-shallow single steps on those entry points). Uncommitted
  changes were present in the working tree (`mcp-tool-registration-analyzer.ts`,
  `react-analyzer.ts`, `terminal-signal.ts`, plus new tests
  `react-hook-fetcher-edges.test.ts`/`structural-cross-links.test.ts`) but no completion feedback
  file existed yet at write time — **pending final verify**.
- **Structural-perspective unification** (`structural-unify` claim, `query.ts`/`server.ts`/
  `architectural-conflicts.ts`/`paradigm-conformance.ts`) — intended to bring
  `get_architectural_conflicts`/`get_paradigm_conformance`/`get_perspectives` under the same
  conceptual-layer vocabulary as flows/steps. Claim was still active at write time with no
  completion feedback file — **pending final verify**.
- **End-to-end fabric fleet proof** (`fabric-proof` claim,
  `apps/mcp-server/src/gauntlet/fabric-fleet-proof.ts`, `docs/FABRIC-FLEET-PROOF.md`) — intended
  as a live multi-agent proof run over the conceptual fabric. Neither the script's output nor
  `docs/FABRIC-FLEET-PROOF.md` existed in the repo at write time — **pending final verify**.
- **Hash/id-token domain-naming guard hardening** (`hashaudit` claim, `orchestrator.ts`) — a
  continuation of the corpus-validation hash-domain fixes already released in v1.0.11
  (`isGenericDomainToken`/`isHashOrIdShapedToken`, commits `8777a22c`/`3a177d4b`); still active at
  write time — **pending final verify** for whatever incremental hardening it adds beyond what's
  already shipped.

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
