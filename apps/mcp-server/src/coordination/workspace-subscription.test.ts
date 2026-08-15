import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRemoteAnalyzerHttpServer } from '../remote-analyzer-service';
import { appendClaim } from './local-store';
import { appendParticipantInFlightSnapshot } from './participant-in-flight-store';
import { remoteClaim } from './remote-transport';
import { waitForLocalWorkspaceChange, waitForRemoteWorkspaceChange } from './workspace-subscription';

test('local workspace subscription returns snapshots and wakes for claim and in-flight changes', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-subscribe-local-'));
  const previous = process.env.KLAURO_COORD_DIR;
  process.env.KLAURO_COORD_DIR = root;
  const workspace = 'local-subscription';

  try {
    const initial = await waitForLocalWorkspaceChange(workspace);
    assert.equal(initial.status, 'snapshot');

    const claimWait = waitForLocalWorkspaceChange(workspace, {
      since_seq: initial.resume_seq,
      since_epoch: initial.epoch,
      since_revision: initial.revision,
      wait_ms: 2_000,
    });
    await appendClaim(workspace, {
      claim_id: 'claim-subscription',
      workspace_id: workspace,
      agent_id: 'agent-subscription',
      agent_kind: 'codex',
      scope: { repo: workspace, paths: ['src/shared.ts'], symbols: ['shared'] },
      intent: 'change shared behavior',
      status: 'active',
      created_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      ttl_ms: 60_000,
    });
    const claimChanged = await claimWait;
    assert.equal(claimChanged.status, 'changed');
    assert.equal(claimChanged.active.length, 1);

    const inFlightWait = waitForLocalWorkspaceChange(workspace, {
      since_seq: claimChanged.resume_seq,
      since_epoch: claimChanged.epoch,
      since_revision: claimChanged.revision,
      wait_ms: 2_000,
    });
    await appendParticipantInFlightSnapshot(workspace, {
      workspace,
      agent_id: 'agent-subscription',
      base_commit: 'base',
      diff_context: '{}',
      updated_at: new Date(Date.now() + 1_000).toISOString(),
      attribution_source: 'participant-worktree',
      changes: [{ symbol_id: 'shared', name: 'shared', file: 'src/shared.ts', change_kind: 'body' }],
    });
    const inFlightChanged = await inFlightWait;
    assert.equal(inFlightChanged.status, 'changed');
    assert.equal(inFlightChanged.resume_seq, claimChanged.resume_seq);
    assert.equal(inFlightChanged.in_flight.length, 1);

    const timedOut = await waitForLocalWorkspaceChange(workspace, {
      since_seq: inFlightChanged.resume_seq,
      since_epoch: inFlightChanged.epoch,
      since_revision: inFlightChanged.revision,
      wait_ms: 25,
    });
    assert.equal(timedOut.status, 'timeout');
  } finally {
    if (previous === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previous;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('remote workspace subscription wakes when the hosted Fabric board changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-subscribe-remote-'));
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousCoordDir = process.env.KLAURO_COORD_DIR;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = path.join(root, 'remote-data');
  process.env.KLAURO_COORD_DIR = path.join(root, 'coord');
  const server = createRemoteAnalyzerHttpServer({ dataDir: process.env.KLAURO_REMOTE_ANALYZER_DATA });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const config = { baseUrl: `http://127.0.0.1:${address.port}` };
  const workspace = 'remote-subscription';

  try {
    const initial = await waitForRemoteWorkspaceChange(config, workspace);
    const waiting = waitForRemoteWorkspaceChange(config, workspace, {
      since_seq: initial.resume_seq,
      since_epoch: initial.epoch,
      since_revision: initial.revision,
      wait_ms: 2_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await remoteClaim(config, {
      workspace,
      agentId: 'remote-agent',
      intent: 'collaborate across machines',
      paths: ['src/remote.ts'],
      symbols: ['remoteSymbol'],
    });
    const changed = await waiting;
    assert.equal(changed.status, 'changed');
    assert.equal(changed.tier, 'remote');
    assert.equal(changed.active.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
