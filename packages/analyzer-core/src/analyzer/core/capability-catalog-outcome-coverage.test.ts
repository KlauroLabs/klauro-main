import assert from 'node:assert/strict';
import test from 'node:test';
import type { SystemCapability } from '../../types/cas.types';
import {
  capabilityCatalogOutcomeCoverageFailure,
  deriveCapabilityCatalogOutcomeRequirements,
  uncoveredCapabilityCatalogOutcomeRequirements,
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

const signal = {
  productDocSummary: 'The product builds a trustworthy relationship graph, turns that graph into behavior-level comprehension for people and AI agents, enables real-time collaboration, and correlates static understanding with runtime evidence.',
};

const evidence = [
  candidate('graph', 'Relationship graph analysis', ['query_graph_relationships']),
  candidate('understanding', 'Explore connected software behavior', ['inspect_behavior', 'explain_change_risk']),
  candidate('collaboration', 'Concurrent collaboration', ['coordinate_overlapping_work']),
  candidate('runtime', 'Runtime evidence correlation', ['correlate_runtime_evidence']),
];

test('requires separately stated first-party human, agent, and truth outcomes when structural evidence corroborates them', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements(signal, evidence);
  const incomplete = [
    published('Give AI agents software comprehension', 'Agents understand connected software behavior before changing code.'),
    published('Coordinate concurrent work', 'Collaborators coordinate overlapping changes in real time.'),
    published('Correlate runtime evidence', 'Runtime telemetry is correlated with static software understanding.'),
  ];
  const uncovered = uncoveredCapabilityCatalogOutcomeRequirements(incomplete, requirements);

  assert.deepEqual(new Set(uncovered.map(requirement => requirement.audience)), new Set(['human', undefined]));
  assert.match(capabilityCatalogOutcomeCoverageFailure(incomplete, requirements) || '', /first-party product outcomes/);

  const complete = [
    ...incomplete,
    published('Explore software behavior', 'Human engineers explore connected software behavior and change risks.'),
    published('Build a trustworthy relationship graph', 'A trustworthy relationship graph connects the software structure and behavior.'),
  ];
  assert.equal(capabilityCatalogOutcomeCoverageFailure(complete, requirements), undefined);
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
  const combined = published(
    'Explain software behavior to people and AI agents',
    'Human engineers and AI agents understand connected software behavior from the same context.',
  );
  const audienceGaps = uncoveredCapabilityCatalogOutcomeRequirements([combined], requirements)
    .filter(requirement => requirement.audience);

  assert.equal(audienceGaps.length, 1);
});
