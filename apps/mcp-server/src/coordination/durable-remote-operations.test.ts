import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { executeDurableRemoteOperation, pendingRemoteOperationCount } from './durable-remote-operations';

async function isolatedStore(): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-remote-operations-'));
  process.env.KLAURO_COORD_DIR = directory;
  return directory;
}

test('durable operations retain order across failure and a later process-style drain', async () => {
  const directory = await isolatedStore();
  const sent: string[] = [];
  const first = await executeDurableRemoteOperation({
    workspace: 'workspace-a',
    baseUrl: 'https://fabric.example',
    kind: 'claim',
    route: '/claim',
    body: { value: 'first' },
    send: async () => { throw new Error('offline'); },
  });
  assert.equal(first.queued, true);
  assert.equal(await pendingRemoteOperationCount('workspace-a'), 1);

  const second = await executeDurableRemoteOperation<{ accepted: string }>({
    workspace: 'workspace-a',
    baseUrl: 'https://fabric.example',
    kind: 'extend',
    route: '/extend',
    body: { value: 'second' },
    send: async (_route, body) => {
      sent.push(body.value as string);
      return { accepted: body.value as string };
    },
  });
  assert.deepEqual(sent, ['first', 'second']);
  assert.deepEqual(second.response, { accepted: 'second' });
  assert.equal(second.queued, false);
  assert.equal(await pendingRemoteOperationCount('workspace-a'), 0);
  await fsp.rm(directory, { recursive: true, force: true });
});

test('retrying an identical queued mutation reuses its durable operation identity', async () => {
  const directory = await isolatedStore();
  process.env.KLAURO_SOURCE_IDENTITY = 'proof-source-identity';
  const first = await executeDurableRemoteOperation({
    workspace: 'workspace-retry',
    baseUrl: 'https://fabric.example',
    kind: 'claim',
    route: '/claim',
    body: { agent_id: 'agent-a', intent: 'work' },
    send: async () => { throw new Error('offline'); },
  });
  const sent: Array<{ id: string; attempt: number; source: string }> = [];
  const retry = await executeDurableRemoteOperation<{ status: string }>({
    workspace: 'workspace-retry',
    baseUrl: 'https://fabric.example',
    kind: 'claim',
    route: '/claim',
    body: { agent_id: 'agent-a', intent: 'work' },
    send: async (_route, body) => {
      sent.push({
        id: body.operation_id as string,
        attempt: body.delivery_attempt as number,
        source: body.source_identity as string,
      });
      return { status: 'accepted' };
    },
  });
  assert.deepEqual(sent, [{ id: first.operation_id, attempt: 2, source: 'proof-source-identity' }]);
  assert.equal(retry.operation_id, first.operation_id);
  assert.equal(retry.sequence, first.sequence);
  assert.deepEqual(retry.response, { status: 'accepted' });
  assert.equal(await pendingRemoteOperationCount('workspace-retry'), 0);
  delete process.env.KLAURO_SOURCE_IDENTITY;
  await fsp.rm(directory, { recursive: true, force: true });
});

test('new participant snapshot coalesces an older unsent snapshot', async () => {
  const directory = await isolatedStore();
  await executeDurableRemoteOperation({
    workspace: 'workspace-b',
    baseUrl: 'https://fabric.example',
    kind: 'in-flight',
    route: '/in-flight',
    body: (sequence) => ({ agent_id: 'agent-a', participant_revision: sequence, value: 'old' }),
    coalesceKey: 'agent-a',
    send: async () => { throw new Error('offline'); },
  });
  const sent: Array<{ value: unknown; revision: unknown }> = [];
  await executeDurableRemoteOperation({
    workspace: 'workspace-b',
    baseUrl: 'https://fabric.example',
    kind: 'in-flight',
    route: '/in-flight',
    body: (sequence) => ({ agent_id: 'agent-a', participant_revision: sequence, value: 'new' }),
    coalesceKey: 'agent-a',
    send: async (_route, body) => {
      sent.push({ value: body.value, revision: body.participant_revision });
      return { status: 'success' };
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].value, 'new');
  assert.equal(sent[0].revision, 2);
  assert.equal(await pendingRemoteOperationCount('workspace-b'), 0);
  await fsp.rm(directory, { recursive: true, force: true });
});
