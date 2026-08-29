import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import { capabilityCatalogFocusedTask, capabilityCatalogPendingRequirementIds, capabilityCatalogRepairNudge, capabilityCatalogRepairPlan, captureCapabilityCatalogPendingRequirements, preserveCapabilityCatalogDescriptionIdentity, supersedeUnboundPendingOutcomeDuplicates } from './capability-catalog-repair-plan';

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
    const identity = { ...capability('graph', ['catalog-candidate:graph', 'catalog-outcome-requirement:graph-slot']), name: 'Access job sites by user' };
    const repaired = preserveCapabilityCatalogDescriptionIdentity(identity, { ...capability('renamed', ['catalog-candidate:other'], 'Users access saved job sites from each application record.'), name: 'Manage job applications' });

    assert.equal(repaired.id, 'graph');
    assert.equal(repaired.name, 'Access job sites by user');
    assert.equal(repaired.description, 'Users access saved job sites from each application record.');
    assert.deepEqual(repaired.criticality_factors, ['catalog-candidate:graph', 'catalog-outcome-requirement:graph-slot']);
  });

  test('description repair names the stable identity and carries prior validator feedback', () => {
    const identity = { ...capability('access', ['catalog-candidate:job']), name: 'Access job sites by user' };
    const batch = { mode: 'description' as const, candidateIds: ['job'], requirements: [], identity };
    const task = capabilityCatalogFocusedTask(batch.mode, identity.name);
    const nudge = capabilityCatalogRepairNudge(batch, [{ candidate_id: 'candidate_1', stable_capability_name: identity.name }], 'missing description', 'Remove marketing-language token organized.');

    assert.match(task, /Access job sites by user/);
    assert.match(task, /stable_capability_name/);
    assert.match(task, /description that explains that exact named outcome/);
    assert.match(nudge, /missing description/);
    assert.match(nudge, /Remove marketing-language token organized/);
    assert.match(nudge, /forbidden_subject_terms is prohibited from both name and description/);
    assert.match(nudge, /every lifecycle action listed in observable_actions/);
    assert.match(nudge, /durable user-outcome language/);
    assert.match(nudge, /not by mechanically enumerating transport or CRUD operation labels/);
    assert.match(nudge, /Do not copy a route phrase/);
    assert.match(nudge, /without inventing its effects/);
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

  test('uses strict bound replacements accumulated across repair cycles', () => {
    const human = { id: 'human', statement: 'people understand behavior', audience: 'human' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const agent = { id: 'agent', statement: 'agents understand behavior', audience: 'agent' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const pending = { ...capability('pending', ['catalog-candidate:shared']), name: 'People and agents understand behavior' };
    const humanBound = { ...capability('human', ['catalog-candidate:shared', 'catalog-outcome-requirement:human'], 'People understand connected software behavior.'), name: 'People understand behavior' };
    const agentBound = { ...capability('agent', ['catalog-candidate:shared', 'catalog-outcome-requirement:agent'], 'Agents understand connected software behavior.'), name: 'Agents understand behavior' };
    const pendingMatches = new Map([['pending', ['human', 'agent']]]);

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending, humanBound], [agentBound], [human, agent], pendingMatches), {
      existing: [humanBound], incoming: [agentBound],
    });
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending, agentBound], [humanBound], [human, agent], pendingMatches), {
      existing: [agentBound], incoming: [humanBound],
    });
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending, humanBound], [], [human, agent], pendingMatches), {
      existing: [pending, humanBound], incoming: [],
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

  test('preserves a broad accepted outcome when narrower repairs match only its description', () => {
    const status = {
      id: 'status', statement: 'manage application status', candidateIds: ['status-surface'],
      requiredSubjectTerms: ['statu'], subjectTokens: ['statu'], minimumSubjectMatches: 1,
    };
    const umbrella = {
      ...capability('manage-jobs', ['catalog-candidate:job-surface'], 'Users manage job applications, update status, and add notes.'),
      name: 'Manage job applications',
    };
    const repairedStatus = {
      ...capability('status', ['catalog-candidate:status-surface', 'catalog-outcome-requirement:status'], 'Users update job application status.'),
      name: 'Manage application status',
    };

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
      [umbrella],
      [repairedStatus],
      [status],
      new Map([['manage-jobs', ['status']]]),
    ), {
      existing: [umbrella],
      incoming: [repairedStatus],
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
    const rejectedEvidence = { ...capability('rejected-evidence', ['catalog-candidate:surface', 'catalog-outcome-requirement:graph', 'catalog-evidence-rejected:uncited'], 'Builds a trustworthy relationship graph.'), name: 'Builds a trustworthy relationship graph' };
    const pendingMatches = new Map([['pending', ['graph']]]);

    for (const replacement of [wrongId, wrongCandidate, nonpublishable, invalidProse, rejectedEvidence]) {
      assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending], [replacement], [graph], pendingMatches), {
        existing: [pending], incoming: [replacement],
      });
    }
  });
  test('supersedes a shorter synonymous unbound title only when a strict bound outcome covers its subject', () => {
    const requirement = {
      id: 'collaboration',
      statement: 'enable real-time collaboration across overlapping shared work concepts',
      candidateIds: ['surface'],
      requiredSubjectTerms: ['collaborate', 'work', 'concept'],
      subjectTokens: ['collaborate', 'work', 'concept'],
      minimumSubjectMatches: 2,
    };
    const pending = {
      ...capability('pending', ['catalog-candidate:legacy'], 'Teams coordinate changes across overlapping concepts in real time.'),
      name: 'Enable real-time collaboration across overlapping concepts',
    };
    const distinct = {
      ...capability('review', ['catalog-candidate:legacy'], 'Teams coordinate review sessions in real time.'),
      name: 'Enables real-time coordination through review sessions',
    };
    const replacement = {
      ...capability('bound', ['catalog-candidate:surface', 'catalog-outcome-requirement:collaboration'], 'Teams collaborate on overlapping shared work concepts in real time.'),
      name: 'Enable real-time collaboration on overlapping shared work concepts',
    };
    const result = supersedeUnboundPendingOutcomeDuplicates(
      [pending, distinct],
      [replacement],
      [requirement],
      new Map([['pending', []], ['review', []]]),
    );

    assert.deepEqual(result, { existing: [distinct], incoming: [replacement] });
  });
  test('uses a strict requirement binding as the replacement identity despite title paraphrase', () => {
    const requirement = {
      id: 'agent-understanding', audience: 'agent' as const, audienceLabel: 'agents',
      statement: 'behavior-level understanding for agents', candidateIds: ['surface'],
      requiredSubjectTerms: ['behavior', 'understand'], subjectTokens: ['behavior', 'understand'],
      minimumSubjectMatches: 2,
    };
    const pending = {
      ...capability('pending-agent', ['catalog-candidate:legacy'], 'Agents understand software behavior before changing it.'),
      name: 'Help agents understand software behavior',
    };
    const replacement = {
      ...capability('bound-agent', ['catalog-candidate:surface', 'catalog-outcome-requirement:agent-understanding'], 'AI agents understand software behavior before planning changes.'),
      name: 'Equip AI agents for dependable change planning',
    };
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
      [pending], [replacement], [requirement], new Map([['pending-agent', ['agent-understanding']]]),
    ), { existing: [], incoming: [replacement] });

    const actorless = {
      ...replacement,
      id: 'actorless',
      description: 'Grounded context supports dependable change planning.',
    };
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
      [pending], [actorless], [requirement], new Map([['pending-agent', ['agent-understanding']]]),
    ), { existing: [pending], incoming: [actorless] });

    const mixed = {
      ...replacement,
      id: 'mixed',
      name: 'Equip people and AI agents for dependable change planning',
      description: 'People and AI agents receive grounded context before planning changes.',
    };
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
      [pending], [mixed], [requirement], new Map([['pending-agent', ['agent-understanding']]]),
    ), { existing: [pending], incoming: [mixed] });
  });


  test('does not infer empty-capture supersession across audience, action, token, or binding boundaries', () => {
    const requirement = {
      id: 'collaboration',
      statement: 'enable real-time collaboration across overlapping shared work concepts',
      candidateIds: ['surface'],
      requiredSubjectTerms: ['collaborate', 'work', 'concept'],
      subjectTokens: ['collaborate', 'work', 'concept'],
      minimumSubjectMatches: 2,
    };
    const replacement = {
      ...capability('bound', ['catalog-candidate:surface', 'catalog-outcome-requirement:collaboration'], 'Teams collaborate on overlapping shared work concepts in real time.'),
      name: 'Enable real-time collaboration on overlapping shared work concepts',
    };
    const assertRetained = (
      pending: SystemCapability,
      candidate: SystemCapability,
      scopedRequirement: typeof requirement | (typeof requirement & { audience: 'human' }),
    ) => {
      assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
        [pending], [candidate], [scopedRequirement], new Map([[pending.id, []]]),
      ), { existing: [pending], incoming: [candidate] });
    };

    const audiencePending = {
      ...capability('audience-pending', ['catalog-candidate:legacy']),
      name: 'Enable real-time collaboration on shared work',
      description: 'People collaborate on overlapping shared work concepts in real time.',
    };
    const audienceReplacement = {
      ...replacement,
      description: 'People collaborate on overlapping shared work concepts in real time.',
      name: 'Enable people real-time collaboration on overlapping shared work concepts',
    };
    assertRetained(audiencePending, audienceReplacement, { ...requirement, audience: 'human' });

    assertRetained({
      ...capability('action-pending', ['catalog-candidate:legacy']),
      name: 'Review real-time collaboration on shared work',
    }, replacement, requirement);

    assertRetained({
      ...capability('partial-pending', ['catalog-candidate:legacy']),
      name: 'Enable real-time collaboration reports for shared work',
    }, replacement, requirement);

    const wrongCandidate = {
      ...replacement,
      id: 'wrong-candidate',
      criticality_factors: ['catalog-candidate:legacy', 'catalog-outcome-requirement:collaboration'],
    };
    assertRetained({
      ...capability('invalid-pending', ['catalog-candidate:legacy']),
      name: 'Enable real-time collaboration on shared work',
    }, wrongCandidate, requirement);
  });

});
