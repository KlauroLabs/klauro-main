import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendParticipantInFlightSnapshot, readParticipantInFlightSnapshots } from './participant-in-flight-store';

test('participant snapshot store reduces to the latest fresh snapshot per agent', async () => {
  const coordDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-participant-store-'));
  process.env.KLAURO_COORD_DIR = coordDir;
  const workspace = 'workspace-a';
  const base = {
    workspace,
    base_commit: 'base',
    diff_context: '{}',
    attribution_source: 'participant-worktree' as const,
  };
  await appendParticipantInFlightSnapshot(workspace, {
    ...base,
    agent_id: 'agent-a',
    updated_at: '2026-01-01T00:00:00.000Z',
    changes: [{ symbol_id: 'old', name: 'old', file: 'old.ts', change_kind: 'body' }],
  });
  await appendParticipantInFlightSnapshot(workspace, {
    ...base,
    agent_id: 'agent-a',
    updated_at: '2026-01-01T00:01:00.000Z',
    changes: [{ symbol_id: 'new', name: 'new', file: 'new.ts', change_kind: 'body' }],
  });
  await appendParticipantInFlightSnapshot(workspace, {
    ...base,
    agent_id: 'agent-b',
    updated_at: '2026-01-01T00:01:30.000Z',
  });

  const snapshots = await readParticipantInFlightSnapshots(workspace, {
    nowMs: Date.parse('2026-01-01T00:02:00.000Z'),
  });
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.find((snapshot) => snapshot.agent_id === 'agent-a')?.changes?.[0].symbol_id, 'new');
  await fsp.rm(coordDir, { recursive: true, force: true });
});

test('participant snapshot store excludes stale and workspace-wide observations from attribution', async () => {
  const coordDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-participant-store-'));
  process.env.KLAURO_COORD_DIR = coordDir;
  const workspace = 'workspace-b';
  await appendParticipantInFlightSnapshot(workspace, {
    workspace,
    agent_id: 'agent-a',
    base_commit: 'base',
    diff_context: '{}',
    updated_at: '2026-01-01T00:00:00.000Z',
    attribution_source: 'participant-worktree',
  });
  await appendParticipantInFlightSnapshot(workspace, {
    workspace,
    agent_id: 'agent-b',
    base_commit: 'base',
    diff_context: '{}',
    updated_at: '2026-01-01T00:04:00.000Z',
    attribution_source: 'workspace-tree',
  });

  const snapshots = await readParticipantInFlightSnapshots(workspace, {
    nowMs: Date.parse('2026-01-01T00:05:00.000Z'),
    maxAgeMs: 2 * 60 * 1000,
    attributableOnly: true,
  });
  assert.deepEqual(snapshots, []);
  await fsp.rm(coordDir, { recursive: true, force: true });
});

test('participant snapshot store rejects stale revisions and acknowledges exact retries', async () => {
  const coordDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-participant-store-'));
  process.env.KLAURO_COORD_DIR = coordDir;
  const base = {
    workspace: 'workspace-c',
    agent_id: 'agent-a',
    base_commit: 'base',
    diff_context: '{}',
    attribution_source: 'participant-worktree' as const,
  };
  const accepted = await appendParticipantInFlightSnapshot('workspace-c', {
    ...base,
    updated_at: '2026-01-01T00:00:00.000Z',
    participant_revision: 4,
    operation_id: 'operation-4',
  });
  const stale = await appendParticipantInFlightSnapshot('workspace-c', {
    ...base,
    updated_at: '2026-01-01T00:01:00.000Z',
    participant_revision: 3,
    operation_id: 'operation-3',
  });
  const duplicate = await appendParticipantInFlightSnapshot('workspace-c', {
    ...base,
    updated_at: '2026-01-01T00:02:00.000Z',
    participant_revision: 4,
    operation_id: 'operation-4',
  });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(stale, { status: 'stale', participant_revision: 4 });
  assert.deepEqual(duplicate, { status: 'duplicate', participant_revision: 4 });
  const snapshots = await readParticipantInFlightSnapshots('workspace-c', {
    nowMs: Date.parse('2026-01-01T00:03:00.000Z'),
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].updated_at, '2026-01-01T00:00:00.000Z');
  await fsp.rm(coordDir, { recursive: true, force: true });
});
