import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import { capabilityCatalogOutcomeBindingFailure } from './capability-catalog-outcome-coverage';
import { capabilityCatalogEvidenceFallback, capabilityCatalogFirstPartyFallback, capabilityCatalogRepairPromptEnvelope } from './capability-catalog-repair-context';

test('targeted repair exposes opaque ids and customer-language facts without raw structural evidence', () => {
  const candidates = [{
    id: 'capability_mcp', name: 'CrossCodebaseSystemGraph', structural_label: 'CrossCodebaseSystemGraph',
    category: 'core', evidence_kind: 'behavior-surface', related_entities: ['CASEdge', 'KlauroConfig'],
    related_domains: ['CAS'], evidence_examples: ['get_cross_codebase_system_graph'],
    operations: [
      { entry_point_id: 'raw', entry_point_type: 'message', action: 'Read CASEdge', path_or_command: 'get_cross_codebase_system_graph' },
      { entry_point_id: 'safe', entry_point_type: 'message', action: 'Inspect software behavior', path_or_command: 'preview_codebase_iteration' },
      { entry_point_id: 'path', entry_point_type: 'http', action: 'Inspect internal schema', path_or_command: '/v1/cas/edges' },
      { entry_point_id: 'mixed', entry_point_type: 'message', action: 'Inspect software internal schema' },
    ],
  }] as SystemCapability[];
  const requirements = [{
    id: 'human:understand', audience: 'human' as const, audienceLabel: 'people',
    statement: 'people understand software behavior',
    firstPartyOutcomeText: 'People inspect software behavior and change risk before modifying connected code.',
    subjectTokens: ['understand', 'software', 'behavior'], requiredSubjectTerms: ['understand', 'behavior'],
    visibleActionTerms: ['inspect'],
    minimumSubjectMatches: 2, candidateIds: ['capability_mcp'],
  }];
  const rejections = new Map([['capability_mcp', [{
    name: 'Inspect CASEdge transitions', reason: 'outcome-scope-unsupported:CASEdge,KlauroConfig',
    forbidden_subject_terms: ['CASEdge', 'KlauroConfig'], requirement_id: 'human:understand',
    missing_audience: 'people', missing_audience_locations: ['name'] as const,
    missing_subject_terms: ['understand', 'behavior'], opposite_audience_labels: ['agents'],
    opposite_audience_locations: ['description'] as const,
  }]]]);

  const envelope = capabilityCatalogRepairPromptEnvelope(candidates, ['capability_mcp'], requirements, rejections);
  const serialized = JSON.stringify(envelope.facts);

  assert.deepEqual(envelope.candidateMap, { candidate_1: 'capability_mcp' });
  assert.equal(envelope.facts[0].candidate_id, 'candidate_1');
  assert.deepEqual(envelope.facts[0].first_party_outcomes, [requirements[0].firstPartyOutcomeText]);
  assert.deepEqual(envelope.facts[0].required_audience_labels, ['people']);
  assert.deepEqual(envelope.facts[0].required_subject_terms, ['understand', 'behavior']);
  assert.deepEqual(envelope.facts[0].required_visible_actions, ['inspect']);
  assert.deepEqual(envelope.facts[0].observable_actions, ['inspect software behavior']);
  for (const raw of ['capability_mcp', 'CrossCodebaseSystemGraph', 'CASEdge', 'KlauroConfig', 'get_cross_codebase_system_graph', 'cas edges', 'internal schema']) {
    assert.equal(serialized.includes(raw), false);
  }
  assert.deepEqual(envelope.facts[0].prior_rejections, [{
    reason: 'outcome-scope-unsupported', requirement_id: 'human:understand',
    missing_audience: 'people', missing_audience_locations: ['name'],
    missing_subject_terms: ['understand', 'behavior'], opposite_audience_labels: ['agents'],
    opposite_audience_locations: ['description'],
  }]);
});

test('repair facts retain directly observed lifecycle actions for complete descriptions', () => {
  const candidates = [{
    id: 'article-management',
    name: 'Articles',
    category: 'core',
    operations: [
      { entry_point_id: 'create', entry_point_type: 'http', action: 'Create', trigger: { method: 'POST' } },
      { entry_point_id: 'update', entry_point_type: 'http', action: 'Update', trigger: { method: 'PUT' } },
      { entry_point_id: 'delete', entry_point_type: 'http', action: 'Delete', trigger: { method: 'DELETE' } },
    ],
    related_entities: [],
    related_domains: [],
    criticality: 'high',
    criticality_factors: [],
  }] as SystemCapability[];

  const envelope = capabilityCatalogRepairPromptEnvelope(candidates, ['article-management'], []);

  assert.deepEqual(envelope.facts[0].observable_actions, ['create', 'update', 'delete']);
});

test('route-backed repair facts retain product subjects without framework path scaffolding', () => {
  const candidates = [
    { id: 'auth', name: 'Auth', structural_label: 'Auth Workflow', path: '/api/users/login', actions: ['Create'] },
    { id: 'follow', name: 'Follow', structural_label: 'Follow Management', path: '/api/profiles/{username}/follow', actions: ['Create', 'Delete'] },
    { id: 'favorite', name: 'Favorite', structural_label: 'Favorite Management', path: '/api/articles/{slug}/favorite', actions: ['Create', 'Delete'] },
    { id: 'user', name: 'User', structural_label: 'User Management', path: '/api/user', actions: ['List', 'Update'] },
  ].map(candidate => ({
    id: candidate.id,
    name: candidate.name,
    structural_label: candidate.structural_label,
    category: 'core',
    operations: candidate.actions.map((action, index) => ({
      entry_point_id: `entry_route_router_app_api_routes_${candidate.id}_py_router_${index}`,
      entry_point_type: 'http',
      action,
      path_or_command: candidate.path,
      trigger: { method: action === 'Delete' ? 'DELETE' : 'POST', path: candidate.path },
    })),
    related_entities: [], related_domains: [candidate.id], criticality: 'low', criticality_factors: [],
  })) as SystemCapability[];

  const envelope = capabilityCatalogRepairPromptEnvelope(candidates, ['auth', 'follow', 'favorite', 'user'], []);

  assert.deepEqual(envelope.facts.map(fact => fact.required_subject_terms), [
    ['authenticate'], ['follow', 'profile'], ['article', 'favorite'], ['user'],
  ]);
  assert.deepEqual(envelope.facts.map(fact => fact.observable_actions), [
    ['authenticate'], ['create', 'unfollow'], ['create', 'unfavorite'], ['list', 'update'],
  ]);
});

test('targeted repair omits unsafe operation identifiers instead of translating them into prompt vocabulary', () => {
  const candidates = [{
    id: 'raw_candidate', name: 'KlauroConfig', category: 'core', operations: [
      { entry_point_id: 'one', entry_point_type: 'message', action: 'GetCrossCodebaseSystemGraph' },
      { entry_point_id: 'two', entry_point_type: 'message', action: 'Read CASEdge' },
      { entry_point_id: 'three', entry_point_type: 'http', action: 'inspect internal schema', path_or_command: '/internal/config/schema' },
      { entry_point_id: 'four', entry_point_type: 'cli', action: 'get_cross_codebase_system_graph', path_or_command: 'get_cross_codebase_system_graph' },
    ], related_entities: [], related_domains: [], criticality: 'high', criticality_factors: [],
  }] as SystemCapability[];

  const envelope = capabilityCatalogRepairPromptEnvelope(candidates, ['raw_candidate'], [], new Map());

  assert.deepEqual(envelope.facts, [{
    candidate_id: 'candidate_1', first_party_outcomes: [], observable_actions: [], prior_rejections: [],
    required_audience_labels: [], required_subject_terms: [], required_visible_actions: [], minimum_subject_matches: 0,
  }]);
});

test('targeted evidence repair exposes a canonical product subject without UI gesture terms', () => {
  const candidates = [{
    id: 'login', name: 'Manage Login', category: 'core', evidence_kind: 'behavior-surface',
    evidence_examples: ['Login change', 'Login click'],
    operations: [
      { entry_point_id: 'change', entry_point_type: 'event', action: 'action', path_or_command: 'change' },
      { entry_point_id: 'click', entry_point_type: 'event', action: 'action', path_or_command: 'click' },
    ],
    related_entities: [], related_domains: [], criticality: 'high', criticality_factors: [],
  }] as SystemCapability[];

  const envelope = capabilityCatalogRepairPromptEnvelope(candidates, ['login'], [], new Map());

  assert.deepEqual(envelope.facts[0].required_subject_terms, ['authenticate']);
  assert.equal(envelope.facts[0].minimum_subject_matches, 1);
});
test('targeted evidence repair recovers distinguishing product nouns from route-shaped labels', () => {
  const candidates = [{
    id: 'job-sites', name: 'Get /Job/Job Sites/:User Id', structural_label: 'Get /Job/Job Sites/:User Id',
    category: 'core', evidence_kind: 'behavior-surface',
    evidence_examples: ['Jobsites click', 'GET /job/job-sites/:userId'],
    operations: [
      { entry_point_id: 'click', entry_point_type: 'event', action: 'action', path_or_command: 'click' },
      { entry_point_id: 'route', entry_point_type: 'http', action: 'read', path_or_command: '/job/job-sites/:userId' },
    ],
    related_entities: ['job', 'user'], related_domains: [], criticality: 'high', criticality_factors: [],
  }] as SystemCapability[];

  const envelope = capabilityCatalogRepairPromptEnvelope(
    candidates,
    ['job-sites'],
    [],
    new Map(),
    new Map([['job', 'Job'], ['user', 'User']]),
  );

  assert.deepEqual(envelope.facts[0].required_subject_terms, ['job', 'site']);
  assert.equal(envelope.facts[0].minimum_subject_matches, 2);
});

test('targeted evidence repair does not mistake action and UI words for product subjects', () => {
  const candidates = [{
    id: 'add-job', name: 'Add Job Modal Change', category: 'core', evidence_kind: 'behavior-surface',
    evidence_examples: ['Add Job Modal Change'],
    operations: [
      { entry_point_id: 'change', entry_point_type: 'event', action: 'action', path_or_command: 'change' },
      { entry_point_id: 'submit', entry_point_type: 'event', action: 'submit', path_or_command: 'submit' },
    ],
    related_entities: ['job'], related_domains: [], criticality: 'high', criticality_factors: [],
  }] as SystemCapability[];

  const envelope = capabilityCatalogRepairPromptEnvelope(
    candidates,
    ['add-job'],
    [],
    new Map(),
    new Map([['job', 'Job']]),
  );

  assert.deepEqual(envelope.facts[0].required_subject_terms, ['job']);
  assert.equal(envelope.facts[0].minimum_subject_matches, 1);
});

test('evidence fallback preserves a readable structurally proven family when AI repair fails', () => {
  const candidate = {
    id: 'job-sites', name: 'Get /Job/Job Sites/:User Id', category: 'core', evidence_kind: 'behavior-surface',
    operations: [{
      entry_point_id: 'route', entry_point_type: 'http', action: 'read',
      path_or_command: '/job/job-sites/:userId', trigger: { method: 'GET', path: '/job/job-sites/:userId' },
    }],
    related_entities: ['job', 'user'], related_domains: [], criticality: 'high', criticality_factors: [],
  } as SystemCapability;
  const fact = {
    candidate_id: 'candidate_1',
    first_party_outcomes: ['Users record and keep track of job applications.'],
    observable_actions: [],
    prior_rejections: [],
    required_audience_labels: [],
    required_subject_terms: ['job', 'site'],
    required_visible_actions: [],
    minimum_subject_matches: 2,
  };

  assert.deepEqual(capabilityCatalogEvidenceFallback(fact, candidate.id, candidate), {
    name: 'View Job Sites',
    description: 'Job Sites are available to be viewed for a specific user.',
    category: 'core',
    candidate_ids: ['job-sites'],
    catalog_source: 'deterministic',
  });
});


test('evidence fallback keeps an explicitly named GET surface when an adjacent UI event is mutating', () => {
  const candidate = {
    id: 'categories', name: 'Get /Category/Categories/:User Id', category: 'core', evidence_kind: 'behavior-surface',
    operations: [
      {
        entry_point_id: 'route', entry_point_type: 'http', action: 'view',
        path_or_command: '/category/categories/:userId', trigger: { method: 'GET', path: '/category/categories/:userId' },
      },
      {
        entry_point_id: 'submit', entry_point_type: 'event', action: 'submit',
      },
    ],
    related_entities: ['category', 'user'], related_domains: [], criticality: 'high', criticality_factors: [],
  } as SystemCapability;
  const fact = {
    candidate_id: 'candidate_1', first_party_outcomes: [], observable_actions: [], prior_rejections: [],
    required_audience_labels: [], required_subject_terms: ['category'], required_visible_actions: [], minimum_subject_matches: 1,
  };

  assert.equal(capabilityCatalogEvidenceFallback(fact, candidate.id, candidate)?.name, 'View Categories');
});

test('targeted repair retains only first-party context that disambiguates the focused evidence family', () => {
  const candidates = [{
    id: 'status-change', name: 'Job Status Change', category: 'core',
    operations: [{ entry_point_id: 'change-status', entry_point_type: 'http', action: 'Change job status' }],
    related_entities: ['job'], related_domains: [], criticality: 'high', criticality_factors: [],
  }] as SystemCapability[];
  const firstPartyTexts = [
    'Users track job applications and organize them by progress.',
    'Administrators configure unrelated deployment infrastructure.',
    'job application tracking',
  ];

  const envelope = capabilityCatalogRepairPromptEnvelope(
    candidates, ['status-change'], [], new Map(), new Map([['job', 'Job']]), firstPartyTexts,
  );

  assert.deepEqual(envelope.facts[0].first_party_outcomes, [
    'Users track job applications and organize them by progress.',
    'job application tracking',
  ]);
  assert.equal(JSON.stringify(envelope.facts).includes('deployment infrastructure'), false);
});

test('first-party fallback requires one explicit visible action and normalizes it to an imperative', () => {
  const requirement = {
    id: 'graph', statement: 'builds trustworthy relationship graph', candidateIds: ['candidate'],
    subjectTokens: ['trust', 'relation'], visibleActionTerms: ['build'],
    firstPartyOutcomeText: 'The product builds a trustworthy relationship graph.',
  };

  assert.deepEqual(capabilityCatalogFirstPartyFallback(requirement), {
    requirement_id: 'graph', name: 'Build a trustworthy relationship graph',
    description: requirement.firstPartyOutcomeText, category: 'core', candidate_ids: ['candidate'],
    catalog_source: 'deterministic',
  });
  assert.equal(capabilityCatalogFirstPartyFallback({ ...requirement, visibleActionTerms: [] }), undefined);
  assert.equal(capabilityCatalogFirstPartyFallback({ ...requirement, visibleActionTerms: ['build', 'inspect'] }), undefined);
});

test('first-party fallback carries an audience-specific outcome into its title', () => {
  const requirement = {
    id: 'human', statement: 'people understand behavior', audience: 'human' as const, audienceLabel: 'people',
    candidateIds: ['candidate'], subjectTokens: ['understand', 'behavior'], visibleActionTerms: ['understand'],
    firstPartyOutcomeText: 'People understand connected software behavior before making changes.',
  };
  assert.deepEqual(capabilityCatalogFirstPartyFallback(requirement), {
    requirement_id: 'human', name: 'Understand connected software behavior before making changes for people',
    description: requirement.firstPartyOutcomeText, category: 'core', candidate_ids: ['candidate'],
    catalog_source: 'deterministic',
  });
});

test('first-party fallback uses only an unambiguous audience-scoped coordinated clause', () => {
  const shared = {
    id: 'human', statement: 'behavior comprehension', audience: 'human' as const, audienceLabel: 'people',
    candidateIds: ['candidate'], subjectTokens: ['understand', 'behavior'], visibleActionTerms: ['turn'],
    firstPartyOutcomeText: 'Turns the graph into behavior-level comprehension for people and AI agents.',
    audienceScopedOutcomeText: 'Turns the graph into behavior-level comprehension for people.',
  };
  const humanFallback = capabilityCatalogFirstPartyFallback(shared);
  assert.deepEqual(humanFallback, {
    requirement_id: 'human', name: 'Turn the graph into behavior-level comprehension for people',
    description: shared.audienceScopedOutcomeText, category: 'core', candidate_ids: ['candidate'],
    catalog_source: 'deterministic',
  });
  assert.equal(capabilityCatalogOutcomeBindingFailure(
    humanFallback as SystemCapability, ['candidate'], 'human', [shared], new Set(),
  ), undefined);
  const agent = {
    ...shared, id: 'agent', audience: 'agent' as const, audienceLabel: 'agents',
    audienceScopedOutcomeText: 'Turns the graph into behavior-level comprehension for agents.',
  };
  const agentFallback = capabilityCatalogFirstPartyFallback(agent);
  assert.equal(capabilityCatalogOutcomeBindingFailure(
    agentFallback as SystemCapability, ['candidate'], 'agent', [agent], new Set(),
  ), undefined);
  assert.equal(capabilityCatalogFirstPartyFallback({
    ...shared, firstPartyOutcomeText: 'People help agents understand connected software behavior.', audienceScopedOutcomeText: undefined,
  }), undefined);
});

test('description repair facts retain the exact stable capability identity', () => {
  const candidates = [{
    id: 'job_candidate', name: 'Manage job records', description: '', category: 'core', criticality: 'high',
    criticality_factors: [], operations: [], related_entities: [], related_domains: [],
  }] as SystemCapability[];
  const envelope = capabilityCatalogRepairPromptEnvelope(
    candidates, ['job_candidate'], [], new Map(), new Map(), ['Users track job applications.'], 'Access job sites by user',
  );

  assert.equal(envelope.facts[0]?.stable_capability_name, 'Access job sites by user');
});
