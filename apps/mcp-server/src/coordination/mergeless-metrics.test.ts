import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getMergelessMetrics, recordMergelessObservation } from './mergeless-metrics';

test('mergeless metrics aggregate decision and surprise rates across observations', async () => {
  const coordDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-mergeless-metrics-'));
  process.env.KLAURO_COORD_DIR = coordDir;
  const workspace = 'metrics-workspace';
  await recordMergelessObservation({
    workspace,
    observed_at: '2026-01-01T00:00:00.000Z',
    attribution_source: 'participant-semantic-streams',
    participant_count: 2,
    changed_symbol_count: 4,
    merge_decisions_required: 1,
    surprise_count: 1,
    unattributed_count: 0,
  });
  await recordMergelessObservation({
    workspace,
    observed_at: '2026-01-01T00:01:00.000Z',
    attribution_source: 'participant-semantic-streams',
    participant_count: 3,
    changed_symbol_count: 6,
    merge_decisions_required: 0,
    surprise_count: 0,
    unattributed_count: 1,
  });

  const metrics = await getMergelessMetrics(workspace);
  assert.equal(metrics.observation_count, 2);
  assert.equal(metrics.participant_observations, 5);
  assert.equal(metrics.changed_symbol_observations, 10);
  assert.equal(metrics.merge_decisions_required, 1);
  assert.equal(metrics.surprises, 1);
  assert.equal(metrics.unattributed_changes, 1);
  assert.equal(metrics.merge_decision_rate, 0.1);
  assert.equal(metrics.surprise_rate, 0.1);
  assert.equal(metrics.delivery.operation_count, 0);
  await fsp.rm(coordDir, { recursive: true, force: true });
});

test('mergeless metrics preserve cumulative totals when the observation journal compacts', async () => {
  const coordDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-mergeless-rollup-'));
  process.env.KLAURO_COORD_DIR = coordDir;
  const workspace = 'rollup-workspace';
  const workspaceDir = path.join(coordDir, workspace);
  await fsp.mkdir(workspaceDir, { recursive: true });
  const observations = Array.from({ length: 2_100 }, (_, index) => ({
    workspace,
    observed_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    attribution_source: `source-${index}-${'x'.repeat(1_000)}`,
    participant_count: 1,
    changed_symbol_count: 2,
    merge_decisions_required: 0,
    surprise_count: 0,
    unattributed_count: 0,
  }));
  await fsp.writeFile(
    path.join(workspaceDir, 'mergeless-metrics.jsonl'),
    `${observations.map((observation) => JSON.stringify(observation)).join('\n')}\n`,
    'utf8',
  );
  await recordMergelessObservation({
    workspace,
    observed_at: '2026-01-02T00:00:00.000Z',
    attribution_source: 'latest',
    participant_count: 1,
    changed_symbol_count: 2,
    merge_decisions_required: 1,
    surprise_count: 1,
    unattributed_count: 1,
  });
  const metrics = await getMergelessMetrics(workspace);
  assert.equal(metrics.observation_count, 2_101);
  assert.equal(metrics.participant_observations, 2_101);
  assert.equal(metrics.changed_symbol_observations, 4_202);
  assert.equal(metrics.merge_decisions_required, 1);
  assert.equal(metrics.surprises, 1);
  assert.equal(metrics.unattributed_changes, 1);
  await fsp.rm(coordDir, { recursive: true, force: true });
});
