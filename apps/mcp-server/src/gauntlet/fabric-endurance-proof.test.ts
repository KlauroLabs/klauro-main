import test from 'node:test';
import assert from 'node:assert/strict';

import { runFabricEnduranceProof } from './fabric-endurance-proof';

test('independent Fabric clients recover a fault with no missing operations', async () => {
  const result = await runFabricEnduranceProof({ participantCount: 2, sourceIdentity: 'test-source-identity' });
  assert.equal(result.source_identity, 'test-source-identity');
  assert.equal(result.server_replica_count, 1);
  assert.equal(result.independent_client_processes, 8);
  assert.equal(result.expected_operation_count, result.acknowledged_operation_count);
  assert.equal(result.permanently_lost_operation_count, 0);
  assert.equal(result.recovered_operation_count, 1);
  assert.equal(result.retry_count, 1);
  assert.equal(result.transport_loss_count, 1);
  assert.equal(result.expected_operation_ledger_digest, result.observed_operation_ledger_digest);
});

test('endurance evidence refuses an unstamped source identity', async () => {
  await assert.rejects(
    runFabricEnduranceProof({ participantCount: 2, sourceIdentity: 'unknown' }),
    /requires KLAURO_SOURCE_IDENTITY or a build source identity/,
  );
});
