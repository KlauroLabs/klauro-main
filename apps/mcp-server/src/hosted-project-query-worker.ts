import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getAnalysis } from './analyzer';
import { unavailableComprehensionResponse } from './analysis-response-readiness';
import { executeHostedProjectQuery } from './hosted-project-query';
import type { HostedProjectQueryWorkerRequest } from './hosted-project-query-process';

if (!process.send) {
  process.stderr.write('hosted-project-query-worker must be started through child_process.fork.\n');
  process.exit(1);
}

let cachedWorkspace = '';
let cachedCas: CASOutput | undefined;
let work = Promise.resolve();

process.on('message', (request: HostedProjectQueryWorkerRequest) => {
  if (!request || request.type !== 'query') return;
  work = work.then(async () => {
    try {
      if (!cachedCas || cachedWorkspace !== request.workspace) {
        cachedCas = await getAnalysis(request.workspace);
        cachedWorkspace = request.workspace;
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
    } catch (error) {
      process.send!({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
