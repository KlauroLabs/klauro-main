import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilitiesWithoutDescriptionDisposition,
  scheduleRejectedCapabilityDescriptions,
  selectCapabilityCatalogPromptCandidates,
} from './capability-catalog-scheduling';

test('prompt selection represents every required entity family beyond the baseline window', () => {
  const productCandidates = Array.from({ length: 37 }, (_, index) => ({
    id: `product-${index}`,
    name: `Product ${index}`,
    category: 'core',
    evidence_kind: 'entity',
  }));
  const internalCandidates = Array.from({ length: 49 }, (_, index) => ({
    id: `internal-${index}`,
    name: `Internal ${index}`,
    category: 'internal',
    evidence_kind: 'behavior-surface',
  }));
  const requiredGroups = productCandidates.map(candidate => [candidate.id]);
  const selected = selectCapabilityCatalogPromptCandidates(
    [...productCandidates, ...internalCandidates] as any[],
    requiredGroups,
  );
  const selectedIds = new Set(selected.map(candidate => candidate.id));

  assert.equal(selected.length, 56);
  assert.ok(requiredGroups.every(group => group.some(candidateId => selectedIds.has(candidateId))));
  assert.equal(selected.filter(candidate => candidate.category === 'internal').length, 19);
});

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

test('description scheduling preserves catalog outcomes beyond the element budget', () => {
  const capabilities = [
    { id: 'applied', description_generation: { status: 'ai_applied', attempted: true } },
    { id: 'rejected', description_generation: { status: 'ai_rejected', attempted: true, reason: 'missing-description' } },
    { id: 'undisposed' },
  ] as any[];

  assert.deepEqual(
    capabilitiesWithoutDescriptionDisposition(capabilities).map(capability => capability.id),
    ['undisposed'],
  );
  assert.equal(capabilities[1].description_generation.status, 'ai_rejected');
});
