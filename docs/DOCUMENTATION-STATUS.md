# Documentation Status

Audit date: 2026-07-02. Scope: every `.md` file in the repo except `.agents/` (evidence/
handoff working files, not product docs), `.claude/worktrees/` (a stale parallel worktree
copy), fixture repos under `apps/mcp-server/fixtures/`, and generated benchmark reports
under `apps/mcp-server/.klauro-*/`. This file is the living index; update it when docs
change materially rather than letting it drift.

## Inventory

| Doc | Purpose | Status | Issue |
| --- | --- | --- | --- |
| `README.md` | Repo layout, common commands | current | none found |
| `CLAUDE.md` | Agent operating instructions | not reviewed in depth (outside doc-content scope) | |
| `AGENTS.md` | Agent operating instructions (Codex-facing) | not reviewed in depth | |
| `CONTEXT.md` | Root context pointer | not reviewed in depth | |
| `apps/api/README.md` | Legacy API app | stale by design | README already labels API as non-current per root `README.md` "Current Product Center" note |
| `apps/app/README.md` | Legacy web app | stale by design | same as above |
| `apps/marketing-site/README.md` | Marketing site | not reviewed | |
| `docs/AI-PROVIDER.md` | AI provider setup | current | |
| `docs/CAMPS.md` | Competitive doctrine (Camp A/B/C taxonomy) | current | matches live CAS/WAS field names verified against `cas.types.ts` and `cross-codebase-analysis.ts` |
| `docs/COMPETITOR-SCORECARD.md` | Generated competitor benchmark scorecard | current (dated 2026-07-01) | generated artifact, regenerate rather than hand-edit |
| `docs/KLAURO-ANALYSIS-FLOW.md` | Analysis flow model | current | |
| `docs/KLAURO-PRODUCT-MODEL.md` | Authoritative product model | current | |
| `docs/PRODUCT-RUNTIME.md` | Runtime weight budget | current | |
| `docs/SECURITY-PRIVACY.md` | Data inventory & egress | current | |
| `docs/SPEC-COORDINATION-FABRIC.md` | Coordination fabric build spec | current, correct as a design spec (per task instructions, not to be edited) | now has a companion user-facing doc: `docs/COORDINATION-FABRIC.md` |
| `docs/SPEC-FRESHNESS.md` | Always-fresh-on-read spec | current, correct as a design spec (not edited) | **not yet implemented**: `getFreshAnalysisForAgent` still gates only ~15 of ~191 tools, `resolve_agent_analysis` still does not act on the freshness it reports (verified live: function still named `getFreshAnalysisForAgent`, spec's proposed rename/widening has not landed) |
| `docs/SPEC-RESPONSE-BUDGET.md` | Default-compact response spec | current, correct as a design spec (not edited) | **partially implemented**: `detail: 'compact'/'full'` param has landed on `get_summary`, `resolve_agent_analysis`, `search_nodes` (verified live in `server.ts`); `get_coding_context` caller/callee limit is still hardcoded per the spec's own note |
| `docs/cas/CAS_GAPS.md` | Known CAS gaps | not reviewed in depth | |
| `docs/cas/CAS_ROADMAP.md` | CAS roadmap | not reviewed in depth | |
| `docs/cas/DETERMINISM-BOUNDARY.md` | Determinism boundary doc | not reviewed in depth | |
| `docs/cas/README.md` | CAS docs index | not reviewed in depth | |
| `docs/cas/SPECIFICATION.md` | Formal CAS spec | current | version history section present, matches `CAS_VERSION` |
| `docs/cas/VERSIONING.md` | CAS versioning policy | current | correctly documents 1.11.0 as current, matches `cas.types.ts` |
| `docs/cas/v1.0.0.md` … `v1.10.0-rfp.md` | Per-version RFPs/changelogs | archival, current as history | no action needed — these are dated snapshots, not living docs |
| `docs/context/*.md` (14 files) | Legacy planning/vision/flow-path docs | **likely stale** | several (`VISION.md`, `PROJECT_PLAN.md`, `CRITICAL_FLOW_PATHS*.md`, `DESIGN_FLOW_PATHS.md`, `WORKSPACE_FRONTEND_IMPLEMENTATION.md`) read as pre-dating the current analyzer/MCP-centric product direction (root `README.md` explicitly says the API/web app are "no longer top-level surfaces"); not rewritten in this pass — flagged for a follow-up archival/rewrite decision rather than blind deletion, since some (`ANALYZER-ORCHESTRATION.md`, `MOAR_CONTEXT.md`) may still describe live analyzer internals |
| `docs/marketing/FRAMER_SITE_COPY.md` | Marketing copy | not reviewed | |
| `docs/mcp/AGENT-CONTEXT-LANGUAGE.md` | K15/K5 capsule language | current | |
| `docs/mcp/AGENT-PERFORMANCE-PROOF.md` | Agent performance proof | not reviewed in depth (evidence doc) | |
| `docs/mcp/ANALYSIS-PERFECTION-AUDIT.md` | June 2026 audit | archival | dated content, no action needed |
| `docs/mcp/ANALYZER-COVERAGE.md` | Analyzer language/framework coverage | not reviewed in depth | |
| `docs/mcp/CAS-COVERAGE.md` | CAS field -> MCP tool coverage matrix | **fixed this pass** | said "v1.9 analysis storage"; current version is 1.11.0. Updated header and Coverage Status paragraph to reference 1.11.0, the behavior pillars, and the new coordination fabric surface |
| `docs/mcp/CLAUDE-MD-PROMPT.md` | CLAUDE.md operating-loop snippet | current | |
| `docs/mcp/CONFIGURATION.md` | Server config & install | current for the "clone + npm install" path | **gap, not fixed this pass**: does not mention the hosted-tarball distribution path (`curl \| sh` / PowerShell installers, `klauro update`, `/dist/latest.json`, `scripts/release.sh`) documented only in `SPEC-COORDINATION-FABRIC.md`'s current-state matrix and in the user's memory (`klauro-distribution-release.md`) — no product doc explains it |
| `docs/mcp/CUSTOMER-ONBOARDING.md` | First customer experience | not reviewed in depth | |
| `docs/mcp/EXECUTION-CAPSULE.md` | K15/K5 capsule detail | current | |
| `docs/mcp/GETTING-STARTED.md` | Zero-to-first-context walkthrough | current | verified commands/flags against `apps/mcp-server/scripts/install.mjs` region; no distribution-tarball path mentioned (same gap as CONFIGURATION.md) |
| `docs/mcp/PROMPTS.md` | MCP prompts reference | not reviewed in depth | |
| `docs/mcp/REMOTE-ANALYZER.md` | Remote analyzer deployment | not reviewed in depth | |
| `docs/mcp/RESOURCES.md` | MCP resources reference | not reviewed in depth | |
| `docs/mcp/SCORECARD.md` | Nightly eval scorecard | generated artifact | regenerate, don't hand-edit |
| `docs/mcp/SECURITY-REVIEW.md` | Security/privacy minimum | not reviewed in depth | |
| `docs/mcp/TELEMETRY-INGESTION.md` | Telemetry ingestion shape | current | matches `ingest_telemetry` tool and `/v1/telemetry/ingest` route verified live |
| `docs/mcp/TOOLS.md` | Full MCP tools reference | **fixed this pass** | documented 164 of 191 registered tools (verified via `grep -oP "registerTool\(\s*'\K[^']+"` against `server.ts`). Added the entire missing "Multi-Agent Coordination" section (`claim_work`, `release_work`, `heartbeat_work`, `get_active_agents`, `check_collision`, `get_in_flight_changes`, `subscribe_workspace`) with verified parameter/return shapes read directly from `server.ts`. Still missing (not added this pass, lower priority / already covered narratively elsewhere): `get_adrs`, `manage_adr`, `get_clones`, `get_communities`, `get_dead_code`, `get_cross_codebase_analysis`, `run_cross_codebase_analysis`, `list_cross_codebase_analyses`, `get_data_lineage`, `get_paradigm_conformance`, `get_product_map`, `get_user_journeys`, `diff_behavior`, `query_graph`, `get_greenfield_architecture_guidance`, `install_gauntlet_watcher`, `list_gauntlet_watchers`, `stop_gauntlet_watcher`, `run_incremental_gauntlet` — several of these (`get_user_journeys`, `get_paradigm_conformance`, `get_product_map`, `get_data_lineage`) are now covered narratively in the new `docs/COMPREHENSION-LAYER.md`, which points to them by name |
| `docs/mcp/USAGE.md` | Usage guide (1028 lines) | not fully reviewed (large file, spot-checked) | |
| `docs/was/SPECIFICATION.md` | WAS formal spec | not reviewed in depth | |
| `infrastructure/vps/README.md` | VPS deployment | not reviewed | |
| `legacy/database/typescript/README.md` | Legacy DB reference | correctly labeled legacy per root README | |
| `packages/analyzer-core/src/analyzer/integration-summary.md` | Analyzer integration summary | not reviewed in depth | |
| `packages/analyzer-core/src/auth/README.md` | Auth module notes | not reviewed in depth | |
| `.claude/skills/klauro/SKILL.md` | Installable Klauro skill | not reviewed (generated/installable artifact) | |

## Concept coverage gaps (against the session's stated new concepts)

| Concept | Documented? | Where | Action taken |
| --- | --- | --- | --- |
| Category thesis (coordination fabric for fleets) | Spec only, no product doc | `SPEC-COORDINATION-FABRIC.md` | **Created** `docs/COORDINATION-FABRIC.md` — user-facing: what it is, the tools, same-machine + cross-machine, how a fleet uses it |
| Coordination fabric (claims/arbitration/collision/in-flight/telemetry routes) | Spec only; MCP tools existed but were undocumented in `TOOLS.md` | `SPEC-COORDINATION-FABRIC.md`; tools live in `server.ts` | **Created** `docs/COORDINATION-FABRIC.md`; **added** the Multi-Agent Coordination section to `docs/mcp/TOOLS.md` |
| Freshness model (always-fresh-on-read) | Spec only | `SPEC-FRESHNESS.md` | Not yet implemented in code (verified), so no product doc claiming it works was written — would be inaccurate. Recommend writing a short product doc *after* the wiring lands, not before |
| Response budget / compact responses | Spec + partially implemented | `SPEC-RESPONSE-BUDGET.md`; `detail` param live on 3 of ~5 target tools | Not written as a standalone product doc this pass (lower priority than coordination/comprehension); recommend a short addendum to `docs/mcp/USAGE.md` once the remaining tools (`get_coding_context` caller/callee limits) land |
| Distribution/install/update (`curl\|sh`, PowerShell, `klauro update`, `dist/latest.json`, `release.sh`, doctor mcp-registration check) | **Undocumented in any product doc** | scripts exist (`install.sh`, `install.ps1`, `release.sh`) and `mcp-registration-doctor.ts` exists and is wired into `environment-doctor.ts` | Not written this pass — flagged as the single highest-value doc still missing (see Recommendations) |
| Comprehension layer (capabilities, journeys, flow graph, paradigm conformance, patterns, idioms, data lineage, etc. as one coherent story) | Partially, spread across `CAMPS.md` (competitive framing) and scattered `TOOLS.md` entries; no single "what tool for what understanding" map | `CAMPS.md` §C1-C11 | **Created** `docs/COMPREHENSION-LAYER.md` — maps every comprehension category to its CAS fields and MCP tools, verified each tool name against `server.ts` |
| CAS/WAS spec currency | `docs/cas/SPECIFICATION.md` and `VERSIONING.md` current at 1.11.0; `docs/mcp/CAS-COVERAGE.md` was stale at "v1.9" | multiple | **Fixed** `CAS-COVERAGE.md` |

## What was fixed this pass

1. `docs/mcp/CAS-COVERAGE.md` — corrected the stale "v1.9 analysis storage" framing to
   reference `CAS_VERSION` 1.11.0 and the versioning doc; added the v1.10 embedding-index and
   v1.10-line behavior-pillar fields (`user_journeys`, `data_lineage`, `paradigm_conformance`,
   `product_map`) and a pointer to the new coordination fabric doc.
2. `docs/mcp/TOOLS.md` — added the entire missing "Multi-Agent Coordination" section (7
   tools: `claim_work`, `release_work`, `heartbeat_work`, `get_active_agents`,
   `check_collision`, `get_in_flight_changes`, `subscribe_workspace`), with parameter and
   return shapes read directly from the live `registerTool` calls in `server.ts`, not
   guessed.

## What was created this pass

1. `docs/COORDINATION-FABRIC.md` — the user/product-facing companion to
   `SPEC-COORDINATION-FABRIC.md`: what the coordination fabric is, the two-tier
   (same-machine + cross-machine) store, the 7 MCP tools, the HTTP `/v1/coordination/*` +
   `/v1/telemetry/ingest` routes, same-machine-specific hazards it addresses, current
   build state (grounded against source, not aspirational), and a step-by-step "how a fleet
   uses it" walkthrough.
2. `docs/COMPREHENSION-LAYER.md` — the differentiated what/why/how-built/patterns/principles
   story, organized the same way `CAMPS.md` categorizes Camp C (product/domain, journeys,
   behavior/intent, patterns/paradigms, framework/architecture facts, data lineage/security,
   deep call/data flow, runtime, quality/health, workspace-level), with every category
   pointing to the exact MCP tool(s) that produce it — every tool name verified present in
   `server.ts` before being cited (one candidate, `get_decorators`, was dropped because no
   such tool is registered; decorators are exposed inline through other CAS fields instead).

## Recommendations — still needs writing

Priority order:

1. **Distribution/install/update doc** (highest value, zero coverage today). Should live as
   a new section in `docs/mcp/CONFIGURATION.md` or `docs/mcp/GETTING-STARTED.md`: the
   hosted-tarball `curl | sh` / PowerShell install path, `klauro update`, how
   `/dist/latest.json` versioning works, and the `klauro doctor` mcp-registration check
   (`mcp-registration-doctor.ts`, already wired into `environment-doctor.ts`) that verifies
   the MCP server is actually registered and loadable in the detected client. This is a real
   product surface (v1.0.2 shipped per the user's own memory) with no corresponding doc.
2. **Freshness guarantee product doc** — write this *after* `SPEC-FRESHNESS.md`'s wiring
   gap closes (currently only ~15 of ~191 tools call the refresh gate, and
   `resolve_agent_analysis` still doesn't act on the freshness it reports). Writing it now
   would document an aspirational guarantee as if it already holds.
3. **Response-budget / compact-mode addendum** to `docs/mcp/USAGE.md` once the remaining
   target tools in `SPEC-RESPONSE-BUDGET.md`'s table (`get_coding_context` caller/callee
   limits, `get_route_table` page size) get their `detail`/limit params — right now only 3 of
   ~5 target tools have landed the compact-by-default behavior, so a doc today would
   overstate coverage.
4. **`docs/context/*.md` archival pass** — 14 files that read as pre-dating the current
   analyzer/MCP product direction. Not touched this pass because distinguishing "stale
   planning doc, safe to archive" from "still-accurate analyzer internals doc" for each of
   the 14 needs deeper per-file review than this audit's budget allowed; flagging rather than
   guessing.
5. **`docs/mcp/TOOLS.md` remaining gaps** — the ~18 still-undocumented tools listed in the
   inventory row above (ADR management, cross-codebase-analysis tools, gauntlet-watcher
   tools, `query_graph`, `diff_behavior`). Several of the highest-value ones now have a
   narrative home in `docs/COMPREHENSION-LAYER.md`; a full per-tool reference entry in
   `TOOLS.md` is still the more complete fix.

## Dogfood contract (Klauro MCP usage for this audit)

- **Material value: yes, materially.** `resolve_agent_analysis` confirmed a fresh (8-minute-
  old) analysis existed before any exploration, avoiding a blind "does this even have
  tooling" check. `get_summary` and `get_product_map` gave capability/domain/health/coverage
  facts (5 capabilities, 79 data entities, at-risk health score 48, per-language coverage
  caveats) in two calls that would otherwise have required reading `query.ts`'s output
  shapes plus multiple source files to reconstruct. Most importantly, `CAMPS.md`'s own
  Camp-C taxonomy (verified, not trusted blindly) gave `COMPREHENSION-LAYER.md` its entire
  structure — I did not have to invent a categorization scheme, only verify each cited tool
  actually exists via grep against `server.ts`, which caught one wrong tool name
  (`get_decorators`) before it shipped into a doc.
- **Tokens saved vs reading source directly:** the two Klauro calls (`get_summary`,
  `get_product_map`) returned condensed counts and structure in roughly 2-3K tokens combined
  that would otherwise have required reading `packages/analyzer-core/src/types/cas.types.ts`
  (CAS field list), `apps/mcp-server/src/query.ts` (`buildSummary`/`buildProductMap`
  implementations), and `cross-codebase-analysis.ts` — realistically 15-25K+ tokens of raw
  source to reconstruct the same orientation. Estimated savings: roughly 8-10x on the
  orientation step alone. This estimate is not benchmarked in this session (no A/B run) —
  it's a comparison against the alternative path I would have taken (Read on the 3 files
  above) if the MCP tools were unavailable.
  Everything after orientation (verifying tool names, reading TOOLS.md gaps, checking wiring
  in server.ts) was done via grep/Read against source, appropriately — Klauro's structural
  tools are for orientation and finding things, not a substitute for reading the exact code
  a doc is about to cite.
- **Time saved:** orientation (repo shape, capability count, health, coverage caveats) took
  under a minute via 3 parallel tool calls (`resolve_agent_analysis`, `get_summary`,
  `get_product_map`) versus what would have been several minutes of file discovery and
  reading to get the same facts from source.
- **Parallel-conflict: N/A.** This was a solo documentation task with no other agent working
  the same paths concurrently in this session, so the coordination fabric itself was not
  exercised as part of doing this work (though it is, ironically, the subject of one of the
  two docs written).
