import assert from 'node:assert/strict';
import test from 'node:test';
import type { SystemCapability } from '../../types/cas.types';
import {
  bindUniquelySatisfiedCatalogOutcomeRequirements,
  capabilityCatalogOutcomeBindingFailure,
  capabilityCatalogOutcomeBindingFailureDetail,
  capabilityCatalogOutcomeCoverageFailure,
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

test('requires separately stated first-party human, agent, and truth outcomes when structural evidence corroborates them', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const human = requirements.find(requirement => requirement.audience === 'human')!;
  const agent = requirements.find(requirement => requirement.audience === 'agent')!;
  const graph = requirements.find(requirement => requirement.subjectTokens.includes('relation'))!;
  const collaboration = requirements.find(requirement => requirement.subjectTokens.includes('collaborate'))!;
  const runtime = requirements.find(requirement => requirement.subjectTokens.includes('runtime'))!;
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
    cited(published('Explore software behavior', 'Human engineers explore connected software behavior and change risks.'), human),
    cited(published('Build a trustworthy relationship graph', 'A trustworthy relationship graph connects the software structure and behavior.'), graph),
  ];
  assert.equal(capabilityCatalogOutcomeCoverageFailure(complete, requirements), undefined);
});

test('preserves evidence-grounded original-clause aliases for compressed outcome subjects', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'The product provides real-time collaboration. It exposes shared work concepts for real-time collaboration.',
  }, [candidate('coordination', 'Shared work concepts for real-time collaboration', ['coordinate_overlapping_work'])]);
  const collaboration = requirements.find(requirement => requirement.subjectTokens.includes('concept'))!;

  assert.equal(collaboration.subjectTokenAliases?.some(alias => alias.includes('collaborate')), true);
  assert.equal(collaboration.subjectAliasAnchorTokens?.flat().includes('collaborate'), true);
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

test('does not turn uncorroborated first-party aspirations into mandatory catalog outcomes', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'The product visualizes future production economics and predicts customer demand.',
  }, evidence);

  assert.deepEqual(requirements, []);
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
  assert.equal(requirements.some(requirement => requirement.audience === 'human'), false);
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
    'behavior-level comprehension',
    'behavior-level comprehension',
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
  assert.deepEqual(uncoveredCapabilityCatalogOutcomeRequirements(combined, requirements).map(requirement => requirement.audience), ['agent']);
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
  assert.equal(capabilitySatisfiesCatalogOutcomeRequirement(humanOutcome, human), true);
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
    missingSubjectTerms: [],
    reason: 'required-outcome-audience-missing:human',
  });
  assert.deepEqual(capabilityCatalogOutcomeBindingFailureDetail(wrongSubject, human.candidateIds, human.id, [human], new Set()), {
    missingSubjectTerms: human.requiredSubjectTerms,
    reason: `required-outcome-subject-mismatch:${human.id}`,
  });
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
    'builds relationship graph',
    'behavior-level comprehension',
    'behavior-level comprehension',
    'correlates static runtime evidence',
  ]);
  const [graph, human, agent, runtime] = requirements;
  assert.equal(capabilityCatalogOutcomeCoverageFailure([
    cited(published('Build a relationship graph', 'A relationship graph connects software structure and behavior.'), graph),
    cited(published('Help people understand software behavior', 'Human engineers understand connected software behavior and change risks.'), human),
    cited(published('Give agents software comprehension', 'AI agents understand connected software behavior before making changes.'), agent),
    cited(published('Correlate static analysis with runtime evidence', 'Static code structure and runtime evidence refine behavioral understanding.'), runtime),
  ], requirements), undefined);
});
