import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import {
  capabilitiesWithoutDescriptionDisposition,
  scheduleRejectedCapabilityDescriptions,
  selectCapabilityCatalogPromptCandidates,
  uncoveredCapabilityCatalogCandidateIds,
  capabilityTitlesShareOutcome,
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

test('prompt selection retains nonmandatory supporting and verification surfaces as context', () => {
  const selected = selectCapabilityCatalogPromptCandidates([
    { id: 'required', name: 'Review work', category: 'core', evidence_kind: 'behavior-surface', evidence_role: 'product-outcome' },
    { id: 'support', name: 'Coordinate transport', category: 'supporting', evidence_kind: 'behavior-surface', evidence_role: 'supporting-mechanism' },
    { id: 'proof', name: 'Exercise proof', category: 'supporting', evidence_kind: 'behavior-surface', evidence_role: 'verification-harness' },
  ] as any[]);

  assert.deepEqual(selected.map(candidate => candidate.id), ['required', 'support', 'proof']);
});

test('prompt selection requires a first-party-backed internal surface to be mapped to an outcome', () => {
  const selected = selectCapabilityCatalogPromptCandidates([
    {
      id: 'fabric', name: 'Fabric MCP Tool Surface', category: 'internal', evidence_kind: 'behavior-surface',
      evidence_role: 'unresolved', evidence_role_reasons: ['first-party-product-delivery-surface-requires-outcome-mapping'],
    },
    { id: 'bootstrap', name: 'Bootstrap Surface', category: 'internal', evidence_kind: 'behavior-surface', evidence_role: 'unresolved' },
  ] as any[]);

  assert.equal(selected[0].id, 'fabric');
});

test('recognizes analysis verb variants as the same product outcome without merging other actions', () => {
  assert.equal(capabilityTitlesShareOutcome(
    { name: 'Analyze codebase' } as SystemCapability,
    { name: 'Run codebase analysis' } as SystemCapability,
  ), true);
  assert.equal(capabilityTitlesShareOutcome(
    { name: 'Generate codebase report' } as SystemCapability,
    { name: 'Analyze codebase report' } as SystemCapability,
  ), false);
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

test('targeted catalog repair converges when full passes omit different families', () => {
  const requiredGroups = Array.from({ length: 37 }, (_, index) => [`family-${index}`]);
  const capability = (id: string) => ({
    id,
    criticality_factors: [`catalog-candidate:${id}`],
  }) as any;
  const firstFullPass = requiredGroups.slice(0, 20).map(([id]) => capability(id));
  const firstRepairIds = uncoveredCapabilityCatalogCandidateIds(firstFullPass, [], requiredGroups);
  const firstRepair = firstRepairIds.filter((_, index) => index % 2 === 0).map(capability);
  const partiallyRepaired = [...firstFullPass, ...firstRepair];
  const secondRepairIds = uncoveredCapabilityCatalogCandidateIds(partiallyRepaired, [], requiredGroups);
  const fullyRepaired = [...partiallyRepaired, ...secondRepairIds.map(capability)];

  assert.equal(firstRepairIds.length, 17);
  assert.equal(secondRepairIds.length, 8);
  assert.deepEqual(uncoveredCapabilityCatalogCandidateIds(fullyRepaired, [], requiredGroups), []);
});
