import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import { capabilityCatalogRepairPlan, preserveCapabilityCatalogDescriptionIdentity } from './capability-catalog-repair-plan';

const capability = (id: string, factors: string[], description = '') => ({
  id, name: `Outcome ${id}`, description, category: 'core', criticality: 'high', criticality_factors: factors,
  operations: [], related_entities: [], related_domains: [],
}) as SystemCapability;

describe('capability catalog repair planning', () => {
  test('separates graph, audience, runtime, and unrelated evidence repair contracts', () => {
    const human = { id: 'human', statement: 'People understand behavior', audience: 'human' as const, candidateIds: ['mcp'], subjectTokens: ['understand'] };
    const runtime = { id: 'runtime', statement: 'Static understanding correlates with runtime evidence', candidateIds: ['mcp'], subjectTokens: ['runtime'] };
    const graph = capability('graph', ['catalog-candidate:graph', 'catalog-outcome-requirement:graph-slot']);
    const graphRequirement = { id: 'graph-slot', statement: 'Build a trustworthy relationship graph', candidateIds: ['graph'], subjectTokens: ['trust', 'relation'] };
    const plan = capabilityCatalogRepairPlan({
      evidenceCandidateIds: ['architecture', 'graph', 'mcp'],
      outcomeRequirements: [human, runtime, graphRequirement],
      pendingCapabilities: [graph],
    });

    assert.deepEqual(plan.map(batch => batch.mode), ['description', 'outcome', 'outcome', 'evidence']);
    assert.deepEqual(plan[0], { mode: 'description', candidateIds: ['graph'], requirements: [graphRequirement], identity: graph });
    assert.deepEqual(plan[1], { mode: 'outcome', candidateIds: ['mcp'], requirements: [human] });
    assert.deepEqual(plan[2], { mode: 'outcome', candidateIds: ['mcp'], requirements: [runtime] });
    assert.deepEqual(plan[3], { mode: 'evidence', candidateIds: ['architecture'], requirements: [] });
  });

  test('description repair preserves the stable identity while accepting only replacement prose', () => {
    const identity = capability('graph', ['catalog-candidate:graph', 'catalog-outcome-requirement:graph-slot']);
    const repaired = preserveCapabilityCatalogDescriptionIdentity(identity, capability('renamed', ['catalog-candidate:other'], 'Grounded product prose.'));

    assert.equal(repaired.id, 'graph');
    assert.equal(repaired.name, 'Outcome graph');
    assert.equal(repaired.description, 'Grounded product prose.');
    assert.deepEqual(repaired.criticality_factors, ['catalog-candidate:graph', 'catalog-outcome-requirement:graph-slot']);
  });
});
