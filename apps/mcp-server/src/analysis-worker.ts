import {
  analyzeProject,
  analyzeProjectIncremental,
  analyzeProjectLayered,
  summarizeFullAnalysis,
  summarizeIncrementalAnalysis,
  summarizeLayeredAnalysis,
  type AnalysisRunSummary,
  type LayeredJobPhaseEvent,
  type LayeredRunSummary,
} from './analyzer';
import { AnalysisRunLog } from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { applyAnalysisFocus, type AnalysisFocus } from './analysis-focus';
import { saveAnalysis } from './storage';
import type { RepoFacts } from './remote-source';
import { applyLayeredAnalysisMetadata } from './layered-analysis-metadata';

interface WorkerAnalyzeRequest {
  type: 'analyze';
  id: number;
  projectPath: string;
  forceFull: boolean;
  displayName?: string;
  env: Record<string, string>;
}










interface WorkerLayeredRequest {
  type: 'layered';
  id: number;
  projectPath: string;
  displayName?: string;
  env: Record<string, string>;
  analysisFocus?: AnalysisFocus;
  repoFacts?: RepoFacts;
  repoFactsUnavailable?: boolean;

  forceFullRebuild?: boolean;
}

type WorkerRequest = WorkerAnalyzeRequest | WorkerLayeredRequest;

if (!process.send) {
  process.stderr.write('analysis-worker must be started via child_process.fork from the Klauro MCP server.\n');
  process.exit(1);
}

process.on('disconnect', () => process.exit(0));

function applyEnvSnapshot(snapshot: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KLAURO_') && !(key in snapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

async function executeAnalysis(request: WorkerAnalyzeRequest): Promise<AnalysisRunSummary> {
  if (request.forceFull) {
    const output = await analyzeProject(request.projectPath, request.displayName);
    return summarizeFullAnalysis(request.projectPath, output);
  }
  const result = await analyzeProjectIncremental(request.projectPath, request.displayName);
  return summarizeIncrementalAnalysis(request.projectPath, result);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendPhase(id: number, phase: LayeredJobPhaseEvent['phase'], status: LayeredJobPhaseEvent['status'], error?: string): void {
  process.send!({ type: 'phase', id, phase, status, error });
}

function sendProgress(id: number, event: { sequence: number; phase: string; completedAt: string }): void {
  process.send!({ type: 'progress', id, ...event });
}


















async function executeLayeredAnalysis(request: WorkerLayeredRequest): Promise<LayeredRunSummary> {
  if (process.env.KLAURO_TEST_ANALYSIS_WORKER_STALL === 'before-start') {
    await new Promise<void>(() => undefined);
  }









  const workerStartedAt = Date.now();
  let l0DoneAt = workerStartedAt;
  let restDoneAt = workerStartedAt;
  const layered = await analyzeProjectLayered(
    request.projectPath,
    request.displayName,
    event => sendProgress(request.id, event),
    request.forceFullRebuild,
  );

  try {
    await layered.l0;
    l0DoneAt = Date.now();
    sendPhase(request.id, 'l0', 'succeeded');
  } catch (error) {





    sendPhase(request.id, 'l0', 'failed', errorMessage(error));
  }

  if (process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH === 'sigkill-after-l0') {



    process.kill(process.pid, 'SIGKILL');
  }

  let deferred: Awaited<typeof layered.rest>;
  try {
    deferred = await layered.rest;
    applyLayeredAnalysisMetadata(deferred.output, request);
    restDoneAt = Date.now();
    sendPhase(request.id, 'rest', 'succeeded');
  } catch (error) {
    sendPhase(request.id, 'rest', 'failed', errorMessage(error));
    throw error;
  }

  if (process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH === 'sigkill-after-rest') {

    process.kill(process.pid, 'SIGKILL');
  }

  const enrichmentPersistsOutput = deferred.output.ai_enrichment === 'pending';
  await deferred.enrichment.catch(() => {




  });
  if ((request.repoFacts || request.repoFactsUnavailable) && !enrichmentPersistsOutput) {
    await saveAnalysis(request.projectPath, deferred.output, 'main', { deferSegmentedWrite: true });
  }
  const aiEnrichment = deferred.output.ai_enrichment;
  sendPhase(
    request.id,
    'enrichment',
    aiEnrichment === 'error' ? 'failed' : 'succeeded',
    aiEnrichment === 'error' ? deferred.output.ai_enrichment_error : undefined,
  );

  const enrichmentDoneAt = Date.now();
  console.error(
    `[Klauro] worker segments: l0=${l0DoneAt - workerStartedAt}ms ` +
    `rest=${restDoneAt - l0DoneAt}ms enrichment=${enrichmentDoneAt - restDoneAt}ms ` +
    `total=${enrichmentDoneAt - workerStartedAt}ms`,
  );
  return summarizeLayeredAnalysis(request.projectPath, deferred.output);
}

let jobChain: Promise<unknown> = Promise.resolve();

async function handleRequest(request: WorkerRequest): Promise<void> {
  applyEnvSnapshot(request.env);
  if (request.type === 'layered') applyAnalysisFocus(request.analysisFocus);

  if (process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH === 'sigkill') {

    new AnalysisRunLog(request.projectPath, `analysis_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    process.kill(process.pid, 'SIGKILL');
    return;
  }

  try {
    if (request.type === 'layered') {
      const summary = await executeLayeredAnalysis(request);
      process.send!({ type: 'result', id: request.id, summary });
      return;
    }
    const summary = await executeAnalysis(request);
    process.send!({ type: 'result', id: request.id, summary });
  } catch (error) {
    const message = errorMessage(error);
    const stackTop = error instanceof Error && error.stack
      ? error.stack.split('\n').slice(0, 5).join('\n')
      : undefined;
    process.send!({ type: 'error', id: request.id, message, stackTop });
  }
}

process.on('message', (message: WorkerRequest) => {
  if (!message || (message.type !== 'analyze' && message.type !== 'layered')) return;
  jobChain = jobChain.then(() => handleRequest(message));
});
