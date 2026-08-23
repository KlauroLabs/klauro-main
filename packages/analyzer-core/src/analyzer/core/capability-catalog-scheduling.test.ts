import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import {
  capabilitiesWithoutDescriptionDisposition,
  capabilityIdentityPendingDescriptionRepair,
  scheduleRejectedCapabilityDescriptions,
  selectCapabilityCatalogPromptCandidates,
  uncoveredCapabilityCatalogCandidateIds,
  capabilityTitlesShareOutcome,
  capabilityCatalogTargetedRepairBatches,
  collectCapabilityCatalogEvidenceBatches,
  capabilityCatalogRepairEvidenceFacts,
  mergeUniquelyMatchedBehaviorEvidence,
  recordCapabilityCatalogRejection,
  updateCapabilityCatalogPublishabilityRepairIds,
} from './capability-catalog-scheduling';

const catalogCapability = (overrides: Partial<SystemCapability>): SystemCapability => ({
  id: 'capability',
  name: 'Analyze Codebase',
  description: 'Builds behavior-level understanding of a codebase.',
  category: 'core',
  operations: [],
  related_entities: [],
  related_domains: [],
  criticality: 'high',
  criticality_factors: [],
  ...overrides,
});

test('uniquely matched behavior evidence enriches an accepted product outcome without replacing its authored identity', () => {
  const accepted = catalogCapability({
    id: 'accepted-analysis',
    operations: [{ entry_point_id: 'existing', entry_point_type: 'command', action: 'analyze repository' }],
    related_entities: ['entity_existing'],
    related_domains: ['codebase'],
    criticality_factors: ['catalog-candidate:cap_analysis_core'],
  });
  const surface = catalogCapability({
    id: 'cap_analysis_mcp_tool_surface',
    name: 'Analysis MCP Tool Surface',
    description: '',
    evidence_kind: 'behavior-surface',
    operations: [{ entry_point_id: 'tool', entry_point_type: 'mcp_tool', action: 'analyze codebase' }],
    related_entities: ['entity_tool'],
    related_domains: ['analysis'],
    evidence_examples: ['analyze codebase'],
  });

  const merged = mergeUniquelyMatchedBehaviorEvidence(
    [accepted],
    [surface],
    [surface.id],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, accepted.name);
  assert.equal(merged[0].description, accepted.description);
  assert.deepEqual(merged[0].operations.map(operation => operation.entry_point_id), ['existing', 'tool']);
  assert.deepEqual(merged[0].related_entities, ['entity_existing', 'entity_tool']);
  assert.deepEqual(merged[0].related_domains, ['codebase', 'analysis']);
  assert.ok(merged[0].criticality_factors.includes(`catalog-candidate:${surface.id}`));
  assert.deepEqual(merged[0].evidence_examples, ['analyze codebase']);
});

test('behavior evidence remains uncovered when its outcome match is ambiguous', () => {
  const surface = catalogCapability({
    id: 'cap_codebase_surface', name: 'Codebase Tool Surface', evidence_kind: 'behavior-surface',
  });
  const capabilities = [
    catalogCapability({ id: 'analysis', name: 'Analyze Codebase' }),
    catalogCapability({ id: 'history', name: 'Track Codebase History' }),
  ];

  const merged = mergeUniquelyMatchedBehaviorEvidence(capabilities, [surface], [surface.id]);

  assert.ok(merged.every(capability => !capability.criticality_factors.includes(`catalog-candidate:${surface.id}`)));
});

test('automatic evidence merge never absorbs entity evidence or an unrequired surface', () => {
  const entity = catalogCapability({ id: 'cap_analysis_entity', name: 'Analysis', evidence_kind: 'infrastructure' });
  const optionalSurface = catalogCapability({ id: 'cap_analysis_optional', name: 'Analysis Tool Surface', evidence_kind: 'behavior-surface' });

  const merged = mergeUniquelyMatchedBehaviorEvidence(
    [catalogCapability({ id: 'analysis' })],
    [entity, optionalSurface],
    [entity.id],
  );

  assert.deepEqual(merged[0].criticality_factors, []);
});

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

test('targeted repair isolates evidence families while a full pass remains one batch', () => {
  const facts = [{ candidate_id: 'workspace' }, { candidate_id: 'fabric' }, { candidate_id: 'history' }];

  assert.deepEqual(capabilityCatalogTargetedRepairBatches(facts, true), facts.map(fact => [fact]));
  assert.deepEqual(capabilityCatalogTargetedRepairBatches(facts, false), [facts]);
});

test('behavior-surface repair facts exclude internal entity names while entity evidence retains them', () => {
  const entityNames = new Map([['entity_config', 'KlauroConfig']]);
  const candidates = [
    { id: 'runtime', evidence_kind: 'behavior-surface', related_entities: ['entity_config'], name: 'Runtime Tool Surface' },
    { id: 'history', evidence_kind: 'entity', related_entities: ['entity_config'], name: 'Change History' },
  ] as SystemCapability[];

  const facts = capabilityCatalogRepairEvidenceFacts(candidates, ['runtime', 'history'], entityNames);

  assert.deepEqual(facts.find(fact => fact.candidate_id === 'runtime')?.entity_names, []);
  assert.deepEqual(facts.find(fact => fact.candidate_id === 'runtime')?.evidence_subject_terms, ['runtime']);
  assert.deepEqual(facts.find(fact => fact.candidate_id === 'history')?.entity_names, ['KlauroConfig']);
  assert.ok(facts.find(fact => fact.candidate_id === 'history')?.evidence_subject_terms.includes('config'));
});

test('capability repair facts carry bounded candidate-specific rejection constraints', () => {
  const candidates = [
    { id: 'agent', name: 'Agent Tool Surface', category: 'core', evidence_kind: 'behavior-surface' },
    { id: 'analysis', name: 'Analysis Tool Surface', category: 'core', evidence_kind: 'behavior-surface' },
  ] as SystemCapability[];
  const rejections = new Map();
  const recorded = recordCapabilityCatalogRejection(rejections, {
    candidateIds: ['agent'],
    name: 'Evaluate agent readiness and task proof',
    reason: 'outcome-scope-unsupported:readiness,task,proof',
  });

  const facts = capabilityCatalogRepairEvidenceFacts(candidates, ['agent', 'analysis'], new Map(), rejections);

  assert.deepEqual(facts[0].prior_rejections, [{
    name: 'Evaluate agent readiness and task proof',
    reason: 'outcome-scope-unsupported:readiness,task,proof',
    forbidden_subject_terms: ['readiness', 'task', 'proof'],
  }]);
  assert.deepEqual(facts[1].prior_rejections, []);
  assert.equal(recorded.added, true);
});

test('evidence batch collection preserves successful families when one focused call times out', async () => {
  const calls: string[][] = [];
  const values = await collectCapabilityCatalogEvidenceBatches({
    facts: ['workspace', 'fabric', 'history'], evidenceScoped: true, batchBudgetMs: 100,
    extract: async batch => {
      calls.push(batch);
      if (batch[0] === 'fabric') throw new Error('focused-deadline');
      return batch.map(value => `authored:${value}`);
    },
    isDeadlineError: error => error instanceof Error && error.message === 'focused-deadline',
  });

  assert.deepEqual(calls, [['workspace'], ['fabric'], ['history']]);
  assert.deepEqual(values, ['authored:workspace', 'authored:history']);
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

test('description rejection preserves the grounded identity but never the rejected prose', () => {
  const capability = {
    id: 'workspace', name: 'Understand workspace context', description: 'Unsupported tracking insights.',
    description_source: 'ai', description_generation: { status: 'ai_applied', attempted: true },
    criticality_factors: ['catalog-candidate:cap_workspace'],
  } as SystemCapability;

  const retained = capabilityIdentityPendingDescriptionRepair(capability, 'description-marketing-language');

  assert.equal(retained?.name, capability.name);
  assert.equal(retained?.description, '');
  assert.equal(retained?.description_source, undefined);
  assert.deepEqual(retained?.description_generation, {
    status: 'ai_rejected', attempted: true, reason: 'description-marketing-language',
  });
  assert.equal(capabilityIdentityPendingDescriptionRepair(capability, 'bare-noun-name'), undefined);
});

test('accepted grounded identity clears an earlier description-repair request for the same family', () => {
  const pending = new Set<string>();
  const candidate = (description?: string) => ({
    id: 'workspace', name: 'Understand workspace context', description,
    criticality_factors: ['catalog-candidate:cap_workspace'],
  }) as SystemCapability;

  updateCapabilityCatalogPublishabilityRepairIds(pending, [candidate()], [candidate('bad')]);

  assert.deepEqual([...pending], []);
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
