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
  conciseCapabilityCatalogOutcomeName,
  capabilitySatisfiesCatalogOutcomeRequirement,
  deriveCapabilityCatalogOutcomeRequirements,
  recoverGroundedAuthoredOutcomeCapabilities,
  sanitizeCapabilityCatalogDescription,
  uncoveredCapabilityCatalogOutcomeRequirements,
  type CapabilityCatalogOutcomeRequirement,
} from './capability-catalog-outcome-coverage';
import { selectMultiActionOutcomeCandidateIds } from './capability-outcome-evidence-selection';

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

test('does not promote authored usage examples into capability requirements', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: [
      'A pet clinic application for maintaining owner, pet, visit, and veterinarian records.',
      'Feature: Ask questions in natural language through the chatbot.',
      'Example: Which owners have dogs?',
      'Example: Are there any vets that specialize in surgery?',
    ].join(' '),
  }, [
    candidate('chatbot', 'Ask questions about clinic records', ['ask_clinic_question']),
    candidate('owners', 'Find owners with dogs', ['find_owners_with_dogs']),
    candidate('vets', 'Find veterinarians by specialty', ['find_vets_by_specialty']),
  ]);

  assert.equal(requirements.some(requirement => /owners with dogs/i.test(requirement.firstPartyOutcomeText || '')), false);
  assert.equal(requirements.some(requirement => /vets that specialize/i.test(requirement.firstPartyOutcomeText || '')), false);
  assert.equal(requirements.some(requirement => /questions in natural language/i.test(requirement.firstPartyOutcomeText || '')), true);
});

test('does not promote marketing-decorated generic management into a second outcome', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'Categorize and seamlessly manage your job applications. Categorize your applications by creating categories and adding job applications to them.',
  }, [candidate('categories', 'Job application categories', [
    'create_category',
    'add_job_application_category',
    'edit_category',
    'delete_category',
  ])]);

  assert.equal(requirements.filter(requirement =>
    requirement.visibleActionTerms?.includes('categorize')).length, 1);
});

test('treats authored feature bullets as outcomes without promoting overview prose or subordinate steps', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: [
      'Memos is an open-source, self-hosted knowledge hub where links, work logs, and snippets flow into one place.',
      'Feature: Capture quickly — Write in Markdown, attach media, and save without choosing a folder or title.',
      'Feature: Organize lightly — Use tags, search, pinning, and simple filters to revisit what matters.',
      'Feature: Share selectively — Keep memos private, publish them, or share with a link.',
      'Feature: Keep control — Self-host your data and move it whenever you choose.',
    ].join(' '),
  }, [
    candidate('capture', 'Capture memos', ['create_memo', 'attach_memo_media']),
    candidate('organize', 'Find and organize memos', ['search_memos', 'tag_memo', 'pin_memo']),
    candidate('share', 'Share memos selectively', ['publish_memo', 'create_memo_share']),
    candidate('control', 'Self-host memo data', ['deploy_memos', 'export_memo_data']),
  ]);

  assert.equal(requirements.length, 4);
  assert.deepEqual(
    requirements.map(requirement => requirement.firstPartyOutcomeText),
    [
      'Capture quickly — Write in Markdown, attach media, and save without choosing a folder or title',
      'Organize lightly — Use tags, search, pinning, and simple filters to revisit what matters',
      'Share selectively — Keep memos private, publish them, or share with a link',
      'Keep control — Self-host your data and move it whenever you choose',
    ],
  );
  assert.equal(requirements.some(requirement => /^Memos is\b/.test(requirement.firstPartyOutcomeText || '')), false);
  assert.equal(requirements.some(requirement => /^(?:attach media|save without)/i.test(requirement.firstPartyOutcomeText || '')), false);
  assert.deepEqual(
    requirements.map(requirement => requirement.statement),
    ['Capture quickly', 'Organize lightly', 'Share selectively', 'Keep control'],
  );
  assert.deepEqual(
    requirements.map(requirement => requirement.visibleActionTerms),
    [['capture'], ['organize'], ['share'], ['keep']],
  );
  assert.equal(requirements.some(requirement => /^(?:attach|save|publish)\b/i.test(requirement.statement)), false);
});


test('preserves concise authored capability statements without vocabulary-dependent merging', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: [
      'Feature: Understand what a codebase actually built.',
      'Feature: Onboard to an unfamiliar system without reading every file.',
      'Feature: Know what will break before changing something.',
      'Feature: Verify AI-generated code beyond the demo path.',
      'Feature: Work alongside other people and agents on one codebase without duplicating or colliding.',
    ].join(' '),
  }, [
    candidate('cap_comprehension', 'Comprehension', ['explain_system_behavior']),
    candidate('cap_agent_adoption', 'Agent Adoption', ['get_agent_start_context']),
    candidate('cap_risk', 'Risk', ['assess_change_risk']),
    candidate('cap_tests', 'Tests', ['validate_behavioral_invariants']),
    candidate('cap_overlap', 'Overlap', ['coordinate_overlapping_work']),
  ]);

  assert.deepEqual(
    requirements.map(requirement => requirement.statement),
    [
      'Understand what a codebase actually built',
      'Onboard to an unfamiliar system without reading every file',
      'Know what will break before changing something',
      'Verify AI-generated code beyond the demo path',
      'Work alongside other people and agents on one codebase without duplicating or colliding',
    ],
  );
  assert.equal(requirements.filter(requirement => requirement.statement.startsWith('Work alongside')).length, 1);
  assert.deepEqual(requirements.map(requirement => requirement.candidateIds), [
    ['cap_comprehension'], ['cap_agent_adoption'], ['cap_risk'], ['cap_tests'], ['cap_overlap'],
  ]);
});

test('recovers only structurally grounded authored outcomes after AI omission', () => {
  const grounded = candidate('risk', 'Risk', ['assess_change_risk']);
  const requirements: CapabilityCatalogOutcomeRequirement[] = [
    {
      candidateIds: ['risk'],
      firstPartyOutcomeText: 'Know what will break before changing something',
      id: 'all:risk',
      statement: 'Know what will break before changing something',
      subjectTokens: ['risk'],
    },
    {
      candidateIds: [],
      firstPartyOutcomeText: 'Promise an outcome that is not implemented',
      id: 'all:missing',
      statement: 'Promise an outcome that is not implemented',
      subjectTokens: ['promise'],
    },
  ];

  const recovered = recoverGroundedAuthoredOutcomeCapabilities([], requirements, [grounded]);

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].name, 'Know what will break before changing something');
  assert.deepEqual(recovered[0].operations, grounded.operations);
  assert.ok(recovered[0].criticality_factors.includes('catalog-candidate:risk'));
  assert.ok(recovered[0].criticality_factors.includes('catalog-outcome-requirement:all:risk'));
});
test('retains a richer authored capability when grounding recovery resolves the same outcome identity', () => {
  const grounded = candidate('invoice', 'Invoice', ['settle_invoice']);
  const requirement: CapabilityCatalogOutcomeRequirement = {
    candidateIds: ['invoice'],
    firstPartyOutcomeText: 'Settle customer invoices',
    id: 'all:invoice-settle',
    statement: 'Settle customer invoices',
    subjectTokens: ['settle', 'invoice'],
    requiredSubjectTerms: ['settle', 'invoice'],
    minimumSubjectMatches: 2,
  };
  const authored = {
    ...grounded,
    id: 'capability_authored_all_invoice_settle',
    name: 'Settle customer invoices',
    description: 'Billing staff settle customer invoices after capturing payments and preserve the resulting status.',
    name_source: 'ai' as const,
    description_source: 'ai' as const,
    description_generation: { attempted: true, status: 'success' as const },
  };

  const placeholder = {
    ...authored,
    name: 'settle customer invoices',
    description: 'settle customer invoices.',
    name_source: 'deterministic' as const,
    description_source: 'deterministic' as const,
  };

  const recovered = recoverGroundedAuthoredOutcomeCapabilities([placeholder], [requirement], [grounded], new Map(), [authored]);

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].description, authored.description);
  assert.equal(recovered[0].description_source, 'ai');
  assert.ok(recovered[0].criticality_factors.includes('catalog-outcome-requirement:all:invoice-settle'));
});
test('prefers a candidate whose identity names the first-party outcome over incidental operation overlap', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'Route requests to handlers with a macro-free API.',
  }, [
    candidate('clone', 'Clone', ['route_request_handler', 'clone_router_request_handler']),
    candidate('routing', 'Routing', ['register_handler']),
  ]);

  assert.equal(requirements.length, 1);
  assert.deepEqual(requirements[0].candidateIds, ['routing']);
});

test('grounds library outcomes in matching public symbols instead of incidental directory words', () => {
  const clone = candidate('clone', 'Clone', ['Coordinate']);
  clone.evidence_role = 'supporting-mechanism';
  clone.operations[0].entry_point_id = 'node:method:src/extract/cookie.rs:CookieJar:clone';
  clone.operations[0].path_or_command = 'src/extract/cookie.rs';
  const parts = candidate('parts', 'Parts', ['Coordinate']);
  parts.evidence_role = 'supporting-mechanism';
  parts.operations[0].entry_point_id = 'node:function:src/ext_traits/request.rs:extract_parts';
  parts.operations[0].path_or_command = 'src/ext_traits/request.rs';
  const response = candidate('into', 'Into', ['Coordinate']);
  response.evidence_role = 'supporting-mechanism';
  response.operations[0].entry_point_id = 'node:function:src/response/into_response.rs:into_response';
  response.operations[0].path_or_command = 'src/response/into_response.rs';
  const pipeline = candidate('ci', 'CI Pull Request', ['CI pull_request']);
  pipeline.evidence_role = 'supporting-mechanism';
  pipeline.evidence_kind = 'behavior-surface';
  pipeline.operations[0].entry_point_id = 'entry:ci_pipeline:.github/workflows/ci.yml:CI:pull_request:1';

  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'High level features: Declaratively parse requests using extractors. Generate responses with minimal boilerplate.',
  }, [clone, parts, response, pipeline]);

  const extraction = requirements.find(requirement => requirement.firstPartyOutcomeText?.includes('Declaratively parse requests'));
  const responses = requirements.find(requirement => requirement.subjectTokens.includes('response'));
  assert.ok(extraction);
  assert.ok(responses);
  assert.deepEqual(extraction.candidateIds, ['parts']);
  assert.deepEqual(responses.candidateIds, ['into']);
});

test('keeps demonstration outcomes and rejects technology-stack listings as authored capabilities', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'This microservices branch was derived from an earlier application to demonstrate how to split a sample Spring application into microservices. To achieve that goal, we use Spring Cloud Gateway, Circuit Breaker, Open Telemetry, and Eureka Service Discovery.',
  }, [
    candidate('microservices', 'Split Spring application into microservices', ['split_spring_application']),
    candidate('gateway', 'Spring Cloud Gateway', ['gateway_route']),
    candidate('telemetry', 'Open Telemetry', ['telemetry_collect']),
  ]);

  assert.equal(requirements.some(requirement => requirement.statement === 'Learn how to split a sample Spring application into microservices'), true);
  assert.equal(requirements.some(requirement => /open telemetry|cloud gateway/i.test(requirement.statement)), false);
  assert.equal(requirements.some(requirement => requirement.requiredSubjectTerms?.includes('telemetry')), false);
});

test('uses contextual architecture to inform synthesis without making it an authored outcome requirement', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: [
      'This sample application exists to demonstrate how to split an application into microservices.',
      'Context: Vets Service handles information about veterinarians.',
      'Context: API Gateway routes client requests to services.',
      'Feature: Users can ask natural-language questions about owners and veterinarians.',
    ].join(' '),
  }, [
    candidate('microservices', 'Split application into microservices', ['split_application']),
    candidate('vets', 'Find veterinarians', ['read_veterinarian']),
    candidate('gateway', 'Route client requests', ['route_request']),
    candidate('chatbot', 'Ask questions about owners and veterinarians', ['ask_question']),
  ]);

  assert.equal(requirements.some(requirement => /split.*microservices/i.test(requirement.statement)), true);
  assert.equal(requirements.some(requirement => /natural-language questions/i.test(requirement.statement)), true);
  assert.equal(requirements.some(requirement => /api gateway|routes client requests/i.test(requirement.statement)), false);
  assert.equal(requirements.some(requirement => /^Vets Service/i.test(requirement.statement)), false);
});

test('normalizes conversational product examples into outcome-shaped requirements', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: [
      'Context: GenAI Service provides a chatbot interface to the application.',
      'Feature: Spring Petclinic integrates a Chatbot that allows you to interact with the application in a natural language.',
      'Feature: Please list the owners that come to the clinic.',
      'Feature: Are there any vets that specialize in surgery?',
      'Feature: Which owners have dogs?',
    ].join(' '),
  }, [
    candidate('genai', 'Genai workflow', ['chat']),
    candidate('owners', 'List owners', ['read_owner']),
    candidate('vets', 'Find veterinarians by specialty', ['read_vet_specialty']),
    candidate('pets', 'Find owners with pets', ['read_owner_pet']),
  ]);

  const statements = requirements.map(requirement => requirement.statement);
  assert.equal(statements.some(statement => /^Ask questions in natural language through the chatbot$/i.test(statement)), true);
  assert.equal(statements.some(statement => /^List the owners that come to the clinic$/i.test(statement)), true);
  assert.equal(statements.some(statement => /^Find vets that specialize in surgery$/i.test(statement)), true);
  assert.equal(statements.some(statement => /^Find owners with dogs$/i.test(statement)), true);
  assert.equal(statements.some(statement => /^(?:Are there|Which|Please)\b/i.test(statement)), false);
  assert.deepEqual(requirements.find(requirement => /^Ask questions in natural language through the chatbot$/i.test(requirement.statement))?.candidateIds, ['genai']);
  assert.equal(Boolean(requirements.find(requirement => /split.*microservices/i.test(requirement.statement))?.candidateIds.includes('genai')), false);
});

test('turns a sample-collection README description into an audience outcome', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'A collection of open source samples that illustrate best practices for Flutter.',
  }, [candidate('flutter-samples', 'Flutter samples', ['open_flutter_sample'])]);

  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].statement, 'Learn Flutter best practices from open source samples');
  assert.equal(requirements[0].firstPartyOutcomeText,
    'A collection of open source samples that illustrate best practices for Flutter');
  assert.deepEqual(requirements[0].visibleActionTerms, ['learn']);
  assert.deepEqual(requirements[0].candidateIds, ['flutter-samples']);
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
  assert.equal(canonicalCapabilityCatalogOutcomeToken('status'), 'status');
  assert.equal(canonicalCapabilityCatalogOutcomeToken('statu'), 'status');
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
  assert.equal(capabilityCatalogOutcomesMayMerge(
    { ...people, criticality_factors: [] },
    { ...people, criticality_factors: [] },
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

test('uses the outcome action to disambiguate shared subjects during unique binding', () => {
  const broad: CapabilityCatalogOutcomeRequirement = {
    id: 'all:track-job-applications',
    statement: 'keep track of job applications',
    firstPartyOutcomeText: 'Keep track of job applications.',
    candidateIds: ['jobs', 'notes'],
    subjectTokens: ['job', 'application'],
    requiredSubjectTerms: ['job', 'application'],
    visibleActionTerms: ['keep'],
  };
  const notes: CapabilityCatalogOutcomeRequirement = {
    id: 'all:manage-job-application-notes',
    statement: 'delete or edit job applications and add notes to job applications',
    firstPartyOutcomeText: 'Delete or edit job applications. Add notes to job applications.',
    candidateIds: ['jobs', 'notes'],
    subjectTokens: ['job', 'application', 'note'],
    requiredSubjectTerms: ['job', 'application'],
    visibleActionTerms: ['delete'],
  };
  const capability = published(
    'Attach notes to job applications',
    'Job applicants retain contextual notes with each application.',
  );
  capability.criticality_factors = ['catalog-candidate:notes'];

  const [bound] = bindUniquelySatisfiedCatalogOutcomeRequirements([capability], [broad, notes]);

  assert.equal(
    bound.criticality_factors.includes('catalog-outcome-requirement:all:manage-job-application-notes'),
    true,
  );
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

test('pairs each action with its subject and folds exact operation evidence into the parent family', () => {
  const evidence = (id: string, values: string[], aggregateRank = 0, evidenceRank = 0, identityValues = values) => ({
    id,
    aggregateRank,
    evidenceRank,
    identityTokens: new Set(identityValues),
    symbolTokens: new Set(identityValues),
    tokens: new Set(values),
  });
  const purposeVerbs = new Set(['add', 'create', 'delete', 'display', 'edit', 'filter', 'search', 'update']);
  const tokenize = (value: string) => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  assert.deepEqual(selectMultiActionOutcomeCandidateIds(
    'Delete or edit job applications. Add notes to job applications. Display the note count.',
    [
      evidence('jobs', ['delete', 'edit', 'job', 'application']),
      evidence('categories', ['create', 'edit', 'delete', 'category']),
      evidence('notes', ['add', 'delete', 'note', 'job', 'application'], 0, 0, ['note']),
      evidence('operation-obligation:notes:0123456789abcdef', ['edit', 'note', 'job', 'application']),
      evidence('route-add-note', ['add', 'note', 'job', 'application'], 1),
    ],
    tokenize,
    token => purposeVerbs.has(token),
  ), ['jobs', 'notes']);
});

test('preserves complete outcome clauses from a feature-rich README instead of emitting sentence fragments', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocSummary: 'Todojobs is a web application that allows to you record and keep track of your job applications. Categorize and seamlessly manage your job applications. Categorize your applications: You can categorize your applications by creating different categories and adding your job applications to any corresponding category. You can also edit or delete your categories. Manage application status: You can manage your application status. You can change to Rejected, Assessment, Interview or set it to closed. Manage job application: You can delete or edit your job applications with easy. You can add notes to your job applications. Job applications with notes display the note count. Robust job filter: Filter between job applications using the category, status, and the job board or website. The search feature also adds and extra way to narrow down what you are looking for.',
  }, [
    candidate('jobs', 'Track job applications and application status', ['record_job', 'update_job_status', 'filter_jobs', 'delete_job', 'edit_job']),
    candidate('categories', 'Organize application categories', ['create_category', 'edit_category', 'delete_category']),
    candidate('notes', 'Record job application notes', ['add_note', 'delete_note']),
    candidate('route-add-note', 'Add note route', ['add_note']),
  ]);
  const statements = requirements.map(requirement => requirement.statement);

  assert.ok(statements.includes('keep track of your job applications'));
  assert.equal(requirements.find(requirement => requirement.statement === 'keep track of your job applications')?.candidateIds.includes('jobs'), true);
  assert.equal(statements.includes('Categorize and seamlessly manage your job applications'), false);
  assert.equal(statements.filter(statement => /^categorize/i.test(statement)).length, 1, JSON.stringify(requirements));
  const categorization = requirements.find(requirement =>
    requirement.statement.startsWith('categorize your applications by creating different categories'));
  assert.ok(categorization?.statement.includes('edit or delete your categories'));
  assert.deepEqual(categorization?.candidateIds.sort(), ['categories', 'jobs']);
  assert.ok(statements.some(statement => statement.startsWith('manage your application status') && statement.includes('Interview or set it to closed')));
  assert.ok(statements.some(statement => statement.startsWith('delete or edit your job applications') && statement.includes('add notes to your job applications')));
  const jobManagement = requirements.find(requirement => requirement.statement.startsWith('delete or edit your job applications'))!;
  assert.deepEqual(jobManagement.visibleActionTerms, ['delete']);
  assert.deepEqual(jobManagement.candidateIds.sort(), ["jobs", "notes"]);
  assert.equal(capabilityCatalogOutcomeNameFailure("Attach notes to job applications", jobManagement), undefined);
  assert.ok(statements.some(statement => statement.startsWith('Filter between job applications using the category, status, and the job board or website') && statement.includes('narrow down what you are looking for')), JSON.stringify(statements));
  assert.equal(statements.some(statement => /^(?:corresponding|with easy|status: status|search feature adds)$/i.test(statement)), false);
  assert.equal(requirements.some(requirement => requirement.requiredSubjectTerms?.includes('statu')), false);
  assert.equal(requirements.some(requirement => requirement.requiredSubjectTerms?.includes('status')), true);
  assert.equal(requirements.find(requirement => requirement.statement.startsWith('manage your application status'))?.candidateIds.includes('jobs'), true);
  const status = requirements.find(requirement => requirement.statement.startsWith('manage your application status'));
  const filter = requirements.find(requirement => requirement.statement.startsWith('Filter between job applications'));
  assert.equal(status?.candidateIds.includes('jobs'), true);
  assert.equal(filter?.candidateIds.includes('jobs'), true);
  assert.deepEqual(status?.visibleActionTerms, []);
  assert.notEqual(status?.id, filter?.id);
});

test('rejects sentence-shaped repair text as a capability title', () => {
  const requirement: CapabilityCatalogOutcomeRequirement = {
    id: 'all:categorize-job', statement: 'Categorize job applications', candidateIds: ['jobs'],
    subjectTokens: ['job', 'application'], requiredSubjectTerms: ['job', 'application'], visibleActionTerms: ['categorize'],
  };
  assert.equal(
    capabilityCatalogOutcomeNameFailure('Categorize your applications You can categorize your applications by creating different categories', requirement),
    'required-outcome-title-not-concise:all:categorize-job',
  );
  assert.equal(capabilityCatalogOutcomeNameFailure('Change application status to Rejected, Assessment, or Interview', requirement), 'required-outcome-title-not-concise:all:categorize-job');
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
  const direct = published('Track notes', 'Users track notes through the verified product workflow.');
  direct.criticality_factors = ['catalog-candidate:cap_note_management'];
  const occupied = published('Categorize records', 'Users categorize records and can also inspect attached notes.');
  occupied.criticality_factors = ['catalog-candidate:cap_note_management', 'catalog-outcome-requirement:all:categorize'];
  const directBound = bindAtomicallySatisfiedCatalogOutcomeRequirements([occupied, direct], [requirement], new Set(['cap_note_management']), scopes);
  assert.equal(uncoveredCapabilityCatalogOutcomeRequirements(directBound, [requirement]).length, 0);
  assert.equal(directBound[0].criticality_factors.includes('catalog-outcome-union:all:note'), false);
  assert.equal(directBound[1].criticality_factors.includes('catalog-outcome-union:all:note'), true);
  const compoundRequirement: CapabilityCatalogOutcomeRequirement = {
    ...requirement,
    id: 'all:categorize-category',
    firstPartyOutcomeText: 'Categorize applications by creating categories. Edit or delete categories.',
    statement: 'categorize applications by creating categories and edit or delete categories',
    subjectTokens: ['application', 'category', 'create', 'edit', 'delete'],
    requiredSubjectTerms: ['application', 'category', 'create', 'edit', 'delete'],
    visibleActionTerms: ['categorize'],
  };
  const organized = published('Organize job applications by category', 'Users create, edit, and delete categories for job applications.');
  organized.criticality_factors = ['catalog-candidate:cap_note_management'];
  const compoundBound = bindAtomicallySatisfiedCatalogOutcomeRequirements(
    [organized], [compoundRequirement], new Set(['cap_note_management']), scopes,
  );
  assert.equal(uncoveredCapabilityCatalogOutcomeRequirements(compoundBound, [compoundRequirement]).length, 0);
  const partial = bindAtomicallySatisfiedCatalogOutcomeRequirements([atom('create'), atom('delete')], [requirement], new Set(), scopes);
  const multiParentRequirement: CapabilityCatalogOutcomeRequirement = {
    ...requirement,
    id: 'all:applications-and-notes',
    firstPartyOutcomeText: 'Manage job applications. Add, edit, and delete notes for each application.',
    statement: 'manage job applications and add edit or delete notes for each application',
    subjectTokens: ['job', 'application', 'note'],
    requiredSubjectTerms: ['application', 'note'],
    minimumSubjectMatches: 2,
    candidateIds: ['cap_job_management', 'cap_note_management'],
  };
  const jobs = published('Manage job applications', 'Users create, edit, and delete job applications.');
  jobs.criticality_factors = [
    'catalog-candidate:cap_job_management',
    'catalog-outcome-requirement:all:applications-and-notes',
  ];
  const notes = published('Track job application notes', 'Users add, edit, and delete notes for each job application.');
  notes.criticality_factors = [
    'catalog-operation-obligation:operation-obligation:cap_note_management:read',
    'catalog-operation-obligation:operation-obligation:cap_note_management:create',
    'catalog-operation-obligation:operation-obligation:cap_note_management:delete',
  ];
  const multiParentBound = bindAtomicallySatisfiedCatalogOutcomeRequirements(
    [jobs, notes], [multiParentRequirement], new Set(['cap_job_management']), scopes,
  );
  assert.equal(multiParentBound[1].criticality_factors.includes('catalog-outcome-requirement:all:applications-and-notes'), true);
  assert.equal(multiParentBound[1].criticality_factors.includes('catalog-outcome-union:all:applications-and-notes'), true);
  const rebound = bindAtomicallySatisfiedCatalogOutcomeRequirements(
    multiParentBound, [multiParentRequirement], new Set(['cap_job_management']), scopes,
  );
  assert.equal(rebound.filter(item => item.criticality_factors.includes('catalog-outcome-union:all:applications-and-notes')).length, 1);
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

test('moves enumerated state-transition details out of capability titles only when evidence retains them', () => {
  const title = 'Change job application status to Rejected, Assessment, Interview, or closed';
  const evidence = 'Job application status changes to Rejected, Assessment, Interview, or closed.';

  assert.equal(conciseCapabilityCatalogOutcomeName(title, evidence), 'Change job application status');
  assert.equal(conciseCapabilityCatalogOutcomeName(title, 'Job application status changes.'), title);
  assert.equal(
    conciseCapabilityCatalogOutcomeName('Filter applications by category, status, and job board', evidence),
    'Filter applications by category, status, and job board',
  );
});

test('moves a proven multi-step implementation clause out of an outcome title', () => {
  const title = 'Categorize job applications by creating, editing, or deleting categories and adding applications to them';
  const evidence = 'Job applications are organized into user-defined categories by creating new categories, adding applications to them, editing category names, or deleting categories.';

  assert.equal(conciseCapabilityCatalogOutcomeName(title, evidence), 'Categorize job applications');
  assert.equal(
    conciseCapabilityCatalogOutcomeName('Categorize your applications by creating categories and adding job applications to them', evidence),
    'Categorize your applications',
  );
  assert.equal(
    conciseCapabilityCatalogOutcomeName(title, 'Job applications can be organized into categories.'),
    title,
  );
  assert.equal(conciseCapabilityCatalogOutcomeName('Filter applications by category, status, and job board', evidence), 'Filter applications by category, status, and job board');
});


test('repairs an omitted control noun in otherwise grounded capability prose', () => {
  assert.equal(
    sanitizeCapabilityCatalogDescription('Users retain full of their infrastructure and data.'),
    'Users retain full control of their infrastructure and data.',
  );
});

test('a product-goal clause whose only grounded subject is a verb does not become an outcome requirement (corpus shape)', () => {
  const apiGroup = (id: string, name: string, ops: string[]) => ({ id, name, category: 'core', evidence_role: 'product-outcome', evidence_kind: 'behavior-surface', related_entities: [], related_domains: [],
    operations: ops.map(action => ({ entry_point_id: `e_${action}`, entry_point_type: 'api', action })), evidence_examples: ops.map(action => `${action}: ${action.replace(/_/g, ' ')}`), criticality: 'medium', criticality_factors: [] } as any);
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    concepts: ['web application framework', 'wsgi'],
    productDocTitle: 'Flask',
    productDocSummary: 'Flask is a lightweight WSGI web application framework. It is designed to make getting started quick and easy, with the ability to scale up to complex applications.',
    manifestDescription: 'A simple framework for building complex web applications.',
  } as any, [apiGroup('cap_flask_helpers_api_management', 'Flask Helpers API', ['make_response', 'flash', 'redirect', 'abort', 'url_for']), apiGroup('cap_flask_app_api_management', 'Flask App API', ['route', 'run', 'make_config', 'test_client'])]);
  assert.equal(requirements.length, 0, JSON.stringify(requirements.map(requirement => [requirement.id, requirement.subjectTokens])));
});

test('a product-goal clause with no object (only a verb) does not become an outcome requirement', () => {
  const requirements = deriveCapabilityCatalogOutcomeRequirements({
    productDocTitle: 'Flask',
    productDocSummary: 'Flask is a lightweight WSGI web application framework. It is designed to make getting started quick and easy, with the ability to scale up to complex applications.',
  }, [candidate('helpers', 'Flask Helpers API', ['make_response', 'flash', 'redirect', 'abort']), candidate('app', 'Flask App API', ['route', 'run', 'make_config'])]);
  assert.equal(requirements.filter(requirement => requirement.subjectTokens.every(token => token === 'make')).length, 0);
});

test('a fulfilled requirement only rejects a later item that names its subject; unrelated outcomes stay independent', () => {
  const requirement = { id: 'all:profile', subjectTokens: ['customer', 'profile'], candidateIds: ['profiles'], requiredSubjectTerms: ['customer', 'profile'] } as any;
  const fulfilled = new Set(['all:profile']);
  assert.equal(capabilityCatalogOutcomeBindingFailureDetail({ name: 'Onboard customer profiles', description: 'Support staff onboard customer profiles.' }, ['profiles'], 'all:profile', [requirement], fulfilled)?.reason, 'required-outcome-already-fulfilled:all:profile');
  assert.equal(capabilityCatalogOutcomeBindingFailureDetail({ name: 'Render dynamic templates', description: 'Developers render templates with Jinja.' }, ['profiles'], 'all:profile', [requirement], fulfilled)?.reason, 'independent-outcome');
});

test('an item sharing no subject term with the active requirement is an independent outcome, not a mismatch', () => {
  const requirement = { id: 'all:profile', subjectTokens: ['customer', 'profile'], candidateIds: ['profiles'], requiredSubjectTerms: ['customer', 'profile'] } as any;
  const verdict = capabilityCatalogOutcomeBindingFailureDetail({ name: 'Render dynamic templates', description: 'Developers render templates.' }, ['templating'], 'all:profile', [requirement], new Set());
  assert.equal(verdict?.reason, 'independent-outcome');
  const wrongCandidate = capabilityCatalogOutcomeBindingFailureDetail({ name: 'Onboard customer profiles', description: 'Staff onboard customer profiles.' }, ['templating'], 'all:profile', [requirement], new Set());
  assert.equal(wrongCandidate?.reason, 'required-outcome-candidate-mismatch:all:profile');
});
