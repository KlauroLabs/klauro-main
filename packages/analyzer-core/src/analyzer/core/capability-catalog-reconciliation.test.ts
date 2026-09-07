import assert from 'node:assert/strict';
import test from 'node:test';
import type { SystemCapability } from '../../types/cas.types';
import type { CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';
import { buildCapabilityCatalogReconciliation } from './capability-catalog-reconciliation';

const capability = (id: string, name: string, candidateId: string): SystemCapability => ({
  id, name, description: name, category: 'core', criticality: 'medium', criticality_factors: ['catalog-candidate:' + candidateId],
  operations: [], related_entities: [], related_domains: [],
});
const requirement = (id: string, text: string, candidateIds: string[]): CapabilityCatalogOutcomeRequirement => ({
  id, statement: text, firstPartyOutcomeText: text, candidateIds, subjectTokens: ['invoice'],
});

test('reconciliation retains normalized grounding, raw citations, gaps and undocumented outcomes', () => {
  const declared = requirement('invoice', 'Settle invoices', ['operation-obligation:billing:write']);
  const ungrounded = requirement('forecast', 'Predict future invoices', []);
  const normalized = { ...declared, candidateIds: ['billing'] };
  const input = {
    requiredOutcomes: [declared, ungrounded],
    normalizedOutcomeRequirements: [normalized, ungrounded],
    publishedCapabilities: [capability('payments', 'Settle invoices', 'billing'), capability('notes', 'Organize notes', 'notes')],
    intentGapRequirements: [ungrounded],
    unresolvedRejectedProductOutcomeIds: ['pending', 'nameless'],
    evidenceCandidates: [{ ...capability('pending', 'Internal handler', 'pending'), structural_label: 'Pending invoices' }],
  };
  const before = structuredClone(input);
  const result = buildCapabilityCatalogReconciliation(input);
  assert.deepEqual(result.proposals.map(proposal => [proposal.requirement_id, proposal.disposition, proposal.capability_ids]), [
    ['invoice', 'grounded', ['payments']], ['forecast', 'intent-gap', []],
  ]);
  assert.deepEqual(result.proposals[0].candidate_ids, declared.candidateIds);
  assert.deepEqual(result.undocumented_capabilities, [{ capability_id: 'notes', name: 'Organize notes' }]);
  assert.deepEqual(result.structural_gaps?.map(gap => [gap.candidate_id, gap.name]), [
    ['pending', 'Pending invoices'], ['nameless', 'nameless'],
  ]);
  assert.deepEqual(input, before);
});

test('empty reconciliation does not manufacture proposals, capabilities or structural gaps', () => {
  assert.deepEqual(buildCapabilityCatalogReconciliation({
    requiredOutcomes: [], normalizedOutcomeRequirements: [], publishedCapabilities: [],
    intentGapRequirements: [], unresolvedRejectedProductOutcomeIds: [], evidenceCandidates: [],
  }), { proposals: [], undocumented_capabilities: [] });
});

test('explicit declarations without corroborating candidates stay visible without becoming capabilities', () => {
  const firstPartyEvidence = { statements: [
    'Know what will break before changing something.',
    'Pay bills.',
    'Predict customer demand.',
    'Exceptionally fast.',
    'Hail a ride.',
  ].map(value => ({ role: 'feature' as const, value, source: 'PRODUCT.md' })) };
  const requirements = [
    requirement('risk', firstPartyEvidence.statements[0].value.slice(0, -1), ['risk']),
    requirement('billing', firstPartyEvidence.statements[1].value.slice(0, -1), ['billing']),
  ];
  const original = structuredClone(firstPartyEvidence);
  const result = buildCapabilityCatalogReconciliation({
    requiredOutcomes: requirements, normalizedOutcomeRequirements: requirements,
    publishedCapabilities: [], intentGapRequirements: requirements,
    unresolvedRejectedProductOutcomeIds: [],
    evidenceCandidates: [capability('risk', 'Change impact', 'risk'), capability('billing', 'Bill payment', 'billing')],
    firstPartyEvidence,
  });
  assert.deepEqual(result.unverified_declarations,
    firstPartyEvidence.statements.slice(2).map(statement => ({ ...statement, reason: 'no-corroborating-candidate' })));
  assert.deepEqual(result.proposals.map(proposal => proposal.disposition), ['intent-gap', 'intent-gap']);
  assert.deepEqual(result.undocumented_capabilities, []);
  assert.deepEqual(firstPartyEvidence, original);
});

test('unverified declaration reporting retains unfamiliar text and qualifications but does not promote examples', () => {
  const firstPartyEvidence = { statements: [
    { role: 'feature' as const, value: 'Read records without changing them.', source: 'README.md' },
    { role: 'feature' as const, value: 'Read records and change them.', source: 'PRD.md' },
    { role: 'feature' as const, value: '走る', source: 'PRD.md' },
    { role: 'feature' as const, value: 'Recover bills.', source: 'PRD.md' },
    { role: 'example' as const, value: 'Which record changed yesterday?', source: 'README.md' },
    { role: 'context' as const, value: 'Records are persisted.', source: 'README.md' },
  ] };
  const requirements = [
    requirement('read', 'Read records without changing them', ['read']),
    requirement('stale', 'Recover bills', ['missing']),
  ];
  const result = buildCapabilityCatalogReconciliation({
    requiredOutcomes: requirements, normalizedOutcomeRequirements: requirements,
    publishedCapabilities: [], intentGapRequirements: requirements,
    unresolvedRejectedProductOutcomeIds: [], evidenceCandidates: [capability('read', 'Read records', 'read')],
    firstPartyEvidence,
  });
  assert.deepEqual(result.unverified_declarations,
    firstPartyEvidence.statements.slice(1, 4).map(statement => ({ ...statement, reason: 'no-corroborating-candidate' })));
});
