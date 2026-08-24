import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { unavailableComprehensionResponse } from './analysis-response-readiness';
import type { HostedProjectQueryWorkerRequest } from './hosted-project-query-process';
import { getAnalysisFileFingerprint, loadAnalysisProjection } from './storage';
import type { CasSectionName } from './cas-sections';
import { attachCasProjection, casProjection } from './cas-projection';
import type { SubCasNodeIndex } from './deployable-analysis';

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
      if (!fingerprint) throw new Error(`No analysis found for: ${request.workspace}. Run analyze_codebase first.`);
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
      const sameProfile = cachedSections.size === requiredSections.length
        && requiredSections.every(section => cachedSections.has(section))
        && (request.type !== 'analysis-status' || Boolean(cachedSubCasNodes));
      if (!cachedCas || !sameProfile) {
        cachedCas = undefined;
        cachedSections = new Set<CasSectionName>();
        const loadStartedAt = Date.now();
        const loaded = await loadAnalysisProjection(request.workspace, requiredSections, {
          require_sub_cas_index: request.type === 'analysis-status',
        });
        debugMemory('sections');
        if (!loaded) throw new Error(`No analysis found for: ${request.workspace}. Run analyze_codebase first.`);
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
      const activeCas = cachedCas;
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
      const result = unavailable
        ? undefined
        : await queryModule!.executeHostedProjectQuery({
            cas: activeCas,
            tool: request.tool,
            args: request.args,
            projectPath: request.workspace,
          });
      debugMemory('result');
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
    } catch (error) {
      process.send!({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});

function loadedInventory(cas: CASOutput, field: 'node_count' | 'edge_count'): number | undefined {
  const projection = casProjection(cas);
  return projection?.[field];
}
