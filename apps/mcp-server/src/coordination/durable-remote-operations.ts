import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getStoreDir } from './local-store';
import { getBuildIdentity } from '../installed-client-runtime';

export type RemoteOperationKind = 'claim' | 'extend' | 'release' | 'in-flight';

interface DurableRemoteOperation {
  sequence: number;
  operation_id: string;
  workspace: string;
  base_url: string;
  kind: RemoteOperationKind;
  route: string;
  body: Record<string, unknown>;
  created_at: string;
  client_persisted_at: string;
  source_identity: string;
  delivery_attempt: number;
}

export interface DurableRemoteOperationResult<T> {
  response?: T;
  queued: boolean;
  operation_id: string;
  sequence: number;
  pending: number;
  error?: string;
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;

function outboxDir(workspace: string): string {
  return path.join(getStoreDir(workspace), 'remote-operations');
}

function counterPath(workspace: string): string {
  return path.join(outboxDir(workspace), 'sequence');
}

function lockPath(workspace: string): string {
  return path.join(outboxDir(workspace), '.lock');
}

function operationPath(workspace: string, operation: DurableRemoteOperation): string {
  return path.join(outboxDir(workspace), `${String(operation.sequence).padStart(16, '0')}-${operation.operation_id}.json`);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(target: string, contents: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(temporary, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, target);
  await syncDirectory(path.dirname(target));
}

async function withOutboxLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const directory = outboxDir(workspace);
  await fsp.mkdir(directory, { recursive: true });
  const target = lockPath(workspace);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fsp.open(target, 'wx');
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fsp.stat(target).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fsp.rm(target, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring remote operation lock for ${workspace}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fsp.utimes(target, now, now).catch(() => undefined);
  }, 1000);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fsp.rm(target, { force: true });
  }
}

async function nextSequence(workspace: string): Promise<number> {
  const target = counterPath(workspace);
  const current = Number.parseInt(await fsp.readFile(target, 'utf8').catch(() => '0'), 10) || 0;
  const next = current + 1;
  await writeDurableFile(target, `${next}\n`);
  return next;
}

async function readOperations(workspace: string): Promise<Array<{ file: string; operation: DurableRemoteOperation }>> {
  const directory = outboxDir(workspace);
  const names = (await fsp.readdir(directory).catch(() => []))
    .filter((name) => /^\d{16}-.+\.json$/.test(name))
    .sort();
  const operations: Array<{ file: string; operation: DurableRemoteOperation }> = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const operation = JSON.parse(await fsp.readFile(file, 'utf8')) as DurableRemoteOperation;
    operations.push({ file, operation });
  }
  return operations;
}

function operationId(sequence: number): string {
  return `op_${sequence.toString(36)}_${randomUUID()}`;
}

function comparableBody(body: Record<string, unknown>): string {
  const {
    operation_id: _operationId,
    client_persisted_at: _clientPersistedAt,
    source_identity: _sourceIdentity,
    delivery_attempt: _deliveryAttempt,
    ...value
  } = body;
  return JSON.stringify(value);
}

function sourceIdentity(): string {
  return process.env.KLAURO_SOURCE_IDENTITY || process.env.KLAURO_GIT_SHA || getBuildIdentity().git_sha;
}

export async function executeDurableRemoteOperation<T>(options: {
  workspace: string;
  baseUrl: string;
  kind: RemoteOperationKind;
  route: string;
  body: Record<string, unknown> | ((sequence: number) => Record<string, unknown>);
  coalesceKey?: string;
  send: (route: string, body: Record<string, unknown>) => Promise<unknown>;
}): Promise<DurableRemoteOperationResult<T>> {
  return withOutboxLock(options.workspace, async () => {
    const queued = await readOperations(options.workspace);
    const reusable = typeof options.body !== 'function' && options.coalesceKey === undefined
      ? queued.find((pending) =>
          pending.operation.base_url === options.baseUrl &&
          pending.operation.kind === options.kind &&
          pending.operation.route === options.route &&
          comparableBody(pending.operation.body) === comparableBody(options.body as Record<string, unknown>))
      : undefined;
    let sequence = reusable?.operation.sequence;
    let id = reusable?.operation.operation_id;
    if (sequence === undefined || id === undefined) {
      sequence = await nextSequence(options.workspace);
      id = operationId(sequence);
      const body = typeof options.body === 'function' ? options.body(sequence) : options.body;
      const persistedAt = new Date().toISOString();
      const identity = sourceIdentity();
      const operation: DurableRemoteOperation = {
        sequence,
        operation_id: id,
        workspace: options.workspace,
        base_url: options.baseUrl,
        kind: options.kind,
        route: options.route,
        body: {
          ...body,
          operation_id: id,
          client_persisted_at: persistedAt,
          source_identity: identity,
          delivery_attempt: 0,
        },
        created_at: persistedAt,
        client_persisted_at: persistedAt,
        source_identity: identity,
        delivery_attempt: 0,
      };
      if (options.coalesceKey) operation.body.coalesce_key = options.coalesceKey;
      await writeDurableFile(operationPath(options.workspace, operation), `${JSON.stringify(operation)}\n`);
      if (options.coalesceKey) {
        for (const pending of queued) {
          if (
            pending.operation.base_url === options.baseUrl &&
            pending.operation.kind === options.kind &&
            pending.operation.body.coalesce_key === options.coalesceKey
          ) {
            await fsp.rm(pending.file, { force: true });
          }
        }
        await syncDirectory(outboxDir(options.workspace));
      }
    }

    let ownResponse: T | undefined;
    let error: string | undefined;
    for (const pending of await readOperations(options.workspace)) {
      if (pending.operation.base_url !== options.baseUrl) continue;
      try {
        pending.operation.delivery_attempt = (pending.operation.delivery_attempt ?? 0) + 1;
        pending.operation.body.delivery_attempt = pending.operation.delivery_attempt;
        pending.operation.body.client_persisted_at = pending.operation.client_persisted_at ?? pending.operation.created_at;
        pending.operation.body.source_identity = pending.operation.source_identity ?? 'unknown';
        await writeDurableFile(pending.file, `${JSON.stringify(pending.operation)}\n`);
        const response = await options.send(pending.operation.route, pending.operation.body);
        if (pending.operation.operation_id === id) ownResponse = response as T;
        await fsp.rm(pending.file, { force: true });
        await syncDirectory(outboxDir(options.workspace));
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        break;
      }
    }
    const pending = (await readOperations(options.workspace)).filter(
      (entry) => entry.operation.base_url === options.baseUrl
    ).length;
    return { response: ownResponse, queued: ownResponse === undefined, operation_id: id, sequence, pending, error };
  });
}

export async function pendingRemoteOperationCount(workspace: string, baseUrl?: string): Promise<number> {
  return (await readOperations(workspace)).filter(
    (entry) => baseUrl === undefined || entry.operation.base_url === baseUrl
  ).length;
}
