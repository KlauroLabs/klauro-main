import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAnalysisHeapMb } from './analysis-heap';
import { registerHostedBackgroundPreflight, withHostedForegroundPermit } from './hosted-background-queue';

export interface HostedProjectQueryWorkerRequest {
  type: 'query' | 'warm' | 'analysis-status';
  id: number;
  workspace: string;
  tool: string;
  args?: unknown;
  projectId: string;
  analysisId: string;
}

interface HostedProjectQueryWorkerResponse {
  type: 'ready' | 'result' | 'error';
  id?: number;
  analysisTimestamp?: string;
  unavailable?: unknown;
  result?: unknown;
  analysisStatus?: Record<string, unknown>;
  error?: string;
}

export interface HostedProjectQueryResult {
  analysisTimestamp: string;
  unavailable?: unknown;
  result?: unknown;
  analysisStatus?: Record<string, unknown>;
}

interface PendingQuery {
  resolve: (value: HostedProjectQueryResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_QUERY_HEAP_MB = 3072;
const DEFAULT_IDLE_MS = 300_000;
let child: ChildProcess | undefined;
let nextRequestId = 1;
let idleTimer: NodeJS.Timeout | undefined;
const pending = new Map<number, PendingQuery>();
const warmedVersions = new Map<string, string>();
const warmingVersions = new Map<string, { version: string; promise: Promise<void> }>();
const idleWaiters = new Set<() => void>();

export function resolveHostedQueryHeapMb(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.KLAURO_HOSTED_QUERY_HEAP_MB);
  if (Number.isFinite(configured) && configured >= 512) return Math.floor(configured);
  return Math.min(resolveAnalysisHeapMb(env).heapMb, DEFAULT_QUERY_HEAP_MB);
}

function resolveWorkerEntryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KLAURO_HOSTED_QUERY_WORKER_ENTRY?.trim();
  if (override) return path.resolve(override);
  const candidates = [
    path.join(__dirname, 'hosted-project-query-worker.cjs'),
    path.join(__dirname, '..', 'dist-hosted', 'hosted-project-query-worker.cjs'),
    path.join(__dirname, 'hosted-project-query-worker.ts'),
  ];
  for (const candidatePath of candidates) {
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
  warmedVersions.clear();
  warmingVersions.clear();
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
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
    if (!message) return;
    if (message.type === 'ready') {
      if (pending.size === 0) scheduleIdleStop();
      return;
    }
    if (message.type !== 'result' && message.type !== 'error') return;
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === 'error') request.reject(new Error(message.error || 'Hosted query worker failed.'));
    else request.resolve({
      analysisTimestamp: message.analysisTimestamp || '',
      unavailable: message.unavailable,
      result: message.result,
      analysisStatus: message.analysisStatus,
    });
    if (pending.size === 0) scheduleIdleStop();
  });
  spawned.once('error', error => stopWorker(error.message));
  spawned.once('exit', (code, signal) => {
    if (child === spawned) stopWorker(`Hosted query worker ${signal ? `was killed by ${signal}` : `exited with code ${code}`}.`);
  });
  return spawned;
}

export function prewarmHostedProjectQueryWorker(): void {
  const alreadyRunning = Boolean(child?.connected);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  getWorker();
  if (alreadyRunning && pending.size === 0) scheduleIdleStop();
}

registerHostedBackgroundPreflight(() => {
  if (!child) return;
  if (pending.size === 0) scheduleIdleStop();
  return new Promise<void>(resolve => idleWaiters.add(resolve));
});

export async function runHostedProjectQueryWorker(
  request: Omit<HostedProjectQueryWorkerRequest, 'type' | 'id'>,
): Promise<HostedProjectQueryResult> {
  return withHostedForegroundPermit(() => dispatchWorkerRequest({ type: 'query', ...request }));
}

function dispatchWorkerRequest(
  request: Omit<HostedProjectQueryWorkerRequest, 'id'>,
): Promise<HostedProjectQueryResult> {
  return new Promise((resolve, reject) => {
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
    worker.send({ id, ...request } satisfies HostedProjectQueryWorkerRequest, error => {
      if (!error) return;
      pending.delete(id);
      reject(new Error(`Failed to dispatch hosted query: ${error.message}`));
    });
  });
}

export async function warmHostedProjectAnalysisWorker(input: {
  workspace: string;
  projectId: string;
  analysisId: string;
}): Promise<Record<string, unknown>> {
  const response = await withHostedForegroundPermit(() => dispatchWorkerRequest({
    type: 'analysis-status',
    tool: '',
    args: undefined,
    ...input,
  }));
  if (!response.analysisStatus) throw new Error('Hosted query worker returned no analysis status.');
  return response.analysisStatus;
}

export async function warmHostedProjectQueryWorker(input: {
  workspace: string;
  projectId: string;
  analysisId: string;
}): Promise<void> {
  await withHostedForegroundPermit(() => dispatchWorkerRequest({
    type: 'warm',
    tool: '',
    args: undefined,
    ...input,
  }));
}

export function beginHostedProjectQueryWarm(input: {
  workspace: string;
  projectId: string;
  analysisId: string;
  version: string;
}): boolean {
  if (warmedVersions.get(input.workspace) === input.version) {
    scheduleIdleStop();
    return true;
  }
  if (warmingVersions.get(input.workspace)?.version === input.version) return false;
  const promise = warmHostedProjectQueryWorker(input).then(() => {
    warmedVersions.set(input.workspace, input.version);
  }).catch(error => {
    process.stderr.write(`[Klauro] hosted query warm failed for ${input.analysisId}: ${error instanceof Error ? error.message : String(error)}\n`);
  }).finally(() => {
    if (warmingVersions.get(input.workspace)?.promise === promise) warmingVersions.delete(input.workspace);
  });
  warmingVersions.set(input.workspace, { version: input.version, promise });
  return false;
}
