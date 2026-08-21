import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAnalysisHeapMb } from './analysis-heap';
import { registerHostedBackgroundPreflight, withHostedForegroundPermit } from './hosted-background-queue';

export interface HostedProjectQueryWorkerRequest {
  type: 'query';
  id: number;
  workspace: string;
  tool: string;
  args?: unknown;
  projectId: string;
  analysisId: string;
}

interface HostedProjectQueryWorkerResponse {
  type: 'result' | 'error';
  id: number;
  analysisTimestamp?: string;
  unavailable?: unknown;
  result?: unknown;
  error?: string;
}

export interface HostedProjectQueryResult {
  analysisTimestamp: string;
  unavailable?: unknown;
  result?: unknown;
}

interface PendingQuery {
  resolve: (value: HostedProjectQueryResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_QUERY_HEAP_MB = 3072;
const DEFAULT_IDLE_MS = 15_000;
let child: ChildProcess | undefined;
let nextRequestId = 1;
let idleTimer: NodeJS.Timeout | undefined;
const pending = new Map<number, PendingQuery>();

export function resolveHostedQueryHeapMb(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.KLAURO_HOSTED_QUERY_HEAP_MB);
  if (Number.isFinite(configured) && configured >= 512) return Math.floor(configured);
  return Math.min(resolveAnalysisHeapMb(env).heapMb, DEFAULT_QUERY_HEAP_MB);
}

function resolveWorkerEntryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KLAURO_HOSTED_QUERY_WORKER_ENTRY?.trim();
  if (override) return path.resolve(override);
  for (const candidate of ['hosted-project-query-worker.cjs', 'hosted-project-query-worker.ts']) {
    const candidatePath = path.join(__dirname, candidate);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }
  throw new Error(`Hosted query worker entry not found next to ${__dirname}; rebuild the hosted bundle.`);
}

function workerExecArgv(execArgv: readonly string[]): string[] {
  const safe: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (['-e', '--eval', '-p', '--print'].includes(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith('--eval=') || argument.startsWith('--print=') || argument.startsWith('--max-old-space-size=') || argument.startsWith('--max_old_space_size=')) continue;
    safe.push(argument);
  }
  return safe;
}

function stopWorker(reason = 'Hosted query worker stopped.'): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const running = child;
  child = undefined;
  if (running?.connected) running.disconnect();
  if (running && running.exitCode === null && running.signalCode === null) running.kill('SIGTERM');
  for (const request of pending.values()) request.reject(new Error(reason));
  pending.clear();
}

function scheduleIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer);
  const configured = Number(process.env.KLAURO_HOSTED_QUERY_IDLE_MS);
  const idleMs = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_IDLE_MS;
  idleTimer = setTimeout(() => {
    if (pending.size === 0) stopWorker();
  }, idleMs);
  idleTimer.unref();
}

function getWorker(): ChildProcess {
  if (child?.connected) return child;
  const spawned = fork(resolveWorkerEntryPath(), [], {
    execArgv: [...workerExecArgv(process.execArgv), `--max-old-space-size=${resolveHostedQueryHeapMb()}`],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: process.env,
  });
  child = spawned;
  spawned.on('message', (message: HostedProjectQueryWorkerResponse) => {
    if (!message || (message.type !== 'result' && message.type !== 'error')) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === 'error') request.reject(new Error(message.error || 'Hosted query worker failed.'));
    else request.resolve({
      analysisTimestamp: message.analysisTimestamp || '',
      unavailable: message.unavailable,
      result: message.result,
    });
    if (pending.size === 0) scheduleIdleStop();
  });
  spawned.once('error', error => stopWorker(error.message));
  spawned.once('exit', (code, signal) => {
    if (child === spawned) stopWorker(`Hosted query worker ${signal ? `was killed by ${signal}` : `exited with code ${code}`}.`);
  });
  return spawned;
}

registerHostedBackgroundPreflight(() => {
  if (pending.size === 0) stopWorker('Hosted query worker yielded to background analysis.');
});

export async function runHostedProjectQueryWorker(
  request: Omit<HostedProjectQueryWorkerRequest, 'type' | 'id'>,
): Promise<HostedProjectQueryResult> {
  return withHostedForegroundPermit(() => new Promise((resolve, reject) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    let worker: ChildProcess;
    try {
      worker = getWorker();
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    worker.send({ type: 'query', id, ...request } satisfies HostedProjectQueryWorkerRequest, error => {
      if (!error) return;
      pending.delete(id);
      reject(new Error(`Failed to dispatch hosted query: ${error.message}`));
    });
  }));
}
