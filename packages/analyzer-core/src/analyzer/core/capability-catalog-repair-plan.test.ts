import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import { capabilityCatalogRepairPlan, preserveCapabilityCatalogDescriptionIdentity, supersedeUnboundPendingOutcomeDuplicates } from './capability-catalog-repair-plan';

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

  test('successful bound repair supersedes only its unbound pending semantic duplicate', () => {
    const requirement = { id: 'graph', statement: 'build trustworthy relationship graph', candidateIds: ['graph-source', 'shared-surface'], subjectTokens: ['build', 'graph'] };
    const stale = { ...capability('stale', ['catalog-candidate:graph-source']), name: 'Build a trustworthy relationship graph' };
    const incomingStale = { ...stale, id: 'incoming-stale' };
    const unrelated = capability('architecture', ['catalog-candidate:architecture']);
    const repaired = { ...capability('graph', ['catalog-candidate:shared-surface', 'catalog-outcome-requirement:graph'], 'The product maps connected software behavior and relationships for inspection.'), name: 'Builds a trustworthy relationship graph' };

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([stale, unrelated], [incomingStale, repaired], [requirement]), {
      existing: [unrelated], incoming: [repaired],
    });
  });

  test('does not supersede pending identities without a valid bound replacement', () => {
    const requirement = { id: 'graph', statement: 'build trustworthy relationship graph', candidateIds: ['graph', 'shared'], subjectTokens: ['build', 'graph'] };
    const pending = { ...capability('pending', ['catalog-candidate:graph']), name: 'Build a relationship graph' };
    const unrelated = { ...capability('unrelated', ['catalog-candidate:other']), name: 'Build a relationship graph' };
    const invalidBound = { ...capability('invalid', ['catalog-candidate:shared', 'catalog-outcome-requirement:graph']), name: 'Build a relationship graph' };

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending, unrelated], [invalidBound], [requirement]), {
      existing: [pending, unrelated], incoming: [invalidBound],
    });
  });

  test('does not supersede an unbound identity that matches multiple shared-candidate audience requirements', () => {
    const human = { id: 'human', statement: 'people understand behavior', audience: 'human' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const agent = { id: 'agent', statement: 'agents understand behavior', audience: 'agent' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const pending = { ...capability('pending', ['catalog-candidate:shared']), name: 'Help people and agents understand behavior' };
    const humanBound = { ...capability('human', ['catalog-candidate:shared', 'catalog-outcome-requirement:human'], 'People understand connected software behavior.'), name: 'Help people understand behavior' };
    const agentBound = { ...capability('agent', ['catalog-candidate:shared', 'catalog-outcome-requirement:agent'], 'Agents understand connected software behavior.'), name: 'Help agents understand behavior' };

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending], [humanBound, agentBound], [human, agent]), {
      existing: [pending], incoming: [humanBound, agentBound],
    });
  });

  test('isolates separate shared-candidate slots while superseding a uniquely matched pending identity', () => {
    const human = { id: 'human', statement: 'people understand behavior', audience: 'human' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const agent = { id: 'agent', statement: 'agents understand behavior', audience: 'agent' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const pendingHuman = { ...capability('pending-human', ['catalog-candidate:shared']), name: 'Help people understand behavior' };
    const pendingAgent = { ...capability('pending-agent', ['catalog-candidate:shared']), name: 'Explain behavior without naming an audience' };
    const humanBound = { ...capability('human', ['catalog-candidate:shared', 'catalog-outcome-requirement:human'], 'People understand connected software behavior.'), name: 'Help people understand behavior' };

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pendingHuman, pendingAgent], [humanBound], [human, agent]), {
      existing: [pendingAgent], incoming: [humanBound],
    });
  });
});
