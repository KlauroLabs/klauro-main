import assert from 'node:assert/strict';
import test from 'node:test';
import type { SystemCapability } from '../../types/cas.types';
import {
  audienceScopedCapabilityCatalogOutcomeText,
  bindAtomicallySatisfiedCatalogOutcomeRequirements,
  bindUniquelySatisfiedCatalogOutcomeRequirements,
  capabilityCatalogOutcomeBindingFailure,
  capabilityCatalogOutcomeBindingFailureDetail,
  capabilityCatalogOutcomeCoverageFailure,
  canonicalCapabilityCatalogOutcomeToken,
  capabilityCatalogOutcomeNameFailure,
  capabilityCatalogOutcomesMayMerge,
  capabilitySatisfiesCatalogOutcomeRequirement,
  deriveCapabilityCatalogOutcomeRequirements,
  uncoveredCapabilityCatalogOutcomeRequirements,
  type CapabilityCatalogOutcomeRequirement,
} from './capability-catalog-outcome-coverage';

const candidate = (id: string, name: string, examples: string[]): SystemCapability => ({
  id,
  name,
  structural_label: name,
  description: `${name} is supported by observed product behavior.`,
  category: 'core',
  criticality: 'medium',
  criticality_factors: [],
  evidence_examples: examples,
  related_domains: [],
  related_entities: [],
  operations: examples.map((action, index) => ({
    action,
    entry_point_id: `${id}-${index}`,
    entry_point_type: 'message',
  })),
} as SystemCapability);

const published = (name: string, description: string): SystemCapability => ({
  id: name,
  name,
  description,
  name_source: 'ai',
  description_source: 'ai',
  category: 'core',
  criticality: 'medium',
  criticality_factors: [],
  related_domains: [],
  related_entities: [],
  operations: [],
} as SystemCapability);

const cited = (capability: SystemCapability, requirement: CapabilityCatalogOutcomeRequirement): SystemCapability => ({
  ...capability,
  criticality_factors: [`catalog-candidate:${requirement.candidateIds[0]}`],
});

const signal = {
  productDocSummary: 'The product builds a trustworthy relationship graph, turns that graph into behavior-level comprehension for people and AI agents, enables real-time collaboration, and correlates static understanding with runtime evidence.',
};

const evidence = [
  candidate('graph', 'Relationship graph analysis', ['query_graph_relationships']),
  candidate('understanding', 'Explore connected software behavior', ['inspect_behavior', 'explain_change_risk']),
  candidate('collaboration', 'Coordinate real-time collaboration', ['coordinate_overlapping_work']),
  candidate('runtime', 'Runtime evidence correlation', ['correlate_runtime_evidence']),
];

test('treats support staff as the audience and onboarding as the visible action', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'This service lets support staff onboard customers with profiles, then retrieve those profiles while assisting them.',
  }, [candidate('profiles', 'Customer profiles', ['onboard_customer_profile', 'retrieve_customer_profile'])]);

  assert.equal(requirements.length, 2);
  const onboarding = requirements.find(requirement => requirement.visibleActionTerms?.includes('onboard'));
  assert.ok(onboarding);
  assert.equal(capabilityCatalogOutcomeNameFailure('Onboard customers with profiles', onboarding), undefined);
});

test('grounds an operator-facing list outcome through equivalent read evidence', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'Fleet operators list vehicles for daily dispatch.',
  }, [candidate('vehicles', 'Read vehicle', ['read_vehicle'])]);

  assert.equal(requirements.length, 1);
  assert.deepEqual(requirements[0].visibleActionTerms, ['list']);
  assert.deepEqual(requirements[0].candidateIds, ['vehicles']);
  assert.equal(capabilityCatalogOutcomeNameFailure('List fleet vehicles', requirements[0]), undefined);
});

test('preserves authored outcomes without matching implementation as intent-gap proposals', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'Operators export compliance reports for external auditors.',
  }, []);

  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].firstPartyOutcomeText, 'Operators export compliance reports for external auditors');
  assert.deepEqual(requirements[0].candidateIds, []);
  assert.deepEqual(requirements[0].visibleActionTerms, ['export']);
  assert.equal(uncoveredCapabilityCatalogOutcomeRequirements([], requirements).length, 1);
  assert.equal(capabilityCatalogOutcomeCoverageFailure([], requirements), undefined,
    'an ungrounded product promise remains an intent gap and does not become a fabricated catalog quota');
});

test('requires separately stated first-party human, agent, and truth outcomes when structural evidence corroborates them', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const agent = requirements.find(requirement => requirement.audience === 'agent')!;
  const graph = requirements.find(requirement => requirement.subjectTokens.includes('relation'))!;
  const collaboration = requirements.find(requirement => requirement.subjectTokens.includes('collaborate'))!;
  const runtime = requirements.find(requirement => requirement.subjectTokens.includes('runtime'))!;
  assert.match(human.firstPartyOutcomeText || '', /people and AI agents/i);
  assert.equal(human.audienceScopedOutcomeText, 'turns that graph into behavior-level comprehension for people');
  assert.equal(agent.audienceScopedOutcomeText, 'turns that graph into behavior-level comprehension for agents');
  assert.deepEqual(graph.visibleActionTerms, ['build']);
  assert.deepEqual(human.visibleActionTerms, ['turn']);
  assert.deepEqual(agent.visibleActionTerms, ['turn']);
  assert.deepEqual(collaboration.visibleActionTerms, ['enable']);
  assert.deepEqual(runtime.visibleActionTerms, ['correlate']);
  const incomplete = [
    cited(published('Give AI agents software comprehension', 'Agents understand connected software behavior before changing code.'), agent),
    cited(published('Coordinate concurrent work', 'Collaborators coordinate overlapping changes in real time.'), collaboration),
    cited(published('Correlate runtime evidence', 'Runtime telemetry is correlated with static software understanding.'), runtime),
  ];
  const uncovered = uncoveredCapabilityCatalogOutcomeRequirements(incomplete, requirements);

  assert.deepEqual(new Set(uncovered.map(requirement => requirement.audience)), new Set(['human', undefined]));
  assert.match(capabilityCatalogOutcomeCoverageFailure(incomplete, requirements) || '', /first-party product outcomes/);

  const complete = [
    ...incomplete,
    cited(published('Help people explore software behavior', 'Human engineers explore connected software behavior and change risks.'), human),
    cited(published('Build a trustworthy relationship graph', 'A trustworthy relationship graph connects the software structure and behavior.'), graph),
  ];
  assert.equal(capabilityCatalogOutcomeCoverageFailure(complete, requirements), undefined);
});

test('canonicalizes mapping without truncating the stem', () => {
  assert.equal(canonicalCapabilityCatalogOutcomeToken('mapping'), 'mapping');
  assert.equal(canonicalCapabilityCatalogOutcomeToken('mappings'), 'mapping');
  assert.equal(canonicalCapabilityCatalogOutcomeToken('authentication'), 'authenticate');
  assert.equal(canonicalCapabilityCatalogOutcomeToken('authenticated'), 'authenticate');
  assert.equal(canonicalCapabilityCatalogOutcomeToken('tags'), 'tag');
  assert.equal(canonicalCapabilityCatalogOutcomeToken('jobs'), 'job');
});

test('derives visible actions only from canonical purpose verbs after plural and shared audiences', () => {
  const cases = [
    {
      summary: 'Humans inspect connected software behavior before making changes.',
      candidates: [candidate('human', 'People understand connected software behavior', ['inspect_behavior'])],
      expected: ['understand'],
      audiences: ['human'],
    },
    {
      summary: 'Software provides grounded change context for reviewers.',
      candidates: [candidate('context', 'Provide grounded software change context', ['provide_context'])],
      expected: ['provide'],
      audiences: [undefined],
    },
    {
      summary: 'Humans and AI agents inspect connected software behavior before making changes.',
      candidates: [candidate('shared', 'People and agents understand connected software behavior', ['inspect_behavior'])],
      expected: ['understand', 'understand'],
      audiences: ['human', 'agent'],
    },
    {
      summary: 'Analyzes connected software behavior for change risk.',
      candidates: [candidate('analysis', 'Analyze connected software behavior for change risk', ['analyze_behavior'])],
      expected: ['analyze'],
      audiences: [undefined],
    },
  ];

  for (const entry of cases) {
    const requirements = deriveCapabilityCatalogOutcomeRequirements({ productDocSummary: entry.summary }, entry.candidates);
    assert.deepEqual(requirements.map(requirement => requirement.visibleActionTerms?.[0]), entry.expected);
    assert.deepEqual(requirements.map(requirement => requirement.audience), entry.audiences);
  }
});

test('projects only a syntactic coordinated audience list into an exact slot-specific clause', () => {
  const forward = 'Turns the graph into behavior-level comprehension for people, and AI agents.';
  const reverse = 'Turns the graph into behavior-level comprehension for agents & people.';
  const relational = 'People help agents understand connected software behavior.';
  const between = 'People inspect dependencies between users and AI agents.';
  const among = 'Agents compare changes among assistants and people.';
  const subject = 'People and agents inspect connected software behavior.';

  assert.equal(audienceScopedCapabilityCatalogOutcomeText(forward, 'human', 'people'), 'Turns the graph into behavior-level comprehension for people.');
  assert.equal(audienceScopedCapabilityCatalogOutcomeText(forward, 'agent', 'agents'), 'Turns the graph into behavior-level comprehension for agents.');
  assert.equal(audienceScopedCapabilityCatalogOutcomeText(reverse, 'human', 'people'), 'Turns the graph into behavior-level comprehension for people.');
  assert.equal(audienceScopedCapabilityCatalogOutcomeText(reverse, 'agent', 'agents'), 'Turns the graph into behavior-level comprehension for agents.');
  assert.equal(audienceScopedCapabilityCatalogOutcomeText(relational, 'human', 'people'), undefined);
  assert.equal(audienceScopedCapabilityCatalogOutcomeText(relational, 'agent', 'agents'), undefined);
  assert.equal(audienceScopedCapabilityCatalogOutcomeText(between, 'human', 'people'), undefined);
  assert.equal(audienceScopedCapabilityCatalogOutcomeText(among, 'agent', 'agents'), undefined);
  assert.equal(audienceScopedCapabilityCatalogOutcomeText(subject, 'human', 'people'), 'people inspect connected software behavior.');
  assert.equal(audienceScopedCapabilityCatalogOutcomeText(subject, 'agent', 'agents'), 'agents inspect connected software behavior.');
});

test('requires the immutable audience-slot action without allowing a sibling slot action', () => {
  const human: CapabilityCatalogOutcomeRequirement = {
    id: 'human:understand', audience: 'human', audienceLabel: 'people', candidateIds: ['shared'],
    statement: 'behavior comprehension', subjectTokens: ['behavior', 'understand'],
    requiredSubjectTerms: ['behavior', 'understand'], visibleActionTerms: ['turn'],
  };
  const agent = { ...human, id: 'agent:understand', audience: 'agent' as const, audienceLabel: 'agents', visibleActionTerms: ['ground'] };

  assert.equal(capabilityCatalogOutcomeNameFailure('Behavior comprehension for people', human), 'required-outcome-visible-action-missing:human:understand');
  assert.equal(capabilityCatalogOutcomeNameFailure('Turn behavior comprehension toward people', human), undefined);
  assert.equal(capabilityCatalogOutcomeNameFailure('Ground behavior comprehension for agents', agent), undefined);
  assert.equal(capabilityCatalogOutcomeNameFailure('Turn behavior comprehension for agents', agent), 'required-outcome-visible-action-missing:agent:understand');
});

test('preserves evidence-grounded original-clause aliases for compressed outcome subjects', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'The product provides real-time collaboration. It exposes shared work concepts for real-time collaboration.',
  }, [candidate('coordination', 'Shared work concepts for real-time collaboration', ['coordinate_overlapping_work'])]);
  const collaboration = requirements.find(requirement => requirement.subjectTokens.includes('concept'))!;

  assert.equal(collaboration.requiredSubjectTerms?.includes('collaborate'), true);
  assert.equal(collaboration.subjectTokenAliases, undefined);
});

test('matches a grounded original-clause alias without admitting unrelated prose', () => {
  const requirement: CapabilityCatalogOutcomeRequirement = {
    id: 'collaboration-slot',
    statement: 'work concepts',
    candidateIds: ['coordination'],
    subjectTokens: ['work', 'concept'],
    requiredSubjectTerms: ['work', 'concept'],
    minimumSubjectMatches: 2,
    subjectAliasAnchorTokens: [['collaborate']],
    subjectTokenAliases: [['real', 'time', 'collaborate', 'overlap', 'software', 'concept']],
  };
  const collaboration = published(
    'Enable real-time collaboration across overlapping code concepts',
    'Teams coordinate concurrent changes across connected software boundaries.',
  );
  const unrelated = cited(published(
    'Review real-time deployment concepts',
    'Operators inspect release configuration before deployment.',
  ), requirement);

  assert.equal(capabilitySatisfiesCatalogOutcomeRequirement(collaboration, requirement), true);
  assert.equal(capabilitySatisfiesCatalogOutcomeRequirement(unrelated, requirement), false);
});

test('does not satisfy an outcome with matching prose cited to the wrong candidate', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const runtime = requirements.find(requirement => requirement.subjectTokens.includes('runtime'))!;
  const wrongCandidate = cited(
    published('Help people understand software behavior', 'Human engineers understand connected software behavior before changing code.'),
    runtime,
  );

  assert.equal(capabilitySatisfiesCatalogOutcomeRequirement(wrongCandidate, human), true);
  assert.equal(uncoveredCapabilityCatalogOutcomeRequirements([wrongCandidate], [human]).length, 1);
});

test('retains uncorroborated first-party outcomes as explicit intent gaps', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'The product visualizes future production economics and predicts customer demand.',
  }, evidence);

  assert.equal(requirements.length, 1);
  assert.deepEqual(requirements[0].candidateIds, []);
  assert.match(requirements[0].statement, /visualizes future production economics/);
});

test('supporting delivery evidence can corroborate a first-party outcome but verification fixtures cannot', () => {
  const supporting = candidate('context', 'Grounded agent software behavior context', ['get_agent_context']);
  supporting.evidence_role = 'supporting-mechanism';
  const verification = candidate('fixture', 'Human software understanding fixture', ['verify_human_understanding']);
  verification.evidence_role = 'verification-harness';
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'Provides grounded context that helps agents understand software behavior and helps people understand software behavior.',
  }, [supporting, verification]);

  assert.equal(requirements.some(requirement => requirement.audience === 'agent'), true);
  const humanGap = requirements.find(requirement => requirement.audience === 'human');
  assert.ok(humanGap);
  assert.deepEqual(humanGap.candidateIds, []);
});

test('does not let one combined audience statement satisfy two explicitly distinct audience outcomes', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const audienceRequirements = requirements.filter(requirement => requirement.audience);
  const combined = cited(published(
    'Explain software behavior to people and AI agents',
    'Human engineers and AI agents understand connected software behavior from the same context.',
  ), audienceRequirements[0]);
  const audienceGaps = uncoveredCapabilityCatalogOutcomeRequirements([combined], requirements)
    .filter(requirement => requirement.audience);

  assert.deepEqual(audienceRequirements.map(requirement => requirement.statement), [
    'turns that graph into behavior-level comprehension',
    'turns that graph into behavior-level comprehension',
  ]);
  assert.ok(audienceGaps.length >= 1);
});

test('does not assign a bound capability to a different shared-candidate slot', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence).filter(requirement => requirement.audience);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const combined = ['first', 'second'].map(id => ({
    ...published(id, 'People and AI agents understand connected software behavior before making changes.'),
    criticality_factors: [`catalog-candidate:${human.candidateIds[0]}`, `catalog-outcome-requirement:${human.id}`],
  }));
  assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements(combined, requirements).map(requirement => requirement.audience), ['human', 'agent']);
});

test('binds an audience-specific repair to its exact requested outcome', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const agent = requirements.find(requirement => requirement.audience === 'agent')!;
  const humanOutcome = published(
    'Help people understand software behavior',
    'Human engineers understand connected software behavior before making changes.',
  );

  assert.equal(capabilitySatisfiesCatalogOutcomeRequirement(humanOutcome, human), true);
  assert.equal(capabilitySatisfiesCatalogOutcomeRequirement(humanOutcome, agent), false);
  humanOutcome.name = 'Surface behavior-level comprehension';
  humanOutcome.description = 'Connected software behavior remains understandable after description refinement.';
  humanOutcome.criticality_factors = [`catalog-outcome-requirement:${human.id}`];
  assert.equal(capabilitySatisfiesCatalogOutcomeRequirement(humanOutcome, human), false);
  assert.equal(capabilitySatisfiesCatalogOutcomeRequirement(humanOutcome, agent), false);
});

test('reports the exact failed audience, candidate, and subject binding', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const actorless = published('Surface behavior comprehension', 'Connected software behavior is explained before changes.');
  assert.equal(capabilityCatalogOutcomeBindingFailure(actorless, human.candidateIds, human.id, [human], new Set()), 'required-outcome-audience-missing:human');
  const wrongCandidate = published('Help people understand software behavior', 'Human engineers understand connected software behavior before making changes.');
  assert.equal(capabilityCatalogOutcomeBindingFailure(wrongCandidate, ['runtime'], human.id, [human], new Set()), `required-outcome-candidate-mismatch:${human.id}`);
  const wrongSubject = published('Help people review changes', 'Human engineers review changes before making decisions.');
  assert.equal(capabilityCatalogOutcomeBindingFailure(wrongSubject, human.candidateIds, human.id, [human], new Set()), `required-outcome-subject-mismatch:${human.id}`);
  const corrected = published('Help people understand software behavior', 'Human engineers understand connected software behavior before making changes.');
  assert.equal(capabilityCatalogOutcomeBindingFailure(corrected, human.candidateIds, human.id, [human], new Set()), undefined);
  assert.deepEqual(capabilityCatalogOutcomeBindingFailureDetail(actorless, human.candidateIds, human.id, [human], new Set()), {
    missingAudience: human.audienceLabel,
    missingAudienceLocations: ['name', 'description'],
    missingSubjectTerms: [],
    reason: 'required-outcome-audience-missing:human',
  });
  const mixed = published('Help people and agents understand software behavior', 'People and agents understand connected software behavior.');
  assert.deepEqual(capabilityCatalogOutcomeBindingFailureDetail(mixed, human.candidateIds, human.id, [human], new Set()), {
    missingSubjectTerms: [], oppositeAudienceLabels: ['agents'], oppositeAudienceLocations: ['name', 'description'],
    reason: 'required-outcome-audience-conflict:human',
  });
  const actorlessMixed = published('Turn behavior into comprehension', 'Turns behavior into comprehension for people and AI agents.');
  assert.deepEqual(capabilityCatalogOutcomeBindingFailureDetail(actorlessMixed, human.candidateIds, human.id, [human], new Set()), {
    missingAudience: human.audienceLabel, missingAudienceLocations: ['name'], missingSubjectTerms: [],
    oppositeAudienceLabels: ['agents'], oppositeAudienceLocations: ['description'],
    reason: 'required-outcome-audience-missing:human',
  });
  assert.deepEqual(capabilityCatalogOutcomeBindingFailureDetail(wrongSubject, human.candidateIds, human.id, [human], new Set()), {
    missingSubjectTerms: human.requiredSubjectTerms,
    reason: `required-outcome-subject-mismatch:${human.id}`,
  });
});

test('requires audience identity in both the bound title and description', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const agent = requirements.find(requirement => requirement.audience === 'agent')!;
  const actorlessTitle = published('Understand connected software behavior', 'People understand connected software behavior before changing it.');
  const actorlessDescription = published('Help people understand connected software behavior', 'Connected software behavior is explained before changes.');
  const people = published('Help people understand connected software behavior', 'People understand connected software behavior before changing it.');
  const agents = published('Help agents understand connected software behavior', 'Agents understand connected software behavior before changing it.');
  const mixed = published('Help people and agents understand connected software behavior', 'People and agents understand connected software behavior before changing it.');

  assert.equal(capabilityCatalogOutcomeBindingFailure(actorlessTitle, human.candidateIds, human.id, [human], new Set()), 'required-outcome-audience-missing:human');
  assert.equal(capabilityCatalogOutcomeBindingFailure(actorlessDescription, human.candidateIds, human.id, [human], new Set()), 'required-outcome-audience-missing:human');
  assert.equal(capabilityCatalogOutcomeBindingFailure(people, human.candidateIds, human.id, [human], new Set()), undefined);
  assert.equal(capabilityCatalogOutcomeBindingFailure(agents, agent.candidateIds, agent.id, [agent], new Set()), undefined);
  assert.equal(capabilityCatalogOutcomeBindingFailure(mixed, human.candidateIds, human.id, [human], new Set()), 'required-outcome-audience-conflict:human');
  assert.equal(capabilityCatalogOutcomeBindingFailure(mixed, agent.candidateIds, agent.id, [agent], new Set()), 'required-outcome-audience-conflict:agent');
  assert.equal(capabilitySatisfiesCatalogOutcomeRequirement({
    ...actorlessTitle,
    criticality_factors: [`catalog-outcome-requirement:${human.id}`],
  }, human), false);
  assert.equal(capabilityCatalogOutcomesMayMerge(
    { ...people, criticality_factors: [`catalog-outcome-requirement:${human.id}`] },
    { ...agents, criticality_factors: [`catalog-outcome-requirement:${agent.id}`] },
  ), false);
});

test('initial one-to-one stamping cannot bind actorless or mixed-audience identities', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const actorless = cited(published('Understand connected software behavior', 'People understand connected software behavior before changing it.'), human);
  const mixed = cited(published('Help people and agents understand software behavior', 'People and agents understand connected software behavior.'), human);
  const specific = cited(published('Help people understand software behavior', 'People understand connected software behavior before changing it.'), human);
  for (const capability of bindUniquelySatisfiedCatalogOutcomeRequirements([actorless, mixed], [human])) {
    assert.equal(capability.criticality_factors.some(factor => factor.startsWith('catalog-outcome-requirement:')), false);
  }
  assert.equal(bindUniquelySatisfiedCatalogOutcomeRequirements([specific], [human])[0].criticality_factors.includes(`catalog-outcome-requirement:${human.id}`), true);
});

test('derives machine-readable extraction requirements from first-party audience and subjects', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence).filter(requirement => requirement.audience);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const agent = requirements.find(requirement => requirement.audience === 'agent')!;
  assert.equal(human.audienceLabel, 'people');
  assert.equal(agent.audienceLabel, 'agents');
  assert.deepEqual(human.requiredSubjectTerms, human.subjectTokens);
  assert.equal(human.minimumSubjectMatches, Math.min(2, human.subjectTokens.length));
});

test('stamps only unambiguous initial audience and runtime outcomes', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const human = published('Help people understand software behavior', 'Human engineers understand connected software behavior before making changes.');
  const agent = published('Ground agents in software behavior', 'AI agents understand connected software behavior before making changes.');
  const runtime = published('Correlate static analysis with runtime evidence', 'Static software understanding is compared with runtime evidence.');
  const ambiguous = published('Explain behavior to people and agents', 'People and AI agents understand connected software behavior.');
  const humanRequirement = requirements.find(requirement => requirement.audience === 'human')!;
  const agentRequirement = requirements.find(requirement => requirement.audience === 'agent')!;
  const runtimeRequirement = requirements.find(requirement => requirement.subjectTokens.includes('runtime'))!;
  human.criticality_factors = [`catalog-candidate:${humanRequirement.candidateIds[0]}`];
  agent.criticality_factors = [`catalog-candidate:${agentRequirement.candidateIds[0]}`];
  runtime.criticality_factors = [`catalog-candidate:${runtimeRequirement.candidateIds[0]}`];
  ambiguous.criticality_factors = [`catalog-candidate:${humanRequirement.candidateIds[0]}`];
  const bound = bindUniquelySatisfiedCatalogOutcomeRequirements([human, agent, runtime], requirements);
  const ambiguousBound = bindUniquelySatisfiedCatalogOutcomeRequirements([ambiguous], requirements.filter(requirement => requirement.audience));

  assert.equal(bound[0].criticality_factors.some(factor => factor.startsWith('catalog-outcome-requirement:human:')), true);
  assert.equal(bound[1].criticality_factors.some(factor => factor.startsWith('catalog-outcome-requirement:agent:')), true);
  assert.equal(bound[2].criticality_factors.some(factor => factor.startsWith('catalog-outcome-requirement:')), true);
  assert.equal(ambiguousBound[0].criticality_factors.some(factor => factor.startsWith('catalog-outcome-requirement:')), false);
});

test('does not bind unique prose across candidate families or reassign an existing requirement', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const agent = requirements.find(requirement => requirement.audience === 'agent')!;
  const wrongCandidate = published('Help people understand software behavior', 'Human engineers understand connected software behavior before making changes.');
  wrongCandidate.criticality_factors = ['catalog-candidate:unrelated'];
  const alreadyBound = published('Help people understand software behavior', 'Human engineers and AI agents understand connected software behavior.');
  alreadyBound.criticality_factors = [`catalog-candidate:${agent.candidateIds[0]}`, `catalog-outcome-requirement:${human.id}`];
  const result = bindUniquelySatisfiedCatalogOutcomeRequirements([wrongCandidate, alreadyBound], [human, agent]);

  assert.deepEqual(result[0].criticality_factors, ['catalog-candidate:unrelated']);
  assert.deepEqual(result[1].criticality_factors, [`catalog-candidate:${agent.candidateIds[0]}`, `catalog-outcome-requirement:${human.id}`]);
});

test('uses the product brief instead of treating package identity metadata as another outcome', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'Builds a connected relationship graph for software behavior.',
    manifestDescription: 'Workspace collection for graph analysis and package tooling.',
  }, [
    candidate('graph', 'Connected relationship graph', ['inspect_graph_relationships']),
    candidate('package', 'Workspace package analysis', ['analyze_package_workspace']),
  ]);

  assert.equal(requirements.some(requirement => requirement.statement.includes('Workspace')), false);
  assert.equal(requirements.some(requirement => requirement.candidateIds.includes('package')), false);
  assert.equal(requirements.some(requirement => requirement.candidateIds.includes('graph')), true);
});

test('removes identity prose and prior-clause references from broad supporting evidence', () => {
  const umbrella = candidate('delivery', 'Product delivery context', [
    'build_relationship_graph',
    'graph_behavior_comprehension_for_agents',
    'correlate_static_understanding_runtime_evidence',
  ]);
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'The platform is a software understanding system. It builds a relationship graph, turns that graph into behavior-level comprehension for people and AI agents, and correlates static understanding with runtime evidence.',
  }, [umbrella]);

  assert.deepEqual(requirements.map(requirement => requirement.statement), [
    'builds a relationship graph',
    'turns that graph into behavior-level comprehension',
    'turns that graph into behavior-level comprehension',
    'correlates static understanding with runtime evidence',
  ]);
  const [graph, human, agent, runtime] = requirements;
  assert.equal(capabilityCatalogOutcomeCoverageFailure([
    cited(published('Build a relationship graph', 'A relationship graph connects software structure and behavior.'), graph),
    cited(published('Help people understand software behavior', 'Human engineers understand connected software behavior and change risks.'), human),
    cited(published('Give agents software comprehension', 'AI agents understand connected software behavior before making changes.'), agent),
    cited(published('Correlate static analysis with runtime evidence', 'Static code structure and runtime evidence refine behavioral understanding.'), runtime),
  ], requirements), undefined);
});

test('preserves complete outcome clauses from a feature-rich README instead of emitting sentence fragments', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'Todojobs is a web application that allows to you record and keep track of your job applications. Categorize and seamlessly manage your job applications. Categorize your applications: You can categorize your applications by creating different categories and adding your job applications to any corresponding category. You can also edit or delete your categories. Manage application status: You can manage your application status. You can change to Rejected, Assessment, Interview or set it to closed. Manage job application: You can delete or edit your job applications with easy. You can add notes to your job applications. Job applications with notes display the note count. Robust job filter: Filter between job applications using the category, status, and the job board or website. The search feature also adds and extra way to narrow down what you are looking for.',
  }, [
    candidate('jobs', 'Track job applications and application status', ['record_job', 'update_job_status', 'filter_jobs']),
    candidate('categories', 'Organize application categories', ['create_category', 'edit_category', 'delete_category']),
    candidate('notes', 'Record job application notes', ['add_note', 'delete_note']),
  ]);
  const statements = requirements.map(requirement => requirement.statement);

  assert.ok(statements.includes('keep track of your job applications'));
  assert.ok(statements.includes('Categorize and seamlessly manage your job applications'));
  assert.ok(statements.includes('categorize your applications by creating different categories and adding your job applications to any corresponding category'));
  assert.ok(statements.includes('manage your application status'));
  assert.ok(statements.includes('change to Rejected, Assessment, Interview or set it to closed'));
  assert.ok(statements.includes('Filter between job applications using the category, status, and the job board or website'));
  assert.equal(statements.some(statement => /^(?:corresponding|with easy|status: status|search feature adds)$/i.test(statement)), false);
  assert.equal(requirements.some(requirement => requirement.requiredSubjectTerms?.includes('statu')), false);
  assert.equal(requirements.some(requirement => requirement.requiredSubjectTerms?.includes('status')), true);
});

test('requires an evidence-grounded outcome anchor when a name starts with an internal subsystem identity', () => {
  const requirement: CapabilityCatalogOutcomeRequirement = {
    id: 'all:concept-fabric-work', statement: 'Fabric work concepts', candidateIds: ['coordination'],
    subjectTokens: ['fabric', 'work'], subjectTokenAliases: [['fabric', 'work', 'collaborate', 'conflict']],
    subjectAliasAnchorTokens: [['collaborate']],
  };
  const coordination = candidate('coordination', 'Fabric work concepts', ['reserve_overlapping_concepts', 'detect_conflicts']);

  assert.equal(capabilityCatalogOutcomeNameFailure('Fabric work concepts across codebase changes', requirement),
    'required-outcome-visible-action-missing:all:concept-fabric-work');
  assert.equal(capabilityCatalogOutcomeNameFailure('Collaborate across overlapping code concepts', requirement), undefined);
  assert.equal(capabilityCatalogOutcomeNameFailure('Manage Fabric work across overlapping concepts', requirement), undefined);
  assert.equal(capabilityCatalogOutcomeNameFailure('Build a trustworthy relationship graph', {
    id: 'graph', statement: 'build trustworthy relationship graph', candidateIds: ['graph'],
    subjectTokens: ['build', 'graph'], requiredSubjectTerms: ['build', 'graph'],
    subjectTokenAliases: [['build', 'graph', 'codebase']], subjectAliasAnchorTokens: [['codebase']],
  }), undefined);
  assert.equal(capabilityCatalogOutcomeNameFailure('Correlates static codebase analysis with runtime evidence', {
    id: 'runtime', statement: 'correlates static runtime evidence', candidateIds: ['runtime'],
    subjectTokens: ['correlate', 'runtime'], requiredSubjectTerms: ['correlate', 'runtime'],
    subjectTokenAliases: [['correlate', 'runtime', 'telemetry']], subjectAliasAnchorTokens: [['telemetry']],
  }), undefined);
});

test('recognizes short leading purpose verbs before subject-token filtering', () => {
  const requirement: CapabilityCatalogOutcomeRequirement = {
    id: 'all:note', statement: 'add notes', candidateIds: ['notes'],
    subjectTokens: ['note'], requiredSubjectTerms: ['note'], visibleActionTerms: ['add'],
  };
  assert.equal(capabilityCatalogOutcomeNameFailure('Add Notes to Job Applications', requirement), undefined);
  assert.equal(capabilityCatalogOutcomeNameFailure('View Notes for Job Applications', requirement), 'required-outcome-visible-action-missing:all:note');
});

test('an exact audience requirement binding covers its slot without title-token restatement', () => {
  const requirement: CapabilityCatalogOutcomeRequirement = {
    id: 'agent:behavior-understand',
    audience: 'agent',
    audienceLabel: 'agents',
    statement: 'behavior-level understanding',
    candidateIds: ['agent-surface'],
    subjectTokens: ['behavior', 'understand'],
    requiredSubjectTerms: ['behavior', 'understand'],
    minimumSubjectMatches: 2,
  };
  const bound = {
    ...published('Equip AI agents for dependable change planning', 'AI agents receive grounded context before planning changes.'),
    criticality_factors: [
      'catalog-candidate:agent-surface',
      'catalog-outcome-requirement:agent:behavior-understand',
    ],
  };
  assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements([bound], [requirement]), []);

  for (const invalid of [
    { ...bound, description: 'Grounded context supports dependable change planning.' },
    {
      ...bound,
      name: 'Equip people and AI agents for dependable change planning',
      description: 'People and AI agents receive grounded context before planning changes.',
    },
  ]) {
    assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements([invalid], [requirement]), [requirement]);
  }
});

test('requirement-bound coverage still requires a corroborating candidate while unbound coverage remains semantic', () => {
  const requirement: CapabilityCatalogOutcomeRequirement = {
    id: 'agent:behavior-understand',
    audience: 'agent',
    audienceLabel: 'agents',
    statement: 'behavior-level understanding',
    candidateIds: ['agent-surface'],
    subjectTokens: ['behavior', 'understand'],
    requiredSubjectTerms: ['behavior', 'understand'],
    minimumSubjectMatches: 2,
  };
  const boundParaphrase = {
    ...published('Equip AI agents for dependable change planning', 'AI agents receive grounded context before planning changes.'),
    criticality_factors: ['catalog-outcome-requirement:agent:behavior-understand'],
  };
  assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements([boundParaphrase], [requirement]), [requirement]);
  assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements([{
    ...boundParaphrase,
    criticality_factors: [
      'catalog-candidate:wrong-surface',
      'catalog-outcome-requirement:agent:behavior-understand',
    ],
  }], [requirement]), [requirement]);
  assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements([{
    ...boundParaphrase,
    criticality_factors: [
      'catalog-candidate:agent-surface',
      'catalog-outcome-requirement:agent:behavior-understand',
    ],
  }], [requirement]), []);

  const unboundSemantic = {
    ...published('Help AI agents understand behavior', 'AI agents understand software behavior before planning changes.'),
    criticality_factors: ['catalog-candidate:agent-surface'],
  };
  assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements([unboundSemantic], [requirement]), []);
  assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements([{
    ...unboundSemantic,
    criticality_factors: ['catalog-candidate:wrong-surface'],
  }], [requirement]), [requirement]);
});


test('binds a broad outcome through a complete order-independent exact atomic union only', () => {
  const requirement: CapabilityCatalogOutcomeRequirement = {
    id: 'all:note', statement: 'notes', subjectTokens: ['note'], requiredSubjectTerms: ['note'],
    minimumSubjectMatches: 1, candidateIds: ['cap_note_management'],
  };
  const scopes = new Map([
    ['operation-obligation:cap_note_management:read', { parentCandidateId: 'cap_note_management' }],
    ['operation-obligation:cap_note_management:create', { parentCandidateId: 'cap_note_management' }],
    ['operation-obligation:cap_note_management:delete', { parentCandidateId: 'cap_note_management' }],
  ]);
  const atom = (action: string) => ({
    ...published(`${action === 'read' ? 'View' : action === 'delete' ? 'Remove' : 'Create'} notes`, `Users ${action === 'read' ? 'view' : action} notes through the verified product workflow.`),
    id: action,
    criticality_factors: [`catalog-operation-obligation:operation-obligation:cap_note_management:${action}`],
  });
  for (const values of [[atom('read'), atom('create'), atom('delete')], [atom('delete'), atom('read'), atom('create')]]) {
    const bound = bindAtomicallySatisfiedCatalogOutcomeRequirements(values, [requirement], new Set(['cap_note_management']), scopes);
    assert.equal(uncoveredCapabilityCatalogOutcomeRequirements(bound, [requirement]).length, 0);
    assert.equal(bound.filter(item => item.criticality_factors.includes('catalog-outcome-union:all:note')).length, 1);
    assert.ok(bound.every(item => item.operations.length === 0));
  }
  const partial = bindAtomicallySatisfiedCatalogOutcomeRequirements([atom('create'), atom('delete')], [requirement], new Set(), scopes);
  assert.equal(uncoveredCapabilityCatalogOutcomeRequirements(partial, [requirement]).length, 1);
  const unrelated = { ...atom('read'), name: 'View note counts', description: 'Users view note counts for monitoring metrics.', criticality_factors: ['catalog-operation-obligation:operation-obligation:other:read'] };
  assert.equal(bindAtomicallySatisfiedCatalogOutcomeRequirements([unrelated], [requirement], new Set(['cap_note_management']), scopes)
    .some(item => item.criticality_factors.includes('catalog-outcome-union:all:note')), false);
});

test('does not ground a visible-action outcome through a differently named atomic union', () => {
  const requirement: CapabilityCatalogOutcomeRequirement = {
    id: 'all:status-update', statement: 'update application status', subjectTokens: ['application', 'status'],
    requiredSubjectTerms: ['application', 'status'], minimumSubjectMatches: 2,
    visibleActionTerms: ['update'], candidateIds: ['cap_job_management'],
  };
  const scopes = new Map([
    ['operation-obligation:cap_job_management:update', { parentCandidateId: 'cap_job_management' }],
  ]);
  const mislabeled = {
    ...published('Categorize job applications', 'Job applications retain status updates while users organize them into categories.'),
    id: 'categorize',
    criticality_factors: ['catalog-operation-obligation:operation-obligation:cap_job_management:update'],
  };

  const bound = bindAtomicallySatisfiedCatalogOutcomeRequirements(
    [mislabeled], [requirement], new Set(['cap_job_management']), scopes,
  );

  assert.equal(bound.some(item => item.criticality_factors.includes('catalog-outcome-union:all:status-update')), false);
  assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements(bound, [requirement]), [requirement]);
});
