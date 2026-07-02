import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { fetchRemoteState, mergeRemotePeers, publishClaim, RemoteStoreError, syncClaim } from './remote-store';
import { readClaimLog } from './local-store';
import type { WorkClaim } from './types';

async function freshCoordDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-coord-test-'));
  process.env.KLAURO_COORD_DIR = dir;
  return dir;
}

function makeClaim(overrides: Partial<WorkClaim> = {}): WorkClaim {
  const now = new Date().toISOString();
  return {
    claim_id: 'claim-1',
    seq: 1,
    workspace_id: 'ws-test',
    agent_id: 'agent-a',
    agent_kind: 'claude',
    scope: { repo: 'proof-of-concept', paths: ['src/foo.ts'], symbols: ['fooHandler'] },
    intent: 'refactor foo',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
    ...overrides,
  };
}

/** A tiny throwaway HTTP server standing in for remote-analyzer-service.ts's coordination routes. */
async function startThrowawayServer(
  handler: (req: http.IncomingMessage, body: any) => Promise<{ status: number; body: unknown }>
): Promise<{ baseUrl: string; close: () => Promise<void>; requests: Array<{ url: string; body: any }> }> {
  const requests: Array<{ url: string; body: any }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ url: req.url || '', body });
    const result = await handler(req, body);
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests,
  };
}

test('publishClaim POSTs the claim to /v1/coordination/claim and parses the verdict', async () => {
  const dir = await freshCoordDir();
  const claim = makeClaim();
  const server = await startThrowawayServer(async (req, body) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/coordination/claim');
    assert.equal(body.workspace, 'ws-test');
    assert.equal(body.agent_id, 'agent-a');
    assert.deepEqual(body.paths, ['src/foo.ts']);
    return { status: 200, body: { claim_id: claim.claim_id, seq: 1, verdict: 'granted' } };
  });

  const result = await publishClaim(server.baseUrl, 'shared-token', claim);
  assert.equal(result.verdict, 'granted');
  assert.equal(result.claim_id, claim.claim_id);
  assert.equal(server.requests.length, 1);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('publishClaim sends the bearer token when provided', async () => {
  const dir = await freshCoordDir();
  let sawAuth: string | undefined;
  const server = await startThrowawayServer(async (req) => {
    sawAuth = req.headers.authorization;
    return { status: 200, body: { claim_id: 'x', seq: 1, verdict: 'granted' } };
  });

  await publishClaim(server.baseUrl, 'secret-token-123', makeClaim());
  assert.equal(sawAuth, 'Bearer secret-token-123');

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('publishClaim throws RemoteStoreError on non-2xx response', async () => {
  const dir = await freshCoordDir();
  const server = await startThrowawayServer(async () => ({ status: 500, body: { error: 'boom' } }));

  await assert.rejects(() => publishClaim(server.baseUrl, undefined, makeClaim()), RemoteStoreError);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('publishClaim throws RemoteStoreError on network failure (unreachable host)', async () => {
  const dir = await freshCoordDir();
  // Port 1 is reserved/unlikely to be listening; fetch should fail fast.
  await assert.rejects(
    () => publishClaim('http://127.0.0.1:1', undefined, makeClaim()),
    RemoteStoreError
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('fetchRemoteState GETs /v1/coordination/state with workspace + since query params and parses claims/presence', async () => {
  const dir = await freshCoordDir();
  const claim = makeClaim();
  const server = await startThrowawayServer(async (req) => {
    assert.equal(req.method, 'GET');
    const url = new URL(req.url || '', 'http://localhost');
    assert.equal(url.pathname, '/v1/coordination/state');
    assert.equal(url.searchParams.get('workspace'), 'ws-test');
    assert.equal(url.searchParams.get('since'), '5');
    return {
      status: 200,
      body: {
        workspace: 'ws-test',
        max_seq: 7,
        claims: [claim],
        presence: [{ agent_id: 'agent-a', agent_kind: 'claude', workspace: 'ws-test', last_seen: claim.heartbeat_at, scope: claim.scope }],
      },
    };
  });

  const state = await fetchRemoteState(server.baseUrl, undefined, 'ws-test', 5);
  assert.equal(state.max_seq, 7);
  assert.equal(state.claims.length, 1);
  assert.equal(state.claims[0].claim_id, 'claim-1');
  assert.equal(state.presence.length, 1);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('fetchRemoteState throws RemoteStoreError on non-2xx', async () => {
  const dir = await freshCoordDir();
  const server = await startThrowawayServer(async () => ({ status: 404, body: { error: 'not found' } }));

  await assert.rejects(() => fetchRemoteState(server.baseUrl, undefined, 'ws-test'), RemoteStoreError);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('syncClaim writes locally even when remote is unreachable (resilience, non-fatal)', async () => {
  const dir = await freshCoordDir();
  const claim = makeClaim({ claim_id: 'resilient-claim' });

  const result = await syncClaim('ws-test', claim, { baseUrl: 'http://127.0.0.1:1' });

  // Local write must have happened regardless of remote failure.
  assert.equal(result.local.claim_id, 'resilient-claim');
  assert.ok(result.remoteError, 'remoteError should be set when remote publish fails');
  assert.equal(result.remote, undefined);

  const log = await readClaimLog('ws-test');
  assert.equal(log.length, 1);
  assert.equal(log[0].claim_id, 'resilient-claim');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('syncClaim writes locally AND publishes remotely when a remote tier is configured and reachable', async () => {
  const dir = await freshCoordDir();
  const claim = makeClaim({ claim_id: 'synced-claim' });
  const server = await startThrowawayServer(async (_req, body) => {
    assert.equal(body.claim_id, 'synced-claim');
    return { status: 200, body: { claim_id: 'synced-claim', seq: 1, verdict: 'granted' } };
  });

  const result = await syncClaim('ws-test', claim, { baseUrl: server.baseUrl, token: 't' });
  assert.equal(result.remote?.verdict, 'granted');
  assert.equal(result.remoteError, undefined);

  const log = await readClaimLog('ws-test');
  assert.equal(log.length, 1);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('syncClaim with no remote option only writes locally (no fetch attempted)', async () => {
  const dir = await freshCoordDir();
  const claim = makeClaim({ claim_id: 'local-only' });

  const result = await syncClaim('ws-test', claim);
  assert.equal(result.local.claim_id, 'local-only');
  assert.equal(result.remote, undefined);
  assert.equal(result.remoteError, undefined);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('mergeRemotePeers unions local + remote active claims, deduping by claim_id with LWW by seq', async () => {
  const now = new Date().toISOString();
  const localOnly = makeClaim({ claim_id: 'local-only', agent_id: 'agent-local', seq: 1 });
  const sharedOld = makeClaim({ claim_id: 'shared', agent_id: 'agent-shared', seq: 1, intent: 'stale intent', heartbeat_at: now });
  const sharedNew = makeClaim({ claim_id: 'shared', agent_id: 'agent-shared', seq: 2, intent: 'fresh intent', heartbeat_at: now });
  const remoteOnly = makeClaim({ claim_id: 'remote-only', agent_id: 'agent-remote', seq: 1 });

  const merged = mergeRemotePeers(
    [localOnly, sharedOld],
    { workspace: 'ws-test', max_seq: 2, claims: [sharedNew, remoteOnly], presence: [] }
  );

  const byId = new Map(merged.map((c) => [c.claim_id, c]));
  assert.equal(merged.length, 3, 'shared claim should be deduped, not duplicated');
  assert.ok(byId.has('local-only'));
  assert.ok(byId.has('remote-only'));
  assert.equal(byId.get('shared')?.intent, 'fresh intent', 'higher seq (remote) should win LWW');
});

test('mergeRemotePeers drops released claims and handles an undefined remote state', async () => {
  const active = makeClaim({ claim_id: 'still-active', status: 'active' });
  const released = makeClaim({ claim_id: 'gone', status: 'released' });

  const merged = mergeRemotePeers([active, released], undefined);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].claim_id, 'still-active');
});
