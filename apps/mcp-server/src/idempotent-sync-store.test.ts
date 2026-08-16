import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotentRequestStore, IdempotentSyncStore } from './idempotent-sync-store';

interface Response {
  cas: { version: number };
  change: string;
}

test('coalesces concurrent sync retries and hydrates completed replays without retaining CAS', async () => {
  const store = new IdempotentSyncStore<Response, Response['cas']>();
  let executions = 0;
  let resolveExecution!: (response: Response) => void;
  const execute = () => {
    executions++;
    return new Promise<Response>(resolve => { resolveExecution = resolve; });
  };
  const first = store.run('project', 'request', execute, async () => ({ version: 2 }));
  const concurrent = store.run('project', 'request', execute, async () => ({ version: 2 }));
  resolveExecution({ cas: { version: 1 }, change: 'one file modified' });

  assert.deepEqual(await first, { value: { cas: { version: 1 }, change: 'one file modified' }, replayed: false });
  assert.deepEqual(await concurrent, { value: { cas: { version: 1 }, change: 'one file modified' }, replayed: true });
  assert.equal(executions, 1);
  assert.deepEqual(
    await store.run('project', 'request', execute, async () => ({ version: 2 })),
    { value: { cas: { version: 2 }, change: 'one file modified' }, replayed: true },
  );
  assert.equal(executions, 1);
});

test('refuses an old replay after a newer sync request supersedes it', async () => {
  const store = new IdempotentSyncStore<Response, Response['cas']>();
  const execute = (version: number) => async () => ({ cas: { version }, change: `change ${version}` });
  await store.run('project', 'older', execute(1), async () => ({ version: 1 }));
  await store.run('project', 'newer', execute(2), async () => ({ version: 2 }));

  await assert.rejects(
    store.run('project', 'older', execute(1), async () => ({ version: 2 })),
    /superseded by a newer request/,
  );
});

test('executes legacy requests independently when they do not carry request identity', async () => {
  const store = new IdempotentSyncStore<Response, Response['cas']>();
  let executions = 0;
  const execute = async () => ({ cas: { version: ++executions }, change: 'legacy' });

  await store.run('project', undefined, execute, async () => ({ version: 0 }));
  await store.run('project', undefined, execute, async () => ({ version: 0 }));
  assert.equal(executions, 2);
});

test('marks repeated accepted requests as replays without repeating preparation', async () => {
  const store = new IdempotentRequestStore<{ workspace: string }>();
  let preparations = 0;
  const prepare = async () => ({ workspace: `workspace-${++preparations}` });

  assert.deepEqual(await store.run('project', 'request', prepare), {
    value: { workspace: 'workspace-1' },
    replayed: false,
  });
  assert.deepEqual(await store.run('project', 'request', prepare), {
    value: { workspace: 'workspace-1' },
    replayed: true,
  });
  assert.equal(preparations, 1);
});
