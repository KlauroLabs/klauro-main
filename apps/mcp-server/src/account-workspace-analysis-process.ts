import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { resolveAnalysisHeapMb } from './analysis-heap';
import { withHostedBackgroundPermit } from './hosted-background-queue';

interface WorkspaceAnalysisWorkerResponse {
  type: 'result' | 'error';
  error?: string;
}

export interface WorkspaceAnalysisWorkerRequest {
  type: 'rebuild';
  dataDir: string;
  workspaceId: string;
  force: boolean;
  env: Record<string, string>;
}

const DEFAULT_WORKSPACE_ANALYSIS_HEAP_MB = 1536;

export function resolveWorkspaceAnalysisHeapMb(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.KLAURO_WORKSPACE_ANALYSIS_HEAP_MB);
  if (Number.isFinite(configured) && configured >= 256) return Math.floor(configured);
  return Math.min(resolveAnalysisHeapMb(env).heapMb, DEFAULT_WORKSPACE_ANALYSIS_HEAP_MB);
}

function resolveWorkerEntryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KLAURO_WORKSPACE_ANALYSIS_WORKER_ENTRY?.trim();
  if (override) return path.resolve(override);
  for (const candidate of ['account-workspace-analysis-worker.cjs', 'account-workspace-analysis-worker.ts']) {
    const candidatePath = path.join(__dirname, candidate);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }
  throw new Error(`Workspace analysis worker entry not found next to ${__dirname}; rebuild the hosted bundle.`);
}

function workerExecArgv(execArgv: readonly string[]): string[] {
  const safe: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (['-e', '--eval', '-p', '--print'].includes(argument)) {
      index += 1;
      continue;
    }
    if (
      argument.startsWith('--eval=')
      || argument.startsWith('--print=')
      || argument.startsWith('--max-old-space-size=')
      || argument.startsWith('--max_old_space_size=')
    ) continue;
    safe.push(argument);
  }
  return safe;
}

function klauroEnvSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('KLAURO_') && value !== undefined) snapshot[key] = value;
  }
  snapshot.KLAURO_WORKSPACE_ANALYSIS_IN_PROCESS = '1';
  return snapshot;
}

function terminate(child: ChildProcess): void {
  if (child.connected) child.disconnect();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

export async function runAccountWorkspaceAnalysisWorker(
  dataDir: string,
  workspaceId: string,
  force: boolean,
): Promise<void> {
  return withHostedBackgroundPermit(async () => {
    const heapMb = resolveWorkspaceAnalysisHeapMb();
    const child = fork(resolveWorkerEntryPath(), [], {
      execArgv: [...workerExecArgv(process.execArgv), `--max-old-space-size=${heapMb}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    });
    const request: WorkspaceAnalysisWorkerRequest = {
      type: 'rebuild',
      dataDir,
      workspaceId,
      force,
      env: klauroEnvSnapshot(),
    };

    await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      terminate(child);
      if (error) reject(error);
      else resolve();
    };
    child.once('message', (message: WorkspaceAnalysisWorkerResponse) => {
      if (message?.type === 'result') finish();
      else finish(new Error(message?.error || `Workspace analysis worker failed for ${workspaceId}.`));
    });
    child.once('error', error => finish(error));
    child.once('exit', (code, signal) => {
      if (!settled) finish(new Error(
        `Workspace analysis worker for ${workspaceId} ${signal ? `was killed by ${signal}` : `exited with code ${code}`}.`,
      ));
    });
    child.send(request, error => {
      if (error) finish(new Error(`Failed to dispatch workspace analysis for ${workspaceId}: ${error.message}`));
    });
    });
  }, { releaseForegroundMemory: true });
}
