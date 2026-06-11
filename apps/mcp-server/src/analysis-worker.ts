import {
  analyzeProject,
  analyzeProjectIncremental,
  summarizeFullAnalysis,
  summarizeIncrementalAnalysis,
  type AnalysisRunSummary,
} from './analyzer';
import { AnalysisRunLog } from '../../../packages/analyzer-core/src/analyzer/core/run-log';

interface WorkerAnalyzeRequest {
  type: 'analyze';
  id: number;
  projectPath: string;
  forceFull: boolean;
  env: Record<string, string>;
}

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
    const output = await analyzeProject(request.projectPath);
    return summarizeFullAnalysis(request.projectPath, output);
  }
  const result = await analyzeProjectIncremental(request.projectPath);
  return summarizeIncrementalAnalysis(request.projectPath, result);
}

let jobChain: Promise<unknown> = Promise.resolve();

async function handleRequest(request: WorkerAnalyzeRequest): Promise<void> {
  applyEnvSnapshot(request.env);

  if (process.env.KLAURO_TEST_ANALYSIS_WORKER_CRASH === 'sigkill') {
    // Test hook: emulate an abrupt heap abort after the run-start record exists.
    new AnalysisRunLog(request.projectPath, `analysis_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    process.kill(process.pid, 'SIGKILL');
    return;
  }

  try {
    const summary = await executeAnalysis(request);
    process.send!({ type: 'result', id: request.id, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stackTop = error instanceof Error && error.stack
      ? error.stack.split('\n').slice(0, 5).join('\n')
      : undefined;
    process.send!({ type: 'error', id: request.id, message, stackTop });
  }
}

process.on('message', (message: WorkerAnalyzeRequest) => {
  if (!message || message.type !== 'analyze') return;
  jobChain = jobChain.then(() => handleRequest(message));
});
