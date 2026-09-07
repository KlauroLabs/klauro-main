import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readAnalysisMemoryCapacity, type AnalysisMemoryCapacity } from './analysis-memory';
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
  type: 'ready' | 'result' | 'error' | 'fallback';
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
  compactFallback?: boolean;
}

interface PendingQuery {
  resolve: (value: HostedProjectQueryResult) => void;
  reject: (error: Error) => void;
}

const DEFAULT_QUERY_HEAP_MB = 3072;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_BACKGROUND_GRACE_MS = 10_000;
let child: ChildProcess | undefined;
let childKind: 'full' | 'search' | undefined;
let nextRequestId = 1;
let idleTimer: NodeJS.Timeout | undefined;
let lastActivityAt = 0;
let dispatchWork: Promise<void> = Promise.resolve();
const pending = new Map<number, PendingQuery>();
const warmedVersions = new Map<string, string>();
const warmingVersions = new Map<string, { version: string; promise: Promise<void> }>();

const QUERY_HEAP_CGROUP_FRACTION = 0.6;

const MIN_QUERY_HEAP_MB = 512;

export class HostedQueryCapacityError extends Error {
  readonly code = 'hosted_query_capacity_unsupported';
}

export function resolveHostedQueryHeapMb(
  env: NodeJS.ProcessEnv = process.env,
  totalMemBytes?: number,
  capacity: AnalysisMemoryCapacity = readAnalysisMemoryCapacity(),
): number {
  const cgroupCapMb = capacity.source === 'cgroup'
    ? Math.floor((capacity.limitBytes / (1024 * 1024)) * QUERY_HEAP_CGROUP_FRACTION)
    : Number.POSITIVE_INFINITY;
  if (cgroupCapMb < MIN_QUERY_HEAP_MB) {
    throw new HostedQueryCapacityError(`Hosted query capacity is unsupported: ${Math.floor(capacity.limitBytes / (1024 * 1024))} MiB container allows a ${cgroupCapMb} MiB query heap under the ${Math.round(QUERY_HEAP_CGROUP_FRACTION * 100)}% cap, below the ${MIN_QUERY_HEAP_MB} MiB minimum.`);
  }
  const configured = Number(env.KLAURO_HOSTED_QUERY_HEAP_MB);
  if (Number.isFinite(configured) && configured >= MIN_QUERY_HEAP_MB) return Math.min(Math.floor(configured), cgroupCapMb);
  const analysisHeap = resolveAnalysisHeapMb(env, totalMemBytes);
  if (env.KLAURO_ANALYSIS_HEAP_MB !== undefined) {
    return Math.min(analysisHeap.heapMb, DEFAULT_QUERY_HEAP_MB, cgroupCapMb);
  }
  return Math.max(MIN_QUERY_HEAP_MB, Math.min(DEFAULT_QUERY_HEAP_MB, Math.floor(analysisHeap.totalRamMb * 0.5), cgroupCapMb));
}

function resolveWorkerEntryPath(kind: 'full' | 'search', env: NodeJS.ProcessEnv = process.env): string {
  const override = (kind === 'search' ? env.KLAURO_HOSTED_SEARCH_WORKER_ENTRY : undefined)?.trim()
    || env.KLAURO_HOSTED_QUERY_WORKER_ENTRY?.trim();
  if (override) return path.resolve(override);
  const candidates = [
    path.join(__dirname, kind === 'search' ? 'hosted-project-search-worker.cjs' : 'hosted-project-query-worker.cjs'),
    path.join(__dirname, '..', 'dist-hosted', kind === 'search' ? 'hosted-project-search-worker.cjs' : 'hosted-project-query-worker.cjs'),
    path.join(__dirname, kind === 'search' ? 'hosted-project-search-worker.ts' : 'hosted-project-query-worker.ts'),
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

function stopWorker(reason = 'Hosted query worker stopped.', invalidateValidatedVersions = false): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const running = child;
  child = undefined;
  childKind = undefined;
  if (running?.connected) running.disconnect();
  if (running && running.exitCode === null && running.signalCode === null) running.kill('SIGTERM');
  for (const request of pending.values()) request.reject(new Error(reason));
  pending.clear();
  if (invalidateValidatedVersions) warmedVersions.clear();
  warmingVersions.clear();
  lastActivityAt = 0;
}

async function stopIdleWorkerForBackground(force = false): Promise<void> {
  if (!child || pending.size > 0) return;
  if (!force && lastActivityAt > 0) {
    const configured = Number(process.env.KLAURO_HOSTED_QUERY_BACKGROUND_GRACE_MS);
    const graceMs = Number.isFinite(configured) && configured >= 0
      ? Math.floor(configured)
      : DEFAULT_BACKGROUND_GRACE_MS;
    const remainingMs = graceMs - (Date.now() - lastActivityAt);
    if (remainingMs > 0) await new Promise(resolve => setTimeout(resolve, remainingMs));
    if (!child || pending.size > 0) return;
  }
  const running = child;
  const exited = new Promise<void>((resolve, reject) => {
    running.once('exit', () => resolve());
    running.once('error', reject);
  });
  stopWorker('Hosted query worker yielded to background analysis.');
  await exited;
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

function getWorker(kind: 'full' | 'search'): ChildProcess {
  if (child?.connected && childKind === kind) return child;
  if (child?.connected) {
    if (pending.size > 0) throw new Error('Hosted query worker profile cannot change while requests are active.');
    stopWorker('Hosted query worker changed its memory profile.');
  }
  const spawned = fork(resolveWorkerEntryPath(kind), [], {
    execArgv: [...workerExecArgv(process.execArgv), `--max-old-space-size=${resolveHostedQueryHeapMb()}`],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: process.env,
  });
  child = spawned;
  childKind = kind;
  spawned.on('message', (message: HostedProjectQueryWorkerResponse) => {
    if (!message) return;
    if (message.type === 'ready') {
      if (pending.size === 0) scheduleIdleStop();
      return;
    }
    if (!['result', 'error', 'fallback'].includes(message.type)) return;
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    lastActivityAt = Date.now();
    if (message.type === 'error') request.reject(new Error(message.error || 'Hosted query worker failed.'));
    else request.resolve({
      analysisTimestamp: message.analysisTimestamp || '',
      unavailable: message.unavailable,
      result: message.result,
      analysisStatus: message.analysisStatus,
      compactFallback: message.type === 'fallback',
    });
    if (pending.size === 0) scheduleIdleStop();
  });
  spawned.once('error', error => stopWorker(error.message, true));
  spawned.once('exit', (code, signal) => {
    if (child === spawned) stopWorker(`Hosted query worker ${signal ? `was killed by ${signal}` : `exited with code ${code}`}.`, true);
  });
  return spawned;
}

export function prewarmHostedProjectQueryWorker(): void {
  if (pending.size > 0) return;
  const alreadyRunning = Boolean(child?.connected);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  getWorker('full');
  if (alreadyRunning && pending.size === 0) scheduleIdleStop();
}

registerHostedBackgroundPreflight(stopIdleWorkerForBackground);

export async function runHostedProjectQueryWorker(
  request: Omit<HostedProjectQueryWorkerRequest, 'type' | 'id'>,
): Promise<HostedProjectQueryResult> {
  return withHostedForegroundPermit(() => enqueueDispatch(async () => {
    const response = await dispatchWorkerRequest({ type: 'query', ...request });
    return response.compactFallback
      ? dispatchWorkerRequest({ type: 'query', ...request }, 'full')
      : response;
  }));
}

function enqueueDispatch<T>(run: () => Promise<T>): Promise<T> {
  const result = dispatchWork.then(run);
  dispatchWork = result.then(() => undefined, () => undefined);
  return result;
}

function dispatchWorkerRequest(
  request: Omit<HostedProjectQueryWorkerRequest, 'id'>,
  forcedKind?: 'full' | 'search',
): Promise<HostedProjectQueryResult> {
  return new Promise((resolve, reject) => {
    lastActivityAt = Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    let worker: ChildProcess;
    try {
      worker = getWorker(forcedKind || (request.type === 'query' && request.tool === 'search_nodes' ? 'search' : 'full'));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
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
  const response = await withHostedForegroundPermit(() => enqueueDispatch(() => dispatchWorkerRequest({
    type: 'analysis-status',
    tool: '',
    args: undefined,
    ...input,
  })));
  if (!response.analysisStatus) throw new Error('Hosted query worker returned no analysis status.');
  return response.analysisStatus;
}

export async function warmHostedProjectQueryWorker(input: {
  workspace: string;
  projectId: string;
  analysisId: string;
}): Promise<void> {
  await withHostedForegroundPermit(() => enqueueDispatch(() => dispatchWorkerRequest({
    type: 'warm',
    tool: '',
    args: undefined,
    ...input,
  })));
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
