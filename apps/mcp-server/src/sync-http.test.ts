import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-sync-http-'));
  const previousCoordination = process.env.KLAURO_COORD_DIR;
  process.env.KLAURO_COORD_DIR = path.join(root, 'data', 'coordination');
  const server = createRemoteAnalyzerHttpServer({ dataDir: path.join(root, 'data') });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousCoordination === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordination;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function registerUser(baseUrl: string, email: string): Promise<{ token: string }> {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<{ token: string }>;
}

test('push then pull round-trips a project through the real HTTP routes', async () => {
  await withServer(async baseUrl => {
    const { token } = await registerUser(baseUrl, 'sync-http-1@example.com');
    const pushResponse = await fetch(`${baseUrl}/api/sync/projects/changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        deviceId: 'dev-a',
        changes: [{ id: 'p1', op: 'put', record: { id: 'p1', name: 'Website' }, lamport: 1, idempotencyKey: 'dev-a:p1:1' }],
      }),
    });
    assert.equal(pushResponse.status, 200);
    const pushed = await pushResponse.json() as { accepted: { id: string; serverSeq: number }[] };
    assert.equal(pushed.accepted[0].serverSeq, 1);

    const pullResponse = await fetch(`${baseUrl}/api/sync/projects/changes?since=0`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(pullResponse.status, 200);
    const pulled = await pullResponse.json() as { changes: { id: string; record: { name: string } }[]; nextSince: number };
    assert.equal(pulled.changes.length, 1);
    assert.equal(pulled.changes[0].record.name, 'Website');
    assert.equal(pulled.nextSince, 1);
  });
});

test('one account can never pull a different account\'s projects', async () => {
  await withServer(async baseUrl => {
    const alice = await registerUser(baseUrl, 'sync-alice@example.com');
    const bob = await registerUser(baseUrl, 'sync-bob@example.com');
    await fetch(`${baseUrl}/api/sync/projects/changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ deviceId: 'dev-a', changes: [{ id: 'p1', op: 'put', record: { name: 'Alice project' }, lamport: 1, idempotencyKey: 'k1' }] }),
    });
    const bobsView = await fetch(`${baseUrl}/api/sync/projects/changes?since=0`, { headers: { authorization: `Bearer ${bob.token}` } });
    const bobsChanges = await bobsView.json() as { changes: unknown[] };
    assert.equal(bobsChanges.changes.length, 0);
  });
});

test('an unauthenticated push is rejected', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/api/sync/projects/changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-a', changes: [] }),
    });
    assert.equal(response.status, 401);
  });
});

test('an unregistered entity class is rejected', async () => {
  await withServer(async baseUrl => {
    const { token } = await registerUser(baseUrl, 'sync-unknown-class@example.com');
    const response = await fetch(`${baseUrl}/api/sync/not-a-real-class/changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceId: 'dev-a', changes: [] }),
    });
    assert.equal(response.status, 404);
  });
});

test('pushing the same change twice through the HTTP layer is idempotent', async () => {
  await withServer(async baseUrl => {
    const { token } = await registerUser(baseUrl, 'sync-http-idempotent@example.com');
    const change = { id: 'p1', op: 'put', record: { name: 'Website' }, lamport: 1, idempotencyKey: 'dev-a:p1:1' };
    const push = async () => fetch(`${baseUrl}/api/sync/projects/changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceId: 'dev-a', changes: [change] }),
    }).then(r => r.json()) as Promise<{ accepted: { serverSeq: number }[] }>;
    const first = await push();
    const second = await push();
    assert.equal(first.accepted[0].serverSeq, second.accepted[0].serverSeq);
  });
});

test('one account hammering the sync endpoint gets rate-limited instead of starving every other account', async () => {
  const previous = process.env.KLAURO_SYNC_RATE_LIMIT_PER_MINUTE;
  process.env.KLAURO_SYNC_RATE_LIMIT_PER_MINUTE = '3';
  try {
    await withServer(async baseUrl => {
      const { token } = await registerUser(baseUrl, 'sync-http-rate-limit@example.com');
      const poll = () => fetch(`${baseUrl}/api/sync/projects/changes?since=0`, { headers: { authorization: `Bearer ${token}` } });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await poll()).status);
      }
      assert.ok(statuses.slice(0, 3).every(s => s === 200), `the first requests under the limit should succeed: ${statuses}`);
      assert.ok(statuses.slice(3).some(s => s === 429), `requests past the limit should be rejected: ${statuses}`);
    });
  } finally {
    if (previous === undefined) delete process.env.KLAURO_SYNC_RATE_LIMIT_PER_MINUTE;
    else process.env.KLAURO_SYNC_RATE_LIMIT_PER_MINUTE = previous;
  }
});

test('an oversized pushed record is rejected by the real HTTP route, not just the in-process store', async () => {
  const previous = process.env.KLAURO_SYNC_MAX_RECORD_BYTES;
  process.env.KLAURO_SYNC_MAX_RECORD_BYTES = '1024';
  try {
    await withServer(async baseUrl => {
      const { token } = await registerUser(baseUrl, 'sync-http-oversized@example.com');
      const response = await fetch(`${baseUrl}/api/sync/projects/changes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ deviceId: 'dev-a', changes: [{ id: 'p1', op: 'put', record: { blob: 'x'.repeat(5000) }, lamport: 1, idempotencyKey: 'k1' }] }),
      });
      assert.equal(response.status, 200, 'the request itself still succeeds; the individual change is reported as rejected');
      const body = await response.json() as { accepted: unknown[]; rejected: { reason: string }[] };
      assert.equal(body.accepted.length, 0);
      assert.match(body.rejected[0].reason, /too large/);
    });
  } finally {
    if (previous === undefined) delete process.env.KLAURO_SYNC_MAX_RECORD_BYTES;
    else process.env.KLAURO_SYNC_MAX_RECORD_BYTES = previous;
  }
});
