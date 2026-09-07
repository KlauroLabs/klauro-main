import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { unavailableComprehensionResponse } from './analysis-response-readiness';
import type { HostedProjectQueryWorkerRequest } from './hosted-project-query-process';
import { getAnalysisFileFingerprint, loadAnalysisProjection, loadAnalysisSections } from './storage';
import { acquirePinnedAnalysis, SCOPED_QUERY_TOOLS, scopedQueryTarget, scopedSmallSections } from './hosted-query-scoped-graph';
import type { CasSectionName } from './cas-sections';
import { attachCasProjection, casProjection } from './cas-projection';
import { loadAnalysisSectionManifest } from './storage';
import type { SubCasNodeIndex } from './deployable-analysis';
import { loadTelemetryObservations } from './telemetry-ingestion';
import { buildNodeRuntimeMetrics } from './product';
import { CasRecordStoreCapacityError } from './cas-record-store';
import { attachAgentRiskSource } from './agent-risk-context';
import { createRankedRiskSource, type AgentRiskSource } from './hosted-query-risk-source';
import { agentContextProjectionGaps, computeAgentContextScope, markNotComputedOnProjection, selectedNodeIdOf, loadAgentContextProjection, loadScopedGraphSection, loadScopedSemanticCollections, loadScopedSourceInputs, planScopedQuery, scopedQueryCapacityOutcome, type AgentContextProjection, type ScopedSourceInputs } from './hosted-query-scoped-graph';

if (!process.send) {
  process.stderr.write('hosted-project-query-worker must be started through child_process.fork.\n');
  process.exit(1);
}

let cachedWorkspace = '';
let cachedFingerprint = '';
let cachedCas: CASOutput | undefined;
let cachedSections = new Set<CasSectionName>();
let cachedSubCasNodes: SubCasNodeIndex | undefined;
let work = Promise.resolve();
const WARM_SECTIONS: readonly CasSectionName[] = [
  'comprehension', 'tests', 'runtime', 'quality', 'supplemental',
];

function debugMemory(phase: string): void {
  if (process.env.KLAURO_DEBUG_QUERY_MEMORY !== '1') return;
  const memory = process.memoryUsage();
  process.stderr.write(`${JSON.stringify({
    event: 'hosted_query_memory', phase,
    rss_mb: Math.round(memory.rss / 1024 / 1024),
    heap_mb: Math.round(memory.heapUsed / 1024 / 1024),
    external_mb: Math.round(memory.external / 1024 / 1024),
  })}\n`);
}

async function loadHostedProjectQueryModule(): Promise<typeof import('./hosted-project-query')> {
  const source = path.join(__dirname, 'hosted-project-query.ts');
  const modulePath = fs.existsSync(source)
    ? source
    : path.join(__dirname, 'hosted-project-query-runtime.cjs');
  const loaded = await import(modulePath) as typeof import('./hosted-project-query') & {
    default?: typeof import('./hosted-project-query');
  };
  return typeof loaded.hostedProjectQuerySections === 'function' ? loaded : loaded.default!;
}

process.send!({ type: 'ready' });

process.on('message', (request: HostedProjectQueryWorkerRequest) => {
  if (!request || !['query', 'warm', 'analysis-status'].includes(request.type)) return;
  work = work.then(async () => {
    const startedAt = Date.now();
    try {
      const fingerprint = await getAnalysisFileFingerprint(request.workspace);
      debugMemory('fingerprint');
      if (!fingerprint) throw new Error(`No analysis found for: ${request.workspace} (storage ${process.env.KLAURO_STORAGE_PATH || 'default'}). Run analyze_codebase first.`);
      if (cachedWorkspace !== request.workspace || cachedFingerprint !== fingerprint) {
        cachedCas = undefined;
        cachedSections = new Set<CasSectionName>();
        cachedSubCasNodes = undefined;
      }
      const queryModule = request.type === 'query'
        ? await loadHostedProjectQueryModule()
        : undefined;
      const requiredSections: CasSectionName[] = request.type === 'query'
        ? [...queryModule!.hostedProjectQuerySections(request.tool, request.args as any)]
        : [...WARM_SECTIONS];
      const scopedEligible = request.type === 'query' && process.env.KLAURO_HOSTED_QUERY_SCOPED !== '0' && SCOPED_QUERY_TOOLS.has(request.tool)
        && Boolean(scopedQueryTarget(request.tool, request.args as Record<string, unknown> | undefined));
      const pinned = scopedEligible ? await acquirePinnedAnalysis(request.workspace) : null;
      const collectionTotals = pinned?.segmented.manifest.collection_totals ?? (await loadAnalysisSectionManifest(request.workspace).catch(() => null))?.collection_totals;
      let scopedCas: CASOutput | undefined;
      let scopedContext: Record<string, unknown> | undefined;
      let scopedCapacityOutcome: Record<string, unknown> | undefined;
      let agentProjection: AgentContextProjection | undefined;
      let agentSmallSections: Record<string, unknown> | undefined;
      let agentPlan: { graph: import('../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph').CompactCASGraph } | undefined;
      let agentSourceInputs: ScopedSourceInputs | { gap: string } | undefined;
      let riskSource: AgentRiskSource | null = null;
      try {
      const scopedPlan = pinned
        ? await planScopedQuery(pinned, request.tool, request.args as Record<string, unknown> | undefined)
        : null;
      if (scopedPlan && pinned) {
        const loadStartedAt = Date.now();
        const smallSections = scopedSmallSections(request.tool, requiredSections);
        const semanticEligible = 'scope' in scopedPlan && (request.tool === 'assess_change_risk' || request.tool === 'find_tests' || request.tool === 'get_coding_context' || request.tool === 'get_agent_context')
          ? await loadScopedSemanticCollections(pinned, scopedPlan.graph, scopedPlan.scope.keepIds)
          : null;
        const semanticSections = semanticEligible && 'method_calls' in semanticEligible.collections
          ? smallSections.filter(section => section !== 'calls')
          : smallSections;
        const loadedSections = await loadAnalysisSections(request.workspace, semanticSections, { pinned: { filePath: pinned.filePath, segmented: pinned.segmented } });
        if (!loadedSections) throw new Error(`Canonical sections are unavailable for: ${request.workspace} (pinned generation could not be read).`);
        if (semanticEligible) Object.assign(loadedSections, semanticEligible.collections);
        if ('scope' in scopedPlan && request.tool === 'get_agent_context') {
          agentProjection = (await loadAgentContextProjection(pinned, scopedPlan.graph, scopedPlan.scope)) ?? undefined;
          if (!agentProjection) throw new Error(`Canonical graph section is unavailable for: ${request.workspace}. Re-run analyze_codebase.`);
          agentSmallSections = loadedSections as Record<string, unknown>;
          agentPlan = { graph: scopedPlan.graph };
          const projection = agentProjection;
          agentSourceInputs = await loadScopedSourceInputs(pinned, scopedPlan.graph, projection.nodes.filter(node => projection.keepIds.has(node.id))) ?? undefined;
        }
        let loaderCapacityFailure: string | undefined;
        const graphSection = 'scope' in scopedPlan
          ? (agentProjection
              ? { nodes: agentProjection.nodes, edges: agentProjection.edges, scanned: { nodes: scopedPlan.graphNodeCount, edges: agentProjection.edges.length }, edgesTruncated: agentProjection.fullEdgesTruncated, source: agentProjection.source, stats: agentProjection.stats }
              : await loadScopedGraphSection(pinned, scopedPlan.scope.keepIds, scopedPlan.graph).catch(error => {
                  if (error instanceof CasRecordStoreCapacityError) { loaderCapacityFailure = error.message; return { nodes: [], edges: [], scanned: { nodes: scopedPlan.graphNodeCount, edges: 0 }, edgesTruncated: true, source: 'record-store' as const }; }
                  throw error;
                }))
          : null;
        if ('scope' in scopedPlan) {
          if (!graphSection) throw new Error(`Canonical graph section is unavailable for: ${request.workspace}. Re-run analyze_codebase.`);
          if (!loaderCapacityFailure && graphSection.scanned.nodes !== scopedPlan.graphNodeCount) {
            throw new Error(`Graph section and compact index of generation ${path.basename(pinned.segmented.directory)} disagree (${graphSection.scanned.nodes} vs ${scopedPlan.graphNodeCount} nodes).`);
          }
        }
        if ('scope' in scopedPlan) scopedCapacityOutcome = scopedQueryCapacityOutcome(request.tool, loaderCapacityFailure ? { ...scopedPlan.scope, incomplete: loaderCapacityFailure } : scopedPlan.scope, Boolean(graphSection?.edgesTruncated));
        if (loaderCapacityFailure && !scopedCapacityOutcome) throw new Error(`Scoped graph load exceeded the bounded worker budget: ${loaderCapacityFailure}`);
        const totalNodes = 'scope' in scopedPlan ? scopedPlan.graphNodeCount : graphSection?.scanned.nodes;
        const totalEdges = graphSection?.scanned.edges;
        scopedCas = attachCasProjection({
          analyzer_contributions: [],
          ...(agentSourceInputs && 'cas' in agentSourceInputs ? agentSourceInputs.cas : {}),
          ...loadedSections,
          nodes: graphSection?.nodes ?? [],
          edges: graphSection?.edges ?? [],
          index: undefined,
        } as CASOutput, {
          loaded_sections: ['identity', ...semanticSections, 'graph'],
          node_count: totalNodes,
          edge_count: totalEdges,
          ...(collectionTotals ? { collection_totals: collectionTotals } : {}),
          ...(semanticEligible ? { projected_collections: semanticEligible.projected } : {}),
        });
        if (agentProjection && agentPlan) {
          riskSource = await createRankedRiskSource(pinned, agentPlan.graph);
          if (riskSource) attachAgentRiskSource(scopedCas, riskSource);
        }
        scopedContext = 'scope' in scopedPlan
          ? {
              mode: 'scoped',
              generation: path.basename(pinned.segmented.directory),
              source: graphSection?.source,
              target_id: scopedPlan.scope.targetId,
              ...(agentProjection ? { risk_source: riskSource ? 'ranked-column' : null } : {}),
              loaded_nodes: graphSection?.nodes.length ?? 0,
              loaded_edges: graphSection?.edges.length ?? 0,
              total_nodes: totalNodes,
              total_edges: totalEdges,
              callers_total: scopedPlan.scope.callerCount,
              callees_total: scopedPlan.scope.calleeCount,
              ...('upstreamNodes' in scopedPlan.scope ? { upstream_nodes: (scopedPlan.scope as unknown as { upstreamNodes: number }).upstreamNodes, upstream_truncated: (scopedPlan.scope as unknown as { upstreamTruncated: boolean }).upstreamTruncated } : {}),
              truncated: scopedPlan.scope.truncated || Boolean(graphSection?.edgesTruncated),
              edges_truncated: Boolean(graphSection?.edgesTruncated),
              ...(scopedPlan.scope.incomplete ? { incomplete: scopedPlan.scope.incomplete } : {}),
              ...(semanticEligible ? { projected_collections: semanticEligible.projected, semantic_source: 'semantic-store', read_budget: { graph: (graphSection as { stats?: unknown } | null)?.stats ?? null, semantic: semanticEligible.stats, note: 'graph and semantic stores each hold one ledger and one cache; retained payload bound per store = decoded records + largest block + cache limit + index residency' } } : {}),
              ...(agentProjection ? { mode: 'agent-context', full_nodes: agentProjection.keepIds.size, light_nodes: agentProjection.lightNodes, light_edges: agentProjection.lightEdges, full_edges_truncated: agentProjection.fullEdgesTruncated, edge_order: agentProjection.edgeOrder, target_resolution: 'compact-index', passes: 1 } : {}),
              ...(agentSourceInputs ? { source_inputs: 'cas' in agentSourceInputs ? { source: 'semantic-store', ...agentSourceInputs.projected } : { not_computed: agentSourceInputs.gap } } : {}),
            }
          : { mode: 'scoped', target_not_found: scopedPlan.targetNotFound, loaded_nodes: 0, loaded_edges: 0 };
        process.stderr.write(`${JSON.stringify({
          event: 'hosted_query_scoped_graph',
          tool: request.tool,
          duration_ms: Date.now() - loadStartedAt,
          ...scopedContext,
          rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        })}\n`);
      }
      const sameProfile = cachedSections.size === requiredSections.length
        && requiredSections.every(section => cachedSections.has(section))
        && (request.type !== 'analysis-status' || Boolean(cachedSubCasNodes));
      if (!scopedCas && (!cachedCas || !sameProfile)) {
        cachedCas = undefined;
        cachedSections = new Set<CasSectionName>();
        const loadStartedAt = Date.now();
        const loaded = await loadAnalysisProjection(request.workspace, requiredSections, {
          require_sub_cas_index: request.type === 'analysis-status',
        });
        debugMemory('sections');
        if (!loaded) throw new Error(`Analysis projection is unavailable for: ${request.workspace}. Run analyze_codebase first.`);
        const persistedSubCasNodes = loaded.manifest.tree_projection?.format === 'recursive-cas-section-references'
          ? loaded.manifest.tree_projection.sub_cas_nodes
          : undefined;
        if (persistedSubCasNodes) cachedSubCasNodes = persistedSubCasNodes;
        const loadedSections = request.type === 'analysis-status' && !persistedSubCasNodes
          ? [...requiredSections, 'graph'] as CasSectionName[]
          : requiredSections;
        cachedCas = attachCasProjection({
          nodes: [],
          edges: [],
          analyzer_contributions: [],
          ...loaded.cas,
        } as CASOutput, {
          loaded_sections: ['identity', ...loadedSections],
          ...(collectionTotals ? { collection_totals: collectionTotals } : {}),
          node_count: loaded.inventory?.node_count,
          edge_count: loaded.inventory?.edge_count,
        });
        cachedSections = new Set(loadedSections);
        cachedWorkspace = request.workspace;
        cachedFingerprint = fingerprint;
        process.stderr.write(`${JSON.stringify({
          event: 'hosted_query_cas_loaded',
          duration_ms: Date.now() - loadStartedAt,
          sections: loadedSections,
          compact_search: false,
          worker_uptime_ms: Math.round(process.uptime() * 1000),
          rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        })}\n`);
      }
      let activeCas = scopedCas || cachedCas;
      if (!activeCas) throw new Error(`No analysis found for: ${request.workspace}. Run analyze_codebase first.`);
      if (request.type === 'warm') {
        process.send!({ type: 'result', id: request.id, analysisTimestamp: activeCas.analysis_timestamp });
        return;
      }
      if (request.type === 'analysis-status') {
        const { buildHostedProjectAnalysisStatus } = await import('./hosted-project-analysis-status.js');
        const statusSubCasNodes = cachedSubCasNodes || (
          await import('./deployable-analysis.js')
        ).buildDeployableAnalyses(activeCas).sub_cas_nodes;
        const analysisStatus = buildHostedProjectAnalysisStatus(
          activeCas,
          request.projectId,
          request.analysisId,
          statusSubCasNodes,
        );
        cachedSubCasNodes = statusSubCasNodes;
        cachedCas = attachCasProjection({
          ...activeCas,
          nodes: [],
          edges: [],
          index: undefined,
        } as CASOutput, {
          loaded_sections: ['identity', ...WARM_SECTIONS],
          ...(collectionTotals ? { collection_totals: collectionTotals } : {}),
          node_count: loadedInventory(activeCas, 'node_count'),
          edge_count: loadedInventory(activeCas, 'edge_count'),
        });
        cachedSections = new Set(WARM_SECTIONS);
        if (Date.now() - startedAt >= 1_000) {
          process.stderr.write(`${JSON.stringify({ event: 'hosted_query_warm_slow', duration_ms: Date.now() - startedAt })}\n`);
        }
        process.send!({
          type: 'result',
          id: request.id,
          analysisTimestamp: activeCas.analysis_timestamp,
          analysisStatus,
        });
        return;
      }
      const unavailable = unavailableComprehensionResponse(activeCas, {
        project_id: request.projectId,
        analysis_id: request.analysisId,
        analysis_timestamp: activeCas.analysis_timestamp,
        tool: request.tool,
      }, request.tool);
      debugMemory('readiness');
      const needsRuntimeMetrics = request.tool === 'get_runtime_static_links' || request.tool === 'get_flow_graph';
      const runtimeSet = !unavailable && needsRuntimeMetrics
        ? await loadTelemetryObservations(request.workspace, { source: 'ingested', limit: 5000 }) : null;
      const runtimeMetrics = runtimeSet ? buildNodeRuntimeMetrics(activeCas, runtimeSet.observations || []) : [];
      const dumpPath = typeof request.diagnostics?.unbounded_dump_path === 'string' && request.diagnostics.unbounded_dump_path.trim() ? request.diagnostics.unbounded_dump_path.trim() : undefined;
      const observeUnbounded = dumpPath
        ? (tool: string, value: unknown): void => {
            const target = `${dumpPath}.${tool}.${process.pid}.json`;
            fs.writeFileSync(target, JSON.stringify(value ?? null), { mode: 0o600, flag: 'w' });
          }
        : undefined;
      let notComputedOnProjection: string[] = [];
      let unboundedSelectedId: string | undefined;
      const transformUnbounded = agentProjection
        ? (_tool: string, value: unknown): unknown => { unboundedSelectedId = selectedNodeIdOf(value); notComputedOnProjection = markNotComputedOnProjection(value); return value; }
        : undefined;
      let result = unavailable
        ? undefined
        : scopedCapacityOutcome ?? await queryModule!.executeHostedProjectQuery({
            cas: activeCas,
            tool: request.tool,
            args: request.args,
            projectPath: request.workspace,
            runtimeMetrics,
            deferBound: true,
            ...(observeUnbounded ? { observeUnbounded } : {}),
            ...(transformUnbounded ? { transformUnbounded } : {}),
          });
      const selectedId = agentProjection ? (unboundedSelectedId ?? selectedNodeIdOf(result)) : undefined;
      if (agentProjection && agentPlan && pinned && typeof selectedId === 'string' && !agentProjection.keepIds.has(selectedId)) {
        const task = ((request.args as { task?: { related_paths?: string[] } } | undefined)?.task) ?? {};
        const secondScope = computeAgentContextScope(agentPlan.graph, [selectedId], (task.related_paths ?? []).filter((file): file is string => typeof file === 'string'));
        const secondProjection = await loadAgentContextProjection(pinned, agentPlan.graph, secondScope);
        if (secondProjection) {
          agentProjection = secondProjection;
          agentSourceInputs = await loadScopedSourceInputs(pinned, agentPlan.graph, secondProjection.nodes.filter(node => secondProjection.keepIds.has(node.id))) ?? undefined;
          activeCas = attachCasProjection({
            analyzer_contributions: [],
            ...(agentSourceInputs && 'cas' in agentSourceInputs ? agentSourceInputs.cas : {}),
            ...(agentSmallSections ?? {}),
            nodes: secondProjection.nodes,
            edges: secondProjection.edges,
            index: undefined,
          } as unknown as CASOutput, { loaded_sections: ['identity', ...Object.keys(agentSmallSections ?? {}), 'graph'] as CasSectionName[], node_count: agentPlan.graph.nodeCount, edge_count: secondProjection.edges.length, ...(collectionTotals ? { collection_totals: collectionTotals } : {}) });
          if (riskSource) attachAgentRiskSource(activeCas, riskSource);
          result = await queryModule!.executeHostedProjectQuery({ cas: activeCas, tool: request.tool, args: request.args, projectPath: request.workspace, runtimeMetrics, deferBound: true, ...(observeUnbounded ? { observeUnbounded } : {}), ...(transformUnbounded ? { transformUnbounded } : {}) });
          if (scopedContext) Object.assign(scopedContext, { passes: 2, second_pass_target: selectedId, full_nodes: secondProjection.keepIds.size, light_nodes: secondProjection.lightNodes, light_edges: secondProjection.lightEdges, source: secondProjection.source, ...(secondScope.incomplete ? { incomplete: secondScope.incomplete } : {}), ...(agentSourceInputs ? { source_inputs: 'cas' in agentSourceInputs ? { source: 'semantic-store', ...agentSourceInputs.projected } : { not_computed: agentSourceInputs.gap } } : {}) });
        }
      }
      debugMemory('result');
      if (scopedContext && result && typeof result === 'object' && !Array.isArray(result)) {
        (result as Record<string, unknown>).scoped_context = scopedContext;
        if (agentProjection) {
          const notComputed = notComputedOnProjection.length > 0 ? notComputedOnProjection : markNotComputedOnProjection(result);
          (result as Record<string, unknown>).projection_gaps = agentContextProjectionGaps(agentProjection, notComputed);
          (scopedContext as Record<string, unknown>).read_budget = { graph: agentProjection.stats ?? null, cache_limit_bytes_per_store: agentProjection.stats?.cacheLimitBytes ?? null, note: 'graph and semantic stores each hold one ledger and one cache; retained payload bound = decoded records + largest block + cache limit + index residency per store' };
        }
      }
      if (!unavailable && !scopedCapacityOutcome && result !== undefined) {
        result = queryModule!.boundHostedProjectQueryResult(request.tool as Parameters<NonNullable<typeof queryModule>['boundHostedProjectQueryResult']>[0], (request.args as Record<string, unknown> | undefined) ?? {}, result);
      }
      process.send!({
        type: 'result',
        id: request.id,
        analysisTimestamp: activeCas.analysis_timestamp,
        unavailable,
        result,
      });
      if (Date.now() - startedAt >= 1_000) {
        process.stderr.write(`${JSON.stringify({ event: 'hosted_query_slow', tool: request.tool, duration_ms: Date.now() - startedAt })}\n`);
      }
      } finally {
        if (pinned) await pinned.release().catch(() => undefined);
      }
    } catch (error) {
      process.send!({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});

function loadedInventory(cas: CASOutput, field: 'node_count' | 'edge_count'): number | undefined {
  const projection = casProjection(cas);
  return projection?.[field];
}
