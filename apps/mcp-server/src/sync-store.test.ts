import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SyncStore } from './sync-store';

function withTempDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sync-store-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('pushing a new record assigns an increasing server sequence', async () => {
  await withTempDir(async dataDir => {
    const store = new SyncStore(dataDir);
    const r1 = await store.pushChanges('usr_1', 'projects', 'dev-a', [
      { id: 'p1', op: 'put', record: { name: 'A' }, lamport: 1, idempotencyKey: 'dev-a:p1:1' },
    ]);
    assert.equal(r1.accepted.length, 1);
    assert.equal(r1.accepted[0].serverSeq, 1);

    const r2 = await store.pushChanges('usr_1', 'projects', 'dev-a', [
      { id: 'p2', op: 'put', record: { name: 'B' }, lamport: 1, idempotencyKey: 'dev-a:p2:1' },
    ]);
    assert.equal(r2.accepted[0].serverSeq, 2);
  });
});

test('pushing the same idempotency key twice does not consume a new sequence number', async () => {
  await withTempDir(async dataDir => {
    const store = new SyncStore(dataDir);
    const change = { id: 'p1', op: 'put' as const, record: { name: 'A' }, lamport: 1, idempotencyKey: 'dev-a:p1:1' };
    const first = await store.pushChanges('usr_1', 'projects', 'dev-a', [change]);
    const retry = await store.pushChanges('usr_1', 'projects', 'dev-a', [change]);
    assert.equal(first.accepted[0].serverSeq, retry.accepted[0].serverSeq);
  });
});

test('a later push with a different idempotency key for the same id gets a fresh sequence', async () => {
  await withTempDir(async dataDir => {
    const store = new SyncStore(dataDir);
    await store.pushChanges('usr_1', 'projects', 'dev-a', [{ id: 'p1', op: 'put', record: { name: 'A' }, lamport: 1, idempotencyKey: 'dev-a:p1:1' }]);
    const second = await store.pushChanges('usr_1', 'projects', 'dev-a', [{ id: 'p1', op: 'put', record: { name: 'A v2' }, lamport: 2, idempotencyKey: 'dev-a:p1:2' }]);
    assert.equal(second.accepted[0].serverSeq, 2);
  });
});

test('pullChanges returns only records newer than since, in order, and reports nextSince', async () => {
  await withTempDir(async dataDir => {
    const store = new SyncStore(dataDir);
    await store.pushChanges('usr_1', 'projects', 'dev-a', [{ id: 'p1', op: 'put', record: { name: 'A' }, lamport: 1, idempotencyKey: 'k1' }]);
    await store.pushChanges('usr_1', 'projects', 'dev-a', [{ id: 'p2', op: 'put', record: { name: 'B' }, lamport: 1, idempotencyKey: 'k2' }]);
    await store.pushChanges('usr_1', 'projects', 'dev-a', [{ id: 'p3', op: 'put', record: { name: 'C' }, lamport: 1, idempotencyKey: 'k3' }]);

    const all = await store.pullChanges('usr_1', 'projects', 0);
    assert.deepEqual(all.changes.map(c => c.id), ['p1', 'p2', 'p3']);
    assert.equal(all.nextSince, 3);

    const fromMiddle = await store.pullChanges('usr_1', 'projects', 1);
    assert.deepEqual(fromMiddle.changes.map(c => c.id), ['p2', 'p3']);
  });
});

test('pullChanges never crosses accounts or entity classes', async () => {
  await withTempDir(async dataDir => {
    const store = new SyncStore(dataDir);
    await store.pushChanges('usr_1', 'projects', 'dev-a', [{ id: 'p1', op: 'put', record: { name: 'Mine' }, lamport: 1, idempotencyKey: 'k1' }]);
    await store.pushChanges('usr_2', 'projects', 'dev-b', [{ id: 'p1', op: 'put', record: { name: 'Theirs' }, lamport: 1, idempotencyKey: 'k2' }]);
    await store.pushChanges('usr_1', 'devices', 'dev-a', [{ id: 'd1', op: 'put', record: { name: 'Laptop' }, lamport: 1, idempotencyKey: 'k3' }]);

    const mine = await store.pullChanges('usr_1', 'projects', 0);
    assert.equal(mine.changes.length, 1);
    assert.equal((mine.changes[0].record as { name: string }).name, 'Mine');
  });
});

test('a delete is recorded as a tombstone, not a removal', async () => {
  await withTempDir(async dataDir => {
    const store = new SyncStore(dataDir);
    await store.pushChanges('usr_1', 'projects', 'dev-a', [{ id: 'p1', op: 'put', record: { name: 'A' }, lamport: 1, idempotencyKey: 'k1' }]);
    await store.pushChanges('usr_1', 'projects', 'dev-a', [{ id: 'p1', op: 'delete', record: { name: 'A' }, lamport: 2, idempotencyKey: 'k2' }]);
    const changes = await store.pullChanges('usr_1', 'projects', 0);
    assert.equal(changes.changes.length, 1, 'a delete updates the same row, it does not disappear from the feed');
    assert.ok(changes.changes[0].deletedAt);
  });
});

test('data survives across a fresh SyncStore instance pointed at the same directory', async () => {
  await withTempDir(async dataDir => {
    const first = new SyncStore(dataDir);
    await first.pushChanges('usr_1', 'projects', 'dev-a', [{ id: 'p1', op: 'put', record: { name: 'A' }, lamport: 1, idempotencyKey: 'k1' }]);
    const second = new SyncStore(dataDir);
    const changes = await second.pullChanges('usr_1', 'projects', 0);
    assert.equal(changes.changes.length, 1);
  });
});
