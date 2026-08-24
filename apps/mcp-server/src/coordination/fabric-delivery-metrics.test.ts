import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getFabricDeliveryMetrics, recordFabricDeliveryStage } from './fabric-delivery-metrics';

test('delivery metrics count one operation across acknowledgement, retry, visibility, and reconciliation updates', async () => {
  const coordinationDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-delivery-metrics-'));
  process.env.KLAURO_COORD_DIR = coordinationDirectory;
  const base = {
    workspace: 'workspace-a',
    operation_id: 'operation-a',
    operation_kind: 'in-flight',
    participant_id: 'agent-a',
    source_identity: 'source-abc',
    captured_at: '2026-01-01T00:00:00.000Z',
    client_persisted_at: '2026-01-01T00:00:00.010Z',
  };
  await recordFabricDeliveryStage({
    ...base,
    acknowledged_at: '2026-01-01T00:00:00.030Z',
    visible_at: '2026-01-01T00:00:00.040Z',
    delivery_attempt: 2,
  });
  await recordFabricDeliveryStage({
    ...base,
    acknowledged_at: '2026-01-01T00:00:00.030Z',
    reconciled_at: '2026-01-01T00:00:00.090Z',
    delivery_attempt: 2,
  });
  const metrics = await getFabricDeliveryMetrics('workspace-a');
  assert.equal(metrics.operation_count, 1);
  assert.equal(metrics.ack_count, 1);
  assert.equal(metrics.visible_count, 1);
  assert.equal(metrics.reconciled_count, 1);
  assert.equal(metrics.retry_count, 1);
  assert.equal(metrics.transport_loss_count, 1);
  assert.equal(metrics.recovered_operation_count, 1);
  assert.equal(metrics.permanent_loss_count, null);
  assert.deepEqual(metrics.source_identities, ['source-abc']);
  assert.deepEqual(metrics.capture_to_persist, { count: 1, average_ms: 10, max_ms: 10 });
  assert.deepEqual(metrics.persist_to_visible, { count: 1, average_ms: 30, max_ms: 30 });
  assert.deepEqual(metrics.visible_to_reconciled, { count: 1, average_ms: 50, max_ms: 50 });
  assert.deepEqual(metrics.capture_to_reconciled, { count: 1, average_ms: 90, max_ms: 90 });
  await fsp.rm(coordinationDirectory, { recursive: true, force: true });
});
