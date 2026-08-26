import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import { capabilityCatalogPendingRequirementIds, capabilityCatalogRepairPlan, captureCapabilityCatalogPendingRequirements, preserveCapabilityCatalogDescriptionIdentity, supersedeUnboundPendingOutcomeDuplicates } from './capability-catalog-repair-plan';

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

  test('supersedes a pending identity from a different candidate when its semantic slot is replaced', () => {
    const requirement = { id: 'graph', statement: 'build trustworthy relationship graph', candidateIds: ['capability_mcp'], subjectTokens: ['build', 'graph'] };
    const stale = { ...capability('stale', ['catalog-candidate:cap_cas']), name: 'Build a trustworthy relationship graph' };
    const incomingStale = { ...stale, id: 'incoming-stale' };
    const unrelated = capability('architecture', ['catalog-candidate:architecture']);
    const repaired = { ...capability('graph', ['catalog-candidate:capability_mcp', 'catalog-outcome-requirement:graph'], 'The product maps connected software behavior and relationships for inspection.'), name: 'Builds a trustworthy relationship graph' };
    const pendingMatches = new Map([
      ['stale', capabilityCatalogPendingRequirementIds(stale, [requirement])],
      ['incoming-stale', capabilityCatalogPendingRequirementIds(incomingStale, [requirement])],
    ]);

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([stale, unrelated], [incomingStale, repaired], [requirement], pendingMatches), {
      existing: [unrelated], incoming: [repaired],
    });
  });

  test('captures every unbound semantic identity before publishability mutation and preserves its first-seen slots', () => {
    const human = { id: 'human', statement: 'people understand behavior', audience: 'human' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const agent = { id: 'agent', statement: 'agents understand behavior', audience: 'agent' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const combined = { ...capability('combined', ['catalog-candidate:legacy'], 'People and agents understand connected software behavior.'), name: 'Behavior comprehension for people and agents' };
    const map = new Map<string, string[]>();

    captureCapabilityCatalogPendingRequirements(map, [combined], [human, agent]);
    captureCapabilityCatalogPendingRequirements(map, [{ ...combined, name: 'Unrelated renamed identity', description: 'No semantic match remains.' }], [human, agent]);

    assert.deepEqual(map.get('combined'), ['human', 'agent']);
    const incomingCombined = { ...combined };
    const humanBound = { ...capability('human', ['catalog-candidate:shared', 'catalog-outcome-requirement:human'], 'People understand connected software behavior.'), name: 'People understand behavior' };
    const agentBound = { ...capability('agent', ['catalog-candidate:shared', 'catalog-outcome-requirement:agent'], 'Agents understand connected software behavior.'), name: 'Agents understand behavior' };
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
      [combined], [incomingCombined, humanBound, agentBound], [human, agent], map,
    ), { existing: [], incoming: [humanBound, agentBound] });
  });

  test('retains pending identities for empty matches and invalid bound replacements', () => {
    const requirement = { id: 'graph', statement: 'build trustworthy relationship graph', candidateIds: ['graph', 'shared'], subjectTokens: ['build', 'graph'] };
    const pending = { ...capability('pending', ['catalog-candidate:other']), name: 'Build a relationship graph' };
    const empty = capability('empty', ['catalog-candidate:other']);
    const invalidBound = { ...capability('invalid', ['catalog-candidate:shared', 'catalog-outcome-requirement:graph']), name: 'Build a relationship graph' };

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
      [pending, empty], [invalidBound], [requirement], new Map([['pending', ['graph']], ['empty', []]]),
    ), {
      existing: [pending, empty], incoming: [invalidBound],
    });
  });

  test('requires every audience slot matched by a combined pending identity to be replaced', () => {
    const human = { id: 'human', statement: 'people understand behavior', audience: 'human' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const agent = { id: 'agent', statement: 'agents understand behavior', audience: 'agent' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const pending = { ...capability('pending', ['catalog-candidate:shared']), name: 'Help people and agents understand behavior' };
    const humanBound = { ...capability('human', ['catalog-candidate:shared', 'catalog-outcome-requirement:human'], 'People understand connected software behavior.'), name: 'Help people understand behavior' };
    const agentBound = { ...capability('agent', ['catalog-candidate:shared', 'catalog-outcome-requirement:agent'], 'Agents understand connected software behavior.'), name: 'Help agents understand behavior' };
    const pendingMatches = new Map([['pending', ['human', 'agent']]]);

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending], [humanBound], [human, agent], pendingMatches), {
      existing: [pending], incoming: [humanBound],
    });
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending], [humanBound, agentBound], [human, agent], pendingMatches), {
      existing: [], incoming: [humanBound, agentBound],
    });
  });

  test('supersedes combined graph and runtime wording only when both bound replacements are valid', () => {
    const graph = { id: 'graph', statement: 'build trustworthy relationship graph', candidateIds: ['surface'], subjectTokens: ['build', 'graph'] };
    const runtime = { id: 'runtime', statement: 'correlate static analysis with runtime evidence', candidateIds: ['surface'], subjectTokens: ['runtime', 'evidence'] };
    const pending = { ...capability('pending', ['catalog-candidate:unrelated']), name: 'Build a graph and correlate runtime evidence' };
    const graphBound = { ...capability('graph', ['catalog-candidate:surface', 'catalog-outcome-requirement:graph'], 'The product maps connected software behavior and relationships for inspection.'), name: 'Builds a trustworthy relationship graph' };
    const runtimeBound = { ...capability('runtime', ['catalog-candidate:surface', 'catalog-outcome-requirement:runtime'], 'Runtime evidence is correlated with static analysis.'), name: 'Correlate runtime evidence' };
    const pendingMatches = new Map([['pending', ['graph', 'runtime']]]);

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending], [graphBound], [graph, runtime], pendingMatches), {
      existing: [pending], incoming: [graphBound],
    });
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending], [graphBound, runtimeBound], [graph, runtime], pendingMatches), {
      existing: [], incoming: [graphBound, runtimeBound],
    });
  });

  test('preserves pending matches from rejected description prose through a publishable incoming repair', () => {
    const human = { id: 'human', statement: 'people understand behavior', audience: 'human' as const, candidateIds: ['surface'], subjectTokens: ['understand', 'behavior'] };
    const original = { ...capability('pending', ['catalog-candidate:legacy'], 'The graph helps people understand software behavior.'), name: 'Behavior comprehension' };
    const cleared = { ...original, description: '', description_generation: { attempted: true, status: 'ai_rejected' as const } };
    const incomingRepair = { ...cleared, description: 'A clearer product description.', description_generation: { attempted: true, status: 'ai_applied' as const } };
    const humanBound = { ...capability('human', ['catalog-candidate:surface', 'catalog-outcome-requirement:human'], 'People understand connected software behavior.'), name: 'Help people understand behavior' };
    const matched = capabilityCatalogPendingRequirementIds(original, [human]);

    assert.deepEqual(matched, ['human']);
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([cleared], [incomingRepair, humanBound], [human], new Map([['pending', matched]])), {
      existing: [], incoming: [humanBound],
    });
  });

  test('keeps unrelated evidence-family identities and leaves bound replacements unchanged', () => {
    const graph = { id: 'graph', statement: 'build trustworthy relationship graph', candidateIds: ['surface'], subjectTokens: ['build', 'graph'] };
    const pending = { ...capability('pending', ['catalog-candidate:legacy']), name: 'Build a trustworthy relationship graph' };
    const evidenceGap = capability('evidence-gap', ['catalog-candidate:architecture']);
    const bound = { ...capability('graph', ['catalog-candidate:surface', 'catalog-outcome-requirement:graph'], 'The product maps connected software behavior and relationships for inspection.'), name: 'Builds a trustworthy relationship graph' };

    const result = supersedeUnboundPendingOutcomeDuplicates(
      [pending, evidenceGap], [bound], [graph], new Map([['pending', ['graph']]]),
    );
    assert.deepEqual(result, { existing: [evidenceGap], incoming: [bound] });
    assert.strictEqual(result.incoming[0], bound);
  });

  test('rejects wrong requirement IDs, wrong primary candidates, nonpublishable, and semantically invalid replacements', () => {
    const graph = { id: 'graph', statement: 'build trustworthy relationship graph', candidateIds: ['surface'], subjectTokens: ['build', 'graph'] };
    const pending = { ...capability('pending', ['catalog-candidate:legacy']), name: 'Build a trustworthy relationship graph' };
    const wrongId = capability('wrong-id', ['catalog-candidate:surface', 'catalog-outcome-requirement:other'], 'Builds a trustworthy graph.');
    const wrongCandidate = capability('wrong-candidate', ['catalog-candidate:legacy', 'catalog-outcome-requirement:graph'], 'Builds a trustworthy graph.');
    const nonpublishable = capability('nonpublishable', ['catalog-candidate:surface', 'catalog-outcome-requirement:graph']);
    const invalidProse = capability('invalid-prose', ['catalog-candidate:surface', 'catalog-outcome-requirement:graph'], 'Provides a concise product summary.');
    const pendingMatches = new Map([['pending', ['graph']]]);

    for (const replacement of [wrongId, wrongCandidate, nonpublishable, invalidProse]) {
      assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending], [replacement], [graph], pendingMatches), {
        existing: [pending], incoming: [replacement],
      });
    }
  });
});
