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

interface WorkerAnalyzeRequest {
  type: 'analyze';
  id: number;
  projectPath: string;
  forceFull: boolean;
  displayName?: string;
  env: Record<string, string>;
}

// The 'layered' job kind (see analyzer.ts's analyzeProjectLayered) runs the
// ENTIRE progressive pipeline — L0 index, L1-4 deterministic pass, and L5 AI
// enrichment — inside THIS child, so the API/coordinator process only ever
// dispatches and watches; it never holds the large in-memory analysis itself.
// The child persists every phase to storage as it lands (analyzeProjectLayered
// already does this internally) and reports back only small phase-completion
// MESSAGES (see WorkerPhaseMessage below) plus a final summary — never the
// full CASOutput over IPC. The parent reloads from disk (getAnalysis) for
// anything it needs, mirroring the 275e9dc7 pattern for the sync routes.
interface WorkerLayeredRequest {
  type: 'layered';
  id: number;
  projectPath: string;
  displayName?: string;
  env: Record<string, string>;
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

/**
 * Runs analyzeProjectLayered's full progressive pipeline (L0 -> L1-4 -> L5 AI
 * enrichment) IN THIS CHILD, reporting each phase's completion back to the
 * parent as a small message rather than the full CASOutput. Design decision:
 * AI enrichment runs in the SAME child, immediately after the L1-4 save,
 * rather than being handed off — analyzeProjectLayered/analyzeProjectDeferred
 * already manage enrichment as a promise chained off the deterministic pass
 * on one dedicated orchestrator instance (the closure holding the enrichment
 * continuation lives only on that instance, see analyzeProjectDeferred's own
 * comment), so splitting it into a second dispatch would mean either
 * serializing a second worker round-trip for no benefit or re-implementing
 * that orchestrator handoff — and the AI-phase budget (458494ef) and the
 * worker's own heap cap already bound how long/how much memory this tail can
 * consume, so keeping it in-child costs nothing extra. The child is kept
 * alive (jobChain, see below) until enrichment settles or the OUTER watchdog
 * (analyzer.ts's withOuterWorkerWatchdog, one layer up in the parent) gives up
 * waiting on it.
 */
async function executeLayeredAnalysis(request: WorkerLayeredRequest): Promise<LayeredRunSummary> {
  const layered = await analyzeProjectLayered(request.projectPath, request.displayName);

  try {
    await layered.l0;
    sendPhase(request.id, 'l0', 'succeeded');
  } catch (error) {
    // analyzeProjectLayered's own L0 path already swallows the common
    // lock-contention case internally (see its withProjectAnalysisLockIfAvailable
    // .catch) — a rejection here means computeL0Index/buildL0OnlyCas itself
    // threw, which also fails `rest` below (it chains off l0Promise), so no
    // CAS landed at all for this attempt.
    sendPhase(request.id, 'l0', 'failed', errorMessage(error));
  }

  if (process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH === 'sigkill-after-l0') {
    // Test hook: emulate a mid-pipeline OOM/crash AFTER L0 has landed but
    // before L1-4 (`rest`) completes — the scenario that left a hung
    // 'in-progress' record with no terminal state in the real incident.
    process.kill(process.pid, 'SIGKILL');
  }

  let deferred: Awaited<typeof layered.rest>;
  try {
    deferred = await layered.rest;
    sendPhase(request.id, 'rest', 'succeeded');
  } catch (error) {
    sendPhase(request.id, 'rest', 'failed', errorMessage(error));
    throw error; // nothing landed beyond (at best) the L0 stub; fail the whole job
  }

  if (process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH === 'sigkill-after-rest') {
    // Test hook: L1-4 landed, but the child dies before/during L5 enrichment.
    process.kill(process.pid, 'SIGKILL');
  }

  await deferred.enrichment.catch(() => {
    // analyzeProjectDeferred/Layered already mark ai_enrichment='error' and
    // persist it on any enrichment failure (comprehension is AI-only, no
    // deterministic substitute — docs/cas/DETERMINISM-BOUNDARY.md); this catch
    // just prevents that (already-handled) rejection from failing this job.
  });
  const aiEnrichment = deferred.output.ai_enrichment;
  sendPhase(
    request.id,
    'enrichment',
    aiEnrichment === 'error' ? 'failed' : 'succeeded',
    aiEnrichment === 'error' ? deferred.output.ai_enrichment_error : undefined,
  );

  return summarizeLayeredAnalysis(request.projectPath, deferred.output);
}

let jobChain: Promise<unknown> = Promise.resolve();

async function handleRequest(request: WorkerRequest): Promise<void> {
  applyEnvSnapshot(request.env);

  if (process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH === 'sigkill') {
    // Test hook: emulate an abrupt heap abort after the run-start record exists.
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
