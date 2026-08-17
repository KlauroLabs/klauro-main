import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleRejectedCapabilityDescriptions } from './capability-catalog-scheduling';

test('description repair schedules only rejected capabilities on detached values', async () => {
  const capabilities = [
    { id: 'accepted', name: 'Accepted', description: 'Already accepted' },
    { id: 'rejected', name: 'Rejected' },
  ] as any[];
  const scheduled = scheduleRejectedCapabilityDescriptions({
    capabilities,
    rejectedIds: new Set(['rejected']),
    authorDescriptions: async selected => {
      assert.deepEqual(selected.map(capability => capability.id), ['rejected']);
      selected[0].description = 'The repaired product description is grounded in supplied evidence.';
    },
  });

  assert.ok(scheduled);
  const outcome = await scheduled;
  assert.equal(outcome.status, 'fulfilled');
  if (outcome.status === 'fulfilled') {
    assert.equal(outcome.value[0].description, 'The repaired product description is grounded in supplied evidence.');
  }
  assert.equal(capabilities[1].description, undefined);
});

test('description repair captures rejection immediately and skips empty work', async () => {
  const error = new Error('provider unavailable');
  const rejected = scheduleRejectedCapabilityDescriptions({
    capabilities: [{ id: 'target', name: 'Target' } as any],
    rejectedIds: new Set(['target']),
    authorDescriptions: async () => { throw error; },
  });
  assert.ok(rejected);
  assert.deepEqual(await rejected, { status: 'rejected', reason: error });
  assert.equal(scheduleRejectedCapabilityDescriptions({
    capabilities: [],
    rejectedIds: new Set(),
    authorDescriptions: async () => undefined,
  }), undefined);
});
