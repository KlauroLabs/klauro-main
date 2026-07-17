import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAnalysesFiltered, DEFAULT_LIMIT, MAX_LIMIT } from './analysis-listing';
import type { AnalysisTrack } from './track';
import { listWorkspaceAnalysesFiltered } from './workspace-listing';
import { resolveAnalysisScope, type AnalysisScope } from './analysis-scope';
import { installGauntletWatcher, listGauntletWatchers, stopGauntletWatcher } from './gauntlet/gauntlet-watcher';
import { runIncrementalGauntlet, listIncrementalRecords } from './gauntlet/incremental-gauntlet';
import { appendFileSync } from 'fs';
import * as nodePath from 'path';
import { analyzeProjectIncremental, getAnalysis as getStoredAnalysis, runAnalysis } from './analyzer';
import { compareHostedFreshness, currentAnalysisSourceStamp, hostedSummaryPayload, resolutionIsStaleDegraded, resolveBoundAnalysis, resolveHostedProjectBinding } from './hosted-analysis';
import { getAnalysisEntry, getStorageHealth, listAgenticBenchmarkReports, listAnalyses, listCrossCodebaseSystemGraphs, listWorkspaceGraphs, loadAgenticBenchmarkReport, loadCrossCodebaseSystemGraph, loadGoldenSnapshot, loadLatestAgenticBenchmarkReportByType, loadRuntimeObservations, loadWorkspaceGraph, saveAgenticBenchmarkReport, saveCrossCodebaseSystemGraph, saveGoldenSnapshot, saveRuntimeObservation, saveWorkspaceGraph } from './storage';
import * as query from './query';
import * as adrStore from './adr-store';
import { queryGraph } from './graph-query';
import * as watcher from './watcher';
import * as product from './product';
import * as agentAdoption from './agent-adoption';
import * as agentBootstrap from './agent-bootstrap';
import * as analysisMastery from './analysis-mastery';
import * as runtimeContract from './runtime-contract';
import * as casContract from './cas-contract';
import * as testDiscovery from './test-discovery';
import * as freshness from './freshness';
import * as runtimeSdk from './runtime-sdk';
import * as agentDoctor from './agent-doctor';
import * as workspaceGraph from './workspace-graph';
import * as crossCodebaseAnalysis from './cross-codebase-analysis';
import * as agentDefaults from './agent-defaults';
import * as integrationDepth from './integration-depth';
import * as invariantValidation from './invariant-validation';
import * as agentProjectMap from './agent-project-map';
import * as idiomQuery from './idiom-query';
import * as agentWorkflow from './agent-workflow';
import { formatMarkdownReport, runAgenticBenchmark } from './agent-benchmark';
import { formatQualityMarkdownReport, runAgentQualityBenchmark } from './agent-quality-benchmark';
import { formatIncrementalValueMarkdownReport, runIncrementalValueBenchmark } from './incremental-benchmark';
import { buildAgentPerformanceProof, formatStoredBenchmarkReport } from './agent-performance-proof';
import { formatIdiomBenchmarkMarkdown, runAgentIdiomBenchmark } from './agent-idiom-benchmark';
import { runMachineAgentProof } from './machine-gauntlet';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { getAgentRevisionTracks } from './agent-revision-tracks';
import { buildUploadManifest } from './remote-source';
import { loadKlauroConfig, writeDefaultKlauroConfig, validateConventions, assertLocalAnalysisAllowed, type KlauroConventions } from './klauro-config';
import { resolveSectionFilterForProject } from './context-filter';
import * as fs from 'node:fs/promises';
import { buildGithubImportPlan } from './github-import';
import * as proposalPreview from './proposal-preview';
import * as greenfieldGuidance from './greenfield-guidance';
import * as greenfieldBuildSession from './greenfield-build-session';
import * as descriptionEnrichment from './description-enrichment';
import * as runtimeSimulation from './runtime-simulation';
import * as telemetryIngestion from './telemetry-ingestion';
import { getAnalysisFocusProfiles, withAnalysisFocus, type AnalysisFocus } from './analysis-focus';
import { getDescriptionEnrichmentTargets } from './analysis-usefulness-review';
import { semanticSearch } from './semantic-search';
import { pruneKlauroStorage } from './storage-maintenance';
import { resolveWorkspaceInputPaths, type WorkspaceSkippedInput } from './workspace-inputs';
import { RESPONSE_BUDGET_BYTES, boundToolPayload, boundToolText, serializeToolResponse } from './response-budget';
import { getBuildIdentity, checkServerStaleness } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';
import { attachEntryPointSecurity } from '../../../packages/analyzer-core/src/analyzer/core/entry-point-security';
import { attachDeployable, ensureEntryPointDescription } from '../../../packages/analyzer-core/src/analyzer/core/entry-point-deployable';
import { attachInteractionReach } from '../../../packages/analyzer-core/src/analyzer/core/entry-point-enrichment';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { loadStoredConnectorAuth, normalizeServerUrl } from './connector-auth';
import { arbitrate, detectCollisions, getGrants, heartbeatGrant, releaseGrant, requestGrant, type AgentKind, type CasEdgeRef, type WasCapabilityRef, type WorkClaim } from './coordination';
import { attributeChange, appendClaim, checkEditLock, getActiveClaims, getPresence, readClaimLog, releaseAgentWithReason, watch } from './coordination/local-store';
import { remoteActive, remoteCheck, remoteClaim, remoteRelease } from './coordination/remote-transport';
import { resolveFabricSettings } from './coordination/fabric-config';
import { ensureWriteHookStarted, closeAllWriteHooks, shouldActivateWriteHook } from './coordination/write-hook';
import { deriveActiveClaims } from './coordination/presence';
import { detectConceptualConflicts, type AgentInFlightState, type ConceptualConflict, type ConflictCas, type SymbolChange } from './coordination/conceptual-conflict';
import { detectConceptualConflictsFromSubstrate } from './coordination/in-flight-substrate';
import { computeAdvisoryOverlap, type AdvisoryOverlapFinding } from './context-fabric';
import { captureInFlightChanges } from './coordination/in-flight-capture';
import { planIntentMerge, planIntentMergeFromSubstrate, shouldUseSubstratePlan } from './coordination/intent-merge';
import { partitionTasks, groupTasksByConcept, type PartitionCas, type PartitionTask } from './coordination/partitioner';
import {
  buildConceptIndex,
  deriveConceptualCoordinate,
  compareConceptualCoordinates,
  type ConceptIndex,
} from './coordination/conceptual-scope';
import type { ConceptualCoordinate } from './coordination/types';
import { loadPersistedRuntimeFacts } from './telemetry-fusion';

export const SERVER_INSTRUCTIONS = `Klauro serves a precomputed analysis of this repository — call graph, routes, data flows, entry points, conventions, and tests, queryable directly. Default to it over grep/Read: a query returns real call sites and blast radius, not guesses. The value is the sequence below; each tool's own description has the detail.

Orient (once per repo): resolve_agent_analysis(path) confirms an analysis exists and selects the right one (not an embedded sub-fixture); if none, analyze_codebase. get_summary gives domain, capabilities, and entry points in one call.

Progressive availability (don't wait): structural facts — call graph, routes, entry points, file nodes, data flows — are precomputed and return instantly. They are complete and authoritative; use them immediately. AI-written prose (the system/element descriptions) enriches in the background, so every result carries an ai_enrichment field: 'ready' = prose included; 'pending' = you got deterministic text now, re-call in a few seconds only if you specifically need the richer narrative; 'disabled'/'synchronous' = no background pass, the text you have is final. Never block on 'pending' — act on the structure first; the prose is flavor, the facts are the product.

Find (instead of grep): search_nodes / semantic_search rank nodes by name+meaning with file:line and risk flags. get_route_table for routes (method/path/handler/auth); get_entry_points and get_exit_points for CLI, events, and queues; get_file_nodes for what a file defines; get_data_entities for the domain's data shapes (entities, fields, and who reads/writes them); get_erd for the entity-relationship model + a renderable Mermaid erDiagram (entities, fields, evidence-gated cardinalities); get_test_summary for the test-suite inventory — pull it before writing tests so you extend the existing suites instead of inventing a parallel harness.

Understand before editing (highest value): get_coding_context(target) returns the node plus conventions, layer boundaries, callers, callees, and the exact tests to run — one call instead of read-file + trace-callers + find-tests. get_callers shows each call site's actual arguments; get_call_chain traces a request end to end; get_data_lineage tracks an entity's reads and writes; get_intent / get_conventions / get_modification_guide explain why it exists and how to change it safely. Before changing an entity, call get_interface_signature to see its full contract — Input (params/entry points it requires), Logic (its caller/callee blackbox wiring), Side-effects (external systems/entities it touches), Output (return type/produced entities) — and blast radius in one call, at function/flow/capability/project/workspace level, instead of joining entry_points + exit_points + data_lineage + get_callers by hand. For the ordered steps a request/job actually moves through (not just one entity's contract), call get_flow_concepts — a named flow per entry point, each step tied to concrete functions (1:1/1:many/sub-section) with its own I/L/S/O + Constraints; use this to coordinate work at the flow/step level ("I own the Persist step of the Checkout flow") instead of file/function.

Behavior surfaces (command/event/message-handler/route registration surfaces) are NAVIGATION AIDS, not capabilities: they live in a separate behavior_surfaces tier (never core/critical, never in top_capabilities). get_summary lists their names + entry-point counts; get_system_overview carries the full tier. Use them to find WHERE handlers register, and the capability catalog for WHAT the product does.

Think in levels, not just files (Capability -> Flow -> Step -> Function): get_summary names the capabilities; get_flow_concepts breaks each into named flows as ordered steps, each step carrying its own Input/Logic/Side-effects(state_changes vs external_integrations)/Output/Constraints; get_coding_context/get_call_chain drill a step down to its concrete function(s) — 1:1, 1:many, or a sub-section of one function. Every level answers the same shape of question, so "what does this do, what does it touch, what rule must hold" is answerable uniformly from one function up to a whole capability — orient wide with get_summary, then narrow through get_flow_concepts before you ever drop to a single file.

Every unit (flow, step, function/node) carries the SAME uniform 6-facet understanding contract (docs/UNDERSTANDING-MODEL.md), all evidence-gated — never fabricated, absent facets omitted: (1) input, (2) output, (3) logic, (4) system effects (state_changes vs external_integrations), (5) constraints — first-class {kind, rule, evidence} where kind is validation | auth | rate-limit | error | invariant | business-rule | consistency (a consistency constraint means "reads here may be eventually consistent / stale" — a real correctness rule, not a hint), and (6) telemetry — real runtime request_count/error_rate/p50-p95-p99 when observations exist. get_flow_concepts returns the full contract per flow AND per step; get_coding_context returns it (incl. the telemetry facet) for one resolved node. When you need "what must hold here" or "how does this actually run", read the constraints/telemetry facets rather than re-deriving them from raw source.

Stay cohesive as the system grows (self-regulation, mandatory before non-trivial additions): lead with the comprehension layer — get_product_map, get_paradigm_conformance, get_patterns — to learn HOW this system is actually built (its layering norm, its dominant design patterns) before writing code that assumes a different shape. Then, before adding a new handler/module/data-access path, call get_architectural_conflicts to check whether what you're about to build would introduce a competing pattern for a concern this codebase already has a norm for (e.g. calling a repository directly where every other handler goes through a service), or an engineering-principle break (layering skip, split ownership of an entity's writes, a new coupling hotspot). A clean is_cohesive:true doesn't mean skip design judgment, but a conflict/violation is a direct signal to align with the existing shape instead of adding a second way to do the same thing — keeping a codebase built by many agents cohesive by construction, not by cleanup after the fact.

Change, then verify: assess_change_risk and get_error_contracts before; validate_agent_change after, to surface ripple (e.g. a dropped DTO field breaking its service and entity) instead of finding it one compile error at a time.

Beyond the static graph — how it RUNS, TALKS, and SHIPS (reach for these on debug/perf/incident/integration work, not just code reading): (1) Runtime "how it runs" — get_runtime_observations returns per-node node_metrics (traffic, error_rate, p50/p95/p99) and get_operational_priorities ranks where load and failures actually concentrate; use them to pick the impactful bug/hot path instead of guessing from structure. (2) Communication seams — get_communication_seams classifies every seam sync / async / passive at node AND deployable level, including shared-state PASSIVE coupling (two components talking through a shared table/cache/bus) that no call-graph or import view shows; call it before changing any integration to see how components really talk. (3) Consistency / CAP — passive seams are tagged strong vs eventual with staleness_risk + cap_lean: a read-replica / CDC / materialized-view seam is EVENTUALLY consistent, a real correctness constraint — do not assume a write is immediately visible across it. (4) Infra + hosting topology — get_product_map's runtime_topology maps each deployable to exposes / routes / depends_on, plus reverse-proxy routes, IaC resources, and CI/CD pipeline/job/step/trigger/deploy facts (how the code ships → get_cicd_pipelines for the first-class pipeline→job→step→trigger→deploy view + job DAG): use it to trace the public-URL -> proxy -> service -> route -> handler chain. (5) Deployables / ship units — a deployable can BUNDLE members (e.g. a client that ships its client-service as one unit, marked bundled_into); treat a bundled member as part of its host, not a separate system.

Cross-repo work (ui -> api -> worker is one product): run_workspace_analysis, then get_workspace_summary / get_workspace_capability_map / get_cross_repo_links.

Default to parallel, through the fabric (not a fallback for when work collides): when a task can fan out, split it and run agents concurrently as the normal posture — each one announcing its flow/step/capability scope through the fabric, always, even when the scopes are obviously disjoint. The fabric is always-on ambient awareness (dedup, conceptual coherence, fleet visibility), not a lock you reach for only on conflict. Serial, one-agent-at-a-time work is the exception that needs a reason; parallel-plus-fabric is the default. You no longer need to fear dozens of agents on the same codebase at once — announce your concept-level scope and the fabric keeps the fleet aware and coherent, so you can go faster, not slower, as more agents join.

Coordinate before you act (multi-agent workspaces — awareness first, never a lockout): before starting any non-trivial edit, call claim_work with the workspace, your agent_id, and the paths/symbols/capability you're about to touch. The fabric makes you AWARE of who else is here and what they intend, so you coordinate — it never blocks work you need. Disjoint work always runs free in parallel (block-time -> 0 for non-overlapping scope). If the verdict is "granted", proceed immediately: heartbeat_work periodically while working so the lease doesn't expire, and release_work the moment you're done or handing off (this instantly frees the scope and promotes the next queued agent, if any). If the verdict is "queued" — meaning another agent's grant genuinely overlaps your scope — you get full awareness in the response, not a dead end: the holder's agent_id, their stated intent, and their lease_status (active/near_expiry/expired), plus an "options" array. If the work is FUNGIBLE (interchangeable with something else), take redirect_hint/free_scope_hint and go do disjoint work instead. If the work is NON-fungible (you specifically need that symbol), you are never denied: wait_and_heartbeat_poll, proceed_with_awareness_if_compatible once you've read the holder's intent and judged the changes compatible, or take_over_stale_lease if their lease_status shows near_expiry/expired. If the verdict is "duplicate", you already hold this exact grant. Use check_collision for the same awareness read-only (no grant taken; surfaces overlapping_grant_holders with intent + lease_status even before you claim) and get_active_agents to see every live grant holder's intent + lease_status plus the queue. Contention is resolved by informed coordination, not lockout — the invariant "one grant per symbol" governs simultaneous blind writes, not your right to reach work you need. Use get_in_flight_changes to see who is touching a specific path and why. This only has value if you actually call it — treat it as mandatory for shared workspaces, not optional bookkeeping.

Catch what textual merge can't (semantic incoherence, not just overlap — now AMBIENT, not opt-in): claim_work/check_collision catch PATH and SYMBOL overlap — two agents touching the same lines. They cannot catch two changes that each merge cleanly on their own but are jointly incoherent (you retype getUser(): User|null -> User while another agent concurrently edits a caller still doing "if (!getUser())"; git sees two valid disjoint diffs and merges them — the bug ships). That is what check_conceptual_conflicts/check_collision are for, and the fabric now SEES what others are changing automatically: every call to either tool ambiently captures your own git working-tree diff (TS/JS files get full before/after signature diffing — signature/return-type/nullability/params — other languages degrade honestly to an unrecognized-change flag) and folds it into your persisted state with zero self-reporting required. Passing your own changes: SymbolChange[] explicitly still works and is merged on top (useful for languages ambient capture can't syntactically diff, or to add before/after detail ambient capture couldn't infer) — but you no longer have to. Conceptual conflicts surface automatically the moment you call either tool; this is fleet-coherence, not textual safety — the two are complementary, run both.

When finishing overlapping work, reconcile by intent, not by textual diff: call plan_intent_merge to get a single MergePlan across everyone touching this workspace — compatible work composes automatically (auto_mergeable, with a rationale naming both intents), only genuine incoherence needs you (needs_resolution — check_conceptual_conflicts findings that would pass a textual merge but shouldn't be auto-merged), and duplicated effort is flagged once instead of kept twice (duplicate_work). It reuses whatever you and others already reported via check_conceptual_conflicts/check_collision — no extra bookkeeping if you were already calling those.

Before fanning work out to a fleet, plan the batching instead of guessing it: call plan_parallel_work with your pending task list (and the repo path) to turn it into the maximally-parallel non-conflicting batches up front — it uses the same CAS blast-radius awareness as the rest of this group, so tasks that look textually disjoint but reach into the same call-graph surface still land in different batches.

Trust, then verify: every result is stamped to a commit/branch. If get_file_nodes returns nothing for a file you can see on disk, it is likely on an unmerged branch — re-analyze or read that one file. On any tool error, fall back to reading. Don't lean on a single tool; no one view is the whole picture.

Watch for silent server staleness: \`klauro update\` overwrites the installed MCP server on disk, but an ALREADY-RUNNING server process keeps executing the OLD build in memory until the client restarts — MCP servers do not hot-reload, and this happens with no error, just missing tools or stale behavior. Every get_summary / get_system_overview response (and anything else on the freshness-stamped orient path) carries a server_update field once it becomes known (empty on the very first call of a session, populated from the second call onward) whenever a newer build is installed or available; get_server_version is the direct, always-fresh way to check on demand and returns the same finding as running_stale/server_update plus installed_version. If you see server_update or a get_server_version note asking for a restart, relay it to the human verbatim — restarting the MCP client (Claude Code / IDE) is the only way to pick up the new build.`;

// Freshness-gated read: this is now the DEFAULT way any agent-entry tool reads
// CAS, not a special agent-only path (see docs/SPEC-FRESHNESS.md). It checks the
// cheap (~sub-100ms, 5s-memoized) git-diff based staleness summary and, only when
// stale, runs analyzeProjectIncremental — which is changed-file-only and
// content-hash cached, so the common case (nothing changed) costs one git scan,
// not a re-parse. The name is kept as getFreshAnalysisForAgent for call-site
// continuity; every agent-entry tool should route through this instead of the
// raw getAnalysis(path).
async function getFreshAnalysisForAgent(projectPath: string) {
  // Project-bound repo (.klaurorc with a prj_ id + signed-in session): the
  // HOSTED analysis is the source of truth (docs/KLAURO-PRODUCT-MODEL.md).
  // resolveBoundAnalysis serves it (via a coherent local mirror keyed by the
  // hosted analysis_timestamp) and NEVER silently runs a local analysis —
  // when the server is unreachable it degrades honestly to the local cache
  // (stamped with a note) or fails with an explicit error. Unbound repos keep
  // the legacy local freshness-gated path below, including auto-analyze.
  const binding = await resolveHostedProjectBinding(projectPath).catch(() => null);
  if (binding) {
    return (await resolveBoundAnalysis(binding)).cas;
  }

  try {
    const cas = await getStoredAnalysis(projectPath);
    const summary = freshness.summarizeAnalysisFreshness(projectPath, cas.analysis_timestamp);
    if (!summary || summary.staleness === 'fresh') return cas;
  } catch {
    // Missing analysis falls through to the same incremental path as stale analysis.
  }

  return (await analyzeProjectIncremental(projectPath)).output;
}

/**
 * Bound-aware analysis read used by every direct tool handler in this file
 * (the former raw import of analyzer.getAnalysis). For a project-bound repo
 * the hosted analysis wins (same resolution as getFreshAnalysisForAgent);
 * track-scoped reads (in-flight / other-branch) are local-only concepts and
 * bypass hosted resolution, as does any unbound repo — those paths are
 * byte-for-byte the legacy local-store behavior.
 */
async function getAnalysis(projectPath: string, options?: { track?: import('./track').AnalysisTrack }) {
  if (!options?.track) {
    const binding = await resolveHostedProjectBinding(projectPath).catch(() => null);
    if (binding) {
      return (await resolveBoundAnalysis(binding)).cas;
    }
  }
  return getStoredAnalysis(projectPath, options);
}

/**
 * TELEMETRY facet (facet 6 of the uniform understanding contract): load
 * persisted runtime observations for `path` and roll them up into per-node
 * metrics (product.buildNodeRuntimeMetrics), returning them in the shape the
 * flow/coding-context telemetry join consumes. Best-effort and evidence-gated:
 * returns [] when there are no observations, so the join simply omits the
 * facet — nothing is fabricated. Reuses `path` as the workspace key, the same
 * convention get_runtime_observations / ingest_telemetry / get_coding_context
 * already use.
 *
 * BUG FIX: this used to call storage.ts `loadRuntimeObservations` directly,
 * which only reads the LEGACY runtime-observations.json store (populated by
 * record_runtime_event / simulate_runtime_telemetry). It silently missed the
 * `ingested` store (telemetry-ingestion.ts, populated by ingest_telemetry,
 * the `/api/telemetry/runtime-events/:projectId` SDK route, and Klauro's own
 * self-telemetry loop — see self-telemetry.ts) — i.e. exactly the sources of
 * real production traffic. `get_runtime_observations` (below) already reads
 * through `telemetryIngestion.loadTelemetryObservations`, which merges both
 * stores and defaults to `source: 'ingested'`; this facet now does the same,
 * plus the same lazy backfill/re-correlation upgrade, so a node that already
 * has real ingested telemetry but was persisted before its CAS existed still
 * shows up correlated instead of "unmatched".
 */
/**
 * Candidate telemetry storage keys for `path`: the literal caller-supplied
 * path, PLUS (when different) the root path the CAS itself records it was
 * analyzed from (`cas.system.root_path`). Telemetry is persisted per
 * project-path bucket (see `getProjectStorageDir`/`projectSlug` in storage.ts,
 * a hash of the literal path string), so an ingest source that used the
 * ANALYZED root as its project id — the natural, most-common wiring for any
 * self-instrumented or SDK-instrumented service, not specific to any one
 * project — lands observations under a key the caller's own `path` argument
 * may not literally match (e.g. a hosted-bound caller path vs the root the
 * hosted analysis itself was produced from). Trying both is a strict,
 * evidence-gated widening: a project with no such alternate root, or whose
 * root already equals `path`, behaves exactly as before.
 */
function telemetryProjectPathCandidates(cas: CASOutput, path: string): string[] {
  const candidates = [path];
  const root = (cas as unknown as { system?: { root_path?: string } })?.system?.root_path;
  if (root && typeof root === 'string' && root.trim() && root !== path) candidates.push(root);
  return candidates;
}

async function runtimeMetricsForContract(cas: CASOutput, path: string): Promise<product.NodeRuntimeMetrics[]> {
  try {
    const candidateKeys = telemetryProjectPathCandidates(cas, path);
    const loadObservations = async () => {
      const sets = await Promise.all(candidateKeys.map(key => telemetryIngestion.loadTelemetryObservations(key)));
      const byId = new Map<string, product.RuntimeObservation>();
      for (const set of sets) {
        for (const observation of set.observations) byId.set(observation.id, observation);
      }
      return [...byId.values()];
    };
    let observations = await loadObservations();
    if (observations.some(observation => observation?.correlation?.status === 'unmatched')) {
      const backfills = await Promise.all(
        candidateKeys.map(key => telemetryIngestion.backfillIngestedTelemetry(cas, key).catch(() => null))
      );
      if (backfills.some(backfill => backfill && backfill.upgraded > 0)) observations = await loadObservations();
    }
    if (!observations || observations.length === 0) return [];
    return product.buildNodeRuntimeMetrics(cas, observations);
  } catch {
    return [];
  }
}

/**
 * GAP #32 fix — telemetry -> ENTRY-POINT keying.
 *
 * `product.buildNodeRuntimeMetrics` (the read-side rollup `runtimeMetricsForContract`
 * returns) already groups a runtime observation under whatever the RICHEST key
 * available is: a resolved CAS static/node id when correlation succeeded, else the
 * raw `method + route` the observation carried (see `buildNodeRuntimeMetrics`'
 * grouping key, apps/mcp-server/src/product.ts). But `get_entry_points` — unlike
 * `get_flow_concepts`/`get_coding_context` (which resolve a single node and pick up
 * `product.buildNodeRuntimeMetrics`' output via a node-id join) — never consulted
 * runtime metrics at all: it returned bare `cas.entry_points` slices, so an entry
 * point's own request_count/error_rate/p50-p95-p99 never appeared anywhere, even
 * when a metric existed for its exact route+method.
 *
 * The deeper reason a route-level join is the right key (not just node id): a very
 * common real-world telemetry source — Klauro's own self-telemetry loop
 * (self-telemetry.ts) among others — emits one runtime event per completed HTTP
 * request carrying method+route+status+duration, and correlation against a CAS
 * node is BEST-EFFORT (stack-frame/file-hint matching, see telemetry-ingestion.ts
 * `resolveHintNode` and product.ts `correlateRuntimeEvent`). When that correlation
 * misses or lands on the wrong node (e.g. a differing container mount root that
 * `filesLikelySameSource` still can't bridge), the observation is still carrying a
 * perfectly good method+route — the SAME identity the entry point's own
 * `trigger.method`/`trigger.path` already records. Keying the entry-point join off
 * the route (normalized, with light param-wildcard tolerance so `/invoices/:id` and
 * `/invoices/123` are treated as the same entry) closes that gap without requiring
 * node-level correlation to succeed at all.
 *
 * Matching precedence per entry point (first hit wins, so an exact CAS-level
 * correlation is always preferred over the route fallback):
 *   1. entry point id === metric static_id / entry_point_id
 *   2. entry point handler.node_id or source_node === metric node_id
 *   3. entry point trigger.method + trigger.path routes-compatible with the
 *      metric's method + route (case-insensitive, trailing-slash-insensitive,
 *      `:param`/`{param}` segments treated as wildcards)
 *
 * Backward compatible: an entry point with no matching metric (or when there are
 * no runtime metrics at all) is returned completely unchanged — no `telemetry` key
 * is ever added, so existing consumers that don't expect the field see no diff.
 * This is also where any OTHER optional per-entry-point field an analyzer pass may
 * have added (`input`, `output`, `security`, `capabilities`, `interaction_reach`,
 * `deployable_id`, `deployable_name`) passes through untouched: entry points are
 * spread verbatim (`{ ...ep, telemetry }`), never reconstructed field-by-field, so
 * an absent optional field simply never appears in the spread and a present one
 * always does — safe whether or not those analyzer-side fields exist yet.
 */
export function normalizeEntryRoute(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\?.*$/, '')
    .replace(/\$\{[^}]*\}/g, ':param')
    .replace(/:[a-z0-9_]+/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function entryRouteSegments(route: string): string[] {
  return route.split('/').filter(Boolean);
}

/** Bounded route-compatibility check: exact match, wildcard-segment match when
 *  either side carries a `:param` segment, or a literal suffix relationship
 *  (mirrors product.ts' internal `routesCompatible`, duplicated locally in
 *  minimal form since that helper isn't exported and this file may not modify
 *  product.ts). */
export function entryRoutesCompatible(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(':param') || right.includes(':param')) {
    const leftParts = entryRouteSegments(left);
    const rightParts = entryRouteSegments(right);
    if (leftParts.length === rightParts.length) {
      return leftParts.every((part, index) => part === rightParts[index] || part === ':param' || rightParts[index] === ':param');
    }
    return false;
  }
  return left.endsWith(right) || right.endsWith(left);
}

/** Locate the runtime metric (if any) that identifies THIS entry point, by id,
 *  handler/source node, then normalized route+method. Returns undefined (never
 *  fabricated) when nothing matches. */
export function matchTelemetryForEntryPoint(
  entryPoint: Record<string, any>,
  runtimeMetrics: product.NodeRuntimeMetrics[],
): product.NodeRuntimeMetrics | undefined {
  if (!runtimeMetrics || runtimeMetrics.length === 0) return undefined;
  const ids = [entryPoint?.id, entryPoint?.handler?.node_id, entryPoint?.source_node].filter(
    (value): value is string => Boolean(value)
  );
  const entryRoute = entryPoint?.trigger?.path ? normalizeEntryRoute(String(entryPoint.trigger.path)) : undefined;
  const entryMethod = entryPoint?.trigger?.method ? String(entryPoint.trigger.method).toUpperCase() : undefined;

  return runtimeMetrics.find(metric => {
    if (metric.static_id && ids.includes(metric.static_id)) return true;
    if (metric.entry_point_id && ids.includes(metric.entry_point_id)) return true;
    if (metric.node_id && ids.includes(metric.node_id)) return true;
    if (!entryRoute || !metric.route) return false;
    const metricMethod = metric.method ? metric.method.toUpperCase() : undefined;
    if (entryMethod && metricMethod && entryMethod !== metricMethod) return false;
    return entryRoutesCompatible(entryRoute, normalizeEntryRoute(metric.route));
  });
}

/**
 * Attach the per-entry-point `telemetry` facet ({request_count, error_rate,
 * p50, p95, p99}) when a runtime metric identifies that entry (see
 * `matchTelemetryForEntryPoint` above for the join precedence). Evidence-gated
 * and additive: entries with no match, or when `runtimeMetrics` is empty, are
 * returned byte-for-byte as passed in.
 */
export function attachEntryPointTelemetry<T extends Record<string, any>>(
  entryPoints: T[],
  runtimeMetrics: product.NodeRuntimeMetrics[],
): T[] {
  if (!runtimeMetrics || runtimeMetrics.length === 0 || !Array.isArray(entryPoints) || entryPoints.length === 0) {
    return entryPoints;
  }
  return entryPoints.map(entryPoint => {
    const match = matchTelemetryForEntryPoint(entryPoint, runtimeMetrics);
    if (!match) return entryPoint;
    return {
      ...entryPoint,
      telemetry: {
        request_count: match.request_count,
        error_rate: match.error_rate,
        ...(match.latency?.p50_ms != null ? { p50: match.latency.p50_ms } : {}),
        ...(match.latency?.p95_ms != null ? { p95: match.latency.p95_ms } : {}),
        ...(match.latency?.p99_ms != null ? { p99: match.latency.p99_ms } : {}),
      },
    };
  });
}

export type ToolProfile = 'core' | 'core-no-pillars' | 'full';

export function resolveToolProfile(): ToolProfile {
  const value = (process.env.KLAURO_TOOL_PROFILE || '').trim().toLowerCase();
  if (value === 'core') return 'core';
  if (value === 'core-no-pillars') return 'core-no-pillars';
  return 'full';
}

export const PILLAR_TOOL_NAMES = [
  'get_user_journeys',
  'get_paradigm_conformance',
  'get_data_lineage',
  'diff_behavior',
  'get_product_map',
];

function blockedToolNames(profile: ToolProfile): Set<string> {
  return new Set(profile === 'core-no-pillars' ? PILLAR_TOOL_NAMES : []);
}

function directToolNames(profile: ToolProfile): string[] {
  const blocked = blockedToolNames(profile);
  return CORE_TOOL_NAMES.filter(name => !blocked.has(name));
}

export const CORE_TOOL_NAMES = [
  'resolve_agent_analysis',
  'get_agent_start_context',
  'get_agent_tool_plan',
  'get_agent_context',
  'search_nodes',
  'get_coding_context',
  'assess_change_risk',
  'find_tests',
  'validate_agent_change',
  'get_product_map',
  'get_user_journeys',
  'run_answer_pack',
  'get_server_version',
];

const GATEWAY_TOOL_NAME = 'klauro_query';

interface RegisteredToolEntry {
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (...args: any[]) => any;
}

// W5 (SPEC-COORDINATION-FABRIC-V3 §8): registered once per process (guarded
// below), NOT once per createServer() call — tests construct createServer()
// repeatedly and must not stack up duplicate 'exit' listeners. Closing every
// write-hook on process exit is the shutdown half of the activation in
// `advisoryFabricSettings` below; `closeAllWriteHooks` is itself idempotent.
let writeHookShutdownRegistered = false;

export function createServer(): McpServer {
  if (!writeHookShutdownRegistered) {
    writeHookShutdownRegistered = true;
    process.on('exit', () => closeAllWriteHooks());
  }
  const toolProfile = resolveToolProfile();
  const server = new McpServer(
    { name: 'klauro', version: getBuildIdentity().version },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  const toolRegistry = recordToolRegistrations(server, toolProfile);
  enableToolCallLogging(server);
  registerTools(server);
  if (toolProfile !== 'full') registerToolGateway(server, toolRegistry, toolProfile);
  registerResources(server);
  registerPrompts(server);

  return server;
}

function recordToolRegistrations(server: McpServer, profile: ToolProfile): Map<string, RegisteredToolEntry> {
  const registry = new Map<string, RegisteredToolEntry>();
  const originalRegisterTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, config: any, handler: (...args: any[]) => any) => {
    const boundedHandler = withResponseBudget(name, config, handler, profile);
    registry.set(name, { config, handler: boundedHandler });
    if (profile !== 'full' && !directToolNames(profile).includes(name) && name !== GATEWAY_TOOL_NAME) return undefined;
    return originalRegisterTool(name as any, config as any, boundedHandler as any);
  };
  return registry;
}

function withResponseBudget(
  name: string,
  config: { inputSchema?: Record<string, unknown> } | undefined,
  handler: (...args: any[]) => any,
  profile: ToolProfile
): (...args: any[]) => Promise<any> {
  return async (...args: any[]) => enforceResponseBudget(name, config, await handler(...args), profile);
}

function enforceResponseBudget(
  name: string,
  config: { inputSchema?: Record<string, unknown> } | undefined,
  result: any,
  profile: ToolProfile
): any {
  if (!result || result.isError || !Array.isArray(result.content)) return result;
  if (result.content.length !== 1 || result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string') return result;
  const text = result.content[0].text;
  if (Buffer.byteLength(text, 'utf8') <= RESPONSE_BUDGET_BYTES) return result;

  const options = {
    tool: name,
    parameterNames: Object.keys(config?.inputSchema ?? {}),
    viaGateway: profile !== 'full' && name !== GATEWAY_TOOL_NAME && !directToolNames(profile).includes(name),
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...result, content: [{ type: 'text', text: boundToolText(text, options) }] };
  }
  const bounded = boundToolPayload(parsed, options);
  return { ...result, content: [{ type: 'text', text: serializeToolResponse(bounded) }] };
}

const GATEWAY_TOOL_GROUPS: Array<{ label: string; tools: string[] }> = [
  { label: 'Analysis management', tools: ['analyze_codebase', 'get_analysis_focus_profiles', 'get_description_enrichment_targets', 'generate_element_description', 'get_element_description', 'get_analysis_phases', 'run_analysis_layer', 'initialize_klauro_project', 'get_klauro_project_config', 'declare_convention', 'get_upload_manifest', 'get_agent_revision_tracks', 'get_github_import_plan', 'analyze_codebase_remote', 'sync_codebase_remote', 'list_analyses', 'validate_cas_contract', 'get_storage_health', 'get_storage_maintenance_report', 'prune_storage_artifacts', 'preview_codebase_iteration', 'get_greenfield_architecture_guidance', 'get_greenfield_build_context', 'preview_greenfield_codebase', 'get_preview_analysis', 'compare_analysis_iterations', 'get_analysis_freshness', 'get_test_discovery_evidence', 'save_cas_golden_snapshot', 'compare_cas_golden_snapshot'] },
  { label: 'System understanding and agent workflow', tools: ['get_summary', 'get_system_overview', 'get_architecture_context', 'list_answer_packs', 'get_mcp_demo_flow', 'get_cross_repo_links', 'run_workspace_analysis', 'resolve_workspace_analysis', 'get_workspace_summary', 'get_workspace_analysis', 'get_workspace_agent_context', 'get_workspace_freshness', 'validate_was_contract', 'get_workspace_health', 'get_workspace_risk_context', 'get_workspace_capability_map', 'get_workspace_entity_map', 'get_workspace_workflow', 'list_workspace_analyses', 'run_cross_codebase_analysis', 'get_cross_codebase_analysis', 'list_cross_codebase_analyses', 'save_workspace_graph', 'get_workspace_graph', 'list_workspace_graphs', 'verify_workspace_link', 'get_agent_bootstrap', 'get_agent_context', 'get_agent_project_map', 'get_agent_doctor', 'get_server_version', 'get_agent_default_config', 'install_agent_default_config', 'get_capability_memory', 'get_idiom_aware_agent_context', 'open_agent_workbench', 'preflight_agent_change', 'get_codebase_agent_rules', 'explain_change_shape', 'evaluate_analysis_truth', 'get_semantic_map', 'get_framework_depth_report', 'get_integration_depth_report', 'get_cross_repo_contracts', 'get_runtime_instrumentation_plan', 'get_runtime_event_contract', 'get_runtime_sdk_package', 'evaluate_agent_task_proof', 'evaluate_agent_readiness', 'run_agentic_benchmark', 'get_agentic_benchmark_report', 'get_agent_performance_proof', 'run_agent_quality_benchmark', 'run_agent_idiom_benchmark', 'run_machine_agent_proof', 'run_incremental_value_benchmark', 'get_patterns', 'get_codebase_idioms', 'get_idiom_examples', 'validate_codebase_idioms', 'get_pattern_instances', 'get_perspectives'] },
  { label: 'Navigation and search', tools: ['semantic_search', 'get_embedding_status', 'get_node', 'get_file_nodes', 'get_level'] },
  { label: 'Entry points, routes, and call graph', tools: ['get_entry_points', 'get_exit_points', 'get_communication_seams', 'get_route_table', 'get_cicd_pipelines', 'get_external_services', 'get_callers', 'get_callees', 'get_call_chain', 'get_method_calls', 'get_interface_signature', 'get_flow_concepts'] },
  { label: 'Component hierarchy', tools: ['get_component_parents', 'get_component_children', 'get_component_metrics', 'get_shared_components'] },
  { label: 'Coding context and conventions', tools: ['get_conventions', 'get_modification_guide', 'get_pattern_examples', 'find_similar_code', 'get_comments', 'get_error_contracts', 'get_framework_guidance', 'get_usage_examples', 'get_configuration'] },
  { label: 'Intent, data, and risk', tools: ['get_intent', 'get_data_entities', 'get_security_overview', 'get_behavioral_invariants', 'validate_behavioral_invariants', 'get_stability', 'get_flow_coverage', 'get_semantic_coverage'] },
  { label: 'Workflows, capabilities, and runtime', tools: ['get_workflows', 'get_paradigm_conformance', 'get_architectural_conflicts', 'get_unified_perspectives', 'get_data_lineage', 'diff_behavior', 'get_flow_graph', 'get_runtime_static_links', 'simulate_runtime_telemetry', 'correlate_runtime_event', 'record_runtime_event', 'ingest_telemetry', 'get_runtime_observations', 'get_operational_priorities', 'get_runtime_trace', 'get_analysis_facts', 'get_domain_concepts'] },
  { label: 'Behaviors, testing, data, and health', tools: ['get_behaviors', 'get_lifecycle_hooks', 'get_test_summary', 'get_database_schema', 'get_erd', 'get_implementation_health', 'get_system_health', 'get_documentation_coverage', 'get_todos'] },
  { label: 'Dependencies', tools: ['get_dependencies', 'get_libraries'] },
  { label: 'Coverage Intelligence', tools: ['get_coverage_gaps'] },
  { label: 'Change history', tools: ['get_changes_since', 'get_changes_between', 'get_changes_for_node', 'get_changes_for_file', 'get_changes_for_entry_point', 'get_change_summary', 'get_hot_spots', 'get_analysis_at', 'get_analysis_snapshots'] },
  { label: 'Watch mode', tools: ['start_watch', 'stop_watch', 'get_watch_status', 'list_watches', 'poll_watch_changes', 'install_gauntlet_watcher', 'list_gauntlet_watchers', 'stop_gauntlet_watcher', 'run_incremental_gauntlet'] },
  { label: 'Multi-agent coordination', tools: ['claim_work', 'release_work', 'heartbeat_work', 'get_active_agents', 'check_collision', 'check_conceptual_conflicts', 'get_in_flight_changes', 'plan_intent_merge', 'plan_parallel_work', 'subscribe_workspace', 'fab_claim_work', 'fab_check_collision', 'fab_release_work', 'fab_list_active_work'] },
];

function buildGatewayDescription(registry: Map<string, RegisteredToolEntry>, profile: ToolProfile): string {
  const blocked = blockedToolNames(profile);
  const available = new Set(
    [...registry.keys()].filter(name => !CORE_TOOL_NAMES.includes(name) && !blocked.has(name) && name !== GATEWAY_TOOL_NAME)
  );
  const lines: string[] = [];
  for (const group of GATEWAY_TOOL_GROUPS) {
    const names = group.tools.filter(name => available.has(name));
    for (const name of names) available.delete(name);
    if (names.length > 0) lines.push(`${group.label}: ${names.join(', ')}`);
  }
  if (available.size > 0) lines.push(`Other: ${[...available].join(', ')}`);
  return [
    'Run any Klauro analysis tool that is not exposed directly in this core profile.',
    'Pass the tool name and its arguments object; the call dispatches to the same handler as the full tool.',
    `Responses are bounded to ${RESPONSE_BUDGET_BYTES} bytes: oversized results return truncated data plus continuation instructions for paging or narrowing instead of an unbounded payload.`,
    'Available tools by purpose:',
    ...lines,
  ].join('\n');
}

function registerToolGateway(server: McpServer, registry: Map<string, RegisteredToolEntry>, profile: ToolProfile): void {
  const blocked = blockedToolNames(profile);
  server.registerTool(
    GATEWAY_TOOL_NAME,
    {
      title: 'Klauro Query Gateway',
      description: buildGatewayDescription(registry, profile),
      inputSchema: {
        tool: z.string().describe('Name of the Klauro tool to run'),
        args: z.record(z.unknown()).optional().describe('Arguments object for the tool, matching its documented input schema'),
      } as any,
    } as any,
    async ({ tool, args }: any) => withErrorHandling(async () => {
      const entry = registry.get(tool);
      if (!entry || tool === GATEWAY_TOOL_NAME || blocked.has(tool)) {
        const names = [...registry.keys()].filter(name => name !== GATEWAY_TOOL_NAME && !blocked.has(name)).sort();
        throw new Error(`Unknown Klauro tool '${tool}'. Available tools: ${names.join(', ')}`);
      }
      return await entry.handler(parseGatewayArgs(tool, entry, args ?? {}));
    })
  );
}

function parseGatewayArgs(tool: string, entry: RegisteredToolEntry, args: Record<string, unknown>): Record<string, unknown> {
  const shape = entry.config?.inputSchema;
  if (!shape) return args;
  const schema = typeof (shape as any).safeParse === 'function' ? (shape as unknown as z.ZodTypeAny) : z.object(shape);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`Invalid arguments for '${tool}': ${issues}`);
  }
  return parsed.data as Record<string, unknown>;
}

function enableToolCallLogging(server: McpServer): void {
  const logPath = process.env.KLAURO_TOOL_CALL_LOG;
  if (!logPath) return;

  const originalRegisterTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, config: unknown, handler: (...args: any[]) => any) =>
    originalRegisterTool(name as any, config as any, (async (...args: any[]) => {
      try {
        appendFileSync(logPath, `${JSON.stringify({ tool: name, at: new Date().toISOString() })}\n`);
      } catch {
        // Logging must never break tool execution.
      }
      return handler(...args);
    }) as any);
}

function json(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: serializeToolResponse(data) }] };
}

// Honest-but-non-leaking projection of AnalysisScope for multi-analysis list
// tool responses (list_analyses, list_workspace_analyses,
// list_cross_codebase_analyses). Reports isolation is active and names the
// agent's OWN workspace; deliberately omits `workspaceRoot` (a local
// filesystem path) since it is not needed by the caller and could hint at
// directory layout beyond what "scoped to workspace X" should reveal.
function describeScopeForResponse(scope: AnalysisScope): { mode: 'workspace' | 'machine'; workspace_name?: string; reason: string } {
  return {
    mode: scope.mode,
    ...(scope.workspaceName ? { workspace_name: scope.workspaceName } : {}),
    reason: scope.reason,
  };
}

// Stamp the freshness guarantee onto agent-entry tool responses, mirroring the
// existing ai_enrichment progressive-serve field pattern: freshness_checked_at
// makes "no agent-entry response is older than the time since the last
// committed/working-tree change" (SPEC-FRESHNESS.md section 2e) observable
// per-call instead of only asserted in docs. Only applied to responses that are
// plain objects, since some gated tools (e.g. an error object) shouldn't be
// mutated.
function withFreshnessStamp<T>(data: T): T {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // analysis_source: provenance of the served analysis for project-bound
    // repos (hosted / local-mirror / local-cache-degraded + honest note when
    // the hosted service was unavailable). Empty for unbound repos.
    return { ...data, freshness_checked_at: new Date().toISOString(), ...currentAnalysisSourceStamp(), ...serverUpdateStampFields() };
  }
  return data;
}

// Silent-staleness surfacing on the main orient path (get_summary,
// get_system_overview, and everything else routed through withFreshnessStamp):
// the customer-facing bug this exists for is that `klauro update` overwrites
// the installed bundle on disk while an already-running MCP server keeps
// serving the OLD in-memory build, with no signal to the human that a restart
// is needed. checkServerStaleness is async (a disk read + an optional network
// fetch of latest.json) and throttled to ~once per 10min internally, but tool
// responses here must stay synchronous and instant — so this wrapper reads the
// LAST completed check synchronously and kicks off a fresh (still throttled)
// check in the background for next time. The very first call in a process's
// lifetime has no prior result yet, so it returns no server_update field
// rather than blocking the response on the fetch; the field appears from the
// second agent-entry call onward.
let lastKnownStaleness: import('../../../packages/analyzer-core/src/analyzer/core/build-identity').StalenessCheck | undefined;
let stalenessRefreshInFlight = false;

function serverUpdateStampFields(): { server_update?: string } {
  refreshStalenessInBackground();
  if (lastKnownStaleness?.note) return { server_update: lastKnownStaleness.note };
  return {};
}

function refreshStalenessInBackground(): void {
  if (stalenessRefreshInFlight) return;
  stalenessRefreshInFlight = true;
  const auth = loadStoredConnectorAuth();
  const resolvedServerUrl = normalizeServerUrl(auth.defaultServerUrl || process.env.KLAURO_URL);
  checkServerStaleness({ serverUrl: resolvedServerUrl })
    .then(result => { lastKnownStaleness = result; })
    .catch(() => { /* best-effort; a failed background check just leaves the prior result in place */ })
    .finally(() => { stalenessRefreshInFlight = false; });
}

function compactText(value: unknown, max = 180): string | undefined {
  const text = String(value || '').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 15)).trimEnd()}...[truncated]` : text;
}

function compactWorkspaceSemanticItem(item: any): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    description: compactText(item.description, 190),
    description_source: item.description_source,
    criticality: item.criticality,
    semantic_role: item.semantic_role,
    confidence: item.confidence,
    project_ids: Array.isArray(item.project_ids) ? item.project_ids.slice(0, 4) : undefined,
    deployable_ids: Array.isArray(item.deployable_ids) ? item.deployable_ids.slice(0, 4) : undefined,
    evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 3) : undefined,
  };
}

function errorResponse(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function versionUpgradeReport(
  hadPreviousAnalysis: boolean,
  previousVersion: string | undefined,
  newVersion: string | undefined
): { from: string; to: string; note: string } | undefined {
  if (!hadPreviousAnalysis || !newVersion) return undefined;
  const from = previousVersion || 'unknown (stored before versioned index)';
  if (from === newVersion) return undefined;
  return {
    from,
    to: newVersion,
    note: `Stored analysis was upgraded from cas_version ${from} to ${newVersion}. Fields introduced between these versions are now populated for this project.`,
  };
}

/**
 * Best-effort CAS edges for blast-radius arbitration (§WS-C). `workspace` is
 * whatever id/path the caller coordinates under, which may not be an
 * analyzable project path (e.g. a logical workspace id) — arbitration must
 * still work with an empty edge set in that case, so failures are swallowed.
 */
async function casEdgesForWorkspace(workspace: string): Promise<CasEdgeRef[]> {
  try {
    const cas = await getAnalysis(workspace);
    return (cas.edges || []).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type }));
  } catch {
    return [];
  }
}

/**
 * Best-effort WAS capabilities for capability-name arbitration (§WS-C). Resolves
 * the persisted workspace-analysis graph whose inputs cover `workspace` (same
 * resolver `resolve_workspace_analysis` uses) and trims its
 * `workspace_capabilities` to the coordination module's minimal
 * `WasCapabilityRef` shape. `workspace` may be a logical id with no matching
 * WAS analysis (or none has been run yet) — that is expected, not an error,
 * so any failure or empty match falls back to `[]` and arbitration proceeds
 * exactly as before this cross-reference existed.
 */
async function wasCapabilitiesForWorkspace(workspace: string): Promise<WasCapabilityRef[]> {
  try {
    const { selected } = await resolveWorkspaceAnalysisForPaths([workspace]);
    if (!selected) return [];
    const capabilities = Array.isArray(selected.workspace_capabilities) ? selected.workspace_capabilities : [];
    return capabilities.map((capability: any) => ({
      id: capability.id,
      name: capability.name,
      project_ids: Array.isArray(capability.project_ids) ? capability.project_ids.slice(0, 20) : undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Awareness-rich holder context for a conflicting/held grant (§1.6 of
 * docs/SPEC-COORDINATION-FABRIC-V2.md — "awareness is the primitive"). A
 * queued/blocked verdict must never be a dead end: the caller needs to see
 * WHO holds the scope, WHY (their stated intent), and whether the lease is
 * stale enough to safely take over. This reads the raw claim log (same
 * per-workspace `claims.jsonl` grant-manager itself appends to) rather than
 * reaching into grant-manager internals, decoding the `__grant__` JSON
 * marker locally so this stays a read-only, additive projection.
 */
interface GrantHolderContext {
  agent_id: string;
  intent: string;
  granted_at: string;
  lease_expires_at: string;
  lease_status: 'active' | 'near_expiry' | 'expired';
}

async function describeGrantHolders(
  workspace: string,
  agentIds: string[]
): Promise<Record<string, GrantHolderContext>> {
  if (agentIds.length === 0) return {};
  const wanted = new Set(agentIds);
  const active = await getActiveClaims(workspace);
  const out: Record<string, GrantHolderContext> = {};
  const nowMs = Date.now();
  for (const claim of active) {
    if (!wanted.has(claim.agent_id) || out[claim.agent_id]) continue;
    let markerIntent: string | undefined;
    try {
      const parsed = JSON.parse(claim.intent);
      if (parsed && typeof parsed === 'object' && parsed.__grant__?.kind === 'granted') {
        markerIntent = parsed.__grant__.intent;
      }
    } catch {
      // not a grant-manager claim; skip (e.g. a plain edit-lock claim for the same agent).
    }
    if (markerIntent === undefined) continue;
    const leaseMs = Date.parse(claim.heartbeat_at) + claim.ttl_ms;
    const remainingMs = leaseMs - nowMs;
    out[claim.agent_id] = {
      agent_id: claim.agent_id,
      intent: markerIntent,
      granted_at: claim.created_at,
      lease_expires_at: new Date(leaseMs).toISOString(),
      lease_status: remainingMs <= 0 ? 'expired' : remainingMs < 30_000 ? 'near_expiry' : 'active',
    };
  }
  return out;
}

/**
 * Wiring for `check_conceptual_conflicts` / `check_collision` (§1.7
 * SPEC-COORDINATION-FABRIC-V2, "ambient in-flight capture").
 *
 * UPDATED (Fabric-v2 #2): conceptual-conflict detection is no longer
 * exclusively agent-reported. `coordination/in-flight-capture.ts`'s
 * `captureInFlightChanges()` derives a `SymbolChange[]` AMBIENTLY from an
 * agent's actual git working-tree diff (`git diff --name-status HEAD` +
 * before/after content via `git show`), with full syntactic before/after
 * signature diffing for TypeScript/JavaScript files (functions, methods,
 * arrow-function bindings: signature/return-type/nullability/params) and an
 * honest "unknown-change" fallback (`body`/`delete`, no fabricated shape) for
 * every other language and for deletes we can't otherwise diff. See that
 * module's header for the full scope statement.
 *
 * `ambientChangesForWorkspace` below calls this treating `workspace` as the
 * agent's own repo working tree (the common case: `workspace` is a repo path)
 * — best-effort, silently empty if `workspace` isn't a git repo or the
 * capture throws for any reason, so a non-git workspace id degrades to
 * exactly today's agent-reported-only behavior. The ambient changes are
 * MERGED with (not a replacement for) whatever the agent explicitly reports:
 * `check_conceptual_conflicts` still accepts a `changes` argument as a
 * conscious top-up/override (e.g. it can carry before/after detail for a
 * non-TS/JS language this module can't syntactically diff), and
 * `check_collision` still accepts `changes` for the same reason. But an agent
 * that calls EITHER tool with no `changes` at all is no longer silent to the
 * fleet: its ambient TS/JS contract changes are captured and persisted the
 * same way a self-report would be, so OTHER agents' next check sees them —
 * "the fabric now sees what others are changing — conceptual conflicts
 * surface automatically."
 *
 * Persistence mechanism is unchanged from the original design: a
 * `__conceptual__` JSON marker embedded in a `WorkClaim.intent` string (the
 * same technique grant-manager.ts uses for its `__grant__` marker), appended
 * to the SAME same-machine claim log local-store.ts already owns
 * (`appendClaim`/`readClaimLog`). No new store, no edits to coordination/
 * store modules beyond the additive `InFlightSnapshot.changes` field in
 * types.ts.
 *
 * HONEST REMAINING SCOPE: this is still a same-machine, single-repo capture —
 * it reads `workspace` as one git working tree, not a fleet-wide remote view
 * of every agent's checkout. Cross-machine ambient capture (each remote
 * agent's diff arriving via `POST /v1/coordination/in-flight` populating its
 * own `InFlightSnapshot.changes`) is real, valuable follow-on work in
 * remote-analyzer-service.ts (out of this workstream's owned files) — flagged,
 * not faked here.
 */

/**
 * Best-effort ambient `SymbolChange[]` for `workspace`, treating it as the
 * calling agent's own repo path. Returns `[]` (never throws) when `workspace`
 * is not a readable git working tree, when `baseRef` doesn't resolve, or when
 * capture otherwise fails — callers merge this with agent-reported `changes`
 * rather than depending on it exclusively.
 */
async function ambientChangesForWorkspace(workspace: string): Promise<SymbolChange[]> {
  try {
    return await captureInFlightChanges({ repoPath: workspace });
  } catch {
    return [];
  }
}

/** Merge agent-reported and ambiently-captured changes, de-duplicating by symbol_id (reported wins on conflict — it's the more authoritative, conscious signal). */
function mergeChanges(reported: SymbolChange[], ambient: SymbolChange[]): SymbolChange[] {
  const bySymbol = new Map<string, SymbolChange>();
  for (const c of ambient) bySymbol.set(c.symbol_id, c);
  for (const c of reported) bySymbol.set(c.symbol_id, c);
  return [...bySymbol.values()];
}
const CONCEPTUAL_CLAIM_TTL_MS = 30 * 60 * 1000; // 30 min — long enough to outlive a typical edit session.

interface ConceptualMarker {
  __conceptual__: {
    intent: string;
    changes: SymbolChange[];
    reported_at: string;
  };
}

function conceptualClaimId(workspaceId: string, agentId: string): string {
  return `conceptual:${workspaceId}:${agentId}`;
}

function encodeConceptualMarker(marker: ConceptualMarker): string {
  return JSON.stringify(marker);
}

function decodeConceptualMarker(intent: string): ConceptualMarker['__conceptual__'] | undefined {
  try {
    const parsed = JSON.parse(intent);
    if (parsed && typeof parsed === 'object' && parsed.__conceptual__) {
      return parsed.__conceptual__ as ConceptualMarker['__conceptual__'];
    }
  } catch {
    // not a conceptual-conflict report (e.g. a plain edit-lock or grant claim); ignore.
  }
  return undefined;
}

/**
 * Persist the calling agent's reported in-flight changes as a `__conceptual__`
 * marker (re-announcing while still active refreshes the same claim_id rather
 * than piling up duplicates, mirroring `announceEdit`'s edit-lock pattern).
 */
async function reportConceptualChanges(
  workspace: string,
  agentId: string,
  agentKind: AgentKind,
  intent: string,
  changes: SymbolChange[]
): Promise<void> {
  const now = new Date().toISOString();
  await appendClaim(workspace, {
    claim_id: conceptualClaimId(workspace, agentId),
    workspace_id: workspace,
    agent_id: agentId,
    agent_kind: agentKind,
    scope: { repo: workspace, paths: [], symbols: changes.map((c) => c.symbol_id) },
    intent: encodeConceptualMarker({ __conceptual__: { intent, changes, reported_at: now } }),
    status: 'active',
    created_at: now,
    ttl_ms: CONCEPTUAL_CLAIM_TTL_MS,
    heartbeat_at: now,
  });
}

/**
 * All OTHER agents' currently-active (LWW + non-expired) conceptual states
 * for a workspace, excluding `excludeAgentId`. Per Fabric-v2 #2, this is no
 * longer purely agent-reported: any active agent that has EVER reported via
 * `check_conceptual_conflicts` (or had ambient changes persisted for it via
 * `check_collision`) contributes its `__conceptual__` marker's changes, and —
 * additive on top — the caller's own current ambient capture for `workspace`
 * is folded into the requesting agent's own contribution by the tool handlers
 * below, so a fleet where nobody has ever self-reported still sees each
 * other's ambient TS/JS contract changes rather than empty `changes` arrays.
 */
async function otherAgentConceptualStates(
  workspace: string,
  excludeAgentId: string
): Promise<AgentInFlightState[]> {
  const log = await readClaimLog(workspace);
  const active = deriveActiveClaims(log, Date.now()).filter((c) => c.workspace_id === workspace);
  const states: AgentInFlightState[] = [];
  for (const claim of active) {
    if (claim.agent_id === excludeAgentId) continue;
    const marker = decodeConceptualMarker(claim.intent);
    if (!marker) continue;
    states.push({ agent_id: claim.agent_id, intent: marker.intent, changes: marker.changes });
  }
  return states;
}

/** Best-effort CAS in the `ConflictCas` shape `detectConceptualConflicts` needs (nodes id/name, "calls" edges). */
async function conceptualConflictCasForWorkspace(workspace: string): Promise<ConflictCas> {
  try {
    const cas = await getAnalysis(workspace);
    return {
      nodes: (cas.nodes || []).map((n: any) => ({ id: n.id, name: n.name })),
      edges: (cas.edges || [])
        .filter((e: any) => e.type === 'calls')
        .map((e: any) => ({ source: e.source, target: e.target, type: e.type })),
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/**
 * ALWAYS-ON conceptual vocabulary for the fabric (§4 SPEC-CONCEPTUAL-LAYER.md).
 *
 * POSTURE: this is not a collision-only special mode — the fabric represents
 * every active agent's flow/step/capability scope BY DEFAULT, whether or not
 * it overlaps anyone else's. Ambient capture (`ambientChangesForWorkspace`,
 * already unconditional for every `check_collision`/`check_conceptual_conflicts`
 * call regardless of whether a collision is found) is mirrored here for
 * conceptual coordinates: `deriveConceptualCoordinate` runs for EVERY claim/
 * caller that supplies paths/symbols, disjoint or not, because awareness has
 * value with zero overlap — dedup visibility, conceptual coherence across the
 * fleet, standing readiness to notice the moment two agents' scopes DO
 * converge. Overlap/conflict classification (`compareConceptualCoordinates`)
 * is a strict SUBSET filter applied on top of this always-computed
 * representation, never a gate on whether the representation happens at all.
 *
 * Best-effort/degrading: a `workspace` with no analyzable CAS, or one whose
 * CAS has no entry_points to root flows from, yields an empty index — every
 * claim then simply carries no concept (honest degrade to file/symbol-only
 * coordination, exactly today's behavior), never a fabricated coordinate.
 */
async function conceptIndexForWorkspace(workspace: string): Promise<ConceptIndex> {
  try {
    const cas = await getAnalysis(workspace);
    // Internal coordination-fabric index, not an agent-facing token cost —
    // needs every flow to be a correct concept index, so explicitly opt out
    // of getFlowConcepts' default browse-cap (query.ts DEFAULT_MAX_FLOWS)
    // rather than silently losing coverage for entry points beyond it.
    const allEntryPoints = (cas.entry_points || []).length;
    const { flows } = query.getFlowConcepts(cas as any, allEntryPoints > 0 ? { maxFlows: allEntryPoints } : {});
    return buildConceptIndex(flows);
  } catch {
    return buildConceptIndex([]);
  }
}

/**
 * Best-effort CAS in the `PartitionCas` shape `partitionTasks` needs (nodes
 * id/name, "calls" edges, plus a derived file list for
 * `inferFootprintFromIntent`'s path matching). Mirrors
 * `conceptualConflictCasForWorkspace` above — same tolerance for `path` being
 * a logical workspace id with no analyzable project (empty CAS, reduced
 * fidelity, never an error).
 */
async function partitionCasForPath(path: string): Promise<PartitionCas> {
  try {
    const cas = await getAnalysis(path);
    const files = new Set<string>();
    for (const n of (cas.nodes || []) as any[]) {
      const f = n?.source?.file;
      if (typeof f === 'string' && f.length > 0) files.add(f);
    }
    return {
      nodes: (cas.nodes || []).map((n: any) => ({ id: n.id, name: n.name })),
      edges: (cas.edges || [])
        .filter((e: any) => e.type === 'calls')
        .map((e: any) => ({ source: e.source, target: e.target, type: e.type })),
      files: [...files],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

async function withErrorHandling(fn: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    return await fn();
  } catch (error) {
    return errorResponse(error);
  }
}

async function loadRepositoryAnalyses(paths?: string[]): Promise<Array<{ path: string; name: string; cas: Awaited<ReturnType<typeof getAnalysis>> }>> {
  const selectedPaths = paths && paths.length > 0
    ? paths
    : (await listAnalyses()).map(analysis => analysis.path);

  const repositories = [];
  for (const repositoryPath of selectedPaths) {
    const cas = await getAnalysis(repositoryPath);
    repositories.push({
      path: repositoryPath,
      name: cas.system?.name || repositoryPath.split('/').pop() || repositoryPath,
      cas,
    });
  }

  return repositories;
}

async function loadWorkspaceRepositoryAnalyses(options: {
  paths?: string[];
  workspaceRoot?: string;
  exclude?: string[];
} = {}): Promise<{
  repositories: Array<{ path: string; name: string; cas: Awaited<ReturnType<typeof getAnalysis>> }>;
  skippedInputs: WorkspaceSkippedInput[];
  inputPolicy?: any;
}> {
  const resolved = await resolveWorkspaceInputPaths({
    paths: options.paths,
    workspaceRoot: options.workspaceRoot,
    exclude: options.exclude,
  });
  const repositories = await loadRepositoryAnalyses(resolved.includedPaths);
  return {
    repositories,
    skippedInputs: resolved.skippedInputs,
    inputPolicy: {
      workspace_root: resolved.workspaceRoot,
      ...resolved.policy,
    },
  };
}

function markWorkspaceAiEnrichmentSkipped(graph: crossCodebaseAnalysis.CrossCodebaseSystemGraph): crossCodebaseAnalysis.CrossCodebaseSystemGraph {
  // Workspace comprehension is AI-only. When AI is intentionally skipped the
  // narrative stays a pre-AI placeholder (empty description); there is no
  // deterministic workspace narrative to substitute in.
  graph.workspace_narrative = {
    ...graph.workspace_narrative,
    source: 'ai-required-degraded',
    degraded_reason: 'Workspace AI enrichment was intentionally skipped; comprehension is AI-only, so the narrative is a placeholder until AI runs.',
  };
  return graph;
}

async function resolveWorkspaceAnalysisForPaths(paths: string[] = []): Promise<{
  selected: any | null;
  alternatives: Array<{ id: string; name: string; score: number; matched_paths: string[]; generated_at?: string; saved_at?: string }>;
}> {
  const requested = paths.map(item => nodePath.resolve(item));
  const summaries = await listCrossCodebaseSystemGraphs();
  const alternatives = [];
  for (const summary of summaries) {
    const inputPaths = ((summary as any).inputs || []).map((input: any) => nodePath.resolve(input.repo_path || input.path || '')).filter(Boolean);
    const matched = requested.length === 0
      ? inputPaths
      : inputPaths.filter((inputPath: string) => requested.some(requestPath =>
        requestPath === inputPath ||
        requestPath.startsWith(`${inputPath}${nodePath.sep}`) ||
        inputPath.startsWith(`${requestPath}${nodePath.sep}`)
      ));
    const score = requested.length === 0 ? Math.min(1, inputPaths.length / 10) : matched.length / Math.max(requested.length, 1);
    alternatives.push({
      id: summary.id,
      name: summary.name,
      score,
      matched_paths: matched,
      generated_at: summary.generated_at,
      saved_at: summary.saved_at,
    });
  }
  alternatives.sort((left, right) => right.score - left.score || String(right.saved_at || right.generated_at || '').localeCompare(String(left.saved_at || left.generated_at || '')));
  const selectedSummary = alternatives.find(item => item.score > 0) || alternatives[0] || null;
  const selected = selectedSummary ? await loadCrossCodebaseSystemGraph(selectedSummary.id) : null;
  return {
    selected,
    alternatives: alternatives.slice(0, 10),
  };
}

async function buildWorkspaceFreshness(graph: any): Promise<{
  status: 'fresh' | 'stale' | 'unknown';
  stale_inputs: Array<{ project_id: string; repo_path: string; was_input_at?: string; current_analysis_at?: string; reason: string }>;
  checked_inputs: number;
}> {
  const staleInputs = [];
  for (const input of graph.inputs || []) {
    const repoPath = input.repo_path || input.path;
    if (!repoPath) continue;
    const entry = await getAnalysisEntry(repoPath);
    if (!entry) {
      staleInputs.push({ project_id: input.project_id || input.codebase_id, repo_path: repoPath, was_input_at: input.cas_generated_at, reason: 'No current CAS index entry exists for this WAS input.' });
      continue;
    }
    if (input.cas_generated_at && entry.analyzed_at && new Date(entry.analyzed_at).getTime() > new Date(input.cas_generated_at).getTime()) {
      staleInputs.push({ project_id: input.project_id || input.codebase_id, repo_path: repoPath, was_input_at: input.cas_generated_at, current_analysis_at: entry.analyzed_at, reason: 'Repo CAS was re-analyzed after this WAS was generated.' });
    }
  }
  return {
    status: staleInputs.length ? 'stale' : (graph.inputs || []).length ? 'fresh' : 'unknown',
    stale_inputs: staleInputs,
    checked_inputs: (graph.inputs || []).length,
  };
}

function validateWasGraph(graph: any, freshnessResult?: Awaited<ReturnType<typeof buildWorkspaceFreshness>>) {
  const missing = [
    graph?.projects?.length ? '' : 'projects',
    graph?.deployables?.length ? '' : 'deployables',
    Array.isArray(graph?.interfaces) ? '' : 'interfaces',
    graph?.runtime_topology ? '' : 'runtime_topology',
    graph?.detail_views?.overview ? '' : 'detail_views.overview',
    graph?.workspace_narrative ? '' : 'workspace_narrative',
    graph?.health ? '' : 'health',
  ].filter(Boolean);
  const degradedAi = graph?.workspace_narrative?.source !== 'ai';
  const stale = freshnessResult?.status === 'stale';
  const failingQualityFlags = (graph?.quality_flags || []).filter((flag: any) => flag.severity === 'fail');
  const warningQualityFlags = (graph?.quality_flags || []).filter((flag: any) => flag.severity === 'warn');
  const score = Math.max(0, 100 - missing.length * 18 - (degradedAi ? 15 : 0) - (stale ? 15 : 0) - failingQualityFlags.length * 20 - Math.min(15, warningQualityFlags.length * 5) - Math.min(20, (graph?.unmatched_interfaces?.length || 0)));
  return {
    status: missing.length || stale || degradedAi || warningQualityFlags.length || failingQualityFlags.length ? 'warn' : 'pass',
    score,
    conforms_to_was: missing.length === 0 && !stale,
    missing_required_sections: missing,
    ai_enrichment: {
      required: true,
      default_summary_status: graph?.workspace_narrative?.source === 'ai' ? 'applied' : 'degraded',
      reason: graph?.workspace_narrative?.degraded_reason || null,
    },
    quality_flags: graph?.quality_flags || [],
    freshness: freshnessResult || null,
    validation: graph?.validation || null,
  };
}

function runtimeObservationId(): string {
  return `runtime_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Optional analysis-track selector shared by analysis-fetch tools. Omitting it
 * preserves today's default behavior (in-flight when present, else main); an
 * explicit value routes loadAnalysis to that exact track. Backward compatible.
 */
const TRACK_PARAM = z
  .enum(['main', 'other-branch', 'in-flight'])
  .optional()
  .describe("Optional analysis track to read: 'main' (committed default branch), 'other-branch' (committed non-default branch), or 'in-flight' (dirty working tree). Omit for the default view (in-flight when present, else main).");

// Runtime opt-out controls, shared across the context/summary read tools.
// 'auto' (default) preserves today's task-type-gated behavior; 'exclude' omits
// runtime telemetry / communication-seams / runtime-topology sections;
// 'include' opts in. Resolved against KLAURO_CONTEXT_RUNTIME and the .klaurorc
// context.runtime default (param wins). See context-filter.ts.
const CONTEXT_RUNTIME_PARAM = z
  .enum(['include', 'exclude', 'auto'])
  .optional()
  .describe("Runtime-section control: 'auto' (default) keeps the existing task-type-gated behavior; 'exclude' omits runtime telemetry, communication seams, and runtime topology for a pure static view (real token reduction); 'include' opts in. Overrides KLAURO_CONTEXT_RUNTIME and the .klaurorc context.runtime default.");
const EXCLUDE_SECTIONS_PARAM = z
  .array(z.string())
  .optional()
  .describe('Named sections to omit regardless of runtime mode, e.g. ["runtime","seams","topology"] (aliases like "telemetry","communication_seams" accepted). Excluded sections are skipped, not blanked.');

// Fold env (KLAURO_CONTEXT_RUNTIME) and the .klaurorc context.runtime default
// into the task's `runtime` field before it reaches getAgentContext (which only
// resolves the param). The explicit per-call param still wins; env/config only
// fill in when the caller left it 'auto'/unset. exclude_sections is per-call
// and passes through unchanged. Returns a task object either way.
async function applyRuntimeContextDefault(path: string, task: any): Promise<any> {
  const base = task || {};
  const filter = await resolveSectionFilterForProject(path, {
    runtime: base.runtime,
    exclude_sections: base.exclude_sections,
  });
  return { ...base, runtime: filter.runtime_mode };
}

function registerTools(server: McpServer) {

  // -- Analysis Management --

  server.registerTool(
    'analyze_codebase',
    {
      title: 'Analyze Codebase',
      description: 'Run full CAS analysis on a local directory path (analysis runs ON THIS MACHINE). Detects languages, frameworks, and libraries. Stores results for querying. Progressive availability: the deterministic structure (nodes, edges, entry points, routes, call graph) is ready to query the moment this returns; AI-written descriptions enrich in the background. The result carries ai_enrichment (pending|ready|disabled|synchronous) — start working off the structure immediately rather than waiting for prose. NOTE: if .klaurorc sets policy.requireRemoteAnalyzer=true this tool refuses and directs you to analyze_codebase_remote (which analyzes on the hosted analyzer instead) — that is the prod-exclusive setup.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        force_full: z.boolean().optional().describe('Force full rebuild even if incremental is possible'),
        analysis_focus: z.enum(['agent-fast', 'ui-overview', 'deep-context', 'full']).optional().describe('Optional layered analysis profile. agent-fast prioritizes MCP context speed, ui-overview prioritizes AI narrative and visualization, deep-context enables deeper semantic layers, full uses default configured behavior.'),
      } as any,
    } as any,
    async ({ path, force_full, analysis_focus }: any) => withErrorHandling(async () => {
      // Prod-exclusive guard: if .klaurorc sets policy.requireRemoteAnalyzer, the
      // on-machine analyzer must refuse and redirect to analyze_codebase_remote,
      // so heavy analysis + storage stay on the hosted analyzer (never local).
      assertLocalAnalysisAllowed(await loadKlauroConfig(path));
      const focus: AnalysisFocus = analysis_focus || 'agent-fast';
      return withAnalysisFocus(focus, async () => {
      const previousEntry = await getAnalysisEntry(path);
      const summary = await runAnalysis(path, { forceFull: Boolean(force_full) });
      return json({
        status: 'success',
        analysis_type: summary.analysisType,
        analysis_focus: focus,
        path,
        name: summary.name,
        nodes: summary.nodes,
        edges: summary.edges,
        entry_points: summary.entryPoints,
        analyzers_run: summary.analyzersRun,
        errors: summary.errors,
        phases: summary.phases,
        version_upgrade: versionUpgradeReport(
          Boolean(previousEntry),
          summary.previousCasVersion || previousEntry?.cas_version,
          summary.casVersion
        ),
        change_summary: summary.changeSummary,
      });
      });
    })
  );

  server.registerTool(
    'get_analysis_focus_profiles',
    {
      title: 'Get Analysis Focus Profiles',
      description: 'Choose the cheapest useful Klauro analysis focus for a caller. Use before triggering analysis layers so coding agents default to agent-fast, UI flows request AI narrative only when needed, and deep-context work is explicit.',
      inputSchema: {
        trigger: z.enum(['mcp', 'cli', 'ui', 'inspector', 'manual-description', 'runtime', 'unknown']).optional().describe('Where the analysis request came from'),
        task_type: z.string().optional().describe('Optional task hint such as modify, debug, review, trace, architecture audit, visual inspection, or description generation'),
      } as any,
    } as any,
    async ({ trigger, task_type }: any) => withErrorHandling(async () => {
      return json(getAnalysisFocusProfiles({ trigger, taskType: task_type }));
    })
  );

  server.registerTool(
    'get_description_enrichment_targets',
    {
      title: 'Get Description Enrichment Targets',
      description: 'Return the exact system, capability, node, service, entity, and entry-point descriptions that need AI enrichment next, with suggested run_analysis_layer or generate_element_description arguments. Use when UI/drilldown text is deterministic, generic, inventory-like, missing, or failed validation.',
      inputSchema: {
        path: z.string().describe('Absolute path to the analyzed project directory'),
        limit: z.number().optional().describe('Maximum targets to return'),
      } as any,
    } as any,
    async ({ path, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const targets = getDescriptionEnrichmentTargets(cas, path);
      return json({
        analysis_id: cas.analysis_id,
        path,
        count: targets.length,
        targets: typeof limit === 'number' ? targets.slice(0, Math.max(0, limit)) : targets,
      });
    })
  );

  server.registerTool(
    'generate_element_description',
    {
      title: 'Generate Element Description',
      description: 'Manually generate and store an AI description for one CAS element. Use this for drilldown descriptions of nodes, services, entities, capabilities, entry points, or exit points after the fast default analysis has completed.',
      inputSchema: {
        path: z.string().describe('Absolute path to the analyzed project directory'),
        target: z.string().describe('Element id or name to describe'),
        target_kind: z.enum(['node', 'service', 'entity', 'capability', 'entry_point', 'exit_point', 'flow']).optional().describe('Optional target kind to disambiguate ids/names'),
        instructions: z.string().optional().describe('Optional guidance for the description, such as audience or what to emphasize'),
      } as any,
    } as any,
    async ({ path, target, target_kind, instructions }: any) => withErrorHandling(async () => {
      return json(await withAnalysisFocus('ui-overview', () => descriptionEnrichment.generateElementDescription({
        projectPath: path,
        target,
        targetKind: target_kind,
        instructions,
      })));
    })
  );

  server.registerTool(
    'get_element_description',
    {
      title: 'Get Element Description',
      description: 'Fetch a stored manual AI description for one CAS element and report whether it is still valid or invalidated by source/fingerprint changes.',
      inputSchema: {
        path: z.string().describe('Absolute path to the analyzed project directory'),
        target: z.string().describe('Element id or name to fetch'),
        target_kind: z.enum(['node', 'service', 'entity', 'capability', 'entry_point', 'exit_point', 'flow']).optional().describe('Optional target kind to disambiguate ids/names'),
      } as any,
    } as any,
    async ({ path, target, target_kind }: any) => withErrorHandling(async () => {
      return json(await descriptionEnrichment.getElementDescription({
        projectPath: path,
        target,
        targetKind: target_kind,
      }));
    })
  );

  server.registerTool(
    'get_analysis_phases',
    {
      title: 'Get Analysis Phases',
      description: 'Inspect which Klauro analysis layers have completed, which were deferred, and what each layer contributes to UI visualization and AI-agent development.',
      inputSchema: {
        path: z.string().describe('Absolute path to the analyzed project directory'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json({
        analysis_id: cas.analysis_id,
        analysis_timestamp: cas.analysis_timestamp,
        phases: cas.analysis_phases || [],
        ai_description_status: {
          system: cas.enhanced_system_purpose?.description_generation || null,
          capabilities: (cas.system_capabilities || []).slice(0, 25).map(capability => ({
            id: capability.id,
            name: capability.name,
            source: capability.description_source || null,
            generation: capability.description_generation || null,
          })),
          enrichment_targets: getDescriptionEnrichmentTargets(cas, path).slice(0, 12),
        },
      });
    })
  );

  server.registerTool(
    'run_analysis_layer',
    {
      title: 'Run Analysis Layer',
      description: 'Manually trigger a focused Klauro analysis layer without making agents run a full default workflow. Use for fast agent refreshes, UI overview refreshes, deep context refreshes, manual element descriptions, or simulated telemetry.',
      inputSchema: {
        path: z.string().describe('Absolute path to the analyzed project directory'),
        layer: z.enum(['agent-fast-refresh', 'ui-overview-refresh', 'deep-context-refresh', 'manual-element-description', 'runtime-simulation']).describe('Layer to run'),
        target: z.string().optional().describe('Element id/name for manual-element-description'),
        target_kind: z.enum(['node', 'service', 'entity', 'capability', 'entry_point', 'exit_point', 'flow']).optional().describe('Element kind for manual-element-description'),
        instructions: z.string().optional().describe('Description instructions for manual-element-description'),
        scenario: z.enum(['balanced', 'bug-hunt', 'traffic-spike', 'slow-dependencies']).optional().describe('Runtime simulation scenario'),
        event_count: z.number().optional().describe('Runtime simulation event count'),
        seed: z.string().optional().describe('Runtime simulation seed'),
        persist: z.boolean().optional().describe('Whether runtime simulation observations should be stored'),
        force_full: z.boolean().optional().describe('Force full rebuild for refresh layers'),
      } as any,
    } as any,
    async ({ path, layer, target, target_kind, instructions, scenario, event_count, seed, persist, force_full }: any) => withErrorHandling(async () => {
      if (layer === 'manual-element-description') {
        if (!target) throw new Error('manual-element-description requires target');
        return json(await withAnalysisFocus('ui-overview', () => descriptionEnrichment.generateElementDescription({
          projectPath: path,
          target,
          targetKind: target_kind,
          instructions,
        })));
      }

      if (layer === 'runtime-simulation') {
        const cas = await getAnalysis(path);
        return json(await runtimeSimulation.simulateRuntimeTelemetry(cas, path, {
          scenario,
          eventCount: event_count,
          seed,
          persist,
        }));
      }

      const focus: AnalysisFocus = layer === 'agent-fast-refresh'
        ? 'agent-fast'
        : layer === 'ui-overview-refresh'
          ? 'ui-overview'
          : 'deep-context';

      return json(await withAnalysisFocus(focus, async () => {
        const summary = await runAnalysis(path, { forceFull: Boolean(force_full) });
        return {
          status: 'success',
          layer,
          analysis_type: summary.analysisType,
          analysis_focus: focus,
          path,
          nodes: summary.nodes,
          edges: summary.edges,
          entry_points: summary.entryPoints,
          phases: summary.phases,
          change_summary: summary.changeSummary,
        };
      }));
    })
  );

  server.registerTool(
    'initialize_klauro_project',
    {
      title: 'Initialize Klauro Project',
      description: 'Write .klaurorc and .klauroignore so teams can control analyzer mode, upload policy, source include/exclude rules, and project identity.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        mode: z.enum(['local', 'remote']).optional().describe('Analyzer mode to write into .klaurorc'),
        server_url: z.string().optional().describe('Remote analyzer URL to write into .klaurorc'),
        project_id: z.string().optional().describe('Stable hosted project id'),
        organization_id: z.string().optional().describe('Hosted organization id'),
        force: z.boolean().optional().describe('Overwrite existing .klaurorc and .klauroignore'),
      } as any,
    } as any,
    async ({ path, server_url, project_id, organization_id, force }: any) => withErrorHandling(async () => {
      const result = await writeDefaultKlauroConfig(path, {
        serverUrl: server_url,
        projectId: project_id,
        organizationId: organization_id,
        force,
      });
      return json({
        status: 'success',
        config_file: result.configPath,
        ignore_file: result.ignorePath,
        analyzer_url: result.config.analyzer.serverUrl,
        project_id: result.config.project.id,
        organization_id: result.config.project.organizationId,
      });
    })
  );

  server.registerTool(
    'get_klauro_project_config',
    {
      title: 'Get Klauro Project Config',
      description: 'Read effective .klaurorc, .klauroignore, analyzer mode, upload policy, and project identity for a repository.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const loaded = await loadKlauroConfig(path);
      return json({
        status: 'success',
        config_file: loaded.configPath,
        ignore_file: loaded.ignorePath,
        ignore_patterns: loaded.ignorePatterns,
        config: loaded.config,
      });
    })
  );

  server.registerTool(
    'declare_convention',
    {
      title: 'Declare Custom Convention',
      description: 'Persist a hand-rolled/proprietary architecture convention (custom route decorator or registration call, entry-point export pattern, entity naming convention, DI binding call, semantic role tag, or a named flow) into .klaurorc conventions: — the DECLARATION half of "analyze ANY codebase" (auto-detection infers patterns; this lets an agent that discovers a bespoke pattern mid-task persist it). Additive only: appends to whichever conventions[kind] array already exists; never replaces prior declarations. Validated before writing — a malformed convention returns a field-specific error and writes nothing, so a mistake never corrupts .klaurorc. The next analyze_codebase run applies it evidence-gated: a declared convention that matches nothing real in the extracted nodes emits nothing (see conventions_applied on the CAS output for the audit trail of what matched).',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        kind: z.enum(['routes', 'entry_points', 'entities', 'di_bindings', 'roles', 'flows']).describe('Which conventions[] array to append to'),
        convention: z.record(z.unknown()).describe(
          'The convention object, shaped per kind: ' +
          'routes = {decorator, path_arg?, method_arg?, default_method?} OR {kind:"call", call, method_arg, path_arg, handler_arg}; ' +
          'entry_points = {files, export_matches, kind}; ' +
          'entities = {name_suffix?, name_regex?, decorator?} (at least one); ' +
          'di_bindings = {call, token_arg, impl_arg}; ' +
          'roles = {name_suffix?, name_regex?, role} (name_suffix or name_regex, plus role); ' +
          'flows = {name, steps: ["Class.method", ...]}'
        ),
      } as any,
    } as any,
    async ({ path, kind, convention }: any) => withErrorHandling(async () => {
      const loaded = await loadKlauroConfig(path);
      const nextConventions: KlauroConventions = { ...(loaded.config.conventions || {}) };
      const existing = (nextConventions as any)[kind] || [];
      const candidate: KlauroConventions = { ...nextConventions, [kind]: [...existing, convention] };

      const validation = validateConventions(candidate);
      if (validation.errors.length > 0) {
        return json({
          status: 'error',
          message: `Convention rejected — .klaurorc was not modified.`,
          errors: validation.errors,
          warnings: validation.warnings,
        });
      }

      const configPath = loaded.configPath || (await writeDefaultKlauroConfig(path)).configPath;
      const rawConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
      rawConfig.conventions = candidate;
      await fs.writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf8');

      return json({
        status: 'success',
        config_file: configPath,
        kind,
        declared: convention,
        conventions: candidate,
        warnings: validation.warnings.length > 0 ? validation.warnings : undefined,
        next_step: 'Run analyze_codebase to apply this convention; check conventions_applied in the resulting CAS (or the next get_summary/get_route_table/get_data_entities/get_flow_concepts call) to confirm it matched real code.',
      });
    })
  );

  server.registerTool(
    'get_upload_manifest',
    {
      title: 'Get Upload Manifest',
      description: 'Dry-run the remote analyzer upload policy and show exactly which files would be sent before full or dirty-tree sync.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        dirty_tree: z.boolean().optional().describe('Show dirty-tree incremental upload instead of full snapshot upload'),
      } as any,
    } as any,
    async ({ path, dirty_tree }: any) => withErrorHandling(async () => {
      return json(await buildUploadManifest(path, dirty_tree ? 'dirty-tree' : 'full'));
    })
  );

  server.registerTool(
    'get_agent_revision_tracks',
    {
      title: 'Get Agent Revision Tracks',
      description: 'Return the three-track agent state for a local repo: private uncommitted working-copy context, shared committed analyzed revision, and incoming analyzed commits from other developers/provider pushes.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        server_url: z.string().optional().describe('Klauro API/analyzer URL. Defaults to KLAURO_API_URL/KLAURO_ANALYZER_URL or Klauro Cloud.'),
        analysis_id: z.string().optional().describe('Stable project analysis id. Defaults to configured project id or a hash of the local project path.'),
      } as any,
    } as any,
    async ({ path, server_url, analysis_id }: any) => withErrorHandling(async () => {
      return json(await getAgentRevisionTracks({ projectPath: path, serverUrl: server_url, analysisId: analysis_id }));
    })
  );

  server.registerTool(
    'get_github_import_plan',
    {
      title: 'Get GitHub Import Plan',
      description: 'Describe the GitHub App permissions, webhooks, and local-agent handoff needed for hosted selected-branch analysis.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const loaded = await loadKlauroConfig(path);
      return json(buildGithubImportPlan(path, loaded.config));
    })
  );

  server.registerTool(
    'analyze_codebase_remote',
    {
      title: 'Analyze Codebase Remotely',
      description: 'Upload a filtered local source snapshot to a remote Klauro analyzer service, then cache the returned CAS locally for fast MCP queries.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        server_url: z.string().optional().describe('Remote analyzer URL. Defaults to KLAURO_ANALYZER_URL or Klauro Cloud.'),
        analysis_id: z.string().optional().describe('Stable remote analysis id. Defaults to a hash of the local project path'),
      } as any,
    } as any,
    async ({ path, server_url, analysis_id }: any) => withErrorHandling(async () => {
      // wait:true — this MCP tool's contract is to cache the returned CAS
      // locally for fast queries, so it needs the synchronous response.
      const result = await analyzeCodebaseRemotely({ projectPath: path, serverUrl: server_url, analysisId: analysis_id, wait: true });
      return json({
        status: result.status,
        analysis_id: result.analysis_id,
        analysis_revision: result.analysis_revision,
        analysis_type: result.analysis_type,
        files_sent: result.manifest.file_count,
        bytes_sent: result.manifest.total_bytes,
        path,
        name: result.cas!.system?.name || path.split('/').pop(),
        nodes: result.cas!.nodes?.length || 0,
        edges: result.cas!.edges?.length || 0,
        entry_points: result.cas!.entry_points?.length || 0,
      });
    })
  );

  server.registerTool(
    'sync_codebase_remote',
    {
      title: 'Sync Codebase Remotely',
      description: 'Send dirty-tree file changes to a remote Klauro analyzer service and cache the updated CAS locally. Use after local agent edits when analyzers are hosted.',
      inputSchema: {
        path: z.string().describe('Absolute path to the project directory'),
        server_url: z.string().optional().describe('Remote analyzer URL. Defaults to KLAURO_ANALYZER_URL or Klauro Cloud.'),
        analysis_id: z.string().optional().describe('Stable remote analysis id. Defaults to a hash of the local project path'),
      } as any,
    } as any,
    async ({ path, server_url, analysis_id }: any) => withErrorHandling(async () => {
      const result = await syncWorkingTreeRemotely({ projectPath: path, serverUrl: server_url, analysisId: analysis_id });
      const summary = result.change_report?.summary;
      return json({
        status: result.status,
        analysis_id: result.analysis_id,
        analysis_revision: result.analysis_revision,
        analysis_type: result.analysis_type,
        files_sent: result.manifest.file_count,
        bytes_sent: result.manifest.total_bytes,
        path,
        name: result.cas.system?.name || path.split('/').pop(),
        nodes: result.cas.nodes?.length || 0,
        edges: result.cas.edges?.length || 0,
        entry_points: result.cas.entry_points?.length || 0,
        change_summary: summary ? {
          files_changed: summary.filesAdded + summary.filesModified + summary.filesDeleted,
          nodes_added: summary.nodesAdded,
          nodes_modified: summary.nodesModified,
          nodes_deleted: summary.nodesDeleted,
          edges_added: summary.edgesAdded,
          edges_modified: summary.edgesModified,
          edges_deleted: summary.edgesDeleted,
        } : undefined,
      });
    })
  );

  server.registerTool(
    'list_analyses',
    {
      title: 'List Analyses',
      description: 'List previously analyzed codebases, with narrowing and pagination. A machine can hold thousands of analyses, so this never dumps them all: filter by name/path, framework, system_type, or min_nodes/min_edges; sort by nodes (default), edges, name, or recent; dedupe re-analyses by name or path; and page with limit/offset. The response reports total_indexed, matched, has_more, and next_offset. When this project is bound to an account workspace (.klaurorc project.workspaceId), results are isolated to that workspace by default (response.scope reports this) — other workspaces\' analyses never appear, by name or otherwise. Set .klaurorc scope.mode="machine" to opt out.',
      inputSchema: {
        limit: z.number().int().optional().describe(`Page size (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
        offset: z.number().int().optional().describe('Page offset (default 0). Use next_offset from a prior call.'),
        name: z.string().optional().describe('Case-insensitive substring matched against analysis name AND path.'),
        framework: z.string().optional().describe('Case-insensitive substring matched against any detected framework.'),
        system_type: z.string().optional().describe('Case-insensitive substring matched against system_type.'),
        min_nodes: z.number().int().optional().describe('Keep only analyses with at least this many graph nodes.'),
        min_edges: z.number().int().optional().describe('Keep only analyses with at least this many graph edges.'),
        dedupe_by: z.enum(['name', 'path', 'none']).optional().describe("Collapse re-analyses: keep the largest entry per 'name' or per 'path'. Default 'none'."),
        sort: z.enum(['nodes', 'edges', 'name', 'recent']).optional().describe("Sort order. Default 'nodes' (desc)."),
        compact: z.boolean().optional().describe('Return a compact projection (default true). Set false for the full AnalysisEntry.'),
        track: z.enum(['main', 'other-branch', 'in-flight']).optional().describe("Optional track filter. Omit (default) to show every track — each entry's `track` is always surfaced in the projection. Set to keep only 'main', 'other-branch', or 'in-flight' entries."),
      } as any,
    } as any,
    async (query: any) => withErrorHandling(async () => {
      const analyses = await listAnalyses();
      const scope = await resolveAnalysisScope();
      return json({ scope: describeScopeForResponse(scope), ...listAnalysesFiltered(analyses, query || {}) });
    })
  );

  server.registerTool(
    'validate_cas_contract',
    {
      title: 'Validate CAS Contract',
      description: 'Run executable CAS completeness checks: graph integrity, entry/exit references, runtime links, facts, method calls, call chains, and optional runtime observation correlation.',
      inputSchema: {
        path: z.string().describe('Project path'),
        include_runtime_observations: z.boolean().optional().describe('Include stored runtime observations in correlation gates'),
      } as any,
    } as any,
    async ({ path, include_runtime_observations }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const observations = include_runtime_observations ? await loadRuntimeObservations(path) : [];
      return json(casContract.validateCASContract(cas, observations));
    })
  );

  server.registerTool(
    'get_storage_health',
    {
      title: 'Get Storage Health',
      description: 'Inspect MCP analysis storage: indexed analyses, snapshots, change history, file cache size, and runtime observation counts.',
      inputSchema: {
        path: z.string().optional().describe('Optional project path filter'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      return json(await getStorageHealth(path));
    })
  );

  server.registerTool(
    'get_storage_maintenance_report',
    {
      title: 'Get Storage Maintenance Report',
      description: 'Dry-run report for generated Klauro storage and allowlisted temp proof/preview/live-trial artifacts. Does not delete anything.',
      inputSchema: {
        root: z.string().optional().describe('Klauro home root. Defaults to ~/.klauro.'),
        repo_root: z.string().optional().describe('Repository root when include_local_artifacts is true.'),
        temp_root: z.string().optional().describe('Temp root when include_temp_artifacts is true. Defaults to os.tmpdir().'),
        older_than_days: z.number().optional().describe('Select generated artifacts older than this many days.'),
        max_bytes: z.number().optional().describe('Also select oldest/largest artifacts until generated storage is under this byte limit.'),
        include_local_artifacts: z.boolean().optional().describe('Include repo-local .klauro-* benchmark artifacts under repo_root.'),
        include_temp_artifacts: z.boolean().optional().describe('Include allowlisted Klauro-generated temp proof/preview/live-trial workspaces.'),
        include_analyses: z.boolean().optional().describe('Include analysis snapshot files. Off by default.'),
      } as any,
    } as any,
    async ({ root, repo_root, temp_root, older_than_days, max_bytes, include_local_artifacts, include_temp_artifacts, include_analyses }: any) => withErrorHandling(async () => {
      return json(await pruneKlauroStorage({
        root,
        repoRoot: repo_root,
        tempRoot: temp_root,
        olderThanDays: older_than_days,
        maxBytes: max_bytes,
        includeLocalArtifacts: include_local_artifacts,
        includeTempArtifacts: include_temp_artifacts,
        includeAnalyses: include_analyses,
        confirm: false,
      }));
    })
  );

  server.registerTool(
    'prune_storage_artifacts',
    {
      title: 'Prune Storage Artifacts',
      description: 'Delete selected generated Klauro artifacts. Requires confirm_delete=true and only deletes allowlisted generated artifacts selected by the provided filters.',
      inputSchema: {
        confirm_delete: z.boolean().describe('Must be true to delete selected generated artifacts.'),
        root: z.string().optional().describe('Klauro home root. Defaults to ~/.klauro.'),
        repo_root: z.string().optional().describe('Repository root when include_local_artifacts is true.'),
        temp_root: z.string().optional().describe('Temp root when include_temp_artifacts is true. Defaults to os.tmpdir().'),
        older_than_days: z.number().optional().describe('Select generated artifacts older than this many days.'),
        max_bytes: z.number().optional().describe('Also select oldest/largest artifacts until generated storage is under this byte limit.'),
        include_local_artifacts: z.boolean().optional().describe('Include repo-local .klauro-* benchmark artifacts under repo_root.'),
        include_temp_artifacts: z.boolean().optional().describe('Include allowlisted Klauro-generated temp proof/preview/live-trial workspaces.'),
        include_analyses: z.boolean().optional().describe('Include analysis snapshot files. Off by default.'),
      } as any,
    } as any,
    async ({ confirm_delete, root, repo_root, temp_root, older_than_days, max_bytes, include_local_artifacts, include_temp_artifacts, include_analyses }: any) => withErrorHandling(async () => {
      if (confirm_delete !== true) {
        return json({
          status: 'needs-confirmation',
          message: 'Set confirm_delete=true to delete selected generated artifacts. Call get_storage_maintenance_report first to inspect the candidate list.',
        });
      }
      return json(await pruneKlauroStorage({
        root,
        repoRoot: repo_root,
        tempRoot: temp_root,
        olderThanDays: older_than_days,
        maxBytes: max_bytes,
        includeLocalArtifacts: include_local_artifacts,
        includeTempArtifacts: include_temp_artifacts,
        includeAnalyses: include_analyses,
        confirm: true,
      }));
    })
  );

  server.registerTool(
    'preview_codebase_iteration',
    {
      title: 'Preview Codebase Iteration',
      description: 'Analyze a proposed plan plus diff/files as an ephemeral iteration of an existing codebase. CAS remains proposal-agnostic; the preview references baseline and proposed analyses.',
      inputSchema: {
        path: z.string().describe('Absolute path to the existing project directory'),
        plan_text: z.string().describe('Natural-language proposal or agent plan'),
        title: z.string().optional().describe('Human-readable preview title'),
        diff_text: z.string().optional().describe('Unified diff to apply in a temporary workspace'),
        proposed_files: z.array(z.object({
          path: z.string(),
          content: z.string().optional(),
          status: z.enum(['added', 'modified', 'deleted']).optional(),
        })).optional().describe('Explicit proposed file writes/deletions to apply in the temporary workspace'),
        organization_id: z.string().optional(),
        project_id: z.string().optional(),
        codebase_id: z.string().optional(),
        preview_base_url: z.string().optional().describe('Hosted Klauro app base URL for generated private preview links'),
      } as any,
    } as any,
    async ({ path, plan_text, title, diff_text, proposed_files, organization_id, project_id, codebase_id, preview_base_url }: any) => withErrorHandling(async () => {
      return json(await proposalPreview.previewCodebaseIteration({
        path,
        planText: plan_text,
        title,
        diffText: diff_text,
        proposedFiles: proposed_files,
        organizationId: organization_id,
        projectId: project_id,
        codebaseId: codebase_id,
        previewBaseUrl: preview_base_url,
      }));
    })
  );

  server.registerTool(
    'get_greenfield_architecture_guidance',
    {
      title: 'Get Greenfield Architecture Guidance',
      description: 'Use existing analyzed repositories as memory before creating a new codebase. Returns architecture options, duplicate-capability warnings, first-file guidance, tests, and next MCP preview steps.',
      inputSchema: {
        plan_text: z.string().describe('Natural-language new-project goal or agent plan'),
        proposed_files: z.array(z.object({
          path: z.string(),
          content: z.string().optional(),
          status: z.enum(['added', 'modified', 'deleted']).optional(),
        })).optional().describe('Optional proposed file bundle to review before preview_greenfield_codebase'),
        reference_paths: z.array(z.string()).optional().describe('Existing analyzed repositories to use as memory. Omit to use all stored analyses.'),
        limit: z.number().optional().describe('Maximum overlap matches to return'),
      } as any,
    } as any,
    async ({ plan_text, proposed_files, reference_paths, limit }: any) => withErrorHandling(async () => {
      const references = await loadRepositoryAnalyses(reference_paths);
      return json(greenfieldGuidance.buildGreenfieldArchitectureGuidance({
        planText: plan_text,
        proposedFiles: proposed_files,
        references: references.map(reference => ({
          path: reference.path,
          name: reference.name,
          cas: reference.cas,
        })),
        limit,
      }));
    })
  );

  server.registerTool(
    'get_greenfield_build_context',
    {
      title: 'Get Greenfield Build Context',
      description: 'Guide a zero-repo or growing greenfield build. For an empty folder it returns first-slice architecture guidance; after files exist it analyzes the folder and returns CAS-backed memory, duplicate-prevention rules, focused files to read, next-slice validation steps, and a compact G1 build capsule for low-token agent prompts.',
      inputSchema: {
        workspace_path: z.string().describe('Absolute path to the empty or growing project folder'),
        plan_text: z.string().describe('Current product requirement or next-slice plan'),
        proposed_files: z.array(z.object({
          path: z.string(),
          content: z.string().optional(),
          status: z.enum(['added', 'modified', 'deleted']).optional(),
        })).optional().describe('Optional proposed file bundle for the next slice'),
        reference_paths: z.array(z.string()).optional().describe('Existing analyzed repositories to use as external memory. Omit to use all stored analyses.'),
        limit: z.number().optional().describe('Maximum overlap matches to return'),
      } as any,
    } as any,
    async ({ workspace_path, plan_text, proposed_files, reference_paths, limit }: any) => withErrorHandling(async () => {
      const references = await loadRepositoryAnalyses(reference_paths);
      return json(await greenfieldBuildSession.buildGreenfieldBuildContext({
        workspacePath: workspace_path,
        planText: plan_text,
        proposedFiles: proposed_files,
        references: references.map(reference => ({
          path: reference.path,
          name: reference.name,
          cas: reference.cas,
        })),
        limit,
      }));
    })
  );

  server.registerTool(
    'preview_greenfield_codebase',
    {
      title: 'Preview Greenfield Codebase',
      description: 'Analyze proposed files as a synthetic new codebase and return a normal CAS-backed preview with advisory readiness warnings.',
      inputSchema: {
        plan_text: z.string().describe('Natural-language proposal or agent plan'),
        title: z.string().optional().describe('Human-readable preview title'),
        proposed_files: z.array(z.object({
          path: z.string(),
          content: z.string().optional(),
          status: z.enum(['added', 'modified', 'deleted']).optional(),
        })).optional().describe('Proposed file bundle for the synthetic codebase'),
        organization_id: z.string().optional(),
        project_id: z.string().optional(),
        preview_base_url: z.string().optional().describe('Hosted Klauro app base URL for generated private preview links'),
      } as any,
    } as any,
    async ({ plan_text, title, proposed_files, organization_id, project_id, preview_base_url }: any) => withErrorHandling(async () => {
      return json(await proposalPreview.previewGreenfieldCodebase({
        planText: plan_text,
        title,
        proposedFiles: proposed_files,
        organizationId: organization_id,
        projectId: project_id,
        previewBaseUrl: preview_base_url,
      }));
    })
  );

  server.registerTool(
    'get_preview_analysis',
    {
      title: 'Get Preview Analysis',
      description: 'Fetch stored proposal preview metadata, baseline/proposed CAS artifacts, comparison payload, and visualization payload.',
      inputSchema: {
        preview_id: z.string().optional().describe('Preview id. Defaults to latest.'),
      } as any,
    } as any,
    async ({ preview_id }: any) => withErrorHandling(async () => {
      return json(await proposalPreview.getPreviewAnalysis(preview_id || 'latest'));
    })
  );

  server.registerTool(
    'compare_analysis_iterations',
    {
      title: 'Compare Analysis Iterations',
      description: 'Compare two normal CAS analyses or return the comparison payload for a proposal preview.',
      inputSchema: {
        preview_id: z.string().optional().describe('Existing preview id to compare'),
        baseline_path: z.string().optional().describe('Path for baseline stored analysis'),
        proposed_path: z.string().optional().describe('Path for proposed stored analysis'),
        diff_text: z.string().optional().describe('Optional diff used to focus impact checks'),
        files: z.array(z.string()).optional().describe('Optional changed files used to focus impact checks'),
      } as any,
    } as any,
    async ({ preview_id, baseline_path, proposed_path, diff_text, files }: any) => withErrorHandling(async () => {
      return json(await proposalPreview.compareAnalysisIterations({
        previewId: preview_id,
        baselinePath: baseline_path,
        proposedPath: proposed_path,
        diffText: diff_text,
        files,
      }));
    })
  );

  server.registerTool(
    'get_analysis_freshness',
    {
      title: 'Get Analysis Freshness',
      description: 'Check whether stored CAS is fresh. For a project-bound repo (.klaurorc with a hosted prj_ id) freshness is judged against the HOSTED analysis timestamp (the source of truth), with the file-mtime scan as secondary local detail; unbound repos keep the local mtime/incremental view.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const report = await freshness.getAnalysisFreshness(path);
      // Bound repo: the authoritative comparison is local mirror vs HOSTED
      // analysis timestamp — a coherent local mirror of a fresh hosted
      // analysis is 'fresh' even if file mtimes moved, and a July-4 local
      // cache is 'stale' the moment the hosted analysis is newer, regardless
      // of mtimes. The mtime-based scan stays in the report as local detail.
      const binding = await resolveHostedProjectBinding(path).catch(() => null);
      if (!binding) return json(report);
      const hosted = await compareHostedFreshness(binding);
      if (hosted.reachable && hosted.status) {
        const status = hosted.status === 'no-local-cache' ? 'no-analysis' : hosted.status;
        return json({
          ...report,
          status,
          hosted,
          recommendation: hosted.status === 'stale'
            ? `Local cache (${hosted.local_analysis_timestamp || 'none'}) is older than the hosted analysis (${hosted.hosted_analysis_timestamp}); the next read tool call will download and mirror the hosted analysis.`
            : hosted.status === 'no-local-cache'
              ? 'No local mirror yet; the next read tool call will download and mirror the hosted analysis.'
              : 'Local mirror matches or is newer than the hosted analysis; CAS-backed context is current.',
        });
      }
      return json({
        ...report,
        hosted,
        recommendation: `${report.recommendation} Note: hosted analysis state was unreachable (${hosted.reason || 'unknown'}); this report reflects the LOCAL cache only.`,
      });
    })
  );

  server.registerTool(
    'get_test_discovery_evidence',
    {
      title: 'Get Test Discovery Evidence',
      description: 'Distinguish CAS-covered tests, missed source tests, and repos with no source test files by scanning test paths and names.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await testDiscovery.getTestDiscoveryEvidence(path, cas));
    })
  );

  server.registerTool(
    'save_cas_golden_snapshot',
    {
      title: 'Save CAS Golden Snapshot',
      description: 'Persist the current stable CAS shape snapshot for regression checks.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const snapshot = casContract.buildCASGoldenSnapshot(cas);
      const saved = await saveGoldenSnapshot(path, snapshot);
      return json({ saved, snapshot });
    })
  );

  server.registerTool(
    'compare_cas_golden_snapshot',
    {
      title: 'Compare CAS Golden Snapshot',
      description: 'Compare current CAS shape against the saved golden snapshot for this repository.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const saved = await loadGoldenSnapshot(path);
      if (!saved) return json({ status: 'warn', gates: [], detail: 'No saved CAS golden snapshot' });
      const gates = casContract.compareCASGoldenSnapshot(cas, saved.snapshot as any);
      return json({
        status: gates.some(gate => gate.status === 'fail') ? 'fail' : gates.some(gate => gate.status === 'warn') ? 'warn' : 'pass',
        saved_at: saved.saved_at,
        gates,
      });
    })
  );

  // -- System-Level Understanding --

  server.registerTool(
    'get_summary',
    {
      title: 'Get Summary',
      description: 'Get condensed intelligence summary of an analyzed codebase. Includes system purpose, flow graph highlights (top 15 capabilities by score), architecture summary, database entities, entry point breakdown, node/edge counts, and analyzer contributions. This is the first tool to call to orient on a codebase — the top of the Capability -> Flow -> Step -> Function hierarchy; drill a named capability into its flows with get_flow_concepts, then a flow/step into concrete code with get_coding_context/get_call_chain. Its orient_capsule field is a pure pullable-INDEX of the fabric: per dimension (routes, seams, topology, cicd, runtime metrics, entities, tests) it reports availability + a count + the exact tool that pulls it, at near-zero tokens and with NO narrative — the cheap map of what is knowable. For the woven NARRATIVE of how those layers fit together (entry points -> deployables with bundled members -> topology -> seams -> CAP, as a headline plus compacted content), call get_system_overview and read its system_fit; the capsule tells you what to pull, system_fit tells you the story. Progressive availability: structural fields (entry points, counts, entities, flow highlights) are always final; the prose system purpose and capability descriptions may still be enriching — check ai_enrichment (pending = deterministic text now; re-call in a few seconds only if you need the richer narrative). Never block on pending prose; orient on the structure and proceed.',
      inputSchema: {
        path: z.string().describe('Project path (must be previously analyzed)'),
        track: TRACK_PARAM,
        detail: z.enum(['compact', 'full']).optional().describe("'compact' (default) omits the static analysis_phases prose and trims architectural_patterns guidance to keep replayed-context cost low; 'full' restores the complete payload."),
        runtime: CONTEXT_RUNTIME_PARAM,
        exclude_sections: EXCLUDE_SECTIONS_PARAM,
      } as any,
    } as any,
    async ({ path, track, detail, runtime, exclude_sections }: any) => withErrorHandling(async () => {
      const filter = await resolveSectionFilterForProject(path, { runtime, exclude_sections });
      if (!track) {
        // Project-bound repo: the hosted analysis is the source of truth. When
        // the FULL hosted CAS cannot be mirrored (e.g. the deployed server
        // predates GET /api/projects/{id}/cas) but the hosted state IS
        // reachable, serve the hosted summary payload directly rather than a
        // local cache that is older than the hosted analysis — the orient
        // surface must never present a stale cache as current.
        const binding = await resolveHostedProjectBinding(path).catch(() => null);
        if (binding) {
          let resolution;
          try {
            resolution = await resolveBoundAnalysis(binding);
          } catch (error) {
            // No local cache AND no full-CAS download (offline, or a server
            // build without the /cas endpoint): the hosted summary alone is
            // still the truthful orient answer when the state is reachable.
            const hosted = await hostedSummaryPayload(binding);
            if (!hosted) throw error;
            const payload: Record<string, unknown> = withFreshnessStamp({ ...hosted });
            payload.analysis_source = {
              path,
              origin: 'hosted-summary',
              project_id: binding.projectId,
              server_url: binding.serverUrl,
              note: `full hosted CAS could not be mirrored (${error instanceof Error ? error.message : String(error)}); serving the hosted summary directly`,
              resolved_at: new Date().toISOString(),
            };
            return json(payload);
          }
          if (resolutionIsStaleDegraded(resolution)) {
            const hosted = await hostedSummaryPayload(binding);
            if (hosted) {
              const payload: Record<string, unknown> = withFreshnessStamp({ ...hosted });
              payload.analysis_source = {
                path,
                origin: 'hosted-summary',
                project_id: binding.projectId,
                server_url: binding.serverUrl,
                note: `${resolution.note || 'full hosted CAS unavailable'}; serving the hosted summary directly — drill-down tools may reflect the older local cache until the hosted CAS can be mirrored`,
                resolved_at: new Date().toISOString(),
              };
              return json(payload);
            }
          }
          return json(withFreshnessStamp(query.buildSummary(resolution.cas, { detail, excludeSeams: filter.isExcluded('seams') })));
        }
      }
      // track-scoped reads (working/committed/incoming) bypass the freshness gate:
      // getFreshAnalysisForAgent only knows about the default track's CAS.
      const cas = track ? await getAnalysis(path, { track }) : await getFreshAnalysisForAgent(path);
      return json(withFreshnessStamp(query.buildSummary(cas, { detail, excludeSeams: filter.isExcluded('seams') })));
    })
  );

  server.registerTool(
    'get_system_overview',
    {
      title: 'Get System Overview',
      description: 'Full system metadata: system info, architecture summary, system purpose, capabilities, progressive levels, analyzer contributions, configuration, runtime, errors, validation. Its system_fit field is the woven NARRATIVE of how the vertical fits together — a "how it fits" headline (entry points -> deployables with bundled members collapsed -> infra topology -> communication seams -> CAP/consistency flags) plus the compacted content for each layer. This is the richer counterpart to get_summary\'s orient_capsule, which is a pure availability+count INDEX with no narrative: reach for the capsule to learn cheaply what is pullable, and for system_fit to read the actual story of how the layers connect.',
      inputSchema: {
        path: z.string().describe('Project path'),
        runtime: CONTEXT_RUNTIME_PARAM,
        exclude_sections: EXCLUDE_SECTIONS_PARAM,
      } as any,
    } as any,
    async ({ path, runtime, exclude_sections }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      const filter = await resolveSectionFilterForProject(path, { runtime, exclude_sections });
      return json(withFreshnessStamp(query.getSystemOverview(cas, {
        excludeRuntime: filter.isExcluded('runtime'),
        excludeSeams: filter.isExcluded('seams'),
        excludeTopology: filter.isExcluded('topology'),
      })));
    })
  );

  server.registerTool(
    'get_architecture_context',
    {
      title: 'Get Architecture Context',
      description: 'Compact architecture guidance for agents. Returns detected architecture patterns, MVC/MVVM/repository/mediator/unit-of-work/singleton inventory counts and examples, target-relevant owners, a pattern decision matrix, pattern-balance risks, and rules to preserve local architecture.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node, file, or feature target to focus architecture owners'),
        files: z.array(z.string()).optional().describe('Optional changed or planned files to focus architecture owners'),
        limit: z.number().optional().describe('Maximum patterns to include'),
      } as any,
    } as any,
    async ({ path, target, files, limit }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(withFreshnessStamp(agentAdoption.buildArchitectureContextForAgent(cas, { target, files, limit })));
    })
  );

  server.registerTool(
    'list_answer_packs',
    {
      title: 'List Answer Packs',
      description: 'List deterministic MCP answer packs. Answer packs are curated question sets that prove a codebase can be explained from CAS with evidence.',
      inputSchema: {} as any,
    } as any,
    async () => withErrorHandling(async () => {
      return json(product.getAnswerPackCatalog());
    })
  );

  server.registerTool(
    'run_answer_pack',
    {
      title: 'Run Answer Pack',
      description: `Answer core product questions from CAS using MCP query surfaces. Available packs: ${product.describeAnswerPackCatalog()}. No other pack names exist — for a security or tests slice, use pack 'mastery' with the matching section id. Returns a bounded digest: per-section sizes plus the sections that fit the response budget inline. Fetch any withheld section in full with the section parameter.`,
      inputSchema: {
        path: z.string().describe('Project path'),
        pack: z.string().optional().describe("Answer pack id. 'mastery' is the only pack (default); call list_answer_packs for the catalog"),
        section: z.string().optional().describe('Answer section id to fetch in full: overview, entry-points, representative-flow, change-impact, data, tests, external-boundaries, security, or runtime-readiness'),
      } as any,
    } as any,
    async ({ path, pack, section }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = product.runAnswerPack(cas, path, pack);
      if (section) {
        const match = result.answers.find(item => item.id === section);
        if (!match) {
          throw new Error(result.answers.length > 0
            ? `Unknown answer pack section '${section}'. Available sections: ${result.answers.map(item => item.id).join(', ')}`
            : `Unknown answer pack: ${result.pack}. Available packs: ${product.describeAnswerPackCatalog()}.`);
        }
        return json({ pack: result.pack, path: result.path, generated_at: result.generated_at, gaps: result.gaps, section: match });
      }
      return json(product.buildAnswerPackDigest(result));
    })
  );

  server.registerTool(
    'get_mcp_demo_flow',
    {
      title: 'Get MCP Demo Flow',
      description: 'Agent-facing customer demo flow: exact MCP tool sequence plus representative CAS-backed outputs for explaining a codebase without UI.',
      inputSchema: {
        path: z.string().describe('Project path'),
        related_paths: z.array(z.string()).optional().describe('Optional related repos to include in the cross-repo step'),
      } as any,
    } as any,
    async ({ path, related_paths }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(product.buildMcpDemoFlow(cas, path, related_paths || []));
    })
  );

  server.registerTool(
    'get_cross_repo_links',
    {
      title: 'Get Cross-Repo Links',
      description: 'Discover deterministic relationships across analyzed repositories: API calls, shared databases, message contracts, and shared internal libraries.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to link. Omit to use all analyzed repositories.'),
      } as any,
    } as any,
    async ({ paths }: any) => withErrorHandling(async () => {
      const repositories = await loadRepositoryAnalyses(paths);
      return json(product.buildCrossRepositoryLinks(repositories));
    })
  );

  server.registerTool(
    'run_workspace_analysis',
    {
      title: 'Run Workspace Analysis',
      description: 'Build and persist a WAS-compliant Workspace analysis after every associated project/repo already has a CAS analysis. This composes completed CAS outputs only: projects, deployables, distribution units, interfaces, runtime topology, infrastructure overlay, integration links, data-flow paths, inferred insights, unmatched interfaces, workspace capabilities, entity indexes, health, risk, and AI-required workspace narrative.',
      inputSchema: {
        name: z.string().optional().describe('Workspace analysis name. Defaults to analyzed-workspace.'),
        paths: z.array(z.string()).optional().describe('Analyzed project paths to include. Omit to use all analyzed repositories.'),
        workspace_root: z.string().optional().describe('Optional workspace folder. When provided, include analyzed repos under this root and honor its .klaurorc source.exclude and .klauroignore policy.'),
        exclude: z.array(z.string()).optional().describe('Optional additional workspace exclude patterns, e.g. ["desktop-tray/**", "archives/**"].'),
        ai_enrichment: z.boolean().optional().describe('Defaults to true. Set false for fast deterministic WAS generation; the returned narrative is marked AI-required degraded.'),
      } as any,
    } as any,
    async ({ name, paths, workspace_root, exclude, ai_enrichment }: any) => withErrorHandling(async () => {
      const { repositories, skippedInputs, inputPolicy } = await loadWorkspaceRepositoryAnalyses({ paths, workspaceRoot: workspace_root, exclude });
      const graphName = name || 'analyzed-workspace';
      const baseGraph = crossCodebaseAnalysis.buildWorkspaceAnalysis(graphName, repositories);
      const graph = ai_enrichment === false
        ? markWorkspaceAiEnrichmentSkipped(baseGraph)
        : await crossCodebaseAnalysis.enrichWorkspaceAnalysisNarrative(baseGraph);
      const saved = await saveCrossCodebaseSystemGraph(graph);
      return json({
        saved,
        summary: crossCodebaseAnalysis.summarizeWorkspaceAnalysis(graph),
        input_policy: inputPolicy,
        skipped_inputs: skippedInputs,
        next_mcp_calls: [
          { tool: 'get_workspace_analysis', args: { analysis_id_or_name: saved.id, detail_level: 'overview' } },
          { tool: 'get_workspace_agent_context', args: { analysis_id_or_name: saved.id, task: { task_type: 'cross-repo' } } },
          { tool: 'get_workspace_analysis', args: { analysis_id_or_name: saved.id, detail_level: 'evidence' } },
        ],
      });
    })
  );

  server.registerTool(
    'resolve_workspace_analysis',
    {
      title: 'Resolve Workspace Analysis',
      description: 'Find the best persisted WAS analysis for one or more local paths. Use this before cross-repo work when the agent has a workspace folder but not a workspace analysis id.',
      inputSchema: {
        path: z.string().optional().describe('Workspace, repo, or subfolder path to resolve.'),
        paths: z.array(z.string()).optional().describe('Optional set of repo/workspace paths to match against WAS inputs.'),
      } as any,
    } as any,
    async ({ path, paths }: any) => withErrorHandling(async () => {
      const selectedPaths = [...(path ? [path] : []), ...(paths || [])];
      const result = await resolveWorkspaceAnalysisForPaths(selectedPaths);
      if (!result.selected) return json({ selected: null, alternatives: result.alternatives, error: 'No workspace analyses found.' });
      const freshnessResult = await buildWorkspaceFreshness(result.selected);
      return json({
        selected: {
          id: result.selected.id,
          name: result.selected.name,
          generated_at: result.selected.generated_at,
          composition: result.selected.composition,
          health: result.selected.health,
          freshness: freshnessResult,
        },
        alternatives: result.alternatives,
        next_mcp_calls: [
          { tool: 'get_workspace_agent_context', args: { analysis_id_or_name: result.selected.id, task: { task_type: 'cross-repo' } } },
          { tool: 'get_workspace_analysis', args: { analysis_id_or_name: result.selected.id, detail_level: 'overview' } },
        ],
      });
    })
  );

  server.registerTool(
    'get_workspace_summary',
    {
      title: 'Get Workspace Summary',
      description: 'Return a compact WAS human/agent summary: AI-required narrative status, product value, composition, health, capabilities, workflows, domains, entities, infrastructure overlay, risk, and freshness.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
      } as any,
    } as any,
    async ({ analysis_id_or_name }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      const freshnessResult = await buildWorkspaceFreshness(graph);
      return json({
        id: graph.id,
        name: graph.name,
        generated_at: graph.generated_at,
        narrative: {
          source: graph.workspace_narrative.source,
          ai_provider: graph.workspace_narrative.ai_provider || graph.ai_enrichment?.provider,
          ai_model: graph.workspace_narrative.ai_model || graph.ai_enrichment?.model,
          ai_structured_model: graph.workspace_narrative.ai_structured_model || graph.ai_enrichment?.structured_model,
          confidence: graph.workspace_narrative.confidence,
          title: graph.workspace_narrative.title,
          product_value_summary: graph.workspace_narrative.product_value_summary,
          description: compactText(graph.workspace_narrative.description, 480),
          domains: graph.workspace_narrative.domains?.slice(0, 8),
          key_capabilities: graph.workspace_narrative.key_capabilities?.slice(0, 8),
          relationship_summary: graph.workspace_narrative.relationship_summary?.slice(0, 8),
          ai_required: graph.workspace_narrative.ai_required,
          generation_pass: graph.workspace_narrative.generation_pass,
          degraded_reason: graph.workspace_narrative.degraded_reason,
        },
        composition: graph.composition,
        health: graph.health,
        freshness: freshnessResult,
        domains: (graph.workspace_domains || []).slice(0, 8).map(compactWorkspaceSemanticItem),
        capabilities: (graph.workspace_capabilities || []).slice(0, 8).map(compactWorkspaceSemanticItem),
        workflows: (graph.workspace_workflows || []).slice(0, 6).map(compactWorkspaceSemanticItem),
        entities: (graph.workspace_entities || []).slice(0, 8).map(compactWorkspaceSemanticItem),
        infrastructure_overlay: graph.infrastructure_overlay ? {
          status: graph.infrastructure_overlay.status,
          summary: graph.infrastructure_overlay.summary,
          environments: graph.infrastructure_overlay.environments.slice(0, 6).map((environment: any) => ({
            name: environment.name,
            provider: environment.provider,
            type: environment.type,
            resource_count: environment.resource_count,
            deployable_ids: environment.deployable_ids?.slice?.(0, 5),
            infrastructure_kinds: environment.infrastructure_kinds?.slice?.(0, 5),
          })),
          shared_resources: graph.infrastructure_overlay.shared_resources.slice(0, 6).map((resource: any) => ({
            name: resource.name,
            kind: resource.kind,
            usage: resource.usage,
            environment: resource.environment,
            project_ids: resource.project_ids?.slice?.(0, 4),
          })),
          gaps: graph.infrastructure_overlay.gaps.slice(0, 4).map((gap: any) => ({
            kind: gap.kind,
            message: compactText(gap.message || gap.description || gap.name, 160),
            evidence: gap.evidence?.slice?.(0, 2),
          })),
        } : undefined,
        risk_areas: (graph.risk_areas || []).slice(0, 6).map((risk: any) => ({
          id: risk.id,
          title: risk.title,
          severity: risk.severity,
          description: compactText(risk.description, 180),
          project_ids: risk.project_ids?.slice?.(0, 4),
          deployable_ids: risk.deployable_ids?.slice?.(0, 4),
          evidence: risk.evidence?.slice?.(0, 3),
        })),
        activity: graph.activity,
        telemetry: graph.telemetry,
      });
    })
  );

  server.registerTool(
    'get_workspace_analysis',
    {
      title: 'Get Workspace Analysis',
      description: 'Load a persisted WAS-compliant Workspace analysis by id or name. Use detail_level=overview for the compact repo/app map, connections for deployable links and insights, evidence for interface/runtime evidence, or full for the complete graph.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
        detail_level: z.enum(['overview', 'connections', 'evidence', 'full']).optional().describe('Retrieval depth. Defaults to overview for MCP/API efficiency.'),
      } as any,
    } as any,
    async ({ analysis_id_or_name, detail_level }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      return json(crossCodebaseAnalysis.selectWorkspaceAnalysisDetail(graph, detail_level || 'overview'));
    })
  );

  server.registerTool(
    'get_workspace_agent_context',
    {
      title: 'Get Workspace Agent Context',
      description: 'Load a compact WAS-backed context for cross-repo agent work. Use before broad multi-repo exploration: selected surfaces with deployable flags, source-backed runtime links, package/topology/inferred candidates, isolated surfaces, token budget, agent read-next guidance, and follow-up MCP calls.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          instructions: z.string().optional(),
          max_apps: z.number().optional(),
          max_connections: z.number().optional(),
          max_external_dependencies: z.number().optional(),
        }).optional().describe('Task context for selecting compact workspace facts.'),
      } as any,
    } as any,
    async ({ analysis_id_or_name, task }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      return json(crossCodebaseAnalysis.buildWorkspaceAgentContext(graph, task || {}));
    })
  );

  server.registerTool(
    'get_workspace_freshness',
    {
      title: 'Get Workspace Freshness',
      description: 'Check whether a persisted WAS is current against the CAS analyses for its input repos.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
      } as any,
    } as any,
    async ({ analysis_id_or_name }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      return json(await buildWorkspaceFreshness(graph));
    })
  );

  server.registerTool(
    'validate_was_contract',
    {
      title: 'Validate WAS Contract',
      description: 'Score a persisted WAS for required sections, freshness, AI-required narrative enrichment, and relationship evidence readiness.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
      } as any,
    } as any,
    async ({ analysis_id_or_name }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      const freshnessResult = await buildWorkspaceFreshness(graph);
      return json(validateWasGraph(graph, freshnessResult));
    })
  );

  server.registerTool(
    'get_workspace_health',
    {
      title: 'Get Workspace Health',
      description: 'Return workspace health, activity, telemetry, trust, and highest-priority risk areas from WAS.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
      } as any,
    } as any,
    async ({ analysis_id_or_name }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      return json({ health: graph.health, activity: graph.activity, telemetry: graph.telemetry, priority_work_items: graph.priority_work_items || [], risk_areas: (graph.risk_areas || []).slice(0, 12) });
    })
  );

  server.registerTool(
    'get_workspace_risk_context',
    {
      title: 'Get Workspace Risk Context',
      description: 'Return WAS risk areas filtered by project, deployable, interface, severity, or target text, with MCP follow-up calls.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
        target: z.string().optional().describe('Optional project/deployable/interface/risk text filter.'),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
        limit: z.number().optional(),
      } as any,
    } as any,
    async ({ analysis_id_or_name, target, severity, limit }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      const terms = String(target || '').toLowerCase();
      const risks = (graph.risk_areas || [])
        .filter((risk: any) => !severity || risk.severity === severity)
        .filter((risk: any) => !terms || JSON.stringify(risk).toLowerCase().includes(terms))
        .slice(0, Number(limit) || 20);
      return json({ analysis_id: graph.id, risks, health: graph.health });
    })
  );

  server.registerTool(
    'get_workspace_capability_map',
    {
      title: 'Get Workspace Capability Map',
      description: 'Return whole-workspace domains, primary capabilities, workflows, and linked deployables from WAS.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
        target: z.string().optional().describe('Optional capability/domain/workflow text filter.'),
        limit: z.number().optional(),
      } as any,
    } as any,
    async ({ analysis_id_or_name, target, limit }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      const terms = String(target || '').toLowerCase();
      const bounded = (items: any[]) => items.filter(item => !terms || JSON.stringify(item).toLowerCase().includes(terms)).slice(0, Number(limit) || 30);
      return json({
        analysis_id: graph.id,
        domains: bounded(graph.workspace_domains || []),
        capabilities: bounded(graph.workspace_capabilities || []),
        workflows: bounded(graph.workspace_workflows || []),
      });
    })
  );

  server.registerTool(
    'get_workspace_entity_map',
    {
      title: 'Get Workspace Entity Map',
      description: 'Return whole-workspace entity concepts and entity paths assembled from repo-level CAS data entities, lineage, workflows, capabilities, and cross-repo flows. Repo-local entity details stay in CAS; use next_mcp_calls to drill down.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
        target: z.string().optional().describe('Optional entity, project, workflow, capability, field, or service text filter.'),
        include_paths: z.boolean().optional().describe('Include entity paths. Defaults to true.'),
        detail_level: z.enum(['summary', 'evidence', 'full']).optional().describe('summary returns compact traversal context; evidence adds bounded refs/evidence; full returns the legacy shape and may be large.'),
        limit: z.number().optional(),
      } as any,
    } as any,
    async ({ analysis_id_or_name, target, include_paths, detail_level, limit }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      const terms = String(target || '').toLowerCase();
      const max = Number(limit) || 30;
      const matches = (item: any) => !terms || JSON.stringify(item).toLowerCase().includes(terms);
      const projectById = new Map<string, any>((graph.codebases || []).map((codebase: any) => [String(codebase.id), codebase]));
      const compactRefs = (refs: any[] = [], refLimit = 4) => refs.slice(0, refLimit).map((ref: any) => ({
        project_id: ref.project_id,
        project_path: projectById.get(ref.project_id)?.path || ref.project_id,
        entity_id: ref.entity_id,
        file: ref.file,
        role: ref.role,
      }));
      const lineageCalls = (refs: any[] = [], callLimit = 4) => refs.slice(0, callLimit).map((ref: any) => ({
        tool: 'get_data_lineage',
        args: { path: projectById.get(ref.project_id)?.path || ref.project_id, entity_id: ref.entity_id },
      }));
      const compactEntity = (entity: any) => {
        if (detail_level === 'full') {
          return {
            ...entity,
            next_mcp_calls: lineageCalls(entity.entity_refs || [], 6),
          };
        }
        const refs = entity.entity_refs || [];
        const compact: any = {
          id: entity.id,
          name: entity.name,
          description: entity.description,
          description_source: entity.description_source,
          confidence: entity.confidence,
          project_ids: (entity.project_ids || []).slice(0, 8),
          project_count: (entity.project_ids || []).length,
          entity_ref_count: refs.length,
          path_count: entity.path_count || 0,
          related_workflow_count: (entity.related_workflow_ids || []).length,
          related_capability_count: (entity.related_capability_ids || []).length,
          sensitive_fields: (entity.sensitive_fields || []).slice(0, 8),
          next_mcp_calls: lineageCalls(refs, 4),
        };
        if (detail_level === 'evidence') {
          compact.entity_refs = compactRefs(refs, 8);
          compact.related_workflow_ids = (entity.related_workflow_ids || []).slice(0, 8);
          compact.related_capability_ids = (entity.related_capability_ids || []).slice(0, 8);
        }
        return compact;
      };
      const compactPath = (pathItem: any) => {
        if (detail_level === 'full') return pathItem;
        const refs = pathItem.entity_refs || [];
        const steps = (pathItem.steps || []).slice(0, detail_level === 'evidence' ? 6 : 3).map((step: any) => ({
          sequence: step.sequence,
          project_id: step.project_id,
          deployable_id: step.deployable_id,
          role: step.role,
          label: step.label,
          edge_type: step.edge_type,
          evidence_quality: step.evidence_quality,
          file: step.file,
          node_id: detail_level === 'evidence' ? step.node_id : undefined,
        }));
        const compact: any = {
          id: pathItem.id,
          name: pathItem.name,
          entity_name: pathItem.entity_name,
          path_type: pathItem.path_type,
          description: pathItem.description,
          source: compactPathEndpoint(pathItem.source),
          target: compactPathEndpoint(pathItem.target),
          steps,
          step_count: (pathItem.steps || []).length,
          project_ids: (pathItem.project_ids || []).slice(0, 8),
          project_count: (pathItem.project_ids || []).length,
          via: steps.length ? undefined : (pathItem.via || []).slice(0, 4).map((hop: any) => ({
            project_id: hop.project_id,
            deployable_id: hop.deployable_id,
            role: hop.role,
            label: hop.label,
            file: hop.file,
            node_id: detail_level === 'evidence' ? hop.node_id : undefined,
          })),
          sensitive: Boolean(pathItem.sensitive),
          confidence: pathItem.confidence,
          evidence_quality: pathItem.evidence_quality,
          next_mcp_calls: (pathItem.next_mcp_calls || []).slice(0, 3),
        };
        if (detail_level === 'evidence') {
          compact.evidence = (pathItem.evidence || []).slice(0, 8);
          compact.entity_refs = compactRefs(refs, 6);
        }
        return compact;
      };
      const compactPathEndpoint = (endpoint: any) => endpoint ? {
        project_id: endpoint.project_id,
        deployable_id: endpoint.deployable_id,
        role: endpoint.role,
        label: endpoint.label,
        file: endpoint.file,
        node_id: endpoint.node_id,
      } : undefined;
      const matchingEntities = (graph.workspace_entities || []).filter(matches);
      const matchingPaths = (graph.workspace_entity_paths || []).filter(matches);
      const topEntities = [...(graph.workspace_entities || [])]
        .sort((left: any, right: any) =>
          ((right.path_count || 0) + (right.related_workflow_ids || []).length + (right.related_capability_ids || []).length + (right.entity_refs || []).length) -
          ((left.path_count || 0) + (left.related_workflow_ids || []).length + (left.related_capability_ids || []).length + (left.entity_refs || []).length) ||
          String(left.name || '').localeCompare(String(right.name || ''))
        );
      const entitySpecific = Boolean(terms && matchingEntities.length > 0);
      const selectedEntities = entitySpecific
        ? matchingEntities
        : [...matchingEntities, ...topEntities.filter((entity: any) => !matchingEntities.some((match: any) => match.id === entity.id))];
      const selectedEntityNames = new Set(selectedEntities.slice(0, max).map((entity: any) => String(entity.name || '').toLowerCase()));
      const entities = selectedEntities
        .slice(0, max)
        .map(compactEntity);
      const selectedPaths = entitySpecific
        ? matchingPaths
        : [...matchingPaths, ...(graph.workspace_entity_paths || []).filter((pathItem: any) => selectedEntityNames.has(String(pathItem.entity_name || '').toLowerCase()))];
      const paths = include_paths === false ? [] : selectedPaths
        .slice(0, max)
        .map(compactPath);
      return json({
        analysis_id: graph.id,
        detail_level: detail_level || 'summary',
        totals: {
          workspace_entities: (graph.workspace_entities || []).length,
          workspace_entity_paths: (graph.workspace_entity_paths || []).length,
          matching_entities: matchingEntities.length,
          matching_entity_paths: matchingPaths.length,
          returned_entities: entities.length,
          returned_entity_paths: paths.length,
          fallback_top_entities_included: !entitySpecific && terms ? entities.length - matchingEntities.length : 0,
          truncated: selectedEntities.length > entities.length || (include_paths !== false && selectedPaths.length > paths.length),
        },
        entities,
        entity_paths: paths,
        guidance: [
          'This is a compact index. Use totals to decide whether to narrow target or request another page/target slice.',
          'Workspace entities are an index over repo-level CAS entities and lineage, not a duplicate source of truth.',
          'Use the included get_data_lineage calls to drill into repo-local readers, writers, boundaries, and tests before editing.',
        ],
      });
    })
  );

  server.registerTool(
    'get_workspace_workflow',
    {
      title: 'Get Workspace Workflow',
      description: 'Return a specific WAS workflow with connected deployables, interfaces, evidence, and repo-level drilldown calls.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
        workflow_id_or_name: z.string().describe('Workflow id or name'),
      } as any,
    } as any,
    async ({ analysis_id_or_name, workflow_id_or_name }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      const key = String(workflow_id_or_name || '').toLowerCase();
      const workflow = (graph.workspace_workflows || []).find((item: any) => String(item.id).toLowerCase() === key || String(item.name).toLowerCase().includes(key));
      if (!workflow) return json({ error: `Workspace workflow not found: ${workflow_id_or_name}` });
      const apps = (graph.applications || []).filter((app: any) => workflow.deployable_ids?.includes(app.id));
      return json({
        workflow,
        deployables: apps,
        interfaces: (graph.interfaces || []).filter((item: any) => workflow.interface_ids?.includes(item.id)),
        next_mcp_calls: apps.map((app: any) => ({ tool: 'get_agent_context', args: { path: app.codebase_path, workspace_analysis_id: graph.id, task: { task_type: 'trace', target: workflow.name } } })),
      });
    })
  );

  const workspaceListSchema = {
    limit: z.number().int().optional().describe(`Page size (default ${50}, max ${200}).`),
    offset: z.number().int().optional().describe('Page offset (default 0). Use next_offset from a prior call.'),
    name: z.string().optional().describe('Case-insensitive substring matched against workspace name AND id.'),
    min_repos: z.number().int().optional().describe('Keep only workspaces with at least this many member repos.'),
    dedupe_by: z.enum(['name', 'none']).optional().describe("Collapse re-runs to the richest entry per workspace name. Default 'name'."),
    sort: z.enum(['repos', 'recent', 'name']).optional().describe("Sort order. Default 'repos' (desc)."),
    compact: z.boolean().optional().describe('Compact projection with member repo names (default true).'),
    max_members: z.number().int().optional().describe('Max member-repo names per workspace in the compact shape (default 20).'),
  };
  const listWorkspacesDescription = 'List persisted WAS-compliant Workspace analyses, with narrowing and pagination. Re-runs of the same workspace are collapsed to the richest entry per name by default, so a few real workspaces are not buried under hundreds of duplicates. Filter by name or min_repos; sort by repos (default), recent, or name; page with limit/offset. Reports total_indexed, matched, has_more, next_offset. IMPORTANT: this indexes LOCAL analysis files on this machine (~/.klauro/analyses/workspace-analyses/), including one-off benchmark/gauntlet runs (ids often look like "gauntlet-<name>-<runid>") that scan arbitrary local folders and are NOT the same thing as a live account workspace or its connected-project membership on mcp.klauro.com. A "soon" entry here can have a very different repo_count/member_repos than the real account workspace of the same name. Never tell a user "workspace X has N repos" based on this tool alone — cross-check the live account workspace (GET /api/workspaces/:id/projects, or the web app) before reporting repo counts tied to a named account workspace.';

  server.registerTool(
    'list_workspace_analyses',
    {
      title: 'List Workspace Analyses',
      description: listWorkspacesDescription,
      inputSchema: workspaceListSchema as any,
    } as any,
    async (query: any) => withErrorHandling(async () => {
      const scope = await resolveAnalysisScope();
      return json({ scope: describeScopeForResponse(scope), ...listWorkspaceAnalysesFiltered(await listCrossCodebaseSystemGraphs(), query || {}) });
    })
  );

  server.registerTool(
    'run_cross_codebase_analysis',
    {
      title: 'Run Cross-Codebase Analysis',
      description: 'Deprecated name for run_workspace_analysis. Builds a WAS-compliant Workspace analysis from completed CAS outputs.',
      inputSchema: {
        name: z.string().optional().describe('Workspace analysis name. Defaults to analyzed-workspace.'),
        paths: z.array(z.string()).optional().describe('Analyzed project paths to include. Omit to use all analyzed repositories.'),
        workspace_root: z.string().optional().describe('Optional workspace folder. When provided, include analyzed repos under this root and honor its .klaurorc source.exclude and .klauroignore policy.'),
        exclude: z.array(z.string()).optional().describe('Optional additional workspace exclude patterns.'),
        ai_enrichment: z.boolean().optional().describe('Defaults to true. Set false for fast deterministic WAS generation.'),
      } as any,
    } as any,
    async ({ name, paths, workspace_root, exclude, ai_enrichment }: any) => withErrorHandling(async () => {
      const { repositories, skippedInputs, inputPolicy } = await loadWorkspaceRepositoryAnalyses({ paths, workspaceRoot: workspace_root, exclude });
      const graphName = name || 'analyzed-workspace';
      const baseGraph = crossCodebaseAnalysis.buildWorkspaceAnalysis(graphName, repositories);
      const graph = ai_enrichment === false
        ? markWorkspaceAiEnrichmentSkipped(baseGraph)
        : await crossCodebaseAnalysis.enrichWorkspaceAnalysisNarrative(baseGraph);
      const saved = await saveCrossCodebaseSystemGraph(graph);
      return json({
        saved,
        summary: crossCodebaseAnalysis.summarizeWorkspaceAnalysis(graph),
        input_policy: inputPolicy,
        skipped_inputs: skippedInputs,
        next_mcp_calls: [
          { tool: 'get_workspace_analysis', args: { analysis_id_or_name: saved.id, detail_level: 'overview' } },
          { tool: 'get_workspace_agent_context', args: { analysis_id_or_name: saved.id, task: { task_type: 'cross-repo' } } },
          { tool: 'get_workspace_analysis', args: { analysis_id_or_name: saved.id, detail_level: 'evidence' } },
        ],
      });
    })
  );

  server.registerTool(
    'get_cross_codebase_analysis',
    {
      title: 'Get Cross-Codebase Analysis',
      description: 'Deprecated name for get_workspace_analysis. Loads a persisted WAS-compliant Workspace analysis by id or name.',
      inputSchema: {
        analysis_id_or_name: z.string().describe('Workspace analysis id or name'),
        detail_level: z.enum(['overview', 'connections', 'evidence', 'full']).optional().describe('Retrieval depth. Defaults to overview for MCP/API efficiency.'),
      } as any,
    } as any,
    async ({ analysis_id_or_name, detail_level }: any) => withErrorHandling(async () => {
      const graph = await loadCrossCodebaseSystemGraph(analysis_id_or_name);
      if (!graph) return json({ error: `Workspace analysis not found: ${analysis_id_or_name}` });
      return json(crossCodebaseAnalysis.selectWorkspaceAnalysisDetail(graph, detail_level || 'overview'));
    })
  );

  server.registerTool(
    'list_cross_codebase_analyses',
    {
      title: 'List Cross-Codebase Analyses',
      description: `Deprecated name for list_workspace_analyses. ${listWorkspacesDescription}`,
      inputSchema: workspaceListSchema as any,
    } as any,
    async (query: any) => withErrorHandling(async () => {
      const scope = await resolveAnalysisScope();
      return json({ scope: describeScopeForResponse(scope), ...listWorkspaceAnalysesFiltered(await listCrossCodebaseSystemGraphs(), query || {}) });
    })
  );

  server.registerTool(
    'save_workspace_graph',
    {
      title: 'Save Workspace Graph',
      description: 'Build and persist a multi-repository workspace graph with cross-repo links, repository contracts, confidence, conflicts, and review decisions.',
      inputSchema: {
        name: z.string().optional().describe('Workspace graph name. Defaults to analyzed-workspace.'),
        paths: z.array(z.string()).optional().describe('Project paths to include. Omit to use all analyzed repositories.'),
      } as any,
    } as any,
    async ({ name, paths }: any) => withErrorHandling(async () => {
      const repositories = await loadRepositoryAnalyses(paths);
      const graphName = name || 'analyzed-workspace';
      const existing = await loadWorkspaceGraph(graphName);
      const graph = workspaceGraph.buildWorkspaceGraph(graphName, repositories, existing);
      const saved = await saveWorkspaceGraph(graph);
      return json({ saved, summary: workspaceGraph.summarizeWorkspaceGraph(graph), graph });
    })
  );

  server.registerTool(
    'get_workspace_graph',
    {
      title: 'Get Workspace Graph',
      description: 'Load a persisted multi-repository workspace graph by id or name.',
      inputSchema: {
        workspace_id_or_name: z.string().describe('Workspace graph id or name'),
      } as any,
    } as any,
    async ({ workspace_id_or_name }: any) => withErrorHandling(async () => {
      const graph = await loadWorkspaceGraph(workspace_id_or_name);
      if (!graph) return json({ error: `Workspace graph not found: ${workspace_id_or_name}` });
      return json({ summary: workspaceGraph.summarizeWorkspaceGraph(graph), graph });
    })
  );

  server.registerTool(
    'list_workspace_graphs',
    {
      title: 'List Workspace Graphs',
      description: 'List persisted multi-repository workspace graphs.',
      inputSchema: {} as any,
    } as any,
    async () => withErrorHandling(async () => {
      return json(await listWorkspaceGraphs());
    })
  );

  server.registerTool(
    'verify_workspace_link',
    {
      title: 'Verify Workspace Link',
      description: 'Mark a persisted workspace graph link as verified, rejected, or unreviewed while preserving the detected graph evidence.',
      inputSchema: {
        workspace_id_or_name: z.string().describe('Workspace graph id or name'),
        link_id: z.string().describe('Cross-repository link id'),
        decision: z.enum(['unreviewed', 'verified', 'rejected']).describe('Review decision'),
        reason: z.string().optional().describe('Reason or evidence for the decision'),
        actor: z.string().optional().describe('Person or agent recording the decision'),
      } as any,
    } as any,
    async ({ workspace_id_or_name, link_id, decision, reason, actor }: any) => withErrorHandling(async () => {
      const graph = await loadWorkspaceGraph(workspace_id_or_name);
      if (!graph) return json({ error: `Workspace graph not found: ${workspace_id_or_name}` });
      const updated = workspaceGraph.applyWorkspaceGraphDecision(graph, link_id, decision, { reason, actor });
      const saved = await saveWorkspaceGraph(updated);
      return json({ saved, summary: workspaceGraph.summarizeWorkspaceGraph(updated), graph: updated });
    })
  );

  server.registerTool(
    'get_agent_bootstrap',
    {
      title: 'Get Agent Bootstrap',
      description: 'Single default agent-start payload. Returns readiness, start context, tool plan, agent context, and a ready-to-use prompt for Codex, Claude, Cursor, or any coding agent.',
      inputSchema: {
        path: z.string().describe('Project path'),
        workspace_analysis_id: z.string().optional().describe('Optional WAS id/name. When provided, include compact workspace context alongside repo CAS context.'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          response_profile: z.enum(['standard', 'minimal', 'first-turn', 'capsule-only']).optional(),
        }).optional().describe('Optional task context for tailoring the default bootstrap'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(await agentBootstrap.getAgentBootstrap(cas, path, task || {}));
    })
  );

  server.registerTool(
    'get_agent_project_map',
    {
      title: 'Get Agent Project Map',
      description: 'List analyzed parent/subproject candidates for a repository path so agents can choose the most specific agent-context-ready CAS analysis before broad file reads.',
      inputSchema: {
        path: z.string().optional().describe('Repository or subproject path to filter candidates. Omit to map all stored analyses.'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          response_profile: z.enum(['standard', 'minimal', 'first-turn', 'capsule-only']).optional(),
        }).optional().describe('Optional task context used to score target matches.'),
        limit: z.number().optional().describe('Maximum candidates to return'),
      } as any,
    } as any,
    async ({ path, task, limit }: any) => withErrorHandling(async () => {
      return json(await agentProjectMap.getAgentProjectMap({ path, task: task || {}, limit }));
    })
  );

  server.registerTool(
    'resolve_agent_analysis',
    {
      title: 'Resolve Agent Analysis',
      description: 'Call this FIRST, before any Read/Grep/Glob exploration of a repository: one call tells you whether a pre-built code analysis (architecture graph, entry points, risks, tests) exists for this path and selects the best one, including routing monorepo roots to the right analyzed subproject. If an analysis exists, the follow-up tools replace dozens of exploratory file reads; if none exists, this reports that honestly so you can fall back to reading files. Costs one cheap call either way.',
      inputSchema: {
        path: z.string().describe('Repository or subproject path the agent was handed'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          response_profile: z.enum(['standard', 'minimal', 'first-turn', 'capsule-only']).optional(),
        }).optional().describe('Optional task context used to score the selected analysis'),
        detail: z.enum(['compact', 'full']).optional().describe("'compact' (default) omits the full candidates[] list when the match is exact and unambiguous; 'full' always includes candidates."),
      } as any,
    } as any,
    async ({ path, task, detail }: any) => withErrorHandling(async () => {
      return json(await agentProjectMap.resolveAgentAnalysis({ path, task: task || {}, detail }));
    })
  );

  server.registerTool(
    'get_server_version',
    {
      title: 'Get Server Version',
      description: 'Diagnostic: report the running Klauro MCP server\'s version and whether a newer build is available. Call this FIRST whenever a tool you expect (e.g. one mentioned in docs, changelog, or another agent\'s output) appears to be missing — that almost always means this MCP connection is a stale/pre-release build, not that the feature does not exist. Also detects the SILENT-STALENESS case: `klauro update` overwrites the installed package on disk, but an already-running MCP server process keeps executing the OLD build in memory until the client restarts (MCP servers do not hot-reload) — server_update/running_stale surfaces that drift even when this exact process has never seen a hosted-version check. Always available, no analysis required, never throws.',
      inputSchema: {
        server_url: z.string().optional().describe('Optional override for the release-manifest host; defaults to the stored login server, KLAURO_URL, or the public Klauro cloud URL.'),
      } as any,
    } as any,
    async ({ server_url }: any) => withErrorHandling(async () => {
      const identity = getBuildIdentity();
      const currentVersion = identity.version;
      const auth = loadStoredConnectorAuth();
      const resolvedServerUrl = normalizeServerUrl(server_url || auth.defaultServerUrl || process.env.KLAURO_URL);

      const staleness = await checkServerStaleness({ serverUrl: resolvedServerUrl, forceRefresh: true });
      const latestVersion = staleness.latest_version;
      const upToDate = latestVersion ? !staleness.running_stale && !staleness.update_available : null;
      const note = staleness.note
        ?? (latestVersion === null ? 'Could not reach the release manifest.' : 'On the latest version.');

      return json({
        current_version: currentVersion,
        latest_version: latestVersion,
        up_to_date: upToDate,
        update_command: 'klauro update',
        note,
        // Silent-staleness fields (SPEC: running bundle vs installed-on-disk bundle vs hosted latest):
        installed_version: staleness.installed_version,
        running_stale: staleness.running_stale,
        server_update: staleness.note,
      });
    })
  );

  server.registerTool(
    'get_agent_doctor',
    {
      title: 'Get Agent Doctor',
      description: 'Agent-use readiness check for Codex, Claude, and other agents: CAS contract, freshness, tests, runtime SDK proof, and golden snapshot status.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(await agentDoctor.getAgentDoctor(cas, path));
    })
  );

  server.registerTool(
    'get_agent_default_config',
    {
      title: 'Get Agent Default Config',
      description: 'Return install-ready agent-context-ready instructions for Codex, Claude, Cursor, or another coding agent without writing files.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          response_profile: z.enum(['standard', 'minimal', 'first-turn', 'capsule-only']).optional(),
        }).optional().describe('Optional task context for tailoring agent-context-ready instructions'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(await agentDefaults.getAgentDefaultConfig(cas, path, task || {}));
    })
  );

  server.registerTool(
    'install_agent_default_config',
    {
      title: 'Install Agent Default Config',
      description: 'Write .klauro/agent-defaults.json, .klauro/agent-defaults.md, and .klauro/skills/klauro/SKILL.md into a repository so agents have a default Klauro start path and skill-aware agents can learn K15/K5/G1.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          response_profile: z.enum(['standard', 'minimal', 'first-turn', 'capsule-only']).optional(),
        }).optional().describe('Optional task context for tailoring agent-context-ready instructions'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(await agentDefaults.writeAgentDefaultConfig(cas, path, task || {}));
    })
  );

  server.registerTool(
    'get_agent_start_context',
    {
      title: 'Get Agent Start Context',
      description: 'Call this BEFORE reading or grepping files in an analyzed repository — it replaces the first 20-40 exploratory Read/Grep/Glob calls with one response: the architecture map, entry points, key risks, top graph anchors, analysis readiness, and the recommended next calls for your task. This is the fastest way to orient in a codebase you have not seen before. Use after resolve_agent_analysis confirms an analysis exists.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          response_profile: z.enum(['standard', 'minimal', 'first-turn', 'capsule-only']).optional(),
        }).optional().describe('Optional task context for tailoring the default MCP path'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(agentAdoption.getAgentStartContext(cas, path, task || {}));
    })
  );

  server.registerTool(
    'get_agent_tool_plan',
    {
      title: 'Get Agent Tool Plan',
      description: 'Returns the exact sequence of analysis calls for your task type (orient, modify, debug, review, trace, cross-repo, runtime) so you do not have to guess which files to grep or which tools to chain. Call this instead of planning a manual file-exploration strategy; the pre-built code graph narrows the work area before you open a single file.',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Task context for selecting a plan'),
      } as any,
    } as any,
    async ({ path, task }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(agentAdoption.getAgentToolPlan(cas, { path, task: task || {} }));
    })
  );

  server.registerTool(
    'get_agent_context',
    {
      title: 'Get Agent Context',
      description: 'Return task-scoped context for what the agent is about to do. Klauro does not decide the task; it supplies the relevant graph target, risks, callers and callees, tests, invariants, idioms, in-flight overlap, and first source files so the agent can act with system understanding instead of broad rediscovery. Requires an existing analysis (check with resolve_agent_analysis).',
      inputSchema: {
        path: z.string().describe('Project path'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          response_profile: z.enum(['standard', 'minimal', 'first-turn', 'capsule-only']).optional().describe('Optional response budget. Use capsule-only when token savings matter most; use first-turn for compact fields plus capsules; use minimal for compact context; omit for the full context.'),
          runtime: CONTEXT_RUNTIME_PARAM,
          exclude_sections: EXCLUDE_SECTIONS_PARAM,
        }).optional().describe('Task context for building the agent context'),
      } as any,
    } as any,
    async ({ path, workspace_analysis_id, task }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      const resolvedTask = await applyRuntimeContextDefault(path, task);
      const context = await agentAdoption.getAgentContext(cas, path, resolvedTask);
      const workspaceGraph = workspace_analysis_id ? await loadCrossCodebaseSystemGraph(workspace_analysis_id) : null;
      return json(workspaceGraph ? {
        ...context,
        workspace_context: crossCodebaseAnalysis.buildWorkspaceAgentContext(workspaceGraph, task || { target: path }),
      } : context);
    })
  );

  server.registerTool(
    'get_capability_memory',
    {
      title: 'Get Capability Memory',
      description: 'Find existing analyzed capabilities that overlap the requested work so agents avoid rebuilding behavior that already exists. Use before adding new services, routes, workers, models, packages, or greenfield-adjacent features in an existing codebase.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Capability, file, node, route, domain, or user-requested feature to compare against existing CAS capabilities'),
        instructions: z.string().optional().describe('Task or plan text to match against existing capabilities'),
        success_criteria: z.array(z.string()).optional().describe('Expected outcomes to include in overlap matching'),
        files: z.array(z.string()).optional().describe('Known files involved in the work'),
        limit: z.number().optional().describe('Maximum capabilities to return'),
      } as any,
    } as any,
    async ({ path, target, instructions, success_criteria, files, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentAdoption.buildCapabilityMemoryForAgent(cas, {
        target,
        instructions,
        success_criteria,
        files,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_idiom_aware_agent_context',
    {
      title: 'Get Idiom-Aware Agent Context',
      description: 'Task-scoped agent context with compact repo-local idiom context. Use for edits where matching local naming, placement, boundaries, testing, migrations, and framework style matters.',
      inputSchema: {
        path: z.string().describe('Project path'),
        workspace_analysis_id: z.string().optional().describe('Optional WAS id/name for compact workspace context.'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          runtime: CONTEXT_RUNTIME_PARAM,
          exclude_sections: EXCLUDE_SECTIONS_PARAM,
        }).optional().describe('Task context for building the agent context'),
      } as any,
    } as any,
    async ({ path, workspace_analysis_id, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const resolvedTask = await applyRuntimeContextDefault(path, task);
      const context = await agentAdoption.getAgentContext(cas, path, resolvedTask);
      const workspaceGraph = workspace_analysis_id ? await loadCrossCodebaseSystemGraph(workspace_analysis_id) : null;
      return json({
        ...context,
        idiom_context: (context.work_context as any).idiom_context,
        ...(workspaceGraph ? { workspace_context: crossCodebaseAnalysis.buildWorkspaceAgentContext(workspaceGraph, task || { target: path }) } : {}),
      });
    })
  );

  server.registerTool(
    'open_agent_workbench',
    {
      title: 'Open Agent Workbench',
      description: 'Product-level agent workspace for a task: orientation, target resolution, file-read plan, repo rules, evidence policy, validation plan, and next MCP calls. Use before broad source exploration.',
      inputSchema: {
        path: z.string().describe('Project path'),
        workspace_analysis_id: z.string().optional().describe('Optional WAS id/name for compact workspace context.'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          change_type: z.enum(['add', 'modify', 'delete', 'refactor', 'rename', 'schema', 'test']).optional(),
          files: z.array(z.string()).optional(),
          diff_text: z.string().optional(),
          plan_text: z.string().optional(),
        }).optional().describe('Task context for the agent workbench'),
      } as any,
    } as any,
    async ({ path, workspace_analysis_id, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const workbench = await agentWorkflow.openAgentWorkbench(cas, path, task || {});
      const workspaceGraph = workspace_analysis_id ? await loadCrossCodebaseSystemGraph(workspace_analysis_id) : null;
      return json(workspaceGraph ? {
        ...workbench,
        workspace_context: crossCodebaseAnalysis.buildWorkspaceAgentContext(workspaceGraph, task || { target: path }),
      } : workbench);
    })
  );

  server.registerTool(
    'preflight_agent_change',
    {
      title: 'Preflight Agent Change',
      description: 'Before an agent edits or presents a plan, evaluate whether the proposed change fits the codebase model, idioms, invariants, tests, migrations, auth/tenant boundaries, and risk surface.',
      inputSchema: {
        path: z.string().describe('Project path'),
        workspace_analysis_id: z.string().optional().describe('Optional WAS id/name for cross-repo blast-radius context.'),
        target: z.string().optional().describe('Node id, file path, or natural language target'),
        plan_text: z.string().optional().describe('Agent plan text to evaluate'),
        diff_text: z.string().optional().describe('Optional unified diff to evaluate'),
        files: z.array(z.string()).optional().describe('Optional changed/proposed files'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
          change_type: z.enum(['add', 'modify', 'delete', 'refactor', 'rename', 'schema', 'test']).optional(),
          files: z.array(z.string()).optional(),
          diff_text: z.string().optional(),
          plan_text: z.string().optional(),
        }).optional().describe('Optional task context'),
      } as any,
    } as any,
    async ({ path, workspace_analysis_id, target, plan_text, diff_text, files, task }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const preflight = await agentWorkflow.preflightAgentChange(cas, path, {
        target,
        planText: plan_text,
        diffText: diff_text,
        files,
        task,
        includeWorkingTree: false,
      });
      const workspaceGraph = workspace_analysis_id ? await loadCrossCodebaseSystemGraph(workspace_analysis_id) : null;
      return json(workspaceGraph ? {
        ...preflight,
        workspace_context: crossCodebaseAnalysis.buildWorkspaceAgentContext(workspaceGraph, {
          task_type: task?.task_type || 'modify',
          target: target || task?.target,
          instructions: plan_text || task?.instructions,
        }),
      } : preflight);
    })
  );

  server.registerTool(
    'get_codebase_agent_rules',
    {
      title: 'Get Codebase Agent Rules',
      description: 'Generate a living, CAS-backed guide for how agents should work in this repository: architecture rules, idioms, invariant rules, testing rules, and evidence policy.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node id, file path, or natural language target'),
        files: z.array(z.string()).optional().describe('Optional files to focus rules on'),
        limit: z.number().optional().describe('Max idioms/invariants to include'),
      } as any,
    } as any,
    async ({ path, target, files, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentWorkflow.buildCodebaseAgentRules(cas, path, { target, files, limit }));
    })
  );

  server.registerTool(
    'explain_change_shape',
    {
      title: 'Explain Change Shape',
      description: 'Explain what a proposed or actual diff means in graph terms: changed files, touched CAS nodes, impacted tests, idioms, invariants, boundaries, and missing checks.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional target node id, file path, or search text'),
        plan_text: z.string().optional().describe('Optional plan text'),
        diff_text: z.string().optional().describe('Optional unified diff'),
        files: z.array(z.string()).optional().describe('Optional changed/proposed files'),
      } as any,
    } as any,
    async ({ path, target, plan_text, diff_text, files }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentWorkflow.explainChangeShape(cas, path, {
        target,
        planText: plan_text,
        diffText: diff_text,
        files,
      }));
    })
  );

  server.registerTool(
    'validate_agent_change',
    {
      title: 'Validate Agent Change',
      description: 'Post-edit validation for agents. Validates the working tree, explicit files, or diff text against repo-local idioms, behavioral invariants, migrations, tests, and change shape before finalizing.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node id, file path, or natural language target'),
        diff_text: z.string().optional().describe('Optional unified diff to validate'),
        files: z.array(z.string()).optional().describe('Optional changed files to validate instead of reading working tree'),
        include_working_tree: z.boolean().optional().describe('When true and no files/diff are supplied, validate git working tree. Default true.'),
        plan_text: z.string().optional().describe('Optional original plan text for context'),
      } as any,
    } as any,
    async ({ path, target, diff_text, files, include_working_tree, plan_text }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(agentWorkflow.validateAgentChange(cas, path, {
        target,
        diffText: diff_text,
        files,
        includeWorkingTree: include_working_tree,
        planText: plan_text,
      }));
    })
  );

  server.registerTool(
    'evaluate_analysis_truth',
    {
      title: 'Evaluate Analysis Truth',
      description: 'Compare CAS against explicit ground-truth expectations for frameworks, languages, routes, nodes, data entities, relationships, and runtime signals.',
      inputSchema: {
        path: z.string().describe('Project path'),
        expectation: z.object({
          name: z.string().optional(),
          frameworks: z.array(z.string()).optional(),
          languages: z.array(z.string()).optional(),
          routes: z.array(z.object({
            method: z.string().optional(),
            path: z.string(),
            handler: z.string().optional(),
            controller: z.string().optional(),
          })).optional(),
          nodes: z.array(z.object({
            name: z.string(),
            type: z.string().optional(),
            file: z.string().optional(),
          })).optional(),
          data_entities: z.array(z.string()).optional(),
          relationships: z.array(z.object({
            source: z.string(),
            target: z.string(),
            type: z.string().optional(),
          })).optional(),
          runtime_signals: z.array(z.string()).optional(),
        }).optional().describe('Ground-truth expectations. If omitted, MCP tries repo-local .klauro/analysis-expectations.json.'),
      } as any,
    } as any,
    async ({ path, expectation }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const loadedExpectation = expectation || await analysisMastery.loadTruthExpectation(path);
      if (!loadedExpectation) return json({ error: 'No expectation provided and no repo-local analysis expectation file found.' });
      return json(analysisMastery.evaluateAnalysisTruth(cas, loadedExpectation));
    })
  );

  server.registerTool(
    'get_semantic_map',
    {
      title: 'Get Semantic Map',
      description: 'Return a CAS-derived symbol and data map: files, imports, exports, entry/exit ownership, data entities, relationships, and method calls. Use when source-level semantics matter before reading files.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional target query to narrow the semantic map'),
        limit: z.number().optional().describe('Max matching nodes to include'),
      } as any,
    } as any,
    async ({ path, target, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(analysisMastery.getSemanticMap(cas, { target, limit }));
    })
  );

  server.registerTool(
    'get_framework_depth_report',
    {
      title: 'Get Framework Depth Report',
      description: 'Score detected frameworks by analyzer presence, framework-tagged nodes, entry points, evidence, runtime links, and expected framework-specific surfaces.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(analysisMastery.getFrameworkDepthReport(cas));
    })
  );

  server.registerTool(
    'get_integration_depth_report',
    {
      title: 'Get Integration Depth Report',
      description: 'Detect deeper library and platform integrations such as jobs, brokers, auth, payments, AI SDKs, infrastructure, observability, cache, and persistence; reports coverage and missing analyzer depth.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(integrationDepth.getIntegrationDepthReport(cas));
    })
  );

  server.registerTool(
    'get_cross_repo_contracts',
    {
      title: 'Get Cross Repo Contracts',
      description: 'Build contract-level views across repositories: provided HTTP/message/database contracts, consumed APIs/messages/databases, deterministic links, a contract table (route, consumer file, provider handler), cross-repo journeys (UI action file -> HTTP call -> backend route -> service -> terminal entity), route drift findings (repo-relative API calls with no matching backend route, classified missing-route vs near-miss with the nearest backend route; summary count plus top 10), and contract gaps.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to include. Omit to use all analyzed repositories.'),
        journey_limit: z.number().optional().describe('Max cross-repo journeys to compose (default 25).'),
      } as any,
    } as any,
    async ({ paths, journey_limit }: any) => withErrorHandling(async () => {
      const repositories = await loadRepositoryAnalyses(paths);
      return json(analysisMastery.getCrossRepoContracts(repositories, { journey_limit }));
    })
  );

  server.registerTool(
    'get_runtime_instrumentation_plan',
    {
      title: 'Get Runtime Instrumentation Plan',
      description: 'Turn CAS runtime_static_links into concrete runtime event contracts and instrumentation points for correlating production behavior back to CAS.',
      inputSchema: {
        path: z.string().describe('Project path'),
        limit: z.number().optional().describe('Max instrumentation points to return'),
      } as any,
    } as any,
    async ({ path, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(analysisMastery.getRuntimeInstrumentationPlan(cas, { limit }));
    })
  );

  server.registerTool(
    'get_runtime_event_contract',
    {
      title: 'Get Runtime Event Contract',
      description: 'Return the canonical runtime event schema and CAS-specific event payloads that SDKs should emit so production telemetry can correlate back to CAS.',
      inputSchema: {
        path: z.string().describe('Project path'),
        limit: z.number().optional().describe('Max CAS runtime link contracts to include'),
      } as any,
    } as any,
    async ({ path, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(runtimeContract.getRuntimeEventContract(cas, { limit }));
    })
  );

  server.registerTool(
    'get_runtime_sdk_package',
    {
      title: 'Get Runtime SDK Package',
      description: 'Generate a TypeScript runtime telemetry SDK package from the CAS runtime event contract, including client, middleware, fetch wrapper, and contract file.',
      inputSchema: {
        path: z.string().describe('Project path'),
        limit: z.number().optional().describe('Max CAS runtime link contracts to include in the generated contract file'),
      } as any,
    } as any,
    async ({ path, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(runtimeSdk.getRuntimeSdkPackage(cas, { limit }));
    })
  );

  server.registerTool(
    'evaluate_agent_task_proof',
    {
      title: 'Evaluate Agent Task Proof',
      description: 'Run agent contexts for representative tasks and score whether CAS gives agents enough target, risk, test, MCP, and file-read context to start work.',
      inputSchema: {
        path: z.string().describe('Project path'),
        tasks: z.array(z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
        })).optional().describe('Tasks to evaluate. Defaults to an orient task.'),
      } as any,
    } as any,
    async ({ path, tasks }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(await analysisMastery.evaluateAgentTaskProof(cas, path, tasks || [{ task_type: 'orient' }]));
    })
  );

  server.registerTool(
    'evaluate_agent_readiness',
    {
      title: 'Evaluate Agent Readiness',
      description: 'Score whether CAS/MCP is strong enough for agents to use by default on this repository. Checks graph quality, answerability, evidence, tests, runtime links, and safety surfaces.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      const evidence = await testDiscovery.getTestDiscoveryEvidence(path, cas);
      return json(agentAdoption.evaluateAgentReadiness(cas, path, { testEvidence: evidence }));
    })
  );

  server.registerTool(
    'run_agentic_benchmark',
    {
      title: 'Run Agentic Benchmark',
      description: 'Benchmark the same agent task with Klauro vs without Klauro using deterministic token/file/speed estimates and a two-agent live-run protocol.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to benchmark. Omit to use all analyzed repositories.'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Task to hand to both agents. Defaults to fixture-derived representative tasks.'),
        suite: z.boolean().optional().describe('Generate several CAS-derived task cards per repository.'),
        max_tasks_per_repo: z.number().optional().describe('Maximum generated suite tasks per repository'),
      } as any,
    } as any,
    async ({ paths, task, suite, max_tasks_per_repo }: any) => withErrorHandling(async () => {
      const selectedPaths = paths && paths.length > 0 ? paths : (await listAnalyses()).map(analysis => analysis.path);
      const report = await runAgenticBenchmark({
        repos: selectedPaths.map((repoPath: string) => ({ path: repoPath })),
        includeFixtures: false,
        task: task || undefined,
        suite: Boolean(suite),
        maxTasksPerRepo: max_tasks_per_repo,
        quiet: true,
      });
      const saved = await saveAgenticBenchmarkReport(report);
      return json({ saved, report, markdown: formatMarkdownReport(report) });
    })
  );

  server.registerTool(
    'get_agentic_benchmark_report',
    {
      title: 'Get Agentic Benchmark Report',
      description: 'Load persisted agentic benchmark reports. Use id=latest for the latest report.',
      inputSchema: {
        id: z.string().optional().describe('Benchmark report id. Defaults to latest.'),
        benchmark_type: z.string().optional().describe('When loading latest or listing, restrict to an exact benchmark_type such as agentic-suite-with-klauro-vs-without-klauro, deterministic-agent-quality-proxy, live-agent-quality-ab, or incremental-analysis-agent-value.'),
        list: z.boolean().optional().describe('When true, list reports instead of loading one.'),
      } as any,
    } as any,
    async ({ id, benchmark_type, list }: any) => withErrorHandling(async () => {
      if (list) return json(await listAgenticBenchmarkReports({ benchmarkType: benchmark_type }));
      const report = benchmark_type && (!id || id === 'latest')
        ? await loadLatestAgenticBenchmarkReportByType(benchmark_type)
        : await loadAgenticBenchmarkReport(id || 'latest');
      if (!report) return json({ error: `Agentic benchmark report not found: ${id || 'latest'}` });
      if (benchmark_type && report.benchmark_type !== benchmark_type) {
        return json({ error: `Agentic benchmark report ${id || 'latest'} has benchmark_type ${report.benchmark_type || 'unknown'}, not ${benchmark_type}` });
      }
      return json({ report, markdown: formatStoredBenchmarkReport(report) });
    })
  );

  server.registerTool(
    'get_agent_performance_proof',
    {
      title: 'Get Agent Performance Proof',
      description: 'Summarize persisted agent benchmarks into the current evidence that Klauro saves tokens, speeds agents up, preserves or improves quality, and keeps incremental analysis useful after edits.',
      inputSchema: {
        benchmark_types: z.array(z.string()).optional().describe('Exact benchmark_type values to include. Omit to include all persisted types.'),
        max_reports: z.number().optional().describe('Maximum persisted reports to inspect before grouping by latest benchmark type. Default 25.'),
        since_days: z.number().optional().describe('Only include reports generated within this many days. Defaults to 7. Use 0 to include all persisted reports.'),
      } as any,
    } as any,
    async ({ benchmark_types, max_reports, since_days }: any) => withErrorHandling(async () => {
      const benchmarkTypes = Array.isArray(benchmark_types) ? new Set(benchmark_types) : null;
      const sinceDays = since_days ?? 7;
      const summaries = (await listAgenticBenchmarkReports())
        .filter(summary => !benchmarkTypes || benchmarkTypes.has(summary.benchmark_type || ''))
        .filter(summary => reportSummaryWithinWindow(summary, sinceDays))
        .slice(0, max_reports || 25);
      const reports = [];
      for (const summary of summaries) {
        const report = await loadAgenticBenchmarkReport(summary.id);
        if (report) reports.push(report);
      }
      return json(buildAgentPerformanceProof(reports, { sinceDays }));
    })
  );

  server.registerTool(
    'run_agent_quality_benchmark',
    {
      title: 'Run Agent Quality Benchmark',
      description: 'Run the work-quality benchmark layer: success gates, context completeness, projected patch quality, token/time/file deltas, and optional live A/B agent command execution.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to benchmark. Omit to use all analyzed repositories.'),
        task: z.object({
          task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
          target: z.string().optional(),
          related_paths: z.array(z.string()).optional(),
          runtime_event: z.record(z.unknown()).optional(),
          instructions: z.string().optional(),
          success_criteria: z.array(z.string()).optional(),
        }).optional().describe('Single task to hand to both agents. Omit to generate a suite.'),
        max_tasks_per_repo: z.number().optional().describe('Maximum generated suite tasks per repository'),
        agent_with_command: z.string().optional().describe('Live with-Klauro agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        agent_without_command: z.string().optional().describe('Live without-Klauro agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        orchestrator_command: z.string().optional().describe('Optional evaluator command template. Supports {evaluation_input}, {evaluation_file}, {with_workspace}, {without_workspace}, {with_diff}, and {without_diff}.'),
        test_command: z.string().optional().describe('Optional command to run inside each copied repo after the agent attempt.'),
        work_root: z.string().optional().describe('Directory for live repo copies and benchmark artifacts.'),
        max_live_tasks: z.number().optional().describe('Maximum task pairs to run through live agents.'),
        live_task_types: z.array(z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime'])).optional().describe('Only run live pairs for these task types.'),
        live_task_categories: z.array(z.string()).optional().describe('Only run live pairs for these generated task categories, such as modify, debug, review, trace, data, external, runtime, or test.'),
        timeout_ms: z.number().optional().describe('Per-agent command timeout in milliseconds.'),
        test_timeout_ms: z.number().optional().describe('Per-test command timeout in milliseconds.'),
        orchestrator_timeout_ms: z.number().optional().describe('Evaluator command timeout in milliseconds.'),
      } as any,
    } as any,
    async ({ paths, task, max_tasks_per_repo, agent_with_command, agent_without_command, orchestrator_command, test_command, work_root, max_live_tasks, live_task_types, live_task_categories, timeout_ms, test_timeout_ms, orchestrator_timeout_ms }: any) => withErrorHandling(async () => {
      const selectedPaths = paths && paths.length > 0 ? paths : (await listAnalyses()).map(analysis => analysis.path);
      const report = await runAgentQualityBenchmark({
        repos: selectedPaths.map((repoPath: string) => ({ path: repoPath })),
        maxTasksPerRepo: max_tasks_per_repo,
        task: task || undefined,
        commands: {
          withKlauro: agent_with_command,
          withoutKlauro: agent_without_command,
          orchestrator: orchestrator_command,
          testCommand: test_command,
          workRoot: work_root,
          maxLiveTasks: max_live_tasks,
          liveTaskTypes: live_task_types,
          liveTaskCategories: live_task_categories,
          timeoutMs: timeout_ms,
          testTimeoutMs: test_timeout_ms,
          orchestratorTimeoutMs: orchestrator_timeout_ms,
        },
        live: Boolean(agent_with_command || agent_without_command),
        quiet: true,
      });
      const saved = await saveAgenticBenchmarkReport(report);
      return json({ saved, report, markdown: formatQualityMarkdownReport(report) });
    })
  );

  server.registerTool(
    'run_agent_idiom_benchmark',
    {
      title: 'Run Agent Idiom Benchmark',
      description: 'Run copied-repo A/B idiom quality tasks where both agents can pass correctness, but the with-Klauro arm receives CAS idiom context. Scores correctness, idiom conformance, minimality, test relevance, boundary preservation, and file targeting.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to benchmark. Omit to use all analyzed repositories.'),
        max_targets: z.number().optional().describe('Maximum repositories to benchmark'),
        max_tasks_per_repo: z.number().optional().describe('Maximum generated idiom tasks per repository'),
        agent_with_command: z.string().optional().describe('Live with-Klauro agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        agent_without_command: z.string().optional().describe('Live without-Klauro agent command template. Supports {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.'),
        orchestrator_command: z.string().optional().describe('Optional evaluator command template. Supports {evaluation_input}, {evaluation_file}, {with_workspace}, {without_workspace}, {with_diff}, and {without_diff}.'),
        test_command: z.string().optional().describe('Optional command to run inside each copied repo after the agent attempt.'),
        work_root: z.string().optional().describe('Directory for live repo copies and benchmark artifacts.'),
        max_live_tasks: z.number().optional().describe('Maximum task pairs to run through live agents.'),
        timeout_ms: z.number().optional().describe('Per-agent command timeout in milliseconds.'),
        test_timeout_ms: z.number().optional().describe('Per-test command timeout in milliseconds.'),
        orchestrator_timeout_ms: z.number().optional().describe('Evaluator command timeout in milliseconds.'),
      } as any,
    } as any,
    async ({ paths, max_targets, max_tasks_per_repo, agent_with_command, agent_without_command, orchestrator_command, test_command, work_root, max_live_tasks, timeout_ms, test_timeout_ms, orchestrator_timeout_ms }: any) => withErrorHandling(async () => {
      const selectedPaths = paths && paths.length > 0 ? paths : (await listAnalyses()).map(analysis => analysis.path);
      const report = await runAgentIdiomBenchmark({
        repos: selectedPaths.map((repoPath: string) => ({ path: repoPath })),
        maxTargets: max_targets,
        maxTasksPerRepo: max_tasks_per_repo,
        commands: {
          withKlauro: agent_with_command,
          withoutKlauro: agent_without_command,
          orchestrator: orchestrator_command,
          testCommand: test_command,
          workRoot: work_root,
          maxLiveTasks: max_live_tasks,
          timeoutMs: timeout_ms,
          testTimeoutMs: test_timeout_ms,
          orchestratorTimeoutMs: orchestrator_timeout_ms,
        },
        live: Boolean(agent_with_command || agent_without_command),
        quiet: true,
      });
      const saved = await saveAgenticBenchmarkReport(report);
      return json({ saved, report, markdown: formatIdiomBenchmarkMarkdown(report) });
    })
  );

  server.registerTool(
    'run_machine_agent_proof',
    {
      title: 'Run Machine Agent Proof',
      description: 'Discover every real Git repo under a dev root, account for unsupported/skipped repos, run analysis/readiness/idiom/incremental checks on eligible repos, and require live idiom A/B proof when agent commands are supplied.',
      inputSchema: {
        dev_root: z.string().optional().describe('Root to discover real Git repos under. Defaults to ~/dev.'),
        mode: z.enum(['fast', 'full']).optional().describe('fast samples eligible repos with resource budgets; full analyzes every eligible repo.'),
        max_targets: z.number().optional().describe('Limit eligible repos for expensive checks while still reporting all discovered repos.'),
        max_source_files: z.number().optional().describe('Skip eligible repos above this source-file count for expensive checks while still reporting them.'),
        work_root: z.string().optional().describe('Directory for copied repo workspaces and benchmark artifacts.'),
        no_live: z.boolean().optional().describe('Skip live idiom A/B execution. The live proof gate remains failed when skipped.'),
        agent_with_command: z.string().optional().describe('Live with-Klauro agent command template.'),
        agent_without_command: z.string().optional().describe('Live without-Klauro agent command template.'),
        orchestrator_command: z.string().optional().describe('Optional external evaluator command template.'),
        test_command: z.string().optional().describe('Optional command to run inside each copied repo after the agent attempt.'),
        max_live_tasks: z.number().optional().describe('Maximum live idiom task pairs.'),
        timeout_ms: z.number().optional().describe('Per-agent command timeout in milliseconds.'),
        test_timeout_ms: z.number().optional().describe('Per-test command timeout in milliseconds.'),
        analysis_budget_ms: z.number().optional().describe('Per-selected-repo analysis budget gate.'),
        incremental_budget_ms: z.number().optional().describe('Per-selected-repo incremental edit budget gate.'),
      } as any,
    } as any,
    async ({ dev_root, mode, max_targets, max_source_files, work_root, no_live, agent_with_command, agent_without_command, orchestrator_command, test_command, max_live_tasks, timeout_ms, test_timeout_ms, analysis_budget_ms, incremental_budget_ms }: any) => withErrorHandling(async () => {
      const report = await runMachineAgentProof({
        devRoot: dev_root || `${process.env.HOME || ''}/dev`,
        mode,
        maxTargets: max_targets,
        maxSourceFiles: max_source_files,
        outputPath: '',
        markdownPath: '',
        workRoot: work_root,
        runLive: !no_live,
        agentWithCommand: agent_with_command,
        agentWithoutCommand: agent_without_command,
        orchestratorCommand: orchestrator_command,
        testCommand: test_command,
        maxLiveTasks: max_live_tasks,
        timeoutMs: timeout_ms,
        testTimeoutMs: test_timeout_ms,
        discardWorkspaces: true,
        analysisBudgetMs: analysis_budget_ms,
        incrementalBudgetMs: incremental_budget_ms,
      });
      return json(report);
    })
  );

  server.registerTool(
    'run_incremental_value_benchmark',
    {
      title: 'Run Incremental Value Benchmark',
      description: 'Copy repositories, run an initial analysis, rerun with no changes, edit one source file, rerun incremental analysis, optionally verify against a fresh full analysis, and report speed, correctness, cache, and agent-context value.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Project paths to benchmark. Omit to use all analyzed repositories.'),
        max_targets: z.number().optional().describe('Maximum repositories to benchmark'),
        work_root: z.string().optional().describe('Directory for copied repo workspaces and isolated benchmark storage.'),
        verify_full: z.boolean().optional().describe('Run a fresh full analysis after the edit and compare CAS count parity.'),
        discard_workspaces: z.boolean().optional().describe('Remove copied repositories after collecting results.'),
      } as any,
    } as any,
    async ({ paths, max_targets, work_root, verify_full, discard_workspaces }: any) => withErrorHandling(async () => {
      const selectedPaths = paths && paths.length > 0 ? paths : (await listAnalyses()).map(analysis => analysis.path);
      const report = await runIncrementalValueBenchmark({
        repos: selectedPaths.map((repoPath: string) => ({ path: repoPath })),
        maxTargets: max_targets,
        workRoot: work_root,
        verifyFull: Boolean(verify_full),
        keepWorkspaces: discard_workspaces ? false : true,
        quiet: true,
      });
      const saved = await saveAgenticBenchmarkReport(report);
      return json({ saved, report, markdown: formatIncrementalValueMarkdownReport(report) });
    })
  );

  server.registerTool(
    'get_patterns',
    {
      title: 'Get Patterns',
      description: 'Design patterns and anti-patterns detected in the codebase. Returns pattern summaries with instance counts and variation breakdowns. Use get_pattern_instances to drill into specific pattern instances.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getPatterns(cas));
    })
  );

  server.registerTool(
    'get_communities',
    {
      title: 'Get Communities',
      description: 'Louvain functional modules: clusters of tightly call-connected functions/classes, discovered by community detection over the call graph. Surfaces de-facto modules an agent should treat as a unit. Each community lists member nodes and internal cohesion.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCommunities(cas));
    })
  );

  server.registerTool(
    'get_clones',
    {
      title: 'Get Clones',
      description: 'Near-duplicate (copy-paste) function/method groups via MinHash + Jaccard over structure-normalized code — catches renamed clones (Type-2). Each pair reports the two functions and an estimated similarity. Refactor and divergence-risk signal.',
      inputSchema: {
        path: z.string().describe('Project path'),
        threshold: z.number().optional().describe('Minimum estimated Jaccard similarity to report (0-1, default 0.8)'),
      } as any,
    } as any,
    async ({ path, threshold }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getClones(cas, { threshold }));
    })
  );

  server.registerTool(
    'get_dead_code',
    {
      title: 'Get Dead Code',
      description: 'Functions/methods with zero callers in the call graph, excluding entry points and tests. Surfaces unreachable or unused code (and exported-but-uncalled API surface) for cleanup or review.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDeadCode(cas));
    })
  );

  server.registerTool(
    'get_adrs',
    {
      title: 'Get ADRs',
      description: 'List Architecture Decision Records persisted for this project across sessions: the decisions, their status, context, and consequences.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      return json(await adrStore.getAdrs(path));
    })
  );

  server.registerTool(
    'manage_adr',
    {
      title: 'Manage ADR',
      description: 'Create or update an Architecture Decision Record (persisted across sessions). Provide title + decision; optionally context, consequences, status, and the id of an ADR this supersedes.',
      inputSchema: {
        path: z.string().describe('Project path'),
        title: z.string().describe('Short decision title'),
        decision: z.string().describe('The decision made'),
        context: z.string().optional().describe('Why the decision was needed'),
        consequences: z.string().optional().describe('Resulting trade-offs'),
        status: z.enum(['proposed', 'accepted', 'deprecated', 'superseded']).optional(),
        supersedes: z.string().optional().describe('id of an ADR this replaces'),
        id: z.string().optional().describe('Existing ADR id to update'),
      } as any,
    } as any,
    async ({ path, title, decision, context, consequences, status, supersedes, id }: any) => withErrorHandling(async () => {
      return json(await adrStore.saveAdr(path, { title, decision, context, consequences, status, supersedes, id }));
    })
  );

  server.registerTool(
    'query_graph',
    {
      title: 'Query Graph',
      description: "Cypher-lite query over the code graph. Supports MATCH (a)[-[:TYPE]->(b)] [WHERE a.field = 'value'] RETURN a|b — e.g. \"MATCH (a)-[:CALLS]->(b) WHERE b.name = 'save' RETURN a\" (callers of save), or \"MATCH (n) WHERE n.type = 'function' RETURN n\". Fields: name, type, id, file, qualified_name.",
      inputSchema: {
        path: z.string().describe('Project path'),
        query: z.string().describe('Cypher-lite query'),
        limit: z.number().optional().describe('Max nodes per RETURN variable (default 200)'),
      } as any,
    } as any,
    async ({ path, query: q, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(queryGraph(cas, q, { limit }));
    })
  );

  server.registerTool(
    'get_codebase_idioms',
    {
      title: 'Get Codebase Idioms',
      description: 'Repo-local conventions inferred from CAS: naming, file organization, module boundaries, dependency injection, data access, errors, validation, auth/tenant scope, logging, testing, migrations, async style, and configuration.',
      inputSchema: {
        path: z.string().describe('Project path'),
        category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional().describe('Filter by idiom category'),
        target: z.string().optional().describe('Node id, file path, or text target to filter idioms'),
        min_confidence: z.number().optional().describe('Minimum idiom confidence, 0-1'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, category, target, min_confidence, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(idiomQuery.getCodebaseIdioms(cas, { category, target, minConfidence: min_confidence, limit, offset }));
    })
  );

  server.registerTool(
    'get_idiom_examples',
    {
      title: 'Get Idiom Examples',
      description: 'Return positive local examples for codebase idioms so agents can copy the repo style before editing.',
      inputSchema: {
        path: z.string().describe('Project path'),
        idiom_id: z.string().optional().describe('Specific idiom id from get_codebase_idioms'),
        category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional().describe('Filter by idiom category'),
        target: z.string().optional().describe('Node id, file path, or text target to filter examples'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, idiom_id, category, target, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(idiomQuery.getIdiomExamples(cas, { idiomId: idiom_id, category, target, limit, offset }));
    })
  );

  server.registerTool(
    'validate_codebase_idioms',
    {
      title: 'Validate Codebase Idioms',
      description: 'Validate a working diff, explicit file list, or provided diff text against repo-local idioms. Use after edits to catch non-idiomatic naming, placement, testing, migration, logging, error-handling, and auth/tenant-scope drift.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node id, file path, or text target'),
        category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional().describe('Filter by idiom category'),
        files: z.array(z.string()).optional().describe('Explicit changed files to validate instead of reading the working tree'),
        diff_text: z.string().optional().describe('Optional unified diff text to validate'),
        include_working_tree: z.boolean().optional().describe('When false, validate only files/diff_text. Default true reads git working-tree and staged changes.'),
        min_confidence: z.number().optional().describe('Minimum idiom confidence, 0-1'),
        limit: z.number().optional().describe('Maximum impacted idioms to report'),
      } as any,
    } as any,
    async ({ path, target, category, files, diff_text, include_working_tree, min_confidence, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(idiomQuery.validateCodebaseIdioms(cas, path, {
        target,
        category,
        files,
        diffText: diff_text,
        includeWorkingTree: include_working_tree,
        minConfidence: min_confidence,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_pattern_instances',
    {
      title: 'Get Pattern Instances',
      description: 'Get the node IDs that are instances of a specific pattern. Optionally filter by variation. Paginated.',
      inputSchema: {
        path: z.string().describe('Project path'),
        pattern_id: z.string().describe('Pattern ID from get_patterns results'),
        variation_id: z.string().optional().describe('Filter to a specific variation'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, pattern_id, variation_id, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = query.getPatternInstances(cas, pattern_id, { variation_id, limit, offset });
      if (!result) return json({ error: `Pattern not found: ${pattern_id}` });
      return json(result);
    })
  );

  server.registerTool(
    'get_perspectives',
    {
      title: 'Get Perspectives',
      description: 'Multi-view analysis perspectives with connection rules and layout hints.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getPerspectives(cas));
    })
  );

  // -- Navigation & Search --

  server.registerTool(
    'search_nodes',
    {
      title: 'Search Nodes',
      description: 'Use this instead of Grep to find where a class, function, route, service, or concept lives: it searches the pre-built code graph and returns ranked nodes with file locations, types, and relationships rather than raw text matches, so "driver status" finds the handler even when the literal string never appears. Supports lexical, semantic, and hybrid retrieval modes.',
      inputSchema: {
        path: z.string().describe('Project path'),
        query: z.string().describe('Search query (matches name, qualified_name, description)'),
        type: z.string().optional().describe('Filter by node type (e.g. class, function, module, service, controller)'),
        category: z.string().optional().describe('Filter by category'),
        level: z.number().optional().describe('Filter by hierarchy level'),
        limit: z.number().optional().describe('Max results (default 8 in compact detail, 25 in full)'),
        mode: z.enum(['lexical', 'semantic', 'hybrid']).optional().describe('Retrieval mode. hybrid (default) and semantic blend embedding similarity with structural re-ranking; lexical matches names and descriptions only.'),
        detail: z.enum(['compact', 'full']).optional().describe("'compact' (default) returns a single final score per hit, drops graph_context, and lowers the default limit to 8; 'full' restores the semantic/lexical/structural score breakdown, graph_context, and the historical limit of 25."),
      } as any,
    } as any,
    async ({ path, query: q, type, category, level, limit, mode, detail }: any) => withErrorHandling(async () => {
      const resolvedMode = mode || 'hybrid';
      const resolvedDetail = detail || 'compact';
      if (resolvedMode === 'lexical') {
        // searchNodes returns a bare array (existing contract) — not stamped
        // with freshness_checked_at to avoid a breaking shape change; the
        // freshness guarantee still applies, it's just not observable on this
        // particular branch the way it is on object-shaped responses.
        const cas = await getFreshAnalysisForAgent(path);
        const resolvedLimit = limit || (resolvedDetail === 'full' ? 25 : 8);
        return json(query.searchNodes(cas, q, { type, category, level, limit: resolvedLimit }));
      }
      return json(withFreshnessStamp(await semanticSearch(path, q, { type, category, level, limit, detail: resolvedDetail, getCas: getFreshAnalysisForAgent })));
    })
  );

  server.registerTool(
    'semantic_search',
    {
      title: 'Semantic Search',
      description: 'Ask in plain English where code lives ("where are driver status updates handled?") and get ranked code nodes with file paths — use this instead of guessing grep keywords when you do not know the codebase vocabulary. Fuses embedding similarity with lexical match, then re-ranks on structural graph signals. Falls back to lexical search and reports degraded when no embedding index is available.',
      inputSchema: {
        path: z.string().describe('Project path'),
        query: z.string().describe('Natural-language description of the code to find'),
        type: z.string().optional().describe('Filter by node type'),
        category: z.string().optional().describe('Filter by category'),
        level: z.number().optional().describe('Filter by hierarchy level'),
        types: z.array(z.string()).optional().describe('Restrict results to these node types'),
        files: z.array(z.string()).optional().describe('Restrict results to nodes in these files'),
        limit: z.number().optional().describe('Max results (default 25)'),
      } as any,
    } as any,
    async ({ path, query: q, type, category, level, types, files, limit }: any) => withErrorHandling(async () => {
      return json(withFreshnessStamp(await semanticSearch(path, q, { type, category, level, types, files, limit, getCas: getFreshAnalysisForAgent })));
    })
  );

  server.registerTool(
    'get_embedding_status',
    {
      title: 'Get Embedding Status',
      description: 'Report the embedding index for an analysis: model, dimensions, store, coverage, generation time, and whether the index is degraded, stale, or absent.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const index = cas.embedding_index;
      if (!index) {
        return json({
          status: 'no_index',
          has_index: false,
          message: 'This analysis has no embedding index. Semantic search falls back to lexical retrieval.',
        });
      }
      return json({
        status: index.degraded ? 'degraded' : 'ready',
        has_index: true,
        model: index.model,
        provider: index.provider,
        dimensions: index.dimensions,
        document_version: index.document_version,
        store: index.store,
        generated_at: index.generated_at,
        node_count: index.node_count,
        coverage: index.coverage,
        degraded: Boolean(index.degraded),
        degraded_reason: index.degraded_reason,
      });
    })
  );

  server.registerTool(
    'get_node',
    {
      title: 'Get Node Details',
      description: 'Full details for a specific code element: signature, metadata, documentation, call graph, children, connected edges, entry/exit points, decorators, intent, change risk, stability.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID from search results or other tools'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = query.getNode(cas, node_id);
      if (!result) return json({ error: `Node not found: ${node_id}` });
      return json(result);
    })
  );

  server.registerTool(
    'get_file_nodes',
    {
      title: 'Get File Nodes',
      description: 'All code elements defined in a specific file, with their internal relationships.',
      inputSchema: {
        path: z.string().describe('Project path'),
        file_path: z.string().describe('Relative file path within the project'),
      } as any,
    } as any,
    async ({ path, file_path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getFileNodes(cas, file_path, path));
    })
  );

  server.registerTool(
    'get_level',
    {
      title: 'Get Level',
      description: 'Progressive disclosure: get nodes at a specific hierarchy level with their edges and entry/exit points. Level 0 is system-wide, level 1 is subsystems, deeper levels reveal more detail. Optimized for token efficiency: nodes default to 50, edges to 200. Cross-level edges use node_refs for deduplication.',
      inputSchema: {
        path: z.string().describe('Project path'),
        level: z.number().describe('Hierarchy level (0 = system, 1 = subsystems, deeper = more detail)'),
        limit: z.number().optional().describe('Max nodes to return (default 50)'),
        offset: z.number().optional().describe('Skip first N nodes (default 0)'),
        edge_limit: z.number().optional().describe('Max edges to return (default 200)'),
        include_edges: z.boolean().optional().describe('Include edges in response (default true)'),
        include_entry_exit: z.boolean().optional().describe('Include entry/exit points (default true)'),
      } as any,
    } as any,
    async ({ path, level, limit, offset, edge_limit, include_edges, include_entry_exit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getLevel(cas, level, { limit, offset, edge_limit, include_edges, include_entry_exit }));
    })
  );

  // -- Entry/Exit Points & Routes --

  server.registerTool(
    'get_entry_points',
    {
      title: 'Get Entry Points',
      description: 'All system entry points (HTTP endpoints, CLI commands, WebSocket handlers, event listeners, scheduled tasks, etc.). Optionally filter by type. Paginated (default 50). Each entry point carries a `telemetry` facet (request_count/error_rate/p50/p95/p99) when real runtime observations identify it — by resolved static/node id, or by its own route+method when only route-level telemetry exists (GAP #32 fix; omitted, never fabricated, when nothing matches). Other optional per-entry fields an analysis may carry (input, output, security, capabilities, interaction_reach, deployable_id, deployable_name) pass through unchanged when present.',
      inputSchema: {
        path: z.string().describe('Project path'),
        type: z.string().optional().describe('Filter by type: http, websocket, cli, event, schedule, page, route, message, file, test'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, type, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = query.getEntryPoints(cas, { type, limit, offset });
      // ENTRY-POINT ANALYSIS-GAP ENRICHMENT (query-time — keeps the stored CAS
      // canonical, mirrors the getFlowConcepts/telemetry query-time pattern).
      // Every join here reads ONLY CAS-level data (boundaries, deployable
      // evidence, seams) with no flow derivation, so the hot path stays cheap.
      // Contract/capability enrichment (which needs derived flows) is
      // deliberately NOT wired here — deriving all flows per get_entry_points
      // call is the exact getFlowConcepts cost the old /conceptual path paid.
      let eps: any[] = result.entry_points || [];
      eps = ensureEntryPointDescription(eps);                                             // description coverage (was 28% missing)
      eps = attachDeployable(eps, cas.deployable_evidence, cas.nodes);                     // per-deployable attribution
      eps = attachEntryPointSecurity(eps, cas.security_boundaries, cas.security_contexts); // per-entry security (boundary/context join)
      eps = attachInteractionReach(eps, cas.communication_seams as any);                  // external vs internal reach
      // TELEMETRY facet: join persisted runtime metrics by id/node/route. Also
      // where any optional per-entry field passes through untouched (entries are
      // spread verbatim, never rebuilt field-by-field).
      const runtimeMetrics = await runtimeMetricsForContract(cas, path);
      return json({
        ...result,
        entry_points: attachEntryPointTelemetry(eps, runtimeMetrics),
      });
    })
  );

  server.registerTool(
    'get_exit_points',
    {
      title: 'Get Exit Points',
      description: 'All external interactions (database calls, API calls, file operations, message publishing, cache operations, SDK calls, webhooks). Paginated (default 50).',
      inputSchema: {
        path: z.string().describe('Project path'),
        type: z.string().optional().describe('Filter by type: database, api, file, message, cache, sdk, webhook'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, type, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getExitPoints(cas, { type, limit, offset }));
    })
  );

  server.registerTool(
    'get_communication_seams',
    {
      title: 'Get Communication Seams',
      description: "Unified modality classification of every communication seam between components. For each seam — an exit point, a messaging edge, or a shared-state link — it returns a modality: SYNC (request/response the caller awaits: HTTP/REST, gRPC unary, GraphQL, RPC, DB reads), ASYNC (fire-and-forget: message publish/consume, queue enqueue, webhook, event emit), or PASSIVE (communication via shared state — two components that both write and read the same database entity/cache/bucket, with no direct call). Each seam carries confidence + the driving fact as evidence. Also returns a system-level inventory (sync/async/passive counts and the component-to-component seams with their modality) at node level or, rolled up, deployable level. Derived additively from exit/entry/messaging/data-lineage facts. Use level=deployable for cross-deployable seams; filter by modality to isolate e.g. passive shared-state coupling.",
      inputSchema: {
        path: z.string().describe('Project path'),
        modality: z.enum(['sync', 'async', 'passive']).optional().describe('Filter to one modality'),
        level: z.enum(['node', 'deployable', 'workspace']).optional().describe('Inventory rollup level (default node)'),
        limit: z.number().optional().describe('Max seams to return (default 50)'),
        offset: z.number().optional().describe('Skip first N seams (default 0)'),
      } as any,
    } as any,
    async ({ path, modality, level, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCommunicationSeams(cas, { modality, level, limit, offset }));
    })
  );

  server.registerTool(
    'get_route_table',
    {
      title: 'Get Route Table',
      description: 'HTTP route table: method, path, controller, handler, auth requirements, guards, middleware. Paginated (default 50).',
      inputSchema: {
        path: z.string().describe('Project path'),
        method: z.string().optional().describe('Filter by HTTP method (GET, POST, PUT, DELETE, etc.)'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, method, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getRouteTable(cas, { method, limit, offset }));
    })
  );

  server.registerTool(
    'get_cicd_pipelines',
    {
      title: 'Get CI/CD Pipelines',
      description: 'First-class CI/CD read: every detected pipeline with its triggers, stages, jobs, steps (command/action/env+secret refs), deploy targets, and the inter-job DAG. Reads the already-computed CAS CI facts (GitHub Actions, GitLab CI, CircleCI, Jenkins, Azure Pipelines, Travis, Drone, Buildkite, Bitbucket, TeamCity) — does not recompute. Cheap map first (paginated pipelines + counts), heavy step detail included per pipeline. Filter by provider or deploy_only to isolate release pipelines. Use before touching CI or tracing how the code ships.',
      inputSchema: {
        path: z.string().describe('Project path'),
        provider: z.string().optional().describe('Filter by CI provider (github-actions, gitlab-ci, circleci, jenkins, azure-pipelines, travis-ci, drone, buildkite, bitbucket-pipelines, teamcity)'),
        deploy_only: z.boolean().optional().describe('Only pipelines that have at least one deploy target'),
        limit: z.number().optional().describe('Max pipelines to return (default 20)'),
        offset: z.number().optional().describe('Skip first N pipelines (default 0)'),
      } as any,
    } as any,
    async ({ path, provider, deploy_only, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCicdPipelines(cas, { provider, deployOnly: deploy_only, limit, offset }));
    })
  );

  server.registerTool(
    'get_external_services',
    {
      title: 'Get External Services',
      description: 'All external service integrations with purpose, endpoint, usage pattern, monitoring, and cost info.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getExternalServices(cas));
    })
  );

  // -- Call Graph & Flow Tracing --

  server.registerTool(
    'get_callers',
    {
      title: 'Get Callers',
      description: 'Find code elements that call or reference a given node. Traverses edges and method calls. Limited to 50 results by default.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find callers for'),
        depth: z.number().optional().describe('Max traversal depth (default 2)'),
        limit: z.number().optional().describe('Max results to return (default 50)'),
      } as any,
    } as any,
    async ({ path, node_id, depth, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCallers(cas, node_id, depth, limit));
    })
  );

  server.registerTool(
    'get_callees',
    {
      title: 'Get Callees',
      description: 'Find code elements that a given node calls or references. Limited to 50 results by default.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find callees for'),
        depth: z.number().optional().describe('Max traversal depth (default 2)'),
        limit: z.number().optional().describe('Max results to return (default 50)'),
      } as any,
    } as any,
    async ({ path, node_id, depth, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCallees(cas, node_id, depth, limit));
    })
  );

  // -- Component Hierarchy (React/Frontend) --

  server.registerTool(
    'get_component_parents',
    {
      title: 'Get Component Parents',
      description: 'Find components that render a given component (via JSX). Shows which parent components use this component in their render output.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Component node ID to find parents for'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, node_id, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getComponentParents(cas, node_id, limit));
    })
  );

  server.registerTool(
    'get_component_children',
    {
      title: 'Get Component Children',
      description: 'Find components that a given component renders (via JSX). Shows which child components are used in this component\'s render output.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Component node ID to find children for'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, node_id, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getComponentChildren(cas, node_id, limit));
    })
  );

  server.registerTool(
    'get_component_metrics',
    {
      title: 'Get Component Metrics',
      description: 'Full metrics for a React component: usage count, usage locations, rendered components, props, state, hooks. Includes parent and child component lists.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Component node ID'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = query.getComponentMetrics(cas, node_id);
      if (!result) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Node not found or not a component' }) }], isError: true };
      }
      return json(result);
    })
  );

  server.registerTool(
    'get_shared_components',
    {
      title: 'Get Shared Components',
      description: 'Find components that are used in multiple places. Useful for identifying high-impact components where changes need careful consideration.',
      inputSchema: {
        path: z.string().describe('Project path'),
        min_usage: z.number().optional().describe('Minimum usage count to include (default 2)'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, min_usage, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getSharedComponents(cas, { min_usage, limit }));
    })
  );

  server.registerTool(
    'get_call_chain',
    {
      title: 'Get Call Chain',
      description: 'Complete call chain from entry to exit. With chain_id: returns full chain detail. With entry_point_id: returns chains for that entry. Without filters: returns paginated chain summaries (id, type, entry/exit, risk level).',
      inputSchema: {
        path: z.string().describe('Project path'),
        chain_id: z.string().optional().describe('Specific call chain ID for full detail'),
        entry_point_id: z.string().optional().describe('Entry point ID to find chains for'),
        limit: z.number().optional().describe('Max results when listing all chains (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, chain_id, entry_point_id, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCallChain(cas, { chainId: chain_id, entryPointId: entry_point_id, limit, offset }));
    })
  );

  server.registerTool(
    'get_method_calls',
    {
      title: 'Get Method Calls',
      description: 'All method calls made by or received by a node, with execution context (async, conditional, loop depth), arguments, external details, framework semantics, performance hints.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getMethodCalls(cas, node_id));
    })
  );

  server.registerTool(
    'get_interface_signature',
    {
      title: 'Get Interface Signature',
      description: 'The I/L/S/O contract for one entity in a single call: Input (required parameters / entry points it triggers on), Logic (blackbox caller/callee wiring — counts + key refs, truncation-signal honest), Side-effects (exit points + external data-lineage recipients + boundaries crossed), Output (return type / produced entities), and purpose (terminal-signal proximity, when reachable). Replaces the manual join of get_entry_points + get_exit_points + get_data_lineage + get_callers/get_callees for the same target. Level-aware: function/flow/capability resolve to one node; project/workspace aggregate from product_map + entry/exit points (gaps are reported honestly, not fabricated). Call this before changing an entity to see its full contract and blast radius.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().describe('Node ID, file path, search query, or "project"/"workspace" for the aggregate rollup'),
        level: z.enum(['auto', 'function', 'flow', 'capability', 'project', 'workspace']).optional().describe('Granularity (default: auto-detected from target shape)'),
        caller_limit: z.number().optional().describe('Max callers to include in logic.key_refs (default: 10)'),
        callee_limit: z.number().optional().describe('Max callees to include in logic.key_refs (default: 10)'),
      } as any,
    } as any,
    async ({ path, target, level, caller_limit, callee_limit }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(withFreshnessStamp(query.getInterfaceSignature(cas, target, { level, caller_limit, callee_limit })));
    })
  );

  server.registerTool(
    'get_flow_concepts',
    {
      title: 'Get Flow Concepts',
      description: 'High-level named flows (the behavioral conceptual layer over the call graph, docs/SPEC-CONCEPTUAL-LAYER.md) — each flow = an ordered set of semantic steps (Validate -> Process -> Persist -> Call External -> Respond), not a raw function chain. Each flow and each step carries the full 6-facet UNDERSTANDING CONTRACT (docs/UNDERSTANDING-MODEL.md), all evidence-gated: (1) input, (2) output, (3) logic, (4) system effects split into state_changes (DB/cache/file writes, entity mutations) vs external_integrations (API/webhook/SDK/queue calls), (5) constraints — first-class {kind, rule, evidence} records where kind is validation | auth | rate-limit | error | invariant | business-rule | consistency (derived from validation schemas, auth guards, guard clauses, data-entity/behavioral invariants, and the consistency model — e.g. "reads from this replica are eventually consistent"), and (6) telemetry — real runtime metrics (request_count/error_rate/p50-p95-p99/status distribution) joined onto the unit WHEN observations exist for it, omitted otherwise. Nothing is fabricated: a facet with no supporting fact is omitted. Each step ties back to concrete function_ids, 1:1, 1:many, or a sub-section (line-range) of a single large function. Flows link to capability_id when a system_capabilities entry references the same entry point, and list the data entities touched. Deterministic-first (composed from entry_points, call edges, exit_points, data_lineage, data_entities.invariants, consistency_model, and persisted telemetry) — omits (not fabricates) whatever cannot be derived, with reasons in gaps. Powers the UI capability->flow->step->function hierarchy, agent work-alignment (coordinate at flow/step level, not file/function), and the coordination fabric. Sits between get_summary (names the capability) and get_coding_context/get_call_chain (drills a step into its concrete function) — the middle rung of the level-drilling path, and the concept-level vocabulary the fabric uses for claims ("I own the Persist step of the Checkout flow") when multiple agents work this codebase at once.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Restrict to entry points matching this id, name, or route path substring (e.g. "/orders" or "createOrder"); omit for all derivable flows'),
        max_depth: z.number().optional().describe('Bound on forward call-chain traversal depth from the entry point (default 6)'),
        max_functions_per_flow: z.number().optional().describe('Cap on distinct functions traced per flow, deduped (default 40)'),
        max_flows: z.number().optional().describe('Cap on number of flows returned (default 15 when target is omitted — each flow carries a full I/L/S/O contract per flow+step, so "all entry points" can be very large on big repos; response reports total_available/truncated so you know when to raise this. When target is set the result is already narrow and uncapped by default.)'),
        role: z.enum(['core', 'supporting', 'infrastructure']).optional().describe('Filter to flows with this semantic role. core = domain capability flows; supporting = auth/config/notifications/audit; infrastructure = plumbing (health/telemetry/migrations/serialization). Each returned flow also carries `role` + `role_evidence`, and the response includes a role_breakdown count. When set, all flows are classified first so the filter never silently misses matches past the browse cap.'),
        detail: z.enum(['compact', 'full']).optional().describe("'compact' (default) elides the heavy evidence tiers — contract facet_provenance and per-step code_mappings — with availability markers (facet_provenance_available, code_mappings_available) so a browse response stays small; 'full' inlines the walkable provenance + typed step-code mapping chains. Prefer compact + a targeted full call over full browsing."),
      } as any,
    } as any,
    async ({ path, target, max_depth, max_functions_per_flow, max_flows, role, detail }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      // TELEMETRY facet: join persisted runtime metrics onto flow/step
      // contracts when observations exist (evidence-gated, omitted otherwise).
      const runtimeMetrics = await runtimeMetricsForContract(cas, path);
      // INTERPRETIVE layer: persisted AI-authored flow/step descriptions
      // (element-description store, kind 'flow') feed the nameStep seam —
      // matched units flip description_source to 'ai'; unmatched units keep
      // their deterministic labels. Empty store -> fully deterministic output.
      const aiDescriptions = await descriptionEnrichment.loadStoredFlowDescriptions(path).catch(() => undefined);
      return json(query.getFlowConcepts(cas, { target, maxDepth: max_depth, maxFunctionsPerFlow: max_functions_per_flow, maxFlows: max_flows, role, detail, runtimeMetrics, aiDescriptions }));
    })
  );

  server.registerTool(
    'get_unified_perspectives',
    {
      title: 'Get Unified Perspectives',
      description: 'ONE call that sees the code from every angle at once (docs/SPEC-CONCEPTUAL-LAYER.md §3/§6): the BEHAVIORAL hierarchy (capabilities/flows/steps, same data as get_flow_concepts) cross-referenced with the STRUCTURAL perspectives (architectural conflicts + paradigm conformance, same data as get_architectural_conflicts/get_paradigm_conformance) — each side annotated with links into the other instead of three siloed tool calls. Every flow/step carries `structural.layers` (the architectural layer(s) its functions sit in, e.g. entry/business/data/presentation — derived deterministically from the same node classification flow segmentation already uses) and `structural.paradigm_deviations` (paradigm-norm deviations whose evidence node lands inside that step, if any). Every architectural conflict / principle violation carries `flow_links` (flow_ids/step_ids/capability_ids whose traced function set actually contains the conflict\'s evidence node — e.g. "this layering violation sits on the Persist step of the Checkout flow"). Links are only asserted when real node-id/file membership supports them — never guessed by name similarity; omitted otherwise (see cross_links_summary + gaps). Additive/composed only: get_architectural_conflicts, get_paradigm_conformance, and get_flow_concepts remain independently callable with unchanged behavior — use this tool when you want the cross-referenced view in one call instead of joining them by hand.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Restrict flows to entry points matching this id, name, or route path substring; omit for all derivable flows'),
        max_flows: z.number().optional().describe('Cap on number of flows included (default 10, since this composes flow + architectural + paradigm passes in one call)'),
        severity: z.enum(['low', 'medium', 'high']).optional().describe('Minimum severity filter for architectural conflicts'),
      } as any,
    } as any,
    async ({ path, target, max_flows, severity }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getUnifiedPerspectives(cas, { target, maxFlows: max_flows, severity }));
    })
  );

  // -- Agentic Coding Tools --

  server.registerTool(
    'get_coding_context',
    {
      title: 'Get Coding Context',
      description: 'THE essential tool for AI coding. Returns everything needed to start coding in a specific area: target node details, conventions, patterns, layer boundaries, modification checklist, connected code, and — when real runtime observations exist for the resolved node — a `telemetry` facet (request_count/error_rate/p50-p95-p99), the telemetry facet of the uniform 6-facet understanding contract (docs/UNDERSTANDING-MODEL.md; omitted when no observation matches, never fabricated). Call this before writing ANY code. This is the bottom rung of the level-drilling path (get_summary -> get_flow_concepts -> here): use it once you have a concrete target — a step from get_flow_concepts, or a node from search — to resolve it down to the actual function(s)/sub-section.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().describe('Node ID, file path, or search query to find the target'),
        task_type: z.enum(['add', 'modify', 'delete', 'refactor']).optional().describe('Type of change (default: modify)'),
        include: z.array(z.string()).optional().describe('Sections to include: conventions, patterns, constraints, tests (default: all)'),
        caller_limit: z.number().optional().describe('Max callers to include in connected_code (default: 10). If the node has more, the response reports callers_total and truncated:true — pass a larger limit or call get_callers directly for the full set.'),
        callee_limit: z.number().optional().describe('Max callees to include in connected_code (default: 10). If the node has more, the response reports callees_total and truncated:true — pass a larger limit or call get_callees directly for the full set.'),
      } as any,
    } as any,
    async ({ path, target, task_type, include, caller_limit, callee_limit }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      // TELEMETRY facet: join persisted runtime metrics onto the resolved
      // target node's contract (evidence-gated; omitted when none match).
      const runtimeMetrics = await runtimeMetricsForContract(cas, path);
      const context: any = query.getCodingContext(cas, target, { task_type, include, caller_limit, callee_limit, runtimeMetrics });
      // WS-A (minimal, safe merge): surface fused runtime facts for the
      // resolved target node, if any were persisted via telemetry ingest.
      // We don't have a dedicated dataDir/workspace parameter on this tool,
      // so we reuse `path` as the workspace key (same convention as
      // get_runtime_observations / ingest_telemetry) rather than threading a
      // new parameter through query.getCodingContext.
      const nodeId = context?.target_node?.id;
      if (nodeId) {
        const fused = await loadPersistedRuntimeFacts('', path).catch(() => null);
        const matches = fused?.facts?.filter((f) => f.node_id === nodeId) || [];
        if (matches.length > 0) context.fused_runtime_facts = matches;
      }
      // Per-file staleness surface (additive, non-blocking): getFreshAnalysisForAgent
      // just refreshed this CAS, so the changed-file set is normally empty here — it
      // is only non-empty when a refresh couldn't complete synchronously (e.g. a huge
      // diff tripped the full-rebuild path). Attach the specific reason to the node
      // instead of only a project-wide banner, so the agent knows exactly what's
      // uncertain rather than an undifferentiated stale/fresh flag.
      const nodeFile = context?.target_node?.file;
      if (nodeFile) {
        const postRefreshSummary = freshness.summarizeAnalysisFreshness(path, cas.analysis_timestamp);
        const normalizedFile = String(nodeFile).replace(/\\/g, '/');
        const stillChanged = postRefreshSummary?.files_changed_since_analysis.examples.some(
          (f) => normalizedFile.endsWith(f) || f.endsWith(normalizedFile)
        );
        if (stillChanged) {
          context.may_be_stale = {
            value: true,
            reason: `${nodeFile} changed since the last completed analysis and a synchronous refresh could not fully resolve it (likely an in-progress full rebuild after a large diff). Treat this node's file/line citations as provisional.`,
          };
        }
      }
      return json(withFreshnessStamp(context));
    })
  );

  server.registerTool(
    'get_conventions',
    {
      title: 'Get Conventions',
      description: 'Codebase coding standards extracted from actual code patterns: naming conventions, file organization, import style, error handling patterns, async patterns. Use to ensure new code matches existing style.',
      inputSchema: {
        path: z.string().describe('Project path'),
        scope: z.enum(['global', 'layer', 'module']).optional().describe('Scope of conventions (default: global)'),
        layer: z.string().optional().describe('Layer name if scope=layer'),
        module_id: z.string().optional().describe('Module node ID if scope=module'),
      } as any,
    } as any,
    async ({ path, scope, layer, module_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getConventions(cas, { scope, layer, module_id }));
    })
  );

  server.registerTool(
    'get_modification_guide',
    {
      title: 'Get Modification Guide',
      description: 'Complete safety checklist before modifying specific code: risk level, blast radius, files that must be updated, verification steps, existing tests, tests to add, rollback considerations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to modify'),
        change_type: z.enum(['signature', 'behavior', 'delete', 'add_parameter', 'rename']).describe('Type of change'),
      } as any,
    } as any,
    async ({ path, node_id, change_type }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getModificationGuide(cas, node_id, change_type));
    })
  );

  server.registerTool(
    'get_pattern_examples',
    {
      title: 'Get Pattern Examples',
      description: 'Get actual working code examples for detected patterns. Use to learn how patterns are implemented in this codebase before writing similar code.',
      inputSchema: {
        path: z.string().describe('Project path'),
        pattern_id: z.string().describe('Pattern ID from get_patterns'),
        variation_id: z.string().optional().describe('Specific variation ID'),
        limit: z.number().optional().describe('Max examples (default 3)'),
      } as any,
    } as any,
    async ({ path, pattern_id, variation_id, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getPatternExamples(cas, pattern_id, { variation_id, limit }));
    })
  );

  server.registerTool(
    'find_similar_code',
    {
      title: 'Find Similar Code',
      description: 'Find code similar to a given node for consistency and potential reuse. Returns similarity scores, reasons, differences, and reuse recommendations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().optional().describe('Node ID to find similar code for'),
        code_snippet: z.string().optional().describe('Code snippet to find similar code for'),
        similarity_type: z.enum(['structural', 'semantic', 'both']).optional().describe('Type of similarity (default: both)'),
        limit: z.number().optional().describe('Max results (default 10)'),
      } as any,
    } as any,
    async ({ path, node_id, code_snippet, similarity_type, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.findSimilarCode(cas, { node_id, code_snippet, similarity_type, limit }));
    })
  );

  // -- Agentic Coding Tools (Tier 2) --

  server.registerTool(
    'get_comments',
    {
      title: 'Get Comments',
      description: 'Surface TODO/FIXME/HACK/NOTE/WARNING comments affecting a code area. Filter by scope (node, file, module, all) and comment types.',
      inputSchema: {
        path: z.string().describe('Project path'),
        scope: z.enum(['node', 'file', 'module', 'all']).describe('Scope of comments to retrieve'),
        node_id: z.string().optional().describe('Node ID (required if scope=node or scope=module)'),
        file_path: z.string().optional().describe('File path (required if scope=file)'),
        types: z.array(z.enum(['todo', 'fixme', 'hack', 'note', 'warning'])).optional().describe('Comment types to include (default: all)'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, scope, node_id, file_path, types, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getComments(cas, { scope, node_id, file_path, types, limit }));
    })
  );

  server.registerTool(
    'get_error_contracts',
    {
      title: 'Get Error Contracts',
      description: 'What errors can a function throw/return and how callers handle them. Shows throws, caught_by callers, and uncaught paths to entry points.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to analyze'),
        direction: z.enum(['throws', 'catches', 'both']).optional().describe('Analysis direction (default: both)'),
      } as any,
    } as any,
    async ({ path, node_id, direction }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getErrorContracts(cas, node_id, direction));
    })
  );

  server.registerTool(
    'get_framework_guidance',
    {
      title: 'Get Framework Guidance',
      description: 'Framework-specific best practices for the detected stack. Shows detected patterns, recommendations, and anti-patterns found.',
      inputSchema: {
        path: z.string().describe('Project path'),
        framework: z.string().optional().describe('Framework name (auto-detect if not specified)'),
        topic: z.enum(['routing', 'state', 'data-fetching', 'testing', 'security']).optional().describe('Specific topic to focus on'),
      } as any,
    } as any,
    async ({ path, framework, topic }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getFrameworkGuidance(cas, { framework, topic }));
    })
  );

  server.registerTool(
    'get_usage_examples',
    {
      title: 'Get Usage Examples',
      description: 'How is this function/class/type actually used throughout the codebase? Shows usage count, patterns, and example locations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find usages for'),
        limit: z.number().optional().describe('Max results (default 10)'),
        include_tests: z.boolean().optional().describe('Include test file usages (default: false)'),
      } as any,
    } as any,
    async ({ path, node_id, limit, include_tests }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getUsageExamples(cas, node_id, { limit, include_tests }));
    })
  );

  server.registerTool(
    'get_configuration',
    {
      title: 'Get Configuration',
      description: 'Surface configuration that affects code behavior. Filter by scope (all, runtime, build, test) or find config affecting a specific node.',
      inputSchema: {
        path: z.string().describe('Project path'),
        scope: z.enum(['all', 'runtime', 'build', 'test']).optional().describe('Config scope (default: all)'),
        affecting_node_id: z.string().optional().describe('Find config affecting this specific node'),
      } as any,
    } as any,
    async ({ path, scope, affecting_node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getConfiguration(cas, { scope, affecting_node_id }));
    })
  );

  // -- v1.7.0 Intelligence --

  server.registerTool(
    'get_intent',
    {
      title: 'Get Intent',
      description: 'WHY code exists: inferred purpose, constraints, architectural decisions with evidence, workaround indicators.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const result = query.getIntent(cas, node_id);
      if (!result) return json({ error: `No intent data for node: ${node_id}` });
      return json(result);
    })
  );

  server.registerTool(
    'get_data_entities',
    {
      title: 'Get Data Entities',
      description: 'Data entity lifecycle: entities with fields, CRUD lifecycle (created_by, read_by, updated_by, deleted_by), transformations, invariants, sensitive data, validation gaps. Each entity also carries a semantic `role` (core = domain/business noun the product exists for; supporting = auth/config/session/audit; infrastructure = migration/log/telemetry/serialization plumbing) with `role_evidence`, classified by the shared core/supporting/infrastructure classifier (reused from the workspace item classifier) anchored on the already-computed domain-concept classification and the entity lifecycle shape; the response includes a role_breakdown count. Paginated (default 25).',
      inputSchema: {
        path: z.string().describe('Project path'),
        entity_name: z.string().optional().describe('Filter by entity name'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
        role: z.enum(['core', 'supporting', 'infrastructure']).optional().describe('Filter to entities with this semantic role (applied before pagination so total/role_breakdown stay honest).'),
      } as any,
    } as any,
    async ({ path, entity_name, limit, offset, role }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDataEntities(cas, { entityName: entity_name, limit, offset, role }));
    })
  );

  server.registerTool(
    'get_security_overview',
    {
      title: 'Get Security Overview',
      description: 'Security posture: trust boundaries, enforcement points (enforced/assumed/missing), bypass risks, unprotected operations, per-node trust levels and protection gaps.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getSecurityOverview(cas));
    })
  );

  server.registerTool(
    'get_behavioral_invariants',
    {
      title: 'Get Behavioral Invariants',
      description: 'First-class behavior-level invariants inferred from CAS: tenant/org scope, auth and authorization boundaries, database constraints, migration contracts, and test coverage evidence.',
      inputSchema: {
        path: z.string().describe('Project path'),
        invariant_type: z.enum(['tenant-scope', 'auth-boundary', 'authorization', 'db-constraint', 'migration-contract', 'test-coverage', 'data-lifecycle', 'business-rule']).optional().describe('Filter by invariant type'),
        target: z.string().optional().describe('Node id, file path, entity, field, or text target to filter invariants'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, invariant_type, target, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getBehavioralInvariants(cas, { invariantType: invariant_type, target, limit, offset }));
    })
  );

  server.registerTool(
    'validate_behavioral_invariants',
    {
      title: 'Validate Behavioral Invariants',
      description: 'Validate a working diff, explicit file list, or provided diff text against CAS behavioral invariants. Use after edits and before final answers to catch tenant-scope, auth, DB constraint, migration, and test-coverage risks.',
      inputSchema: {
        path: z.string().describe('Project path'),
        target: z.string().optional().describe('Optional node id, file path, entity, field, or text target'),
        invariant_type: z.enum(['tenant-scope', 'auth-boundary', 'authorization', 'db-constraint', 'migration-contract', 'test-coverage', 'data-lifecycle', 'business-rule']).optional().describe('Filter by invariant type'),
        files: z.array(z.string()).optional().describe('Explicit changed files to validate instead of reading the working tree'),
        diff_text: z.string().optional().describe('Optional unified diff text to validate'),
        include_working_tree: z.boolean().optional().describe('When false, validate only files/diff_text. Default true reads git working-tree and staged changes.'),
        limit: z.number().optional().describe('Maximum impacted invariants to return'),
      } as any,
    } as any,
    async ({ path, target, invariant_type, files, diff_text, include_working_tree, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(invariantValidation.validateBehavioralInvariants(cas, path, {
        target,
        invariantType: invariant_type,
        files,
        diffText: diff_text,
        includeWorkingTree: include_working_tree,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_stability',
    {
      title: 'Get Stability',
      description: 'Code stability and churn analysis. With node_id: returns detailed stability for that node. Without: returns summary with class distribution counts (not individual node data).',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().optional().describe('Specific node ID (omit for full summary)'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getStability(cas, node_id));
    })
  );

  server.registerTool(
    'assess_change_risk',
    {
      title: 'Assess Change Risk',
      description: 'Risk of modifying a code element: risk level, factors (many-callers, critical-path, no-tests, etc.), downstream impact (direct/transitive callers, affected chains and entry points), test protection, stability context, recommendations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to assess'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.assessChangeRisk(cas, node_id));
    })
  );

  server.registerTool(
    'get_flow_coverage',
    {
      title: 'Get Flow Coverage',
      description: 'Per-flow test coverage. With chain_id: returns full coverage detail and test gaps for that chain. Without: returns coverage status counts and test gap severity counts (not individual flow data).',
      inputSchema: {
        path: z.string().describe('Project path'),
        chain_id: z.string().optional().describe('Specific call chain ID (omit for all flows)'),
      } as any,
    } as any,
    async ({ path, chain_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getFlowCoverage(cas, chain_id));
    })
  );

  server.registerTool(
    'get_semantic_coverage',
    {
      title: 'Get Semantic Coverage',
      description: 'Measures "everything rolls up" (docs/SEMANTIC-MODEL.md "Coverage invariants") — the honest, deterministic answer to how much of the code the Capability->Flow->Step semantic layer actually explains. Returns three ratios (0..1): reachable_code_to_steps (of executable nodes REACHABLE from an entry point via the call graph, what fraction participate in >=1 flow step), steps_to_flows (of all steps, what fraction are assigned to a flow — an invariant ~1.0 by construction, measured to catch regressions), and flows_to_capabilities (of flows, what fraction carry >=1 capability relationship). Each ratio reports mapped/total. Crucially it also returns the UNMAPPED lists themselves (not just counts): the reachable code_units with no step (each with a deterministic reason: reachable-with-effects-uncaptured | framework-generated | test-code | reachable-no-effects), orphan steps, and capability-less flows — capped ~50 each with an omitted count. Unmapped code is surfaced, never hidden: it flags missing semantics, generic infra, dead code, framework-generated behavior, incomplete extraction, or an undiscovered capability. Deterministic (Camp-B), evidence-only, byte-stable run-to-run; measured over the full flow set (same as get_flow_coverage). Use to audit semantic completeness of an analysis and to see exactly what the flow layer is not yet explaining.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getSemanticCoverage(cas));
    })
  );

  // -- Workflows & Capabilities --

  server.registerTool(
    'get_workflows',
    {
      title: 'Get Workflows',
      description: 'Business workflows. With workflow_id: returns full workflow detail. Without: returns workflow summaries (id, name, type, criticality, counts) and dependency graph.',
      inputSchema: {
        path: z.string().describe('Project path'),
        workflow_id: z.string().optional().describe('Specific workflow ID (omit for all)'),
      } as any,
    } as any,
    async ({ path, workflow_id }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getWorkflows(cas, workflow_id));
    })
  );

  server.registerTool(
    'get_user_journeys',
    {
      title: 'Get User Journeys',
      description: 'Deterministic end-to-end user journeys composed from entry points, call chains, and terminal effects. Each journey shows why a path exists via its terminal entities (e.g. "Create work order -> WorkOrder created"). With journey_id: returns full journey detail with steps, security boundaries, and covering tests. Without: returns paginated journey summaries with a human-readable title/headline and the compact step chain (node_id, name, layer, depth) per journey, so no 2nd call is needed just to see the steps. Set include_steps false to drop the step chain from the list for very large listings. Use format markdown for a readable journey brief.',
      inputSchema: {
        path: z.string().describe('Project path'),
        journey_id: z.string().optional().describe('Specific journey ID for full detail'),
        kind: z.enum(['user-facing', 'system', 'scheduled']).optional().describe('Filter by journey kind'),
        limit: z.number().optional().describe('Max results when listing (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
        format: z.enum(['json', 'markdown']).optional().describe("Output format: 'json' (default) or 'markdown' for a human-readable journey brief"),
        include_steps: z.boolean().optional().describe('Include the compact step chain (node_id, name, layer, depth) per journey in the list form (default true)'),
      } as any,
    } as any,
    async ({ path, journey_id, kind, limit, offset, format, include_steps }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getUserJourneys(cas, { journeyId: journey_id, kind, limit, offset, format, includeSteps: include_steps }));
    })
  );

  server.registerTool(
    'get_paradigm_conformance',
    {
      title: 'Get Paradigm Conformance',
      description: 'Statistically detected codebase paradigms (service-mediated data access, entry-service-repository layering, guarded HTTP entry points, single-owner entity writes) with adoption rates, evidence files, and file-level deviations. Norms only emerge when at least 70 percent of comparable code follows the shape, so repos without a norm produce no noise. With paradigm: returns full detail including every deviation. Without: returns per-paradigm summaries with up to 3 sample deviations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        paradigm: z.string().optional().describe('Specific paradigm name for full detail (e.g. guarded-http-entry-points)'),
      } as any,
    } as any,
    async ({ path, paradigm }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getParadigmConformance(cas, { paradigm }));
    })
  );

  server.registerTool(
    'get_architectural_conflicts',
    {
      title: 'Get Architectural Conflicts',
      description: 'Architectural consistency check: is what you are about to build (or what already exists) consistent with how this system is actually built? Returns pattern-conflict/overlap findings — the same concern (e.g. entry-to-repository data access) handled by two competing structural patterns in different places — and engineering-principle violations (layering skips, single-responsibility/ownership breaks, coupling hotspots), each grounded in file/node evidence. Call this BEFORE adding non-trivial code to a large system so cohesion is maintained by construction, not caught after the fact. is_cohesive is true only when no conflicts and no error-severity principle violations were found.',
      inputSchema: {
        path: z.string().describe('Project path'),
        severity: z.enum(['low', 'medium', 'high']).optional().describe('Minimum conflict severity to include'),
        limit: z.number().optional().describe('Max conflicts to return (default 25)'),
        offset: z.number().optional().describe('Skip first N conflicts (default 0)'),
      } as any,
    } as any,
    async ({ path, severity, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getFreshAnalysisForAgent(path);
      return json(withFreshnessStamp(query.getArchitecturalConflicts(cas, { severity, limit, offset })));
    })
  );

  server.registerTool(
    'get_data_lineage',
    {
      title: 'Get Data Lineage',
      description: 'Deterministic per-entity data lineage: which code writes and reads each data entity, which external services receive it, which security boundaries the data crosses and whether they are guarded, and which user journeys carry it. Entities are ranked by exposure (sensitive fields + unguarded paths + external transfer first). With entity_id (or entity, an alias that also matches by display name, case-insensitively): returns full lineage detail for one entity, or an explicit not-found error naming known entities if it does not resolve. Without either: returns ranked summaries.',
      inputSchema: {
        path: z.string().describe('Project path'),
        entity_id: z.string().optional().describe('Specific data entity ID for full lineage detail'),
        entity: z.string().optional().describe('Alias for entity_id — also resolves by entity display name, case-insensitively (e.g. "Invoice")'),
        sensitive_only: z.boolean().optional().describe('Only return entities with sensitive fields'),
        limit: z.number().optional().describe('Max results when listing (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, entity_id, entity, sensitive_only, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDataLineage(cas, { entityId: entity_id, entityName: entity, sensitiveOnly: sensitive_only, limit, offset }));
    })
  );

  server.registerTool(
    'diff_behavior',
    {
      title: 'Diff Behavior',
      description: 'Behavior-level diff between the current analysis and a prior snapshot: journeys added/removed/changed (matched by entry signature plus terminal entities, not ids), security boundary changes and newly unguarded entries, capability additions and possible duplicates, data lineage exposure changes for sensitive entities, and paradigm deviations introduced or resolved. Risk flags appear first, e.g. a new journey that writes an entity without crossing the auth boundary.',
      inputSchema: {
        path: z.string().describe('Project path'),
        snapshot: z.string().optional().describe("Snapshot id to diff against, or 'previous' for the most recent prior snapshot (default)"),
      } as any,
    } as any,
    async ({ path, snapshot }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.diffBehaviorAgainstSnapshot(path, cas, snapshot));
    })
  );

  server.registerTool(
    'get_product_map',
    {
      title: 'Get Product Map',
      description: 'What this codebase actually does, in one call — read this instead of skimming READMEs and directory trees to orient: system identity, capabilities ordered by criticality and linked to the user journeys and entities they serve, sensitive data and exposure highlights, conventions with open deviations, health (tests, implementation gaps, top risks), and — when the repo carries infra-as-code — a runtime_topology section describing, per deployable, what ships it, the ports/services it exposes, the routes it serves, and the channels/databases/storage it provisions; each with coverage caveats so you know what the analysis is sure about. Use section to fetch one part token-efficiently, or format markdown for a compact onboarding brief.',
      inputSchema: {
        path: z.string().describe('Project path'),
        section: z.enum(['identity', 'capabilities', 'journeys', 'data', 'conventions', 'health', 'runtime_topology', 'coverage_caveats']).optional().describe('Return only one section of the map'),
        format: z.enum(['json', 'markdown']).optional().describe("Output format: 'json' (default) or 'markdown' for a compact product brief"),
      } as any,
    } as any,
    async ({ path, section, format }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getProductMap(cas, { section, format }));
    })
  );

  server.registerTool(
    'get_flow_graph',
    {
      title: 'Get Flow Graph',
      description: 'Capability-level architecture: capabilities with scores, dependencies, topology (root/leaf/critical path), primary flow (value chain), layers (entry/business/data/infrastructure), system insights.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getFlowGraph(cas));
    })
  );

  server.registerTool(
    'get_runtime_static_links',
    {
      title: 'Get Runtime Static Links',
      description: 'Runtime-to-static correlation: entry points, exit points, call chains, and external services mapped to runtime signals with telemetry coverage status and instrumentation points.',
      inputSchema: {
        path: z.string().describe('Project path'),
        telemetry_status: z.enum(['observed', 'instrumentable', 'not-instrumented']).optional().describe('Filter by telemetry status'),
        kind: z.enum(['entry-point', 'exit-point', 'call-chain', 'external-service', 'telemetry-hook']).optional().describe('Filter by link kind'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, telemetry_status, kind, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getRuntimeStaticLinks(cas, { telemetryStatus: telemetry_status, kind, limit, offset }));
    })
  );

  server.registerTool(
    'simulate_runtime_telemetry',
    {
      title: 'Simulate Runtime Telemetry',
      description: 'Generate deterministic simulated traffic, errors, latency, and traces mapped onto CAS objects, then feed them into runtime observations and operational priorities. Use this to preview how telemetry would affect active development before SDK data exists.',
      inputSchema: {
        path: z.string().describe('Project path'),
        scenario: z.enum(['balanced', 'bug-hunt', 'traffic-spike', 'slow-dependencies']).optional().describe('Simulation shape'),
        event_count: z.number().optional().describe('Number of synthetic observations to generate, max 500'),
        seed: z.string().optional().describe('Stable seed for repeatable simulations'),
        persist: z.boolean().optional().describe('Store generated observations. Defaults to true; set false for dry-run planning.'),
      } as any,
    } as any,
    async ({ path, scenario, event_count, seed, persist }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await runtimeSimulation.simulateRuntimeTelemetry(cas, path, {
        scenario,
        eventCount: event_count,
        seed,
        persist,
      }));
    })
  );

  server.registerTool(
    'correlate_runtime_event',
    {
      title: 'Correlate Runtime Event',
      description: 'Map a runtime event or error back to CAS nodes, entry points, exit points, call chains, and runtime_static_links without storing it.',
      inputSchema: {
        path: z.string().describe('Project path'),
        event: z.object({
          type: z.enum(['request', 'error', 'exit', 'log', 'custom']),
          timestamp: z.string().optional(),
          schema_version: z.string().optional(),
          service_name: z.string().optional(),
          environment: z.string().optional(),
          signal: z.string().optional(),
          static_id: z.string().optional(),
          node_id: z.string().optional(),
          entry_point_id: z.string().optional(),
          exit_point_id: z.string().optional(),
          call_chain_id: z.string().optional(),
          trace_id: z.string().optional(),
          span_id: z.string().optional(),
          parent_span_id: z.string().optional(),
          method: z.string().optional(),
          route: z.string().optional(),
          path: z.string().optional(),
          status_code: z.number().optional(),
          duration_ms: z.number().optional(),
          error_message: z.string().optional(),
          stack: z.string().optional(),
          attributes: z.record(z.unknown()).optional(),
        }).describe('Runtime event payload to correlate'),
      } as any,
    } as any,
    async ({ path, event }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(product.correlateRuntimeEvent(cas, event));
    })
  );

  server.registerTool(
    'record_runtime_event',
    {
      title: 'Record Runtime Event',
      description: 'Store a runtime event after correlating it to CAS. Use for requests, errors, exits, logs, or custom telemetry signals.',
      inputSchema: {
        path: z.string().describe('Project path'),
        event: z.object({
          type: z.enum(['request', 'error', 'exit', 'log', 'custom']),
          timestamp: z.string().optional(),
          schema_version: z.string().optional(),
          service_name: z.string().optional(),
          environment: z.string().optional(),
          signal: z.string().optional(),
          static_id: z.string().optional(),
          node_id: z.string().optional(),
          entry_point_id: z.string().optional(),
          exit_point_id: z.string().optional(),
          call_chain_id: z.string().optional(),
          trace_id: z.string().optional(),
          span_id: z.string().optional(),
          parent_span_id: z.string().optional(),
          method: z.string().optional(),
          route: z.string().optional(),
          path: z.string().optional(),
          status_code: z.number().optional(),
          duration_ms: z.number().optional(),
          error_message: z.string().optional(),
          stack: z.string().optional(),
          attributes: z.record(z.unknown()).optional(),
        }).describe('Runtime event payload to store'),
      } as any,
    } as any,
    async ({ path, event }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const eventWithTimestamp = {
        ...event,
        timestamp: event.timestamp || new Date().toISOString(),
      };
      const observation: product.RuntimeObservation = {
        id: runtimeObservationId(),
        project_path: path,
        recorded_at: new Date().toISOString(),
        source: 'ingested',
        event: eventWithTimestamp,
        correlation: product.correlateRuntimeEvent(cas, eventWithTimestamp),
      };
      await saveRuntimeObservation(path, observation);
      return json(observation);
    })
  );

  server.registerTool(
    'ingest_telemetry',
    {
      title: 'Ingest Telemetry',
      description: 'Ingest a batch of real runtime telemetry events in an OTEL-compatible shape, correlate each event onto CAS static structure via routes, file/function hints, and stack frames, and persist them with source "ingested". Returns matched/partial/unmatched counts and the top unmatched hints. Ingested telemetry drives get_runtime_observations and get_operational_priorities by default.',
      inputSchema: {
        path: z.string().describe('Project path'),
        events: z.array(z.object({
          kind: z.enum(['request', 'error', 'log', 'metric']).describe('Event kind'),
          timestamp: z.string().optional().describe('ISO timestamp of the runtime event'),
          name: z.string().optional().describe('Span, signal, or metric name, such as http:POST:/work_orders'),
          service_name: z.string().optional(),
          environment: z.string().optional().describe('Deployment environment, such as production or staging'),
          trace_id: z.string().optional(),
          span_id: z.string().optional(),
          parent_span_id: z.string().optional(),
          method: z.string().optional().describe('HTTP method'),
          route: z.string().optional().describe('Route pattern, such as /work_orders/:id'),
          path: z.string().optional().describe('Raw request path'),
          status: z.number().optional().describe('HTTP status code'),
          duration_ms: z.number().optional(),
          p95_ms: z.number().optional().describe('Observed or pre-aggregated p95 latency for this signal'),
          p99_ms: z.number().optional().describe('Observed or pre-aggregated p99 latency for this signal'),
          function_hint: z.string().optional().describe('Function or method name the event originated from'),
          file_hint: z.string().optional().describe('Source file the event originated from'),
          error: z.object({
            type: z.string().optional(),
            message: z.string().optional(),
            stack_top_frames: z.array(z.union([
              z.string(),
              z.object({ file: z.string(), line: z.number().optional(), function: z.string().optional() }),
            ])).optional().describe('Top stack frames, most specific first'),
          }).optional(),
          volume: z.number().optional().describe('Pre-aggregated event count this entry represents'),
          rate_per_min: z.number().optional().describe('Pre-aggregated throughput for this event stream'),
          window_ms: z.number().optional().describe('Aggregation window size in milliseconds'),
          attributes: z.record(z.unknown()).optional(),
        })).describe('Batch of runtime events, max 1000 per call'),
        persist: z.boolean().optional().describe('Store ingested observations. Defaults to true; set false for dry-run correlation.'),
      } as any,
    } as any,
    async ({ path, events, persist }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await telemetryIngestion.ingestTelemetryBatch(cas, path, events, { persist }));
    })
  );

  server.registerTool(
    'get_runtime_observations',
    {
      title: 'Get Runtime Observations',
      description: 'Query stored runtime observations and their CAS correlations. Filter by type, timestamp, or static CAS id. Returns ingested telemetry by default; simulated observations are only included when source is set to "simulated" or "all" and are always labeled with their provenance.',
      inputSchema: {
        path: z.string().describe('Project path'),
        type: z.enum(['request', 'error', 'exit', 'log', 'custom']).optional().describe('Runtime event type'),
        since: z.string().optional().describe('ISO timestamp lower bound'),
        static_id: z.string().optional().describe('CAS node, entry point, exit point, call chain, or runtime link id'),
        trace_id: z.string().optional().describe('Runtime trace id'),
        span_id: z.string().optional().describe('Runtime span id or parent span id'),
        source: z.enum(['ingested', 'simulated', 'all']).optional().describe('Observation provenance to return (default ingested)'),
        limit: z.number().optional().describe('Max results (default storage order, newest first)'),
        runtime: CONTEXT_RUNTIME_PARAM,
      } as any,
    } as any,
    async ({ path, type, since, static_id, trace_id, span_id, source, limit, runtime }: any) => withErrorHandling(async () => {
      // Runtime opt-out honored here too: when a team globally disables runtime
      // context (.klaurorc context.runtime / KLAURO_CONTEXT_RUNTIME) or the
      // caller passes runtime:"exclude", return a short stub instead of loading
      // and correlating observations — a real skip, with an explicit override path.
      const runtimeFilter = await resolveSectionFilterForProject(path, { runtime });
      if (runtimeFilter.isExcluded('runtime')) {
        return json({
          status: 'runtime-context-excluded',
          runtime_mode: runtimeFilter.runtime_mode,
          observations: [],
          guidance: 'Runtime context is disabled by the runtime opt-out (param runtime:"exclude", KLAURO_CONTEXT_RUNTIME, or .klaurorc context.runtime). Pass runtime:"include" to load runtime observations for this call.',
        });
      }
      const loadObservations = () => telemetryIngestion.loadTelemetryObservations(path, {
        type,
        since,
        staticId: static_id,
        traceId: trace_id,
        spanId: span_id,
        source,
        limit,
      });
      let result: any = await loadObservations();
      // Lazy backfill: if the returned set still carries pre-analysis `unmatched`
      // observations and an analysis now exists, re-correlate and upgrade them so
      // node-level metrics stop reading empty. Bounded, idempotent, best-effort;
      // reload afterwards so this response reflects the upgraded correlations.
      let cas: any = null;
      try {
        cas = await getAnalysis(path);
      } catch {
        cas = null;
      }
      if (cas) {
        const hasUnmatched = (result.observations || []).some(
          (observation: any) => observation?.correlation?.status === 'unmatched');
        if (hasUnmatched) {
          const backfill = await telemetryIngestion.backfillIngestedTelemetry(cas, path).catch(() => null);
          if (backfill && backfill.upgraded > 0) result = await loadObservations();
        }
      }
      // Per-route+method traffic/latency aggregated from the RAW observations,
      // CAS-free — visible with or without an analysis. Mirrors the HTTP
      // GET /v1/telemetry/observations `route_metrics` shape for MCP parity.
      const routeMetrics = telemetryIngestion.summarizeRouteMetrics(result.observations || []);
      if (routeMetrics.length > 0) {
        result.route_metrics = routeMetrics;
        result.route_metrics_guidance =
          'Per route+method request_count/error_rate/p50/p95/p99 aggregated from raw observations. Available with or without an analysis; node_metrics correlate these to CAS static_id once the project is analyzed.';
      }
      // Per-node operational rollup: traffic (request_count/throughput), errors
      // (error_count/error_rate + status distribution), and latency
      // (avg/p50/p95/p99/max) aggregated per CAS node/entry-point/route from the
      // returned observations. Additive — the raw `observations` array is
      // unchanged. Computed over the filtered set so it honors static_id/since.
      try {
        if (!cas) throw new Error('no analysis');
        const nodeMetrics = product.buildNodeRuntimeMetrics(cas, result.observations || []);
        if (nodeMetrics.length > 0) {
          result.node_metrics = nodeMetrics;
          result.node_metrics_guidance =
            'Per-node traffic/error-rate/latency correlated to CAS static_id. Use static_id here as the target for get_agent_context / get_coding_context before editing a hot or erroring node.';
        }
      } catch {
        // Metrics are best-effort; never fail the observation read if the CAS
        // analysis is missing or unreadable.
      }
      // WS-A: merge in fused telemetry facts (hot/slow/error) persisted via
      // POST /v1/telemetry/ingest or ingest_telemetry, additive to the
      // existing observation shape — see telemetry-fusion.ts.
      const fused = await loadPersistedRuntimeFacts('', path).catch(() => null);
      if (fused?.facts?.length) {
        result.fused_runtime_facts = static_id
          ? fused.facts.filter((f) => f.node_id === static_id)
          : fused.facts;
        result.fused_updated_at = fused.updated_at;
      }
      return json(result);
    })
  );

  server.registerTool(
    'get_operational_priorities',
    {
      title: 'Get Operational Priorities',
      description: 'Rank bugs, bottlenecks, problematic areas, and telemetry-backed work by combining stored runtime observations with CAS system health, change risk, tests, idioms, and static/runtime correlations. Uses ingested telemetry only by default; pass include_simulated to mix in simulated observations, which are always labeled per priority.',
      inputSchema: {
        path: z.string().describe('Project path'),
        since: z.string().optional().describe('ISO timestamp lower bound for runtime observations'),
        include_simulated: z.boolean().optional().describe('Also include simulated observations (default false)'),
        limit: z.number().optional().describe('Max priorities to return'),
      } as any,
    } as any,
    async ({ path, since, include_simulated, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      const set = await telemetryIngestion.loadTelemetryObservations(path, {
        since,
        source: include_simulated ? 'all' : 'ingested',
        limit: 5000,
      });
      const result = product.buildOperationalPriorities(cas, set.observations, { limit });
      const notes: string[] = [];
      if (set.ingested_count === 0 && set.simulated_count > 0 && !include_simulated) {
        notes.push(`No ingested telemetry found, but ${set.simulated_count} simulated observations exist. Pass include_simulated: true to rank with simulated data; simulated priorities never represent production truth.`);
      }
      return json({
        source: include_simulated ? 'all' : 'ingested',
        ...result,
        ...(notes.length > 0 ? { notes } : {}),
      });
    })
  );

  server.registerTool(
    'get_runtime_trace',
    {
      title: 'Get Runtime Trace',
      description: 'Replay stored runtime observations for a trace id with matched CAS static ids. Reads ingested telemetry by default; set source to "simulated" or "all" to include simulated observations.',
      inputSchema: {
        path: z.string().describe('Project path'),
        trace_id: z.string().describe('Runtime trace id'),
        source: z.enum(['ingested', 'simulated', 'all']).optional().describe('Observation provenance to read (default ingested)'),
      } as any,
    } as any,
    async ({ path, trace_id, source }: any) => withErrorHandling(async () => {
      return json(await telemetryIngestion.loadTelemetryTrace(path, trace_id, { source }));
    })
  );

  // -- Coordination fabric (§WS-E) --
  // LOCAL tier only: same-machine, file-backed claim log (see coordination/local-store.ts).
  // Cross-machine sync is HTTP-only for now (remote-analyzer-service.ts §WS-C-transport).

  server.registerTool(
    'claim_work',
    {
      title: 'Claim Work',
      description: 'ENFORCED exclusive-lease coordination (one active grant per overlapping symbol/path + FIFO queue). Use claim_work when you need EXCLUSIVITY — a guaranteed at-most-one-writer lease over a scope, with queueing when it is contended. For non-blocking awareness that never takes a lease or queues you, use fab_claim_work (the advisory fabric) instead. Request a symbol/path-level GRANT before starting non-trivial changes. ENFORCED (not advisory): at most one active grant per overlapping symbol/path in a workspace at a time — but this governs simultaneous BLIND writes, not your right to reach work you need (§1.6 SPEC-COORDINATION-FABRIC-V2: awareness is the primitive, never a dead end). Returns verdict "granted" (grant_id + lease_expires_at — proceed; heartbeat_work to keep it alive, release_work when done), "queued" (another agent holds a conflicting grant — you get FULL awareness: the holder\'s agent_id + their stated intent + lease_status [active/near_expiry/expired], plus queue_position, plus an `options` array [\'wait_and_heartbeat_poll\', \'take_over_stale_lease\' (only if lease is near_expiry/expired), \'proceed_with_awareness_if_compatible\', \'redirect_to_free_scope\'] plus redirect_hint/free_scope_hint for when the work is fungible), or "duplicate" (you already hold an identical grant). Disjoint work is never queued: block-time is 0 for non-overlapping scope. Overlapping work is resolved by awareness + negotiation, never lockout. CONCEPTUAL VOCABULARY (§4 SPEC-CONCEPTUAL-LAYER.md, additive): pass flow_id/step_id/capability_id/entities to declare the FLOW step or ENTITY you own ("the Charge step of Checkout") alongside/instead of paths/symbols — higher-signal and human-legible. Even if you only pass paths/symbols, the fabric ALWAYS attempts to derive your conceptual coordinates from them (via real flow-concepts, never guessed) and represents them in `concept` on the response, whether or not anyone else is around — awareness is on by default for every claim, not just colliding ones. `concept_awareness` separately reports any OTHER active agent working the SAME flow (different step = informational, safe, both proceed; same step or same entity constraints = a conceptual heads-up, still never a hard stop — enforcement stays limited to the literal path/symbol grant above).',
      inputSchema: {
        workspace: z.string().describe('Workspace or project id/path to coordinate within'),
        agent_id: z.string().describe('Stable identifier for the calling agent/session'),
        intent: z.string().describe('Short description of the work being claimed'),
        agent_kind: z.enum(['claude', 'cursor', 'codex', 'human', 'other']).optional().describe('Kind of agent (default other)'),
        paths: z.array(z.string()).optional().describe('File/dir paths this work will touch'),
        symbols: z.array(z.string()).optional().describe('Symbol/node ids this work will touch'),
        capability: z.string().optional().describe('Capability or feature name this work implements'),
        flow_id: z.string().optional().describe('Conceptual coordinate: the flow (see get_flow_concepts) this work belongs to. Declared value always wins over any auto-derived one.'),
        step_id: z.string().optional().describe('Conceptual coordinate: the specific step within flow_id this work owns.'),
        capability_id: z.string().optional().describe('Conceptual coordinate: the SystemCapability id this work realizes (distinct from the free-text `capability` name field above).'),
        entities: z.array(z.string()).optional().describe('Conceptual coordinate: data entity name(s) whose CONSTRAINTS this work touches — enables cross-file conceptual-conflict detection even when paths/symbols are disjoint.'),
        ttl_ms: z.number().optional().describe('Grant TTL in ms before it is considered stale (default 5 minutes)'),
        base_commit: z.string().optional(),
        branch: z.string().optional(),
        claim_id: z.string().optional().describe('Deprecated/unused by the enforced grant path; kept for backward-compat request shape.'),
      } as any,
    } as any,
    async ({ workspace, agent_id, intent, agent_kind, paths, symbols, capability, flow_id, step_id, capability_id, entities, ttl_ms, base_commit, branch }: any) => withErrorHandling(async () => {
      // ALWAYS-ON conceptual representation (§4): derive coordinates from
      // paths/symbols via real flow-concepts regardless of whether this claim
      // collides with anyone — awareness has value at zero overlap too
      // (dedup visibility, fleet coherence, standing readiness). Declared
      // fields always win over derived ones.
      const declaredConcept: ConceptualCoordinate | undefined =
        flow_id || step_id || capability_id || (entities && entities.length)
          ? { flow_id, step_id, capability_id, entities, source: 'declared' as const }
          : undefined;
      const conceptIndex = await conceptIndexForWorkspace(workspace);
      const derivedConcept = declaredConcept
        ? undefined
        : deriveConceptualCoordinate({ scope: { paths: paths || [], symbols: symbols || [] } }, conceptIndex);
      const concept = declaredConcept ?? derivedConcept;

      const result = await requestGrant({
        workspace_id: workspace,
        agent_id,
        agent_kind: (agent_kind as AgentKind) || 'other',
        scope: { repo: workspace, paths: paths || [], symbols: symbols || [], capability, concept },
        intent,
        ttl_ms,
      });

      // Conceptual awareness against every OTHER currently-active agent —
      // computed unconditionally (not gated on the grant verdict above),
      // because same-flow awareness is valuable even when the literal
      // path/symbol grant was cleanly "granted" with zero collision.
      const conceptAwareness: Array<{
        agent_id: string;
        intent: string;
        verdict: 'awareness' | 'conceptual_conflict';
        reason: string;
        shared_flow_id?: string;
        shared_step_id?: string;
        shared_entities?: string[];
      }> = [];
      if (concept) {
        const others = await getActiveClaims(workspace);
        for (const other of others) {
          if (other.agent_id === agent_id || !other.scope.concept) continue;
          const cmp = compareConceptualCoordinates(concept, other.scope.concept);
          if (cmp.verdict === 'unrelated') continue;
          conceptAwareness.push({
            agent_id: other.agent_id,
            intent: other.intent,
            verdict: cmp.verdict,
            reason: cmp.reason,
            shared_flow_id: cmp.shared_flow_id,
            shared_step_id: cmp.shared_step_id,
            shared_entities: cmp.shared_entities,
          });
        }
      }

      let freeHint: { free_paths: string[]; free_symbols: string[] } | undefined;
      let holder: GrantHolderContext | undefined;
      let options: string[] | undefined;
      if (result.verdict === 'queued') {
        const { active } = await getGrants(workspace);
        const heldPaths = new Set(active.flatMap((g) => g.scope.paths));
        const heldSymbols = new Set(active.flatMap((g) => g.scope.symbols));
        freeHint = {
          free_paths: (paths || []).filter((p: string) => !heldPaths.has(p)),
          free_symbols: (symbols || []).filter((s: string) => !heldSymbols.has(s)),
        };
        const holderId = result.conflict?.holder_agent_id;
        if (holderId) {
          const holders = await describeGrantHolders(workspace, [holderId]);
          holder = holders[holderId];
        }
        // §1.6: awareness-rich options, never a hard dead end. redirect_to_free_scope
        // is only offered when there is actually free scope to redirect to (fungible
        // work); take_over_stale_lease only when the holder's lease has actually lapsed
        // or is about to — otherwise it would suggest clobbering a live agent.
        options = ['wait_and_heartbeat_poll', 'proceed_with_awareness_if_compatible'];
        if (freeHint.free_paths.length > 0 || freeHint.free_symbols.length > 0) {
          options.push('redirect_to_free_scope');
        }
        if (holder && holder.lease_status !== 'active') {
          options.push('take_over_stale_lease');
        }
      }

      return json({
        // Back-compat shape: callers keyed on claim_id/verdict for the old advisory
        // path still get something sane — grant_id doubles as claim_id, "granted"
        // maps to the old "granted" verdict, "queued"/"duplicate" are new states
        // the old advisory path never returned (it only ever granted or conflicted).
        claim_id: result.grant_id,
        verdict: result.verdict,
        grant_id: result.grant_id,
        lease_expires_at: result.lease_expires_at,
        queue_position: result.queue_position,
        conflict: result.conflict,
        holder,
        options,
        redirect_hint: result.redirect_hint,
        free_scope_hint: freeHint,
        base_commit,
        branch,
        // Conceptual vocabulary (§4): always populated when derivable, whether
        // or not this claim collided with anyone — see the tool description.
        concept,
        concept_awareness: conceptAwareness.length ? conceptAwareness : undefined,
      });
    })
  );

  server.registerTool(
    'release_work',
    {
      title: 'Release Work',
      description: 'Release an ENFORCED grant taken via claim_work (completed or handing off). Frees its paths/symbols for other agents and immediately advances the FIFO queue: the next non-conflicting queued request (if any) is promoted to granted. This is the enforced-lease counterpart; to drop an ADVISORY fabric claim (from fab_claim_work) use fab_release_work instead.',
      inputSchema: {
        workspace: z.string().describe('Workspace or project id/path'),
        claim_id: z.string().describe('Grant id to release (as returned by claim_work\'s grant_id/claim_id)'),
        agent_id: z.string().optional().describe('Agent id that holds the grant (required to release; falls back to claim_id-embedded agent for back-compat callers)'),
      } as any,
    } as any,
    async ({ workspace, claim_id, agent_id }: any) => withErrorHandling(async () => {
      if (!agent_id) return json({ status: 'error', error: 'agent_id is required to release a grant', claim_id });
      await releaseGrant(workspace, agent_id, claim_id);
      return json({ status: 'released', claim_id });
    })
  );

  server.registerTool(
    'heartbeat_work',
    {
      title: 'Heartbeat Work',
      description: 'Extend a held grant\'s lease (does not expire) while work is in progress. Call periodically for long-running tasks. Returns ok:false if the grant no longer exists (released, expired, or still queued — queued requests have nothing to heartbeat).',
      inputSchema: {
        workspace: z.string().describe('Workspace or project id/path'),
        claim_id: z.string().describe('Grant id to heartbeat'),
      } as any,
    } as any,
    async ({ workspace, claim_id }: any) => withErrorHandling(async () => {
      const result = await heartbeatGrant(workspace, claim_id);
      if (!result.ok) return json({ status: 'not_found', claim_id });
      return json({ status: 'heartbeat', claim_id, lease_expires_at: result.lease_expires_at });
    })
  );

  server.registerTool(
    'get_active_agents',
    {
      title: 'Get Active Agents',
      description: 'Live grant state for a workspace: which agents currently hold active (non-expired) grants — scope, stated intent, lease_expires_at, and lease_status (active/near_expiry/expired) — plus the FIFO queue of agents waiting on a conflicting scope. This is the awareness surface (§1.6 SPEC-COORDINATION-FABRIC-V2): use it before starting work to see who else is here, what they intend, blast-radius overlap risk, and free scope you could pick instead of queuing.',
      inputSchema: {
        workspace: z.string().describe('Workspace or project id/path'),
      } as any,
    } as any,
    async ({ workspace }: any) => withErrorHandling(async () => {
      const [presence, grants] = await Promise.all([getPresence(workspace), getGrants(workspace)]);
      const holderCtx = await describeGrantHolders(workspace, grants.active.map((g) => g.agent_id));
      const enrichedGrants = grants.active.map((g) => ({
        ...g,
        intent: holderCtx[g.agent_id]?.intent,
        lease_status: holderCtx[g.agent_id]?.lease_status,
      }));
      return json({ ...presence, grants: enrichedGrants, queued: grants.queued });
    })
  );

  server.registerTool(
    'check_collision',
    {
      title: 'Check Collision',
      description: 'Read-only preflight: does a proposed (not-yet-claimed) set of paths/symbols/capability collide with any other active agent or held GRANT in the workspace? Runs the same duplicate/overlap/blast-radius detectors as claim_work plus the live grant holders/queue, but takes no grant. Overlapping holders are returned WITH awareness context (intent + lease_status), never just a bare yes/no — so you can judge whether to wait, take over a stale lease, or proceed with awareness before ever calling claim_work. Pass agent_id + intent to ALSO run the conceptual-conflict detectors (contract-divergence/duplicate-work/structural-divergence/behavior-drift): this AMBIENTLY captures your own git working-tree diff (workspace treated as your repo path) — TS/JS files get full before/after signature diffing, zero self-reporting needed — and folds it in automatically against every other agent\'s persisted state (self-reported or itself ambient). Pass `changes` too if you want to add explicit SymbolChange[] on top (e.g. for a language ambient capture can\'t diff). CONCEPTUAL VOCABULARY (§4): `concept` in the response is ALWAYS populated (from your declared flow_id/step_id/capability_id/entities, or auto-derived from paths/symbols via real flow-concepts) whether or not anything collides — the fabric represents flow/step scope for every check, not only overlapping ones. `concept_awareness` lists any other active agent sharing your flow (different step = informational/safe) or entity constraints (a real conceptual-conflict heads-up) — advisory only, never a gate.',
      inputSchema: {
        workspace: z.string().describe('Workspace or project id/path'),
        paths: z.array(z.string()).optional(),
        symbols: z.array(z.string()).optional(),
        capability: z.string().optional(),
        agent_id: z.string().optional().describe('Your agent_id, to also run conceptual-conflict detection against other agents\' reported changes'),
        intent: z.string().optional().describe('Your stated intent, used by the conceptual-conflict duplicate-work detector'),
        changes: z.array(z.any()).optional().describe('Optional SymbolChange[] (see check_conceptual_conflicts) for full contract-divergence/structural-divergence detection'),
        flow_id: z.string().optional().describe('Conceptual coordinate: declare the flow this proposed work belongs to (wins over auto-derivation).'),
        step_id: z.string().optional().describe('Conceptual coordinate: declare the specific step within flow_id.'),
        capability_id: z.string().optional().describe('Conceptual coordinate: the SystemCapability id this proposed work realizes.'),
        entities: z.array(z.string()).optional().describe('Conceptual coordinate: data entity name(s) whose constraints this proposed work touches.'),
      } as any,
    } as any,
    async ({ workspace, paths, symbols, capability, agent_id, intent, changes, flow_id, step_id, capability_id, entities }: any) => withErrorHandling(async () => {
      const active = await getActiveClaims(workspace);
      const casEdges = await casEdgesForWorkspace(workspace);
      const editLockConflicts = paths?.length ? await checkEditLock(workspace, paths) : [];

      // ALWAYS-ON conceptual representation (§4) — computed unconditionally,
      // same posture as claim_work: awareness has value even with zero
      // path/symbol overlap.
      const declaredConcept: ConceptualCoordinate | undefined =
        flow_id || step_id || capability_id || (entities && entities.length)
          ? { flow_id, step_id, capability_id, entities, source: 'declared' as const }
          : undefined;
      const conceptIndex = await conceptIndexForWorkspace(workspace);
      const concept =
        declaredConcept ?? deriveConceptualCoordinate({ scope: { paths: paths || [], symbols: symbols || [] } }, conceptIndex);
      const conceptAwareness: Array<{
        agent_id: string;
        intent: string;
        verdict: 'awareness' | 'conceptual_conflict';
        reason: string;
        shared_flow_id?: string;
        shared_step_id?: string;
        shared_entities?: string[];
      }> = [];
      if (concept) {
        for (const other of active) {
          if (agent_id && other.agent_id === agent_id) continue;
          if (!other.scope.concept) continue;
          const cmp = compareConceptualCoordinates(concept, other.scope.concept);
          if (cmp.verdict === 'unrelated') continue;
          conceptAwareness.push({
            agent_id: other.agent_id,
            intent: other.intent,
            verdict: cmp.verdict,
            reason: cmp.reason,
            shared_flow_id: cmp.shared_flow_id,
            shared_step_id: cmp.shared_step_id,
            shared_entities: cmp.shared_entities,
          });
        }
      }

      const probe: WorkClaim = {
        claim_id: '__probe__',
        seq: 0,
        workspace_id: workspace,
        agent_id: '__probe__',
        agent_kind: 'other',
        scope: { repo: workspace, paths: paths || [], symbols: symbols || [], capability, concept },
        intent: 'preflight-check',
        status: 'active',
        created_at: new Date().toISOString(),
        ttl_ms: 0,
        heartbeat_at: new Date().toISOString(),
      };
      const wasCapabilities = capability ? await wasCapabilitiesForWorkspace(workspace) : [];
      const verdict = arbitrate(probe, active, casEdges, wasCapabilities);
      const report = detectCollisions([...active, probe], [], casEdges, wasCapabilities);
      const grants = await getGrants(workspace);
      const heldPaths = new Set(grants.active.flatMap((g) => g.scope.paths));
      const heldSymbols = new Set(grants.active.flatMap((g) => g.scope.symbols));
      const overlappingGrants = grants.active.filter(
        (g) =>
          g.scope.symbols.some((s) => (symbols || []).includes(s)) ||
          g.scope.paths.some((gp) => (paths || []).some((p: string) => gp === p || gp.startsWith(p + '/') || p.startsWith(gp + '/')))
      );
      const holderCtx = await describeGrantHolders(workspace, overlappingGrants.map((g) => g.agent_id));

      // §1.7 SPEC-COORDINATION-FABRIC-V2: also surface conceptual conflicts when
      // the caller identifies itself. Best-effort/additive — see the design note
      // above `reportConceptualChanges` for why this is agent-reported, not ambient.
      let conceptualConflicts: ConceptualConflict[] | undefined;
      let conceptualNote: string | undefined;
      if (agent_id) {
        const reportedChanges: SymbolChange[] = Array.isArray(changes) ? changes : [];
        const ambientChanges = await ambientChangesForWorkspace(workspace);
        const requesterChanges = mergeChanges(reportedChanges, ambientChanges);
        const requesterState: AgentInFlightState = { agent_id, intent: intent || 'preflight-check', changes: requesterChanges };
        const others = await otherAgentConceptualStates(workspace, agent_id);
        if (others.length > 0 || ambientChanges.length > 0) {
          const cas = await conceptualConflictCasForWorkspace(workspace);
          const allConflicts = detectConceptualConflicts([requesterState, ...others], cas);
          conceptualConflicts = allConflicts.filter((c) => c.agents.includes(agent_id));
          if (requesterChanges.length === 0) {
            conceptualNote = 'No changes[] supplied and no ambient TS/JS changes detected, so only intent-overlap (duplicate-work) detection ran. Pass changes: SymbolChange[] (or call check_conceptual_conflicts) for contract-divergence/structural-divergence/behavior-drift detection.';
          } else if (ambientChanges.length > 0) {
            conceptualNote = `Ambient capture found ${ambientChanges.length} change(s) in your working tree (git diff vs HEAD) and folded them in automatically — no self-report required.`;
          }
        } else {
          conceptualNote = 'No other agent has reported or ambiently surfaced conceptual changes yet (call check_conceptual_conflicts, or just edit files — ambient capture picks up TS/JS contract changes automatically).';
        }
      }

      return json({
        verdict: verdict.verdict,
        kind: verdict.kind,
        evidence: verdict.evidence,
        with_claim: verdict.with_claim
          ? { claim_id: verdict.with_claim.claim_id, agent_id: verdict.with_claim.agent_id, intent: verdict.with_claim.intent }
          : undefined,
        edit_lock_conflicts: editLockConflicts,
        collisions: report,
        active_grants: grants.active,
        queued_grants: grants.queued,
        overlapping_grant_holders: overlappingGrants.map((g) => ({ ...g, ...holderCtx[g.agent_id] })),
        free_scope_hint: {
          free_paths: (paths || []).filter((p: string) => !heldPaths.has(p)),
          free_symbols: (symbols || []).filter((s: string) => !heldSymbols.has(s)),
        },
        conceptual_conflicts: conceptualConflicts,
        conceptual_conflicts_note: conceptualNote,
        // Conceptual vocabulary (§4): always populated when derivable, whether
        // or not this proposed scope collides with anything else.
        concept,
        concept_awareness: conceptAwareness.length ? conceptAwareness : undefined,
      });
    })
  );

  server.registerTool(
    'check_conceptual_conflicts',
    {
      title: 'Check Conceptual Conflicts',
      description: 'THE FABRIC\'S CROWN-JEWEL DETECTOR (§1.7 SPEC-COORDINATION-FABRIC-V2): catches semantic incoherence textual/merge conflicts CANNOT — two changes that each compile, pass review, and merge cleanly on their own, but are JOINTLY incoherent. NOW AMBIENT: this call captures your OWN git working-tree diff automatically (workspace treated as your repo path; TS/JS files get full before/after signature diffing — signature/return-type/nullability/params — via the TypeScript compiler API, zero self-reporting required) and merges it with any `changes` (SymbolChange[]: {symbol_id, name, file, change_kind: signature|return_type|nullability|param|rename|split|move|delete|body|add, before?, after?}) you explicitly pass (useful for languages ambient capture can\'t syntactically diff, or extra detail). This call (a) persists the MERGED report so OTHER agents\' checks can detect conflicts with you even if you never call this again, and (b) immediately runs detectConceptualConflicts against every other agent\'s persisted state (self-reported or itself ambient), returning only the conflicts that involve YOU: contract-divergence (you or someone else changed a signature/return-type/nullability while the other edits a caller that assumes the old contract — the canonical case: retyping getUser(): User|null -> User while another agent edits a caller doing `if (!getUser())`), duplicate-work (overlapping intent on the same/similarly-named symbol), structural-divergence (a rename/split/move/delete vs. a new reference to the old structure), behavior-drift (heuristic: a guard/early-return added to a body vs. code appended assuming unconditional execution). REMAINING HONEST LIMITATION: ambient capture is same-machine/single-repo (this process\'s own git working tree) and TS/JS-only for full signature diffing; other languages get an honest unknown-change flag, not a fabricated diff. Call check_collision for path/capability overlap awareness; call this whenever your edit changes a symbol\'s CONTRACT or STRUCTURE, not just its body.',
      inputSchema: {
        workspace: z.string().describe('Workspace or project id/path'),
        agent_id: z.string().describe('Your stable agent/session id'),
        agent_kind: z.enum(['claude', 'cursor', 'codex', 'human', 'other']).optional(),
        intent: z.string().describe('Short description of the work you are about to do'),
        changes: z.array(z.object({
          symbol_id: z.string(),
          name: z.string(),
          file: z.string(),
          change_kind: z.enum(['signature', 'return_type', 'nullability', 'param', 'rename', 'split', 'move', 'delete', 'body', 'add']),
          before: z.object({
            signature: z.string().optional(),
            return_type: z.string().optional(),
            nullable: z.boolean().optional(),
            name: z.string().optional(),
            split_into: z.array(z.string()).optional(),
            body_tags: z.array(z.enum(['early-return', 'guard', 'appends-after', 'other'])).optional(),
          }).optional(),
          after: z.object({
            signature: z.string().optional(),
            return_type: z.string().optional(),
            nullable: z.boolean().optional(),
            name: z.string().optional(),
            split_into: z.array(z.string()).optional(),
            body_tags: z.array(z.enum(['early-return', 'guard', 'appends-after', 'other'])).optional(),
          }).optional(),
        })).describe('The symbol changes you are about to make (or are making), with before/after shape where known'),
      } as any,
    } as any,
    async ({ workspace, agent_id, agent_kind, intent, changes }: any) => withErrorHandling(async () => {
      const reportedChanges: SymbolChange[] = Array.isArray(changes) ? changes : [];
      const ambientChanges = await ambientChangesForWorkspace(workspace);
      const requesterChanges = mergeChanges(reportedChanges, ambientChanges);
      // Persist the MERGED view — ambient TS/JS contract changes ride along
      // with (or stand in for) the agent's own report, so other agents' next
      // check_collision/check_conceptual_conflicts sees them without that
      // agent ever having to self-report them.
      await reportConceptualChanges(workspace, agent_id, (agent_kind as AgentKind) || 'other', intent, requesterChanges);

      const others = await otherAgentConceptualStates(workspace, agent_id);
      const cas = await conceptualConflictCasForWorkspace(workspace);
      const requesterState: AgentInFlightState = { agent_id, intent, changes: requesterChanges };
      const gitBasedConflicts = detectConceptualConflicts([requesterState, ...others], cas);

      // W0 SUBSTRATE PATH (SPEC-COORDINATION-FABRIC-V3 §3): attributed
      // per-participant deltas from the committed vs. in-flight CAS TRACKS,
      // attributed via active claim scope — never git-diff-derived (on a
      // shared tree every participant's "own diff" is the union of everyone's;
      // that's the attribution collapse §3.2). Additive: runs ALONGSIDE the
      // git-ambient path so the substrate can prove itself in production
      // without removing the shipped detector feed; findings dedupe by
      // (kind, agents, symbol). No in-flight track / no claims => no-op.
      let substrateConflicts: ConceptualConflict[] = [];
      let substrateInfo: { participants: number; unattributed: number } | undefined;
      try {
        const substrate = await detectConceptualConflictsFromSubstrate(workspace, cas);
        substrateConflicts = substrate.conflicts;
        substrateInfo = {
          participants: substrate.attributed.participants.length,
          unattributed: substrate.attributed.unattributed.length,
        };
      } catch {
        /* substrate unavailable — never a hard failure of this tool call */
      }
      const conflictDedupeKey = (c: ConceptualConflict) => `${c.kind}|${[...c.agents].sort().join(',')}|${c.symbol}`;
      const seenConflicts = new Set(gitBasedConflicts.map(conflictDedupeKey));
      const allConflicts = [
        ...gitBasedConflicts,
        ...substrateConflicts.filter((c) => !seenConflicts.has(conflictDedupeKey(c))),
      ];
      const conflicts = allConflicts.filter((c) => c.agents.includes(agent_id));

      return json({
        status: 'reported',
        workspace,
        agent_id,
        ambient_changes_captured: ambientChanges.length,
        other_agents_considered: others.length,
        substrate: substrateInfo,
        conflicts,
        note: others.length === 0
          ? 'No other agent has reported or ambiently surfaced conceptual changes yet for this workspace; your report (self-reported + ambient) is now persisted so THEIR next check_conceptual_conflicts/check_collision call can detect conflicts with you.'
          : undefined,
      });
    })
  );

  server.registerTool(
    'get_in_flight_changes',
    {
      title: 'Get In-Flight Changes',
      description: 'Which active agents currently have a claim/edit-lock touching a given path, and their stated intent — answers "who is changing this and why" in a shared workspace. Pass exclude_self to omit your own agent_id.',
      inputSchema: {
        workspace: z.string().describe('Workspace or project id/path'),
        path: z.string().describe('File or directory path to check'),
        exclude_self: z.string().optional().describe('agent_id to exclude from results'),
      } as any,
    } as any,
    async ({ workspace, path, exclude_self }: any) => withErrorHandling(async () => {
      const attribution = await attributeChange(workspace, path);
      if (exclude_self) {
        attribution.attributions = attribution.attributions.filter((a) => a.agent_id !== exclude_self);
      }
      return json(attribution);
    })
  );

  server.registerTool(
    'plan_intent_merge',
    {
      title: 'Plan Intent Merge',
      description: 'THE ART OF MERGE (Fabric-v2 #1, §1.7 SPEC-COORDINATION-FABRIC-V2 primitive 5; re-based on the W0 substrate per SPEC-COORDINATION-FABRIC-V3 §8 W4): when agents finish overlapping work, reconcile by INTENT rather than by textual 3-way diff. Git only asks "do the lines overlap?" — two changes that are textually disjoint merge silently even when they are jointly incoherent (see check_conceptual_conflicts), and two changes on the same lines conflict mechanically even when they are perfectly compatible in intent (e.g. one agent adding retry and another adding logging to the same function body). This tool answers the higher-level question for every symbol touched by the fleet: do the changes COHERE? SELECTION RULE (attribution path, §3.2): with more than one active participant currently claiming work in `workspace`, this defaults to the SUBSTRATE path — per-participant deltas attributed from the live committed-vs-in-flight analysis via active claim scope, with the write-hook\'s announced-edit/unclaimed-edit event log as a tiebreaker, NEVER from ambient git diff (on a shared tree, "my own git diff" is the union of everyone\'s — the exact failure that over-attributed 4 agents with 1 agent\'s edit). At <=1 active participant (or when you pass `states` explicitly), it uses the original git-ambient/self-reported capture path (check_conceptual_conflicts/check_collision\'s persisted state), which is sound at that scale. Pass `use_substrate` to force either path explicitly. Returns a MergePlan: auto_mergeable (compatible intents that compose, with a rationale naming both agents\' intents — includes symbols only one agent touched), needs_resolution (a genuine conceptual conflict was detected — NOT auto-merged even though it would pass a textual merge cleanly; a human or agent must decide), duplicate_work (the fleet did the same thing twice; keep one), merge_decisions_required and surprises (the V3 §5/§9 mergeless metrics — genuine cross-participant decisions and contract changes a participant hasn\'t seen yet; the goal is driving both to 0), and — on the substrate path only — `attribution` (participants/tiebroken/unattributed counts) and `unattributed_symbols` (changes nobody could be honestly credited with yet). Use this at the end of a shared editing session to get a single reconciliation verdict instead of re-deriving it from a pile of individual conflict findings.',
      inputSchema: {
        workspace: z.string().describe('Workspace or project id/path'),
        agent_id: z.string().describe('Your stable agent/session id (excluded from "other agents" lookup; included if you pass it in `states`)'),
        use_substrate: z.boolean().optional().describe('Force the attribution path: true = substrate (claim-scope + write-hook tiebreaker, never git diff), false = git-ambient. Omit to auto-select from the live active-participant count (substrate when >1).'),
        states: z.array(z.object({
          agent_id: z.string(),
          intent: z.string(),
          changes: z.array(z.object({
            symbol_id: z.string(),
            name: z.string(),
            file: z.string(),
            change_kind: z.enum(['signature', 'return_type', 'nullability', 'param', 'rename', 'split', 'move', 'delete', 'body', 'add']),
            before: z.object({
              signature: z.string().optional(),
              return_type: z.string().optional(),
              nullable: z.boolean().optional(),
              name: z.string().optional(),
              split_into: z.array(z.string()).optional(),
              body_tags: z.array(z.enum(['early-return', 'guard', 'appends-after', 'other'])).optional(),
            }).optional(),
            after: z.object({
              signature: z.string().optional(),
              return_type: z.string().optional(),
              nullable: z.boolean().optional(),
              name: z.string().optional(),
              split_into: z.array(z.string()).optional(),
              body_tags: z.array(z.enum(['early-return', 'guard', 'appends-after', 'other'])).optional(),
            }).optional(),
          })),
        })).optional().describe('Explicit agent states to plan a merge over. Omit to use every OTHER active agent\'s persisted conceptual-conflict state for `workspace` (from check_conceptual_conflicts/check_collision) plus your own ambient working-tree changes.'),
      } as any,
    } as any,
    async ({ workspace, agent_id, states, use_substrate }: any) => withErrorHandling(async () => {
      const cas = await conceptualConflictCasForWorkspace(workspace);
      const explicitStates = Array.isArray(states) && states.length > 0;

      // W4 step 1 selection rule (SPEC-COORDINATION-FABRIC-V3 §8 W4, §3.2):
      // explicit `states` always takes the git-ambient/self-reported shape the
      // caller handed us (they opted out of substrate attribution by supplying
      // their own state); otherwise auto-select the substrate path once more
      // than one participant is active on this workspace's claim log — the
      // git-ambient path is sound only at <=1 (§3.2's attribution collapse).
      let useSubstrate = typeof use_substrate === 'boolean' ? use_substrate : undefined;
      if (!explicitStates && useSubstrate === undefined) {
        try {
          const activeClaims = await getActiveClaims(workspace);
          const activeParticipantCount = new Set(activeClaims.map((c) => c.agent_id)).size;
          useSubstrate = shouldUseSubstratePlan(activeParticipantCount);
        } catch {
          useSubstrate = false; // no claim log readable — fall back to the original path rather than fail the call.
        }
      }

      if (!explicitStates && useSubstrate) {
        const plan = await planIntentMergeFromSubstrate(workspace, cas);
        return json({
          workspace,
          attribution_source: 'substrate',
          agents_considered: plan.attribution.participants + plan.attribution.tiebroken,
          plan,
          note: plan.attribution.participants === 0 && plan.attribution.tiebroken === 0
            ? 'Substrate path selected (>1 active participant) but nothing was attributable yet (no in-flight delta, or no active claims cover it) — see unattributed_symbols.'
            : undefined,
        });
      }

      let planStates: AgentInFlightState[];
      if (explicitStates) {
        planStates = states as AgentInFlightState[];
      } else {
        const others = await otherAgentConceptualStates(workspace, agent_id);
        const ambientChanges = await ambientChangesForWorkspace(workspace);
        planStates = ambientChanges.length > 0
          ? [{ agent_id, intent: 'ambient working-tree changes', changes: ambientChanges }, ...others]
          : others;
      }

      const plan = planIntentMerge(planStates, cas);
      return json({
        workspace,
        attribution_source: 'git-ambient',
        agents_considered: [...new Set(planStates.map((s) => s.agent_id))],
        plan,
        note: planStates.length === 0
          ? 'No agent states found (none passed explicitly, no persisted conceptual-conflict state, no ambient changes). Call check_conceptual_conflicts/check_collision first, or pass `states` explicitly.'
          : undefined,
      });
    })
  );

  server.registerTool(
    'plan_parallel_work',
    {
      title: 'Plan Parallel Work',
      description: 'THE ACCELERANT (P6, §1.5 SPEC-COORDINATION-FABRIC-V2): given a pending task list, compute the MAXIMALLY-PARALLEL non-conflicting batching up front — the automated version of the decompose -> disjoint-claims -> fan-out loop a human orchestrator runs by hand. Everything else in this coordination group (claim_work/check_collision/check_conceptual_conflicts) reacts to overlap AFTER agents are already mid-flight; this tool runs BEFORE any agent starts, so a fleet can be routed to avoid most collisions rather than merely surviving them. Pass `tasks` with each task\'s declared `target_symbols`/`target_paths` when known; when a task declares neither, pass `path` (the repo) so the CAS-backed heuristic (`inferFootprintFromIntent`) can match real identifiers/file mentions in its free-text `intent` — deterministic pattern matching against ground truth, not AI, and a task matching nothing real stays visible in `unpartitionable` rather than being silently dropped or guessed at. THE GRAPH-AWARE ADVANTAGE: with `path` supplied and `include_blast_radius` left at its default (true), two tasks whose LITERAL targets are disjoint but whose CAS call-graph blast radii intersect (one edits a function, the other edits a real caller or callee of it) are still separated into different batches — a file/path-only partitioner cannot see this. CONCEPTUAL BATCHING (§4 SPEC-CONCEPTUAL-LAYER.md): pass each task\'s `flow_id`/`capability_id` (declared, or read off get_flow_concepts) to additionally group tasks by CONCEPTUAL blast radius — `concept_groups` in the response clusters tasks by the flow/capability they belong to, a second, coarser-grained disjointness signal on top of the file/symbol `batches` (different flows are conceptually disjoint even before any file-level analysis runs). Returns `batches` (each an array of task_ids meant to run FULLY PARALLEL, in fixed greedy-coloring order), `parallelism_factor` (tasks / batches — higher is more parallel), `conflict_edges` (each with a\'symbol\'/\'path\'/\'blast-radius\' reason), `footprint_source` (declared vs inferred per task id), `unpartitionable` (tasks with no derivable footprint at all, still included in a batch, never dropped), `concept_groups` (tasks clustered by flow_id/capability_id, when declared), and a human-readable `summary` line. Call this before dispatching parallel work to a fleet of agents whenever you have more than one pending task for the same workspace.',
      inputSchema: {
        tasks: z.array(z.object({
          id: z.string(),
          intent: z.string(),
          target_symbols: z.array(z.string()).optional().describe('Node ids (preferred) or bare symbol names this task will edit'),
          target_paths: z.array(z.string()).optional().describe('Relative file paths this task will edit'),
          flow_id: z.string().optional().describe('Conceptual coordinate: the flow (see get_flow_concepts) this task\'s work belongs to, for conceptual batching in `concept_groups`.'),
          capability_id: z.string().optional().describe('Conceptual coordinate: the capability this task realizes, used as a fallback grouping key when flow_id is absent.'),
        })).describe('Pending tasks to partition into maximally-parallel non-conflicting batches'),
        path: z.string().optional().describe('Repo path, to load the CAS for blast-radius expansion and intent->footprint inference. Omit to partition on declared footprints only (reduced fidelity, noted in the response).'),
        include_blast_radius: z.boolean().optional().describe('Expand each task footprint by one hop of CAS call-graph edges before computing conflicts. Default true.'),
      } as any,
    } as any,
    async ({ tasks, path, include_blast_radius }: any) => withErrorHandling(async () => {
      const partitionTasksInput: PartitionTask[] = (tasks || []).map((t: any) => ({
        id: t.id,
        intent: t.intent,
        target_symbols: t.target_symbols,
        target_paths: t.target_paths,
        flow_id: t.flow_id,
        capability_id: t.capability_id,
      }));

      const cas = path ? await partitionCasForPath(path) : { nodes: [], edges: [] };
      const includeBlastRadius = include_blast_radius ?? true;
      const result = partitionTasks(partitionTasksInput, cas, { includeBlastRadius: includeBlastRadius });

      const batchSummaries = result.batches.map(
        (b) => `batch ${b.batch_index + 1} runs [${b.task_ids.join(', ')}] in parallel`
      );
      const conceptSummary = result.concept_groups?.length
        ? ` | ${result.concept_groups.length} conceptual group(s): ${result.concept_groups.map((g) => `${g.kind}:${g.concept_id}=[${g.task_ids.join(', ')}]`).join('; ')}`
        : '';
      const summary = `${partitionTasksInput.length} tasks -> ${result.batches.length} parallel batch${result.batches.length === 1 ? '' : 'es'}, factor ${result.parallelism_factor.toFixed(2)}; ${batchSummaries.join('; ')}${conceptSummary}`;

      return json({
        ...result,
        summary,
        fidelity_note: path
          ? undefined
          : 'No `path` supplied: partitioned on declared target_symbols/target_paths only — no CAS blast-radius expansion, no intent inference. Pass `path` for full fidelity.',
      });
    })
  );

  server.registerTool(
    'subscribe_workspace',
    {
      title: 'Subscribe Workspace',
      description: 'Start (or confirm) live local-peer awareness for a workspace: same-machine claim-log changes are watched via fs events. There is no push transport over MCP (stdio has no server-initiated events), so this call arms a short-lived local watch and returns immediately — poll get_active_agents / get_in_flight_changes / check_collision afterward to see deltas. For cross-machine polling use HTTP GET /v1/coordination/state?workspace=&since=.',
      inputSchema: {
        workspace: z.string().describe('Workspace or project id/path'),
      } as any,
    } as any,
    async ({ workspace }: any) => withErrorHandling(async () => {
      const unwatch = watch(workspace, () => {});
      // Best-effort local watch: MCP stdio has no server push, so this is a
      // fire-and-forget arm+release rather than a held subscription. The
      // caller is expected to poll; this just confirms the store is watchable.
      setTimeout(unwatch, 250);
      return json({
        status: 'watching',
        workspace,
        note: 'MCP has no server-push transport; poll get_active_agents/get_in_flight_changes/check_collision for deltas. For cross-machine or SSE-style polling use HTTP GET /v1/coordination/state?workspace=&since=.',
      });
    })
  );

  // -- Advisory coordination fabric over MCP (CLI-parity for fab.ts) --
  // These four tools expose the SAME advisory, awareness-first local-store
  // primitives that apps/mcp-server/scripts/fab.ts drives from the shell, so a
  // fleet coordinates through the product's MCP surface instead of a private
  // script (the "coordination fabric is CLI-only" open item). They are
  // deliberately DISTINCT from the enforced grant surface (claim_work /
  // check_collision / release_work / get_active_agents above, backed by the
  // grant-manager): those take/queue an ENFORCED one-grant-per-symbol lease;
  // these are advisory claims (appendClaim / checkEditLock / getActiveClaims /
  // releaseAgent) that never block — a claim always succeeds, collisions are
  // surfaced as awareness, not refusals. Same semantics as fab.ts.
  //
  // Transport + workspace resolution is CONFIG-DRIVEN (coordination/
  // fabric-config.ts): once `klauro init` (or `klauro fabric on`) has persisted a fabric section
  // into the repo's .klaurorc (found by walking up from this server process's
  // cwd), these tools go remote automatically — no env vars per shell/agent.
  // Precedence: explicit `workspace` arg > .klaurorc fabric > FAB_* env
  // escape hatch (CI) > local fabric with the stable 'poc' fallback (never
  // the cwd basename — that was the papercut that let a claim land under the
  // wrong workspace).
  // Resolve fabric settings for an advisory fab_* call. process.cwd() alone is
  // fragile: a globally-registered MCP server whose cwd is NOT inside the repo
  // would never find the repo's .klaurorc, so fabric silently stays LOCAL with
  // no reason. Fix: seed the config search with the roots of already-analyzed
  // projects (reusing the analysis registry — the same path resolution the
  // analysis tools use), preferring one whose name/basename matches the
  // requested workspace, so the repo's fabric config is found regardless of
  // where the server process was launched. process.cwd() and KLAURO_FABRIC_CWD
  // remain in the search chain (handled inside resolveFabricSettings), so the
  // original cwd path is preserved and this only ADDS reach.
  const advisoryFabricSettings = async (workspace?: string) => {
    let searchDirs: string[] = [];
    try {
      const analyses = await listAnalyses();
      const roots = analyses.map((a) => a.path).filter(Boolean);
      if (workspace && workspace.trim()) {
        const wsLower = workspace.trim().toLowerCase();
        // Surface a repo whose registered name or directory basename matches the
        // requested workspace first (best guess at "the repo this call is about"),
        // then the rest as fallbacks.
        const preferred = analyses
          .filter((a) => a.name?.toLowerCase() === wsLower || nodePath.basename(a.path).toLowerCase() === wsLower)
          .map((a) => a.path)
          .filter(Boolean);
        searchDirs = [...new Set([...preferred, ...roots])];
      } else {
        searchDirs = [...new Set(roots)];
      }
    } catch {
      // Registry unreadable: fall back to the cwd/env chain only (unchanged behavior).
    }
    const settings = await resolveFabricSettings({ searchDirs, cwd: process.cwd(), explicitWorkspace: workspace });
    // W5 MCP-server lifecycle activation (SPEC-COORDINATION-FABRIC-V3 §8):
    // this is the choke-point where the long-lived MCP server process
    // resolves "which repo, which workspace id" for a fabric-aware call —
    // the natural place to make awareness ambient with zero extra opt-in
    // beyond the `klauro fabric on`/`klauro init` the workspace already ran.
    // `shouldActivateWriteHook` keeps a never-opted-in workspace fully inert;
    // `ensureWriteHookStarted` is idempotent per workspace id, so repeated
    // fab_* calls in one session start the watcher at most once. Never
    // crashes the caller — `startWriteHook` itself never throws, and any
    // async error inside the watcher only reaches `onError` below.
    if (shouldActivateWriteHook(settings)) {
      const root = settings.configPath ? nodePath.dirname(settings.configPath) : (searchDirs[0] ?? process.cwd());
      ensureWriteHookStarted(root, settings.workspace, {
        onError: (err) => {
          process.stderr.write(
            `Klauro write-hook (workspace ${settings.workspace}): ${err instanceof Error ? err.message : String(err)}\n`
          );
        },
      });
    }
    return settings;
  };

  /**
   * CAS+WAS-backed advisory overlap for the LOCAL fab_* path — the blast-radius
   * + cross-repo upgrade over the legacy path-only `checkEditLock`. Reuses the
   * existing analysis machinery (`partitionCasForPath` for same-repo CAS,
   * `resolveWorkspaceAnalysisForPaths` for the workspace WAS) and hands both to
   * `computeAdvisoryOverlap` (context-fabric.ts).
   *
   * Return shape is a STRICT SUPERSET of `checkEditLock`'s `EditLockConflict[]`
   * (agent_id, claim_id, paths, overlapping_paths preserved) so existing callers
   * — `conflicts.length`, `conflicts.map(c => c.agent_id)`, the JSON `conflicts`
   * field — keep working unchanged; the added fields (overlapping_symbols,
   * reason, cas_derived, was_derived, shared_surface) are pure enrichment.
   *
   * Advisory + non-blocking + graceful: every resolution is best-effort and
   * `computeAdvisoryOverlap` never throws, so on any failure this degrades to
   * the plain path-only `checkEditLock` result (never fewer signals than before,
   * never an error, never a gate).
   */
  const advisoryOverlapConflicts = async (
    ws: string,
    agentId: string,
    claimPaths: string[],
    claimSymbols: string[],
  ): Promise<Array<AdvisoryOverlapFinding & { paths: string[] }>> => {
    // Legacy path-only result is the guaranteed floor — we never return less.
    const editLock = claimPaths.length ? await checkEditLock(ws, claimPaths, agentId) : [];
    try {
      const active = await getActiveClaims(ws);
      const others = active.filter((c) => c.agent_id !== agentId);
      // Nothing to compare against, or the caller declared no footprint at all:
      // fall back to the legacy shape (as EditLockConflict already is).
      if (others.length === 0 || (claimPaths.length === 0 && claimSymbols.length === 0)) {
        return editLock.map((c) => ({
          agent_id: c.agent_id,
          claim_id: c.claim_id,
          intent: others.find((o) => o.claim_id === c.claim_id)?.intent ?? '',
          overlapping_paths: c.overlapping_paths,
          overlapping_symbols: [],
          reason: 'path' as const,
          cas_derived: false,
          was_derived: false,
          paths: c.paths,
        }));
      }
      // Same-repo CAS (best-effort; empty CAS => literal symbol/path overlap).
      const cas = await partitionCasForPath(ws);
      // Workspace WAS (best-effort; absent => cross-repo layer skipped).
      let was: any | undefined;
      try {
        was = (await resolveWorkspaceAnalysisForPaths([ws])).selected ?? undefined;
      } catch {
        was = undefined;
      }
      const findings = computeAdvisoryOverlap(
        { agent_id: agentId, paths: claimPaths, symbols: claimSymbols },
        active,
        cas,
        {},
        was,
      );
      return findings.map((f) => ({ ...f, paths: claimPaths }));
    } catch {
      // Any failure — degrade to the legacy path-only conflicts, never throw.
      return editLock.map((c) => ({
        agent_id: c.agent_id,
        claim_id: c.claim_id,
        intent: '',
        overlapping_paths: c.overlapping_paths,
        overlapping_symbols: [],
        reason: 'path' as const,
        cas_derived: false,
        was_derived: false,
        paths: c.paths,
      }));
    }
  };

  server.registerTool(
    'fab_claim_work',
    {
      title: 'Fab: Claim Work (advisory)',
      description: 'ADVISORY awareness claim (default coordination mode) — announces intent to peers, never blocks or queues, takes no lease. Use fab_claim_work for awareness-first parallel work where agents coordinate rather than lock. When you instead need a GUARANTEED exclusive lease over a scope (at-most-one-writer, with queueing on contention), use the enforced claim_work. Advisory work-claim over the same-machine coordination fabric (CLI-parity for `fab.ts claim`). AWARENESS-FIRST, NEVER A LOCKOUT: the claim always succeeds — it announces to peers on this host that you intend to touch these paths/symbols with this intent, so a fleet coordinates instead of blindly clobbering. Unlike the enforced grant surface (claim_work), this takes no lease and never queues you. Belt-and-suspenders: this ALSO runs the same overlap scan check_collision/fab_check_collision does and returns a `warning` (plus `conflicts`) inline when your paths overlap an already-active claim by another agent — so even an agent that skipped the preflight check still gets the heads-up. Call fab_release_work when done.',
      inputSchema: {
        agent_id: z.string().describe('Stable identifier for the calling agent/session'),
        intent: z.string().describe('Short description of the work being claimed'),
        paths: z.array(z.string()).optional().describe('File/dir paths this work will touch'),
        symbols: z.array(z.string()).optional().describe('Symbol/node ids this work will touch'),
        workspace: z.string().optional().describe('Workspace id to coordinate within (defaults to the repo .klaurorc fabric.workspace from `klauro init`, then $FAB_WS, else "poc")'),
        agent_kind: z.enum(['claude', 'cursor', 'codex', 'human', 'other']).optional().describe('Kind of agent (default claude)'),
        ttl_ms: z.number().optional().describe('Claim TTL in ms before it is considered stale (default 6h, matching fab.ts)'),
      } as any,
    } as any,
    async ({ agent_id, intent, paths, symbols, workspace, agent_kind, ttl_ms }: any) => withErrorHandling(async () => {
      const settings = await advisoryFabricSettings(workspace);
      const ws = settings.workspace;
      const claimPaths: string[] = paths || [];
      const claimSymbols: string[] = symbols || [];
      // REMOTE MODE (docs/FABRIC-REMOTE.md): a `klauro init` fabric config (or
      // the FAB_REMOTE_URL CI escape hatch) routes the claim to the
      // cross-machine coordination API instead of this host's filesystem.
      // Advisory contract on network failure: degrade LOUDLY to local, never error.
      const remote = settings.remote;
      if (remote) {
        try {
          const res = await remoteClaim(remote, {
            workspace: ws, agentId: agent_id, intent,
            paths: claimPaths, symbols: claimSymbols,
            agentKind: (agent_kind as AgentKind) || 'claude', ttlMs: ttl_ms,
          });
          return json({
            status: 'claimed', tier: 'remote', remote_url: remote.baseUrl,
            workspace: ws, agent_id, seq: res.seq, intent,
            paths: claimPaths, symbols: claimSymbols,
            ttl_ms: res.ttl_ms, server_time: res.server_time,
            conflicts: res.conflicts, warning: res.warning,
            heartbeat_hint: 'Re-claim before ttl_ms elapses to stay visible; fab_release_work when done.',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return await localClaim(`Remote fabric claim failed (${msg}) — DEGRADED to the LOCAL fabric: agents on other machines can NOT see this claim.`);
        }
      }
      return await localClaim();

      async function localClaim(degradeWarning?: string) {
      // Belt-and-suspenders (papercut fix (b)): scan for overlap BEFORE claiming
      // so an agent that skips fab_check_collision still gets the advisory
      // signal. Advisory — the claim proceeds regardless. Now CAS+WAS-backed
      // (blast-radius + cross-repo aware), a strict superset of the old
      // path-only checkEditLock; degrades gracefully and never throws.
      const conflicts = await advisoryOverlapConflicts(ws, agent_id, claimPaths, claimSymbols);
      const now = new Date().toISOString();
      const entry = await appendClaim(ws, {
        claim_id: `${ws}:${agent_id}`,
        workspace_id: ws,
        agent_id,
        agent_kind: (agent_kind as AgentKind) || 'claude',
        scope: { repo: ws, paths: claimPaths, symbols: claimSymbols },
        intent,
        status: 'active',
        created_at: now,
        ttl_ms: ttl_ms ?? 6 * 60 * 60 * 1000,
        heartbeat_at: now,
      });
      const overlapWarning = conflicts.length
        ? `ADVISORY: ${conflicts.length} other agent(s) overlap your scope (${conflicts
            .map((c) => `${c.agent_id}:${c.reason}`)
            .join(', ')})${conflicts.some((c) => c.was_derived) ? ' [incl. cross-repo]' : conflicts.some((c) => c.cas_derived) ? ' [incl. call-graph blast-radius]' : ''}. Your claim still succeeded — coordinate before writing.`
        : undefined;
      // Tier note, never silent: `degradeWarning` = remote configured but the
      // remote claim failed (unreachable/401); otherwise settings.localReason =
      // remote was never in play (not configured/disabled/config not found from
      // server cwd) so peers on other machines can't see this claim.
      const tierNote = degradeWarning || settings.localReason;
      return json({
        status: 'claimed',
        tier: 'local',
        workspace: ws,
        agent_id,
        seq: entry.seq,
        intent,
        paths: entry.scope.paths,
        symbols: entry.scope.symbols,
        conflicts,
        warning: [tierNote, overlapWarning].filter(Boolean).join(' ') || undefined,
      });
      }
    })
  );

  server.registerTool(
    'fab_check_collision',
    {
      title: 'Fab: Check Collision (advisory)',
      description: 'ADVISORY read-only preflight (pairs with fab_claim_work) — checks overlap without taking any claim or lease; awareness-only, never a gate. (The enforced claim_work performs its own overlap+queue resolution at grant time, so this fabric preflight is for the advisory awareness path.) Read-only advisory preflight over the coordination fabric (CLI-parity for `fab.ts check`): do the proposed paths overlap any OTHER active agent\'s claim on this host? Takes no claim. Returns the conflicting active claims (agent_id + overlapping_paths) so you can coordinate before you call fab_claim_work. Awareness-only — never a gate.',
      inputSchema: {
        agent_id: z.string().describe('Your agent_id (excluded from the overlap scan so you do not collide with yourself)'),
        paths: z.array(z.string()).describe('Proposed file/dir paths to check for overlap'),
        workspace: z.string().optional().describe('Workspace id (defaults to the repo .klaurorc fabric.workspace from `klauro init`, then $FAB_WS, else "poc")'),
      } as any,
    } as any,
    async ({ agent_id, paths, workspace }: any) => withErrorHandling(async () => {
      const settings = await advisoryFabricSettings(workspace);
      const ws = settings.workspace;
      const remote = settings.remote;
      let degradeNote: string | undefined;
      if (remote) {
        try {
          const res = await remoteCheck(remote, { workspace: ws, agentId: agent_id, paths: paths || [] });
          return json({
            workspace: ws,
            tier: 'remote',
            remote_url: remote.baseUrl,
            agent_id,
            paths: paths || [],
            ok: res.ok,
            conflicts: res.conflicts,
            server_time: res.server_time,
            note: res.ok
              ? 'No conflicting active claims on those paths (cross-machine view).'
              : `${res.conflicts.length} other agent(s) claim overlapping paths — advisory, coordinate before writing.`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          degradeNote = `Remote fabric check failed (${msg}) — DEGRADED to the LOCAL view: claims from other machines are NOT visible in this result. `;
        }
      }
      // CAS+WAS-backed advisory overlap (blast-radius + cross-repo aware), a
      // strict superset of the old path-only checkEditLock; degrades gracefully
      // and never throws. This preflight is paths-only (no symbols input), so
      // pass [] for symbols — CAS still expands the paths' blast radius and the
      // WAS still surfaces cross-repo shared-code/contract overlap.
      const conflicts = await advisoryOverlapConflicts(ws, agent_id, paths || [], []);
      // degradeNote = remote was configured but the call failed (unreachable/401).
      // settings.localReason = remote was never in play (not configured/disabled/
      // config not found from server cwd). Surface whichever applies so a local
      // result is never silently ambiguous about cross-machine visibility.
      const localTierNote = degradeNote || (settings.localReason ? `${settings.localReason} ` : '');
      return json({
        workspace: ws,
        tier: 'local',
        agent_id,
        paths: paths || [],
        ok: conflicts.length === 0,
        conflicts,
        note:
          localTierNote +
          (conflicts.length
            ? `${conflicts.length} other agent(s) overlap your scope (${[...new Set(conflicts.map((c) => c.reason))].join(', ')})${conflicts.some((c) => c.was_derived) ? ' incl. cross-repo' : conflicts.some((c) => c.cas_derived) ? ' incl. call-graph blast-radius' : ''} — advisory, coordinate before writing.`
            : 'No conflicting active claims on those paths.'),
      });
    })
  );

  server.registerTool(
    'fab_release_work',
    {
      title: 'Fab: Release Work (advisory)',
      description: 'ADVISORY release (counterpart to fab_claim_work) — clears the fabric awareness claims; to release an ENFORCED lease taken via claim_work use release_work instead. Release EVERY advisory claim held by an agent on this host (CLI-parity for `fab.ts release`): drops your work-claims and edit-locks so peers see the scope free again and false-overlap awareness clears. Call the moment you are done or handing off.',
      inputSchema: {
        agent_id: z.string().describe('Agent id whose claims to release'),
        workspace: z.string().optional().describe('Workspace id (defaults to the repo .klaurorc fabric.workspace from `klauro init`, then $FAB_WS, else "poc")'),
      } as any,
    } as any,
    async ({ agent_id, workspace }: any) => withErrorHandling(async () => {
      const settings = await advisoryFabricSettings(workspace);
      const ws = settings.workspace;
      const remote = settings.remote;
      let degradeWarning: string | undefined;
      if (remote) {
        try {
          const res = await remoteRelease(remote, { workspace: ws, agentId: agent_id });
          return json({
            status: 'released',
            tier: 'remote',
            remote_url: remote.baseUrl,
            workspace: ws,
            agent_id,
            released_count: res.released_count,
            released: res.released,
            server_time: res.server_time,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          degradeWarning = `Remote fabric release failed (${msg}) — released LOCAL claims only; any remote claim will linger until its TTL expires. Re-release once the service is reachable.`;
        }
      }
      // releaseAgentWithReason instead of bare releaseAgent: a released_count
      // of 0 was silently ambiguous between "double-release no-op" and
      // "workspace-id mismatch — your claim is still ACTIVE elsewhere" (V3
      // §6.3 finding: fab_release_work returned released_count:0 for a claim
      // definitely made). The reason names which, incl. where the live claim is.
      const outcome = await releaseAgentWithReason(ws, agent_id);
      const released = outcome.released;
      return json({
        status: 'released',
        tier: 'local',
        workspace: ws,
        agent_id,
        released_count: released.length,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        released: released.map((r) => ({ claim_id: r.claim_id, intent: r.intent, paths: r.scope.paths })),
        // degradeWarning = remote release failed; settings.localReason = remote
        // was never configured (so "released local only" is expected, not a
        // failure). Either way, say why this was a local-only release.
        warning: degradeWarning || settings.localReason,
      });
    })
  );

  server.registerTool(
    'fab_list_active_work',
    {
      title: 'Fab: List Active Work (advisory)',
      description: 'List active ADVISORY fabric claims (the awareness surface for fab_claim_work). For the ENFORCED grant/lease state and its FIFO queue, use get_active_agents instead. List every active advisory claim in a workspace on this host (CLI-parity for `fab.ts active`): each agent\'s intent, claimed paths, and symbols. The awareness surface — call before starting work to see who else is here and what they are touching.',
      inputSchema: {
        workspace: z.string().optional().describe('Workspace id (defaults to the repo .klaurorc fabric.workspace from `klauro init`, then $FAB_WS, else "poc")'),
      } as any,
    } as any,
    async ({ workspace }: any) => withErrorHandling(async () => {
      const settings = await advisoryFabricSettings(workspace);
      const ws = settings.workspace;
      const remote = settings.remote;
      let degradeNote: string | undefined;
      if (remote) {
        try {
          const res = await remoteActive(remote, ws);
          return json({
            workspace: ws,
            tier: 'remote',
            remote_url: remote.baseUrl,
            count: res.count,
            max_seq: res.max_seq,
            server_time: res.server_time,
            active: res.active.map((c) => ({
              agent_id: c.agent_id,
              agent_kind: c.agent_kind,
              status: c.status,
              intent: c.intent,
              paths: c.paths,
              symbols: c.symbols,
              seq: c.seq,
            })),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          degradeNote = `Remote fabric unreachable (${msg}) — showing the LOCAL view only; agents on other machines are NOT listed.`;
        }
      }
      const active = await getActiveClaims(ws);
      return json({
        workspace: ws,
        tier: 'local',
        // Never silent: if remote was expected but we fell back, degradeNote
        // carries the runtime cause (unreachable/401); otherwise settings.localReason
        // explains why local is the resolved tier (not configured / disabled /
        // config not found from the server cwd). Only truly-local, correctly-
        // configured runs have no note.
        note: degradeNote || settings.localReason,
        count: active.length,
        active: active.map((c) => ({
          agent_id: c.agent_id,
          agent_kind: c.agent_kind,
          status: c.status,
          intent: c.intent,
          paths: c.scope.paths,
          symbols: c.scope.symbols,
        })),
      });
    })
  );

  server.registerTool(
    'get_analysis_facts',
    {
      title: 'Get Analysis Facts',
      description: 'Evidence-backed CAS facts. Filter by subject type, subject ID, or fact type to see the claim, producer, confidence, and source evidence behind CAS data. Structural facts (definitions, relationships, workflows) are deterministic and available instantly; each fact carries a description_source (deterministic|ai|manual|reused) so you can tell precomputed structure from AI-enriched prose. Act on deterministic facts immediately — they do not wait on the background AI pass.',
      inputSchema: {
        path: z.string().describe('Project path'),
        subject_type: z.string().optional().describe('Filter by subject type, such as node, edge, entry_point, workflow, capability, runtime_link, repository_link'),
        subject_id: z.string().optional().describe('Filter by concrete CAS object ID'),
        fact_type: z.string().optional().describe('Filter by fact type, such as definition, relationship, workflow, runtime-correlation, cross-repository'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
        track: TRACK_PARAM,
      } as any,
    } as any,
    async ({ path, subject_type, subject_id, fact_type, limit, offset, track }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path, track ? { track } : undefined);
      return json(query.getAnalysisFacts(cas, { subjectType: subject_type, subjectId: subject_id, factType: fact_type, limit, offset }));
    })
  );

  server.registerTool(
    'get_domain_concepts',
    {
      title: 'Get Domain Concepts',
      description: 'Core domain terminology: concepts with frequency, where they appear (entry points, entities, nodes), classification (core/supporting/infrastructure). Sorted by frequency. Paginated (default 25).',
      inputSchema: {
        path: z.string().describe('Project path'),
        classification: z.string().optional().describe('Filter by classification: core, supporting, infrastructure'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, classification, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDomainConcepts(cas, { classification, limit, offset }));
    })
  );

  // -- Behaviors & Lifecycle --

  server.registerTool(
    'get_behaviors',
    {
      title: 'Get Behaviors',
      description: 'System behaviors - what the system does. Returns behavior names, participating nodes, and execution flows. Use behavior_id for full detail.',
      inputSchema: {
        path: z.string().describe('Project path'),
        behavior_id: z.string().optional().describe('Specific behavior ID for full detail'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, behavior_id, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      if (behavior_id) {
        const result = query.getBehaviorDetail(cas, behavior_id);
        if (!result) return json({ error: `Behavior not found: ${behavior_id}` });
        return json(result);
      }
      return json(query.getBehaviors(cas, { limit, offset }));
    })
  );

  server.registerTool(
    'get_lifecycle_hooks',
    {
      title: 'Get Lifecycle Hooks',
      description: 'Find lifecycle hooks - initialization, mounting, updates, destruction. Detects Angular ngOnInit, React useEffect, Vue mounted, NestJS OnModuleInit, etc.',
      inputSchema: {
        path: z.string().describe('Project path'),
        phase: z.string().optional().describe('Filter by phase: init, mount, update, destroy'),
        framework: z.string().optional().describe('Filter by framework'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, phase, framework, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getLifecycleHooks(cas, { phase, framework, limit, offset }));
    })
  );

  // -- Testing --

  server.registerTool(
    'find_tests',
    {
      title: 'Find Tests',
      description: 'Find test suites and test cases covering a specific node or file. Includes assertions, mocks, fixtures, and coverage info. Without node_id or file_path, returns paginated list of all test suites (default 25).',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().optional().describe('Node ID to find tests for'),
        file_path: z.string().optional().describe('File path to find tests for'),
        limit: z.number().optional().describe('Max results when listing all (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, node_id, file_path, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.findTests(cas, { nodeId: node_id, filePath: file_path, limit, offset }));
    })
  );

  server.registerTool(
    'get_test_summary',
    {
      title: 'Get Test Summary',
      description: 'Test overview: counts by type/status, coverage, mocks, fixtures, plus aggregated gap statistics (totals by severity and gap type) and the highest-severity test gaps. Page additional gaps with limit/offset or narrow with gap_type and severity.',
      inputSchema: {
        path: z.string().describe('Project path'),
        gap_type: z.enum(['untested-flow', 'untested-branch', 'mock-only', 'no-assertions']).optional().describe('Only gaps of this type'),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Only gaps of this severity'),
        limit: z.number().optional().describe('Max gaps to return (default 25, max 200)'),
        offset: z.number().optional().describe('Skip first N gaps after severity sorting (default 0)'),
      } as any,
    } as any,
    async ({ path, gap_type, severity, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getTestSummary(cas, { gapType: gap_type, severity, limit, offset }));
    })
  );

  // -- Data & Schema --

  server.registerTool(
    'get_database_schema',
    {
      title: 'Get Database Schema',
      description: 'Database schema from ORM analysis: entities, fields (types, constraints), relationships (1:1, 1:N, M:N).',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDatabaseSchema(cas));
    })
  );

  server.registerTool(
    'get_erd',
    {
      title: 'Get ERD (Entity-Relationship Diagram)',
      description: 'Entity-relationship model from ORM analysis: entities (fields with PK/FK/nullable/unique), and evidence-gated relationships (one-to-one/one-to-many/many-to-one/many-to-many, or "unknown" when the ORM relation kind is unrecognized — never guessed) with the join field. Returns a renderable Mermaid erDiagram plus compact JSON. Reshapes get_database_schema; does not re-extract. Empty ERD for repos with no entities.',
      inputSchema: {
        path: z.string().describe('Project path'),
        format: z.enum(['json', 'mermaid']).optional().describe('json = structured model only; mermaid = erDiagram string only; omit for both'),
        entity: z.string().optional().describe('Focus on one entity and its direct neighbours (subgraph)'),
      } as any,
    } as any,
    async ({ path, format, entity }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getErd(cas, { format, entityName: entity }));
    })
  );

  // -- Code Health --

  server.registerTool(
    'get_implementation_health',
    {
      title: 'Get Implementation Health',
      description: 'Implementation completeness: complete/partial/stub/deprecated/experimental counts, health score, risk areas, deprecation timeline.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getImplementationHealth(cas));
    })
  );

  server.registerTool(
    'get_system_health',
    {
      title: 'Get System Health',
      description: 'CAS-backed coherence and risk analysis: complexity, duplication, paradigm drift, naming/DI/module convention drift, implementation gaps, test gaps, and runtime coverage gaps. Use before broad refactors and after analysis to decide what to fix or align.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getSystemHealth(cas));
    })
  );

  server.registerTool(
    'get_documentation_coverage',
    {
      title: 'Get Documentation Coverage',
      description: 'Documentation quality: coverage by type (functions, classes, interfaces, modules), quality metrics, missing documentation ranked by importance.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDocumentationCoverage(cas));
    })
  );

  server.registerTool(
    'get_todos',
    {
      title: 'Get TODOs',
      description: 'TODO/FIXME tracking: counts by type/priority/category, tech debt items, blocking items, hotspot files.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getTodos(cas));
    })
  );

  // -- Dependencies & Libraries --

  server.registerTool(
    'get_dependencies',
    {
      title: 'Get Dependencies',
      description: 'Package dependencies: packages with versions, licenses, vulnerabilities.',
      inputSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getDependencies(cas));
    })
  );

  server.registerTool(
    'get_libraries',
    {
      title: 'Get Libraries',
      description: 'Library analysis: usage patterns, bundle size, security info, usage stats, optimization opportunities, replacement feasibility, alternatives. Paginated (default 25).',
      inputSchema: {
        path: z.string().describe('Project path'),
        query: z.string().optional().describe('Filter by library name or category'),
        limit: z.number().optional().describe('Max results (default 25)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, query: q, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getLibraries(cas, { query: q, limit, offset }));
    })
  );

  server.registerTool(
    'get_coverage_gaps',
    {
      title: 'Get Coverage Gaps',
      description: 'Self-discovered analysis coverage gaps: dependencies matching no known analyzer, files with a suspiciously low node-extraction ratio (likely an unhandled construct), roots with source but zero entry points, and tree-sitter node types no analyzer ever handled. Also surfaces the codebase_type classification (web-backend, library, cli, ...) this analysis inferred. Use this to see what the analysis does NOT yet understand about a repo, ranked by severity.',
      inputSchema: {
        path: z.string().describe('Project path'),
        kind: z.string().optional().describe('Filter by gap kind: unknown-dependency | low-extraction-ratio | zero-entry-points | unhandled-node-type'),
        severity: z.string().optional().describe('Filter by severity: high | medium | low'),
        limit: z.number().optional().describe('Max results (default 50)'),
        offset: z.number().optional().describe('Skip first N results (default 0)'),
      } as any,
    } as any,
    async ({ path, kind, severity, limit, offset }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(query.getCoverageGaps(cas, { kind, severity, limit, offset }));
    })
  );

  // -- Change History & Incremental Analysis --

  server.registerTool(
    'get_changes_since',
    {
      title: 'Get Changes Since',
      description: 'Query changes after a specific timestamp. Returns change history entries with files, nodes, edges affected, impact analysis, and semantic summaries.',
      inputSchema: {
        path: z.string().describe('Project path'),
        since: z.string().describe('ISO timestamp to query changes from'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, since, limit }: any) => withErrorHandling(async () => {
      return json(await query.getChangesSince(path, since, { limit }));
    })
  );

  server.registerTool(
    'get_changes_between',
    {
      title: 'Get Changes Between',
      description: 'Query changes between two timestamps. Returns change history entries within the time range.',
      inputSchema: {
        path: z.string().describe('Project path'),
        from: z.string().describe('Start ISO timestamp'),
        to: z.string().describe('End ISO timestamp'),
        limit: z.number().optional().describe('Max results (default 50)'),
      } as any,
    } as any,
    async ({ path, from, to, limit }: any) => withErrorHandling(async () => {
      return json(await query.getChangesBetween(path, from, to, { limit }));
    })
  );

  server.registerTool(
    'get_changes_for_node',
    {
      title: 'Get Changes for Node',
      description: 'Query changes affecting a specific node. Optionally include changes to callers/callees to see ripple effects.',
      inputSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to find changes for'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        include_callers: z.boolean().optional().describe('Include changes to callers'),
        include_callees: z.boolean().optional().describe('Include changes to callees'),
        depth: z.number().optional().describe('How far to traverse caller/callee graph (default 1)'),
        limit: z.number().optional().describe('Max results (default 25)'),
      } as any,
    } as any,
    async ({ path, node_id, since, include_callers, include_callees, depth, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.getChangesForNode(cas, path, node_id, {
        since,
        includeCallers: include_callers,
        includeCallees: include_callees,
        depth,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_changes_for_file',
    {
      title: 'Get Changes for File',
      description: 'Query changes to a specific file. Optionally include changes to files that import/are imported by this file.',
      inputSchema: {
        path: z.string().describe('Project path'),
        file_path: z.string().describe('Relative file path to find changes for'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        include_importers: z.boolean().optional().describe('Include changes to files that import this file'),
        include_imported: z.boolean().optional().describe('Include changes to files this file imports'),
        limit: z.number().optional().describe('Max results (default 25)'),
      } as any,
    } as any,
    async ({ path, file_path, since, include_importers, include_imported, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.getChangesForFile(cas, path, file_path, {
        since,
        includeImporters: include_importers,
        includeImported: include_imported,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_changes_for_entry_point',
    {
      title: 'Get Changes for Entry Point',
      description: 'Query changes affecting an entry point (HTTP endpoint, CLI command, etc.). Optionally include the full call chain.',
      inputSchema: {
        path: z.string().describe('Project path'),
        entry_point_id: z.string().describe('Entry point ID to find changes for'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        include_full_chain: z.boolean().optional().describe('Include changes to all nodes in the call chain'),
        limit: z.number().optional().describe('Max results (default 25)'),
      } as any,
    } as any,
    async ({ path, entry_point_id, since, include_full_chain, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.getChangesForEntryPoint(cas, path, entry_point_id, {
        since,
        includeFullChain: include_full_chain,
        limit,
      }));
    })
  );

  server.registerTool(
    'get_change_summary',
    {
      title: 'Get Change Summary',
      description: 'Aggregated change statistics grouped by file, module, author, intent, day, or week. Shows change velocity, risk distribution, and trends.',
      inputSchema: {
        path: z.string().describe('Project path'),
        group_by: z.enum(['file', 'module', 'author', 'intent', 'day', 'week']).describe('How to group changes'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        until: z.string().optional().describe('ISO timestamp to query changes until'),
      } as any,
    } as any,
    async ({ path, group_by, since, until }: any) => withErrorHandling(async () => {
      return json(await query.getChangeSummary(path, {
        groupBy: group_by,
        since,
        until,
      }));
    })
  );

  server.registerTool(
    'get_hot_spots',
    {
      title: 'Get Hot Spots',
      description: 'Find the most frequently changed or bug-prone areas of the codebase. Returns heat map data with normalized intensity values.',
      inputSchema: {
        path: z.string().describe('Project path'),
        metric: z.enum(['change-count', 'churn-lines', 'bug-fix-rate']).describe('Metric to rank files by'),
        since: z.string().optional().describe('ISO timestamp to query changes from'),
        limit: z.number().optional().describe('Max results (default 20)'),
      } as any,
    } as any,
    async ({ path, metric, since, limit }: any) => withErrorHandling(async () => {
      const cas = await getAnalysis(path);
      return json(await query.getHotSpots(cas, path, { metric, since, limit }));
    })
  );

  server.registerTool(
    'get_analysis_at',
    {
      title: 'Get Analysis At',
      description: 'Time travel: retrieve the analysis state at a specific point in time. Returns the full CASOutput as it existed at that timestamp.',
      inputSchema: {
        path: z.string().describe('Project path'),
        timestamp: z.string().describe('ISO timestamp to retrieve analysis for'),
      } as any,
    } as any,
    async ({ path, timestamp }: any) => withErrorHandling(async () => {
      const result = await query.getAnalysisAt(path, timestamp);
      if (!result) return json({ error: `No analysis snapshot found at or before: ${timestamp}` });
      return json(result);
    })
  );

  server.registerTool(
    'get_analysis_snapshots',
    {
      title: 'Get Analysis Snapshots',
      description: 'List all available analysis snapshots for time travel. Returns snapshot IDs and timestamps.',
      inputSchema: {
        path: z.string().describe('Project path'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      return json(await query.getAnalysisSnapshots(path));
    })
  );

  // -- Watch Mode (Real-Time Analysis) --

  server.registerTool(
    'start_watch',
    {
      title: 'Start Watch',
      description: 'Begin watching a project for file changes. Automatically runs incremental analysis when files change. Returns a watch_id for tracking the session.',
      inputSchema: {
        path: z.string().describe('Project path to watch'),
      } as any,
    } as any,
    async ({ path }: any) => withErrorHandling(async () => {
      return json(watcher.startWatch(path));
    })
  );

  server.registerTool(
    'stop_watch',
    {
      title: 'Stop Watch',
      description: 'Stop watching a project for file changes.',
      inputSchema: {
        watch_id: z.string().describe('Watch session ID from start_watch'),
      } as any,
    } as any,
    async ({ watch_id }: any) => withErrorHandling(async () => {
      return json(watcher.stopWatch(watch_id));
    })
  );

  server.registerTool(
    'get_watch_status',
    {
      title: 'Get Watch Status',
      description: 'Get the current status of a watch session including pending changes, recent analyses, and statistics.',
      inputSchema: {
        watch_id: z.string().describe('Watch session ID from start_watch'),
      } as any,
    } as any,
    async ({ watch_id }: any) => withErrorHandling(async () => {
      const status = watcher.getWatchStatus(watch_id);
      if (!status) return json({ error: `Watch session not found: ${watch_id}` });
      return json(status);
    })
  );

  server.registerTool(
    'list_watches',
    {
      title: 'List Watches',
      description: 'List all active and recent watch sessions.',
      inputSchema: {} as any,
    } as any,
    async () => withErrorHandling(async () => {
      return json(watcher.listWatches());
    })
  );

  server.registerTool(
    'poll_watch_changes',
    {
      title: 'Poll Watch Changes',
      description: 'Poll for recent changes from a watch session. Use this to check if new analyses have completed since the last poll.',
      inputSchema: {
        watch_id: z.string().describe('Watch session ID from start_watch'),
        since: z.string().optional().describe('ISO timestamp to filter changes newer than this'),
      } as any,
    } as any,
    async ({ watch_id, since }: any) => withErrorHandling(async () => {
      const changes = watcher.pollWatchChanges(watch_id, since);
      if (!changes) return json({ error: `Watch session not found: ${watch_id}` });
      return json(changes);
    })
  );

  server.registerTool(
    'install_gauntlet_watcher',
    {
      title: 'Install Gauntlet Watcher',
      description: 'Install a watcher on a repository that automatically runs the incremental-change gauntlet whenever the code changes — measuring Klauro\'s advantage on understanding each change (quality/token/speed delta over time). The watcher is persisted and auto-resumes when the gauntlet UI server restarts.',
      inputSchema: {
        repo_path: z.string().describe('Absolute path to the repository to watch (must have a stored analysis).'),
      } as any,
    } as any,
    async ({ repo_path }: any) => withErrorHandling(async () => {
      return json(await installGauntletWatcher(repo_path));
    })
  );

  server.registerTool(
    'list_gauntlet_watchers',
    {
      title: 'List Gauntlet Watchers',
      description: 'List installed gauntlet watchers with their live status, recent changes, and how many incremental gauntlet runs each has produced.',
      inputSchema: {} as any,
    } as any,
    async () => withErrorHandling(async () => {
      return json(await listGauntletWatchers());
    })
  );

  server.registerTool(
    'stop_gauntlet_watcher',
    {
      title: 'Stop Gauntlet Watcher',
      description: 'Stop and disable an installed gauntlet watcher by id.',
      inputSchema: {
        id: z.string().describe('Gauntlet watcher id from list_gauntlet_watchers.'),
      } as any,
    } as any,
    async ({ id }: any) => withErrorHandling(async () => {
      return json(await stopGauntletWatcher(id));
    })
  );

  server.registerTool(
    'run_incremental_gauntlet',
    {
      title: 'Run Incremental Gauntlet',
      description: 'Run the incremental-change gauntlet for one repository on demand: projects Klauro vs every competitor arm on understanding a change and records the quality/token/speed delta. Returns the record and appends it to the repo\'s incremental history.',
      inputSchema: {
        repo_name: z.string().describe('Analysis name of the repository.'),
        files_changed: z.number().optional().describe('Number of files changed (for change-magnitude).'),
        nodes_added: z.number().optional(),
        nodes_modified: z.number().optional(),
        nodes_deleted: z.number().optional(),
        risk_level: z.string().optional(),
      } as any,
    } as any,
    async ({ repo_name, files_changed, nodes_added, nodes_modified, nodes_deleted, risk_level }: any) => withErrorHandling(async () => {
      const change = (files_changed || nodes_added || nodes_modified || nodes_deleted)
        ? { filesChanged: files_changed || 0, nodesAdded: nodes_added || 0, nodesModified: nodes_modified || 0, nodesDeleted: nodes_deleted || 0, riskLevel: risk_level }
        : undefined;
      const record = await runIncrementalGauntlet({ repoName: repo_name, change });
      const history = await listIncrementalRecords(repo_name, 20);
      return json({ record, history_length: history.length });
    })
  );
}

function reportSummaryWithinWindow(summary: { generated_at?: string; saved_at?: string }, sinceDays?: number | null): boolean {
  if (!sinceDays || sinceDays <= 0) return true;
  const parsed = Date.parse(String(summary.generated_at || summary.saved_at || ''));
  if (!Number.isFinite(parsed)) return false;
  return parsed >= Date.now() - sinceDays * 24 * 60 * 60 * 1000;
}

function registerResources(server: McpServer) {
  server.registerResource(
    'analyses-list',
    'klauro://analyses',
    { title: 'All Analyses', description: 'List of all analyzed codebases with metadata.', mimeType: 'application/json' } as any,
    async () => {
      const analyses = await listAnalyses();
      return { contents: [{ uri: 'klauro://analyses', text: JSON.stringify(analyses) }] };
    }
  );

  server.registerResource(
    'workspace-graphs-list',
    'klauro://workspaces',
    { title: 'Workspace Graphs', description: 'Persisted multi-repository workspace graphs.', mimeType: 'application/json' } as any,
    async () => {
      const graphs = await listWorkspaceGraphs();
      return { contents: [{ uri: 'klauro://workspaces', text: JSON.stringify(graphs) }] };
    }
  );

  server.registerResource(
    'workspace-graph',
    new ResourceTemplate('klauro://workspace/{workspace_id_or_name}/graph', { list: undefined }),
    { title: 'Workspace Graph', description: 'Persisted cross-repository graph with links, conflicts, confidence, and review decisions.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const graph = await loadWorkspaceGraph(String(params.workspace_id_or_name));
      if (!graph) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Workspace graph not found' }) }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify({ summary: workspaceGraph.summarizeWorkspaceGraph(graph), graph }) }] };
    }
  );

  server.registerResource(
    'workspace-analyses-list',
    'klauro://workspace-analyses',
    { title: 'Workspace Analyses', description: 'Persisted WAS-compliant Workspace analyses generated from completed CAS analyses.', mimeType: 'application/json' } as any,
    async () => {
      const graphs = await listCrossCodebaseSystemGraphs();
      return { contents: [{ uri: 'klauro://workspace-analyses', text: JSON.stringify(graphs) }] };
    }
  );

  server.registerResource(
    'workspace-analysis',
    new ResourceTemplate('klauro://workspace-analysis/{analysis_id_or_name}', { list: undefined }),
    { title: 'Workspace Analysis', description: 'Persisted WAS-compliant Workspace analysis with projects, deployables, interfaces, integration links, runtime topology, insights, and unmatched interfaces.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const graph = await loadCrossCodebaseSystemGraph(String(params.analysis_id_or_name));
      if (!graph) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Workspace analysis not found' }) }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify({ summary: crossCodebaseAnalysis.summarizeWorkspaceAnalysis(graph), graph }) }] };
    }
  );

  server.registerResource(
    'agentic-benchmark-reports',
    'klauro://agentic-benchmarks',
    { title: 'Agentic Benchmark Reports', description: 'Persisted with-Klauro vs without-Klauro agent benchmark reports.', mimeType: 'application/json' } as any,
    async () => {
      const reports = await listAgenticBenchmarkReports();
      return { contents: [{ uri: 'klauro://agentic-benchmarks', text: JSON.stringify(reports) }] };
    }
  );

  server.registerResource(
    'agent-performance-proof',
    'klauro://agent-performance-proof',
    { title: 'Agent Performance Proof', description: 'Recent proof that Klauro improves agent token use, speed, quality, and incremental edit-loop performance.', mimeType: 'application/json' } as any,
    async () => {
      const summaries = (await listAgenticBenchmarkReports())
        .filter(summary => reportSummaryWithinWindow(summary, 7))
        .slice(0, 25);
      const reports = [];
      for (const summary of summaries) {
        const report = await loadAgenticBenchmarkReport(summary.id);
        if (report) reports.push(report);
      }
      const proof = buildAgentPerformanceProof(reports, { sinceDays: 7 });
      return { contents: [{ uri: 'klauro://agent-performance-proof', text: JSON.stringify(proof) }] };
    }
  );

  server.registerResource(
    'agentic-benchmark-report',
    new ResourceTemplate('klauro://agentic-benchmark/{report_id}', { list: undefined }),
    { title: 'Agentic Benchmark Report', description: 'A persisted agent benchmark, live quality, or incremental value report.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const report = await loadAgenticBenchmarkReport(String(params.report_id));
      if (!report) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Agentic benchmark report not found' }) }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify({ report, markdown: formatStoredBenchmarkReport(report) }) }] };
    }
  );

  server.registerResource(
    'project-overview',
    new ResourceTemplate('klauro://{project_name}/overview', { list: undefined }),
    { title: 'Project Overview', description: 'System overview: architecture summary, tech stack, capabilities, purpose.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(query.getSystemOverview(cas)) }] };
    }
  );

  server.registerResource(
    'project-agent-bootstrap',
    new ResourceTemplate('klauro://{project_name}/agent-bootstrap', { list: undefined }),
    { title: 'Agent Bootstrap', description: 'One payload with agent readiness, start context, MCP plan, agent context, and prompt text.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(await agentBootstrap.getAgentBootstrap(cas, entry.path)) }] };
    }
  );

  server.registerResource(
    'project-agent-start',
    new ResourceTemplate('klauro://{project_name}/agent-start', { list: undefined }),
    { title: 'Agent Start Context', description: 'Default CAS-backed start context for coding agents before broad file reads.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(agentAdoption.getAgentStartContext(cas, entry.path)) }] };
    }
  );

  server.registerResource(
    'project-runtime-event-contract',
    new ResourceTemplate('klauro://{project_name}/runtime-event-contract', { list: undefined }),
    { title: 'Runtime Event Contract', description: 'Canonical runtime event schema and CAS-specific payloads for SDK telemetry correlation.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(runtimeContract.getRuntimeEventContract(cas)) }] };
    }
  );

  server.registerResource(
    'project-cas-contract',
    new ResourceTemplate('klauro://{project_name}/cas-contract', { list: undefined }),
    { title: 'CAS Contract Validation', description: 'Executable graph completeness and evidence checks for the stored CAS output.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      const observations = await loadRuntimeObservations(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(casContract.validateCASContract(cas, observations)) }] };
    }
  );

  server.registerResource(
    'project-agent-readiness',
    new ResourceTemplate('klauro://{project_name}/agent-readiness', { list: undefined }),
    { title: 'Agent Readiness', description: 'Agent-use readiness score and gaps for agent adoption.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      const evidence = await testDiscovery.getTestDiscoveryEvidence(entry.path, cas);
      return { contents: [{ uri: uri.href, text: JSON.stringify(agentAdoption.evaluateAgentReadiness(cas, entry.path, { testEvidence: evidence })) }] };
    }
  );

  server.registerResource(
    'project-agent-doctor',
    new ResourceTemplate('klauro://{project_name}/agent-doctor', { list: undefined }),
    { title: 'Agent Doctor', description: 'Agent-use readiness, freshness, tests, runtime SDK proof, and golden snapshot status.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(await agentDoctor.getAgentDoctor(cas, entry.path)) }] };
    }
  );

  server.registerResource(
    'project-agent-defaults',
    new ResourceTemplate('klauro://{project_name}/agent-defaults', { list: undefined }),
    { title: 'Agent Defaults', description: 'Install-ready agent-context-ready instructions for coding agents.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(await agentDefaults.getAgentDefaultConfig(cas, entry.path)) }] };
    }
  );

  server.registerResource(
    'project-analysis-freshness',
    new ResourceTemplate('klauro://{project_name}/freshness', { list: undefined }),
    { title: 'Analysis Freshness', description: 'Stored CAS freshness against source file mtimes and incremental state.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify(await freshness.getAnalysisFreshness(entry.path)) }] };
    }
  );

  server.registerResource(
    'project-test-discovery',
    new ResourceTemplate('klauro://{project_name}/test-discovery', { list: undefined }),
    { title: 'Test Discovery Evidence', description: 'Repo scan proving whether missing CAS tests are true absence or analyzer coverage gaps.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(await testDiscovery.getTestDiscoveryEvidence(entry.path, cas)) }] };
    }
  );

  server.registerResource(
    'project-runtime-sdk',
    new ResourceTemplate('klauro://{project_name}/runtime-sdk', { list: undefined }),
    { title: 'Runtime SDK Package', description: 'Generated TypeScript SDK package for emitting CAS-correlated runtime telemetry.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(runtimeSdk.getRuntimeSdkPackage(cas)) }] };
    }
  );

  server.registerResource(
    'project-integration-depth',
    new ResourceTemplate('klauro://{project_name}/integration-depth', { list: undefined }),
    { title: 'Integration Depth', description: 'Library and platform integration coverage with missing analyzer depth.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(integrationDepth.getIntegrationDepthReport(cas)) }] };
    }
  );

  server.registerResource(
    'project-endpoints',
    new ResourceTemplate('klauro://{project_name}/endpoints', { list: undefined }),
    { title: 'Project Endpoints', description: 'All entry points and route table.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify({ entry_points: query.getEntryPoints(cas), route_table: query.getRouteTable(cas) }) }] };
    }
  );

  server.registerResource(
    'project-schema',
    new ResourceTemplate('klauro://{project_name}/schema', { list: undefined }),
    { title: 'Project Schema', description: 'Database schema and data entities.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify({ database_schema: query.getDatabaseSchema(cas), data_entities: query.getDataEntities(cas) }) }] };
    }
  );

  server.registerResource(
    'project-security',
    new ResourceTemplate('klauro://{project_name}/security', { list: undefined }),
    { title: 'Project Security', description: 'Security boundaries, trust transitions, protection gaps.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return { contents: [{ uri: uri.href, text: JSON.stringify(query.getSecurityOverview(cas)) }] };
    }
  );

  server.registerResource(
    'project-health',
    new ResourceTemplate('klauro://{project_name}/health', { list: undefined }),
    { title: 'Project Health', description: 'Implementation health, documentation coverage, TODO summary, analysis errors.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            implementation_health: query.getImplementationHealth(cas),
            system_health: query.getSystemHealth(cas),
            documentation_coverage: query.getDocumentationCoverage(cas),
            todos: query.getTodos(cas),
            analysis_errors: cas.analysis_errors,
          }),
        }],
      };
    }
  );

  server.registerResource(
    'project-flows',
    new ResourceTemplate('klauro://{project_name}/flows', { list: undefined }),
    { title: 'Project Flows', description: 'Flow summary, workflow graph, flow coverage overview.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            flow_summary: cas.flow_summary,
            workflows: query.getWorkflows(cas),
            flow_coverage: query.getFlowCoverage(cas),
          }),
        }],
      };
    }
  );

  server.registerResource(
    'project-risks',
    new ResourceTemplate('klauro://{project_name}/risks', { list: undefined }),
    { title: 'Project Risks', description: 'Change risk summary, stability summary, test gaps.', mimeType: 'application/json' } as any,
    async (uri, params) => {
      const analyses = await listAnalyses();
      const entry = analyses.find(a => slugify(a.name) === params.project_name);
      if (!entry) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Analysis not found' }) }] };
      const cas = await getAnalysis(entry.path);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            change_risk_summary: cas.change_risk_summary,
            stability_summary: cas.stability_summary,
            test_gaps: cas.test_gaps,
          }),
        }],
      };
    }
  );
}

function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'agent_coding_session',
    {
      title: 'Agent Coding Session',
      description: 'Default prompt for Codex, Claude, Cursor, and other agents. Resolves the best analysis, then loads CAS readiness, start context, and task-specific MCP tool plan before source-file exploration.',
      argsSchema: {
        path: z.string().describe('Project path'),
        task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional().describe('Task type'),
        target: z.string().optional().describe('Task target, such as a feature, node, file, route, error, or subsystem'),
        instructions: z.string().optional().describe('Exact user instructions to preserve in the agent context'),
        success_criteria: z.array(z.string()).optional().describe('Success criteria for the task'),
      } as any,
    } as any,
    async ({ path, task_type, target, instructions, success_criteria }: any) => {
      const task = { task_type: task_type || 'orient', target, instructions, success_criteria };
      const resolution = await agentProjectMap.resolveAgentAnalysis({ path, task });
      const selectedPath = resolution.selected_path || path;
      const cas = await getAnalysis(selectedPath);
      const bootstrap = await agentBootstrap.getAgentBootstrap(cas, selectedPath, task);
      const prefix = resolution.selected_path && resolution.selected_path !== path
        ? `# Analysis Resolution\nRequested path: ${path}\nSelected path: ${resolution.selected_path}\nRecommendation: ${resolution.recommendation}\n\n`
        : '';

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: `${prefix}${bootstrap.prompt}` } as any,
        }],
      };
    }
  );

  server.registerPrompt(
    'architectural_context',
    {
      title: 'Architectural Context',
      description: 'Generates comprehensive architectural context for a codebase. Inject at the start of a coding session for full awareness.',
      argsSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => {
      const cas = await getAnalysis(path);
      const summary = query.buildSummary(cas);
      const overview = query.getSystemOverview(cas);
      const routes = query.getRouteTable(cas);
      const schema = query.getDatabaseSchema(cas);
      const security = query.getSecurityOverview(cas);
      const patterns = query.getPatterns(cas);
      const idioms = idiomQuery.getCodebaseIdioms(cas, { limit: 10 });

      const sections: string[] = [];

      sections.push(`# Architectural Context: ${cas.system.name}`);
      sections.push(`System type: ${overview.system_purpose?.primary_type || cas.system.type}`);
      if (overview.enhanced_system_purpose) {
        sections.push(`Domain: ${overview.enhanced_system_purpose.primary_domain}`);
        sections.push(`Description: ${overview.enhanced_system_purpose.inferred_description}`);
        sections.push(`Core concepts: ${overview.enhanced_system_purpose.core_concepts?.join(', ') || ''}`);
      }

      sections.push(`\n## Tech Stack`);
      const techs = cas.system.technologies;
      if (techs?.languages) sections.push(`Languages: ${techs.languages.map(l => l.name).join(', ')}`);
      if (techs?.frameworks) sections.push(`Frameworks: ${techs.frameworks.map(f => f.name).join(', ')}`);
      if (techs?.databases) sections.push(`Databases: ${techs.databases.join(', ')}`);

      if (overview.architecture_summary) {
        sections.push(`\n## Architecture Layers`);
        const layers = overview.architecture_summary.layers;
        if (layers?.presentation) sections.push(`Presentation: ${JSON.stringify(layers.presentation)}`);
        if (layers?.business) sections.push(`Business: ${JSON.stringify(layers.business)}`);
        if (layers?.data) sections.push(`Data: ${JSON.stringify(layers.data)}`);
        if (layers?.infrastructure) sections.push(`Infrastructure: ${JSON.stringify(layers.infrastructure)}`);
      }

      if (overview.system_health) {
        sections.push(`\n## System Health`);
        sections.push(`Status: ${overview.system_health.status}, score: ${overview.system_health.score}`);
        sections.push(`Coherence: ${overview.system_health.coherence?.status || 'unknown'}`);
        for (const area of (overview.system_health.risk_areas || []).slice(0, 5)) {
          sections.push(`  ${area.severity}: ${area.title} - ${area.recommendation}`);
        }
      }

      sections.push(`\n## Scale`);
      sections.push(`Nodes: ${summary.nodes} (${Object.entries(summary.nodes_by_type).map(([k, v]) => `${k}:${v}`).join(', ')})`);
      sections.push(`Edges: ${summary.edges}`);
      sections.push(`Entry points: ${summary.entry_points} (${Object.entries(summary.entry_points_by_type).map(([k, v]) => `${k}:${v}`).join(', ')})`);

      if (routes.total > 0) {
        sections.push(`\n## API Routes (${routes.total} total)`);
        for (const r of routes.routes.slice(0, 30)) {
          sections.push(`  ${r.method.padEnd(7)} ${r.path} -> ${r.controller}.${r.handler}${r.auth ? ' [AUTH]' : ''}`);
        }
        if (routes.total > 30) sections.push(`  ... and ${routes.total - 30} more`);
      }

      if (schema) {
        sections.push(`\n## Database (${schema.orm || 'unknown ORM'})`);
        sections.push(`Entities: ${schema.entities.map(e => e.name).join(', ')}`);
      }

      if (summary.capabilities > 0) {
        const flowGraph = query.getFlowGraph(cas);
        sections.push(`\n## Capabilities (${summary.capabilities} total)`);
        if (flowGraph?.system_insights) {
          sections.push(`Patterns: ${flowGraph.system_insights.detected_patterns?.join(', ') || 'none'}`);
          sections.push(`Primary entry: ${flowGraph.system_insights.primary_entry_type || 'unknown'}`);
          sections.push(`Data flow: ${flowGraph.system_insights.data_flow_type || 'unknown'}`);
        }
        if (summary.top_capabilities.length > 0) {
          sections.push(`\nTop capabilities: ${summary.top_capabilities.join(', ')}`);
        }
      }

      if (security.security_boundaries.length > 0) {
        sections.push(`\n## Security`);
        sections.push(`Boundaries: ${security.security_boundaries.length}`);
        if (security.security_summary) {
          sections.push(`Enforced: ${security.security_summary.assumed_vs_enforced.enforced}, Assumed: ${security.security_summary.assumed_vs_enforced.assumed}, Missing: ${security.security_summary.assumed_vs_enforced.missing}`);
        }
      }

      if (patterns.patterns.length > 0) {
        sections.push(`\n## Patterns`);
        for (const p of patterns.patterns) {
          sections.push(`  ${p.name} (${p.type || 'pattern'}, confidence: ${p.confidence}, instances: ${p.instance_count})`);
        }
      }

      if (idioms.total > 0) {
        sections.push(`\n## Codebase Idioms`);
        for (const idiom of idioms.idioms.slice(0, 10)) {
          sections.push(`  ${idiom.name} (${idiom.category}, confidence: ${idiom.confidence})`);
        }
      }

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: sections.join('\n') } as any,
        }],
      };
    }
  );

  server.registerPrompt(
    'safe_modification_guide',
    {
      title: 'Safe Modification Guide',
      description: 'Generates guidance for safely modifying a specific code element, including callers, test coverage, risk assessment, and related components.',
      argsSchema: {
        path: z.string().describe('Project path'),
        node_id: z.string().describe('Node ID to modify'),
      } as any,
    } as any,
    async ({ path, node_id }: any) => {
      const cas = await getAnalysis(path);
      const node = query.getNode(cas, node_id);
      if (!node) {
        return { messages: [{ role: 'user', content: { type: 'text', text: `Node not found: ${node_id}` } }] };
      }

      const callers = query.getCallers(cas, node_id, 3);
      const risk = query.assessChangeRisk(cas, node_id);
      const tests = query.findTests(cas, { nodeId: node_id });
      const stability = query.getStability(cas, node_id);
      const invariants = query.getBehavioralInvariants(cas, { target: node_id, limit: 8 });
      const idiomContext = idiomQuery.buildIdiomContextForAgent(cas, {
        target: node_id,
        files: node.source?.file ? [node.source.file] : [],
        limit: 8,
      });
      const invariantImpact = invariantValidation.assessBehavioralInvariantImpact(cas, {
        target: node_id,
        files: node.source?.file ? [node.source.file] : [],
        limit: 8,
      });

      const sections: string[] = [];
      sections.push(`# Safe Modification Guide: ${node.name}`);
      sections.push(`Type: ${node.type}, File: ${node.source?.file}:${node.source?.line}`);

      if (risk.risk) {
        sections.push(`\n## Risk Assessment: ${risk.risk.risk_level.toUpperCase()}`);
        sections.push(`Factors: ${risk.risk.risk_factors.map(f => f.factor).join(', ')}`);
        sections.push(`Direct callers: ${risk.risk.downstream_impact.direct_callers.length}`);
        sections.push(`Transitive callers: ${risk.risk.downstream_impact.transitive_callers.length}`);
        sections.push(`Affected entry points: ${risk.risk.downstream_impact.affected_entry_points.length}`);
        if (risk.risk.recommendations) {
          sections.push(`\nRecommendations:`);
          for (const r of risk.risk.recommendations) sections.push(`  - ${r}`);
        }
      }

      sections.push(`\n## Callers (${callers.total} found${callers.truncated ? ', truncated' : ''})`);
      for (const c of callers.callers.slice(0, 20)) {
        sections.push(`  ${'  '.repeat(c.depth - 1)}${c.name} (${c.type}) via ${c.via}`);
      }

      sections.push(`\n## Test Coverage`);
      sections.push(`Test suites covering this node: ${tests.suites.length}`);
      if (tests.suites.length > 0) {
        for (const s of tests.suites) {
          sections.push(`  ${s.name} (${s.test_type}, ${s.tests.length} tests)`);
        }
      } else {
        sections.push(`  WARNING: No tests directly cover this node.`);
      }

      sections.push(`\n## Behavioral Invariants`);
      sections.push(`Relevant invariants: ${invariants.total}`);
      for (const invariant of invariants.invariants.slice(0, 8)) {
        const gaps = invariant.gaps?.length ? `, gaps=${invariant.gaps.length}` : '';
        sections.push(`  [${invariant.confidence}] ${invariant.name} (${invariant.invariant_type}${gaps})`);
      }
      sections.push(`Invariant impact status: ${invariantImpact.status}, impacted=${invariantImpact.impacted_count}`);
      sections.push(`After edits, call validate_behavioral_invariants with path=${JSON.stringify(path)} and target=${JSON.stringify(node_id)} before finalizing.`);

      sections.push(`\n## Codebase Idioms`);
      sections.push(`Relevant idioms: ${idiomContext.selected_idioms.length}`);
      for (const idiom of idiomContext.selected_idioms.slice(0, 8)) {
        sections.push(`  [${idiom.confidence}] ${idiom.name} (${idiom.category})`);
        if (idiom.do?.[0]) sections.push(`    Do: ${idiom.do[0]}`);
        if (idiom.avoid?.[0]) sections.push(`    Avoid: ${idiom.avoid[0]}`);
      }
      sections.push(`After edits, call validate_codebase_idioms with path=${JSON.stringify(path)} and target=${JSON.stringify(node_id)} before finalizing.`);

      if (stability && 'stability_score' in stability) {
        sections.push(`\n## Stability`);
        sections.push(`Score: ${stability.stability_score}, Class: ${stability.stability_class}`);
        sections.push(`Commits (30d): ${stability.churn_metrics.commits_30d}, Authors: ${stability.churn_metrics.unique_authors_30d}`);
      }

      sections.push(`\n## Connected Components`);
      sections.push(`Incoming edges: ${node.incoming_edges.length}`);
      sections.push(`Outgoing edges: ${node.outgoing_edges.length}`);
      sections.push(`Entry points: ${node.entry_points.length}`);
      sections.push(`Exit points: ${node.exit_points.length}`);

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: sections.join('\n') } as any,
        }],
      };
    }
  );

  server.registerPrompt(
    'test_coverage_analysis',
    {
      title: 'Test Coverage Analysis',
      description: 'Generates a test coverage report highlighting gaps, untested critical paths, and recommendations.',
      argsSchema: { path: z.string().describe('Project path') } as any,
    } as any,
    async ({ path }: any) => {
      const cas = await getAnalysis(path);
      const testSummary = query.getTestSummary(cas);
      const flowCoverage = query.getFlowCoverage(cas);
      const health = query.getImplementationHealth(cas);

      const sections: string[] = [];
      sections.push(`# Test Coverage Analysis: ${cas.system.name}`);

      if (testSummary.test_summary) {
        const ts = testSummary.test_summary;
        sections.push(`\n## Overview`);
        sections.push(`Total tests: ${ts.total_tests}`);
        sections.push(`By type: unit=${ts.by_type.unit}, integration=${ts.by_type.integration}, e2e=${ts.by_type.e2e}, acceptance=${ts.by_type.acceptance}`);
        sections.push(`Coverage: ${ts.coverage.overall_percentage ? ts.coverage.overall_percentage + '%' : 'unknown'}`);
        sections.push(`Mocks: ${ts.mocks.total}, Fixtures: ${ts.fixtures.total}`);
      }

      if (testSummary.gap_summary.total > 0) {
        sections.push(`\n## Test Gaps (${testSummary.gap_summary.total})`);
        sections.push(`By severity: ${Object.entries(testSummary.gap_summary.by_severity).map(([k, v]) => `${k}:${v}`).join(', ')}`);

        const critical = testSummary.test_gaps.filter(g => g.severity === 'critical' || g.severity === 'high');
        for (const g of critical.slice(0, 20)) {
          sections.push(`  [${g.severity}] ${g.gap_type}: ${g.recommendation}`);
        }
      }

      const fc = flowCoverage as { total_flows?: number; by_coverage_status?: Record<string, number>; total_test_gaps?: number; test_gaps_by_severity?: Record<string, number> };
      if (fc.total_flows && fc.total_flows > 0) {
        sections.push(`\n## Flow Coverage (${fc.total_flows} flows)`);
        for (const [status, count] of Object.entries(fc.by_coverage_status || {})) {
          sections.push(`  ${status}: ${count}`);
        }
        if (fc.total_test_gaps && fc.total_test_gaps > 0) {
          sections.push(`Test gaps: ${fc.total_test_gaps}`);
          for (const [sev, count] of Object.entries(fc.test_gaps_by_severity || {})) {
            sections.push(`  ${sev}: ${count}`);
          }
        }
      }

      if (health) {
        sections.push(`\n## Implementation Health`);
        sections.push(`Health score: ${health.health_score}`);
        sections.push(`Complete: ${health.complete_implementations}, Partial: ${health.partial_implementations}, Stubs: ${health.stubs}`);
        if (health.risk_areas.length > 0) {
          sections.push(`Risk areas:`);
          for (const r of health.risk_areas.slice(0, 10)) {
            sections.push(`  [${r.risk_level}] ${r.node_name}: ${r.recommendation}`);
          }
        }
      }

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: sections.join('\n') } as any,
        }],
      };
    }
  );
}

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}
