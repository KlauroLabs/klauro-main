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
