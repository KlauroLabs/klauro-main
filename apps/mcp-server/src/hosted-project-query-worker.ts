import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { unavailableComprehensionResponse } from './analysis-response-readiness';
import { buildHostedProjectAnalysisStatus } from './hosted-project-analysis-status';
import { executeHostedProjectQuery } from './hosted-project-query';
import type { HostedProjectQueryWorkerRequest } from './hosted-project-query-process';
import { getAnalysisFileFingerprint, loadAnalysis } from './storage';

if (!process.send) {
  process.stderr.write('hosted-project-query-worker must be started through child_process.fork.\n');
  process.exit(1);
}

let cachedWorkspace = '';
let cachedFingerprint = '';
let cachedCas: CASOutput | undefined;
let work = Promise.resolve();

process.send!({ type: 'ready' });

process.on('message', (request: HostedProjectQueryWorkerRequest) => {
  if (!request || !['query', 'warm', 'analysis-status'].includes(request.type)) return;
  work = work.then(async () => {
    const startedAt = Date.now();
    try {
      const fingerprint = await getAnalysisFileFingerprint(request.workspace);
      if (!fingerprint) throw new Error(`No analysis found for: ${request.workspace}. Run analyze_codebase first.`);
      if (!cachedCas || cachedWorkspace !== request.workspace || cachedFingerprint !== fingerprint) {
        const loadStartedAt = Date.now();
        const loaded = await loadAnalysis(request.workspace, { preferAuthoritative: true });
        if (!loaded) throw new Error(`No analysis found for: ${request.workspace}. Run analyze_codebase first.`);
        cachedCas = loaded;
        cachedWorkspace = request.workspace;
        cachedFingerprint = fingerprint;
        process.stderr.write(`${JSON.stringify({
          event: 'hosted_query_cas_loaded',
          duration_ms: Date.now() - loadStartedAt,
          worker_uptime_ms: Math.round(process.uptime() * 1000),
          rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        })}\n`);
      }
      if (request.type === 'warm') {
        process.send!({ type: 'result', id: request.id, analysisTimestamp: cachedCas.analysis_timestamp });
        return;
      }
      if (request.type === 'analysis-status') {
        const analysisStatus = buildHostedProjectAnalysisStatus(cachedCas, request.projectId, request.analysisId);
        if (Date.now() - startedAt >= 1_000) {
          process.stderr.write(`${JSON.stringify({ event: 'hosted_query_warm_slow', duration_ms: Date.now() - startedAt })}\n`);
        }
        process.send!({
          type: 'result',
          id: request.id,
          analysisTimestamp: cachedCas.analysis_timestamp,
          analysisStatus,
        });
        return;
      }
      const unavailable = unavailableComprehensionResponse(cachedCas, {
        project_id: request.projectId,
        analysis_id: request.analysisId,
        analysis_timestamp: cachedCas.analysis_timestamp,
        tool: request.tool,
      }, request.tool);
      const result = unavailable ? undefined : await executeHostedProjectQuery({
        cas: cachedCas,
        tool: request.tool,
        args: request.args,
        projectPath: request.workspace,
      });
      process.send!({
        type: 'result',
        id: request.id,
        analysisTimestamp: cachedCas.analysis_timestamp,
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
