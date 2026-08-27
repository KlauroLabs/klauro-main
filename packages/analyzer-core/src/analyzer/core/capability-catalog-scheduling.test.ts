import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import {
  capabilitiesWithoutDescriptionDisposition,
  capabilityCatalogPendingRepairKeys,
  capabilityCatalogCycleDiagnostic,
  capabilityCatalogOutcomeCorrectiveRetryFeedback,
  capabilityIdentityPendingDescriptionRepair,
  scheduleRejectedCapabilityDescriptions,
  selectCapabilityCatalogPromptCandidates,
  uncoveredCapabilityCatalogCandidateIds,
  capabilityTitlesShareOutcome,
  capabilityDescriptionsShareOutcome,
  capabilityCatalogTargetedRepairBatches,
  collectCapabilityCatalogEvidenceBatches,
  capabilityCatalogRepairEvidenceFacts,
  capabilityOutcomeMatchesEvidence,
  mergeUniquelyMatchedBehaviorEvidence,
  mergeCapabilityCatalogRepairResults,
  recordCapabilityCatalogRejection,
  recordCapabilityPublishabilityRejection,
  retryEmptyCapabilityCatalogOutcome,
  trackCapabilityCatalogRepair,
  updateCapabilityCatalogPublishabilityRepairIds,
} from './capability-catalog-scheduling';
import { capabilityDescriptionProductLanguageViolation, capabilityOutcomeScopeFailure } from './capability-catalog-evidence';
import { capabilityCatalogOutcomeNameFailure } from './capability-catalog-outcome-coverage';
import { validateElementDescription } from '../../ai/element-description-validator';

const catalogCapability = (overrides: Partial<SystemCapability>): SystemCapability => ({
  id: 'capability',
  name: 'Analyze Codebase',
  description: 'Builds behavior-level understanding of a codebase.',
  category: 'core',
  operations: [],
  related_entities: [],
  related_domains: [],
  criticality: 'high',
  criticality_factors: [],
  ...overrides,
});

test('scopes every focused zero-result rejection class to exactly one outcome retry', async () => {
  const requirement = { id: 'human-slot', statement: 'people understand behavior', audience: 'human' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
  const reasons = [
    'malformed-response',
    'required-outcome-requirement-mismatch:wrong',
    'required-outcome-candidate-mismatch:human-slot',
    'required-outcome-audience-missing:human',
    'outcome-scope-unsupported:inventory',
    'grounding-missing',
    'description-delivery-operation-restatement',
  ];

  for (const reason of reasons) {
    const rejections = [
      { candidateIds: ['wrong'], name: 'Rejected result', reason, requirementId: requirement.id },
    ];
    const feedback = capabilityCatalogOutcomeCorrectiveRetryFeedback(rejections, requirement, ['shared']);
    assert.equal(feedback.requirementId, 'human-slot');
    assert.equal(feedback.reason, reason);
    assert.deepEqual(feedback.candidateIds, ['shared']);
    let retries = 0;
    const recorded: Array<{ candidateIds: string[]; requirementId?: string }> = [];
    const result = await retryEmptyCapabilityCatalogOutcome({
      candidateIds: ['shared'], initial: [], rejections, requirement,
      record: scoped => recorded.push(scoped),
      retry: async () => { retries++; return ['corrected']; },
    });
    assert.deepEqual(result, ['corrected']);
    assert.equal(retries, 1);
    assert.deepEqual(recorded[0]?.candidateIds, ['shared']);
    assert.equal(recorded[0]?.requirementId, requirement.id);
  }
  assert.equal(capabilityCatalogOutcomeCorrectiveRetryFeedback([], requirement, ['shared']).reason, 'required-outcome-zero-result');
});

test('uniquely matched behavior evidence enriches an accepted product outcome without replacing its authored identity', () => {
  const accepted = catalogCapability({
    id: 'accepted-analysis',
    operations: [{ entry_point_id: 'existing', entry_point_type: 'command', action: 'analyze repository' }],
    related_entities: ['entity_existing'],
    related_domains: ['codebase'],
    criticality_factors: ['catalog-candidate:cap_analysis_core'],
  });
  const surface = catalogCapability({
    id: 'cap_analysis_mcp_tool_surface',
    name: 'Analysis MCP Tool Surface',
    description: '',
    evidence_kind: 'behavior-surface',
    operations: [{ entry_point_id: 'tool', entry_point_type: 'mcp_tool', action: 'analyze codebase' }],
    related_entities: ['entity_tool'],
    related_domains: ['analysis'],
    evidence_examples: ['analyze codebase'],
  });

  const merged = mergeUniquelyMatchedBehaviorEvidence(
    [accepted],
    [surface],
    [surface.id],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, accepted.name);
  assert.equal(merged[0].description, accepted.description);
  assert.deepEqual(merged[0].operations.map(operation => operation.entry_point_id), ['existing', 'tool']);
  assert.deepEqual(merged[0].related_entities, ['entity_existing', 'entity_tool']);
  assert.deepEqual(merged[0].related_domains, ['codebase', 'analysis']);
  assert.ok(merged[0].criticality_factors.includes(`catalog-candidate:${surface.id}`));
  assert.deepEqual(merged[0].evidence_examples, ['analyze codebase']);
});

test('behavior evidence remains uncovered when its outcome match is ambiguous', () => {
  const surface = catalogCapability({
    id: 'cap_codebase_surface', name: 'Codebase Tool Surface', evidence_kind: 'behavior-surface',
  });
  const capabilities = [
    catalogCapability({ id: 'analysis', name: 'Analyze Codebase' }),
    catalogCapability({ id: 'history', name: 'Track Codebase History' }),
  ];

  const merged = mergeUniquelyMatchedBehaviorEvidence(capabilities, [surface], [surface.id]);

  assert.ok(merged.every(capability => !capability.criticality_factors.includes(`catalog-candidate:${surface.id}`)));
});

test('an accepted outcome can absorb focused repair evidence only when its title names that evidence subject', () => {
  const fabric = catalogCapability({
    id: 'fabric',
    name: 'Fabric Tool Surface',
    evidence_kind: 'behavior-surface',
    evidence_examples: ['claim_work', 'check_collision', 'release_work'],
  });

  assert.equal(capabilityOutcomeMatchesEvidence('Understand workspace capability map', [fabric]), false);
  assert.equal(capabilityOutcomeMatchesEvidence('Coordinate overlapping agent work', [fabric]), true);
});

test('automatic evidence merge never absorbs entity evidence or an unrequired surface', () => {
  const entity = catalogCapability({ id: 'cap_analysis_entity', name: 'Analysis', evidence_kind: 'infrastructure' });
  const optionalSurface = catalogCapability({ id: 'cap_analysis_optional', name: 'Analysis Tool Surface', evidence_kind: 'behavior-surface' });

  const merged = mergeUniquelyMatchedBehaviorEvidence(
    [catalogCapability({ id: 'analysis' })],
    [entity, optionalSurface],
    [entity.id],
  );

  assert.deepEqual(merged[0].criticality_factors, []);
});

test('prompt selection represents every required entity family beyond the baseline window', () => {
  const productCandidates = Array.from({ length: 37 }, (_, index) => ({
    id: `product-${index}`,
    name: `Product ${index}`,
    category: 'core',
    evidence_kind: 'entity',
  }));
  const internalCandidates = Array.from({ length: 49 }, (_, index) => ({
    id: `internal-${index}`,
    name: `Internal ${index}`,
    category: 'internal',
    evidence_kind: 'behavior-surface',
  }));
  const requiredGroups = productCandidates.map(candidate => [candidate.id]);
  const selected = selectCapabilityCatalogPromptCandidates(
    [...productCandidates, ...internalCandidates] as any[],
    requiredGroups,
  );
  const selectedIds = new Set(selected.map(candidate => candidate.id));

  assert.equal(selected.length, 56);
  assert.ok(requiredGroups.every(group => group.some(candidateId => selectedIds.has(candidateId))));
  assert.equal(selected.filter(candidate => candidate.category === 'internal').length, 19);
});

test('prompt selection retains nonmandatory supporting and verification surfaces as context', () => {
  const selected = selectCapabilityCatalogPromptCandidates([
    { id: 'required', name: 'Review work', category: 'core', evidence_kind: 'behavior-surface', evidence_role: 'product-outcome' },
    { id: 'support', name: 'Coordinate transport', category: 'supporting', evidence_kind: 'behavior-surface', evidence_role: 'supporting-mechanism' },
    { id: 'proof', name: 'Exercise proof', category: 'supporting', evidence_kind: 'behavior-surface', evidence_role: 'verification-harness' },
  ] as any[]);

  assert.deepEqual(selected.map(candidate => candidate.id), ['required', 'support', 'proof']);
});

test('prompt selection retains first-party internal surfaces as context without elevating them above other delivery evidence', () => {
  const selected = selectCapabilityCatalogPromptCandidates([
    { id: 'bootstrap', name: 'Bootstrap Surface', category: 'internal', evidence_kind: 'behavior-surface', evidence_role: 'supporting-mechanism' },
    {
      id: 'fabric', name: 'Fabric MCP Tool Surface', category: 'internal', evidence_kind: 'behavior-surface',
      evidence_role: 'supporting-mechanism', evidence_role_reasons: ['first-party-product-delivery-surface-supports-outcome'],
    },
  ] as any[]);

  assert.deepEqual(selected.map(candidate => candidate.id), ['bootstrap', 'fabric']);
});

test('targeted repair isolates evidence families while a full pass remains one batch', () => {
  const facts = [{ candidate_id: 'workspace' }, { candidate_id: 'fabric' }, { candidate_id: 'history' }];

  assert.deepEqual(capabilityCatalogTargetedRepairBatches(facts, true), facts.map(fact => [fact]));
  assert.deepEqual(capabilityCatalogTargetedRepairBatches(facts, false), [facts]);
});

test('behavior-surface repair facts exclude internal entity names while entity evidence retains them', () => {
  const entityNames = new Map([['entity_config', 'KlauroConfig']]);
  const candidates = [
    { id: 'runtime', evidence_kind: 'behavior-surface', related_entities: ['entity_config'], name: 'Runtime Tool Surface' },
    { id: 'history', evidence_kind: 'entity', related_entities: ['entity_config'], name: 'Change History' },
  ] as SystemCapability[];

  const facts = capabilityCatalogRepairEvidenceFacts(candidates, ['runtime', 'history'], entityNames);

  assert.deepEqual(facts.find(fact => fact.candidate_id === 'runtime')?.entity_names, []);
  assert.deepEqual(facts.find(fact => fact.candidate_id === 'runtime')?.evidence_subject_terms, ['runtime']);
  assert.deepEqual(facts.find(fact => fact.candidate_id === 'history')?.entity_names, ['KlauroConfig']);
  assert.ok(facts.find(fact => fact.candidate_id === 'history')?.evidence_subject_terms.includes('config'));
});

test('capability repair facts carry bounded candidate-specific rejection constraints', () => {
  const candidates = [
    { id: 'agent', name: 'Agent Tool Surface', category: 'core', evidence_kind: 'behavior-surface' },
    { id: 'analysis', name: 'Analysis Tool Surface', category: 'core', evidence_kind: 'behavior-surface' },
  ] as SystemCapability[];
  const rejections = new Map();
  const recorded = recordCapabilityCatalogRejection(rejections, {
    candidateIds: ['agent'],
    missingAudience: 'agents',
    missingSubjectTerms: ['understand', 'behavior'],
    name: 'Evaluate agent readiness and task proof',
    reason: 'outcome-scope-unsupported:readiness,task,proof',
  });

  const facts = capabilityCatalogRepairEvidenceFacts(candidates, ['agent', 'analysis'], new Map(), rejections);

  assert.deepEqual(facts[0].prior_rejections, [{
    name: 'Evaluate agent readiness and task proof',
    reason: 'outcome-scope-unsupported:readiness,task,proof',
    forbidden_subject_terms: ['readiness', 'task', 'proof'],
    missing_audience: 'agents',
    missing_subject_terms: ['understand', 'behavior'],
  }]);
  assert.deepEqual(facts[1].prior_rejections, []);
  assert.equal(recorded.added, true);
});

test('publishability repair facts carry the exact requirement reason and validator-derived forbidden terms', () => {
  const candidates = [{ id: 'shared', name: 'Software Understanding', category: 'core', evidence_kind: 'behavior-surface' }] as SystemCapability[];
  const rejections = new Map();
  recordCapabilityCatalogRejection(rejections, {
    candidateIds: ['shared'], requirementId: 'human:understand', name: 'Surface comprehension for people',
    reason: 'description-implementation-graph-inventory', forbiddenSubjectTerms: ['nodes', 'entry points'],
  });

  const [fact] = capabilityCatalogRepairEvidenceFacts(candidates, ['shared'], new Map(), rejections, ['human:understand']);

  assert.deepEqual(fact.prior_rejections, [{
    name: 'Surface comprehension for people', reason: 'description-implementation-graph-inventory',
    forbidden_subject_terms: ['nodes', 'entry points'], requirement_id: 'human:understand',
  }]);
});

test('shared candidates expose only rejection feedback for the current outcome slot', () => {
  const candidates = [{ id: 'shared', name: 'Software Understanding', category: 'core', evidence_kind: 'behavior-surface' }] as SystemCapability[];
  const rejections = new Map();
  recordCapabilityCatalogRejection(rejections, { candidateIds: ['shared'], name: 'Explain behavior', reason: 'description-too-short' });
  recordCapabilityCatalogRejection(rejections, { candidateIds: ['shared'], requirementId: 'human:understand', name: 'Explain behavior', reason: 'required-outcome-mismatch' });
  recordCapabilityCatalogRejection(rejections, { candidateIds: ['shared'], requirementId: 'agent:understand', name: 'Explain behavior', reason: 'required-outcome-mismatch' });
  const [human] = capabilityCatalogRepairEvidenceFacts(candidates, ['shared'], new Map(), rejections, ['human:understand']);
  const [agent] = capabilityCatalogRepairEvidenceFacts(candidates, ['shared'], new Map(), rejections, ['agent:understand']);
  assert.deepEqual(human.prior_rejections.map(rejection => rejection.requirement_id), [undefined, 'human:understand']);
  assert.deepEqual(agent.prior_rejections.map(rejection => rejection.requirement_id), [undefined, 'agent:understand']);
});

test('shared candidates retain bounded feedback independently for every outcome slot', () => {
  const rejections = new Map();
  for (const requirementId of ['graph', 'human', 'agent', 'collaboration', 'runtime']) {
    recordCapabilityCatalogRejection(rejections, { candidateIds: ['shared'], requirementId, name: `Rejected ${requirementId}`, reason: 'required-outcome-mismatch' });
  }
  assert.deepEqual((rejections.get('shared') || []).map(rejection => rejection.requirement_id), ['graph', 'human', 'agent', 'collaboration', 'runtime']);
});

test('cycle diagnostics expose only bounded names and requirement identities', () => {
  const capabilities = Array.from({ length: 14 }, (_, index) => catalogCapability({
    id: `cap-${index}`,
    name: `${'Outcome '.repeat(20)}${index}\nsecret`,
    criticality_factors: [`catalog-outcome-requirement:slot-${index}`],
  }));
  const diagnostic = capabilityCatalogCycleDiagnostic(capabilities);
  assert.equal(diagnostic.length, 12);
  assert.equal(diagnostic[0].name.length, 120);
  assert.equal(diagnostic[0].name.includes('\n'), false);
  assert.deepEqual(diagnostic[0].requirement_ids, ['slot-0']);
});

test('product-language violations expose the exact copied terms for all live repair classes', () => {
  assert.deepEqual(
    capabilityDescriptionProductLanguageViolation('People inspect nodes, entry points, and method calls to understand behavior.', [], []),
    { reason: 'implementation-graph-inventory', forbiddenTerms: ['nodes', 'entry points', 'method calls'] },
  );
  assert.deepEqual(
    capabilityDescriptionProductLanguageViolation('ChangeHistoryEntry shows how behavior evolved.', ['ChangeHistoryEntry'], []),
    { reason: 'raw-related-entity-identifier', forbiddenTerms: ['ChangeHistoryEntry'] },
  );
  assert.deepEqual(
    capabilityDescriptionProductLanguageViolation('People click architecture diagram to inspect changes.', [], ['["click","architecture diagram"]']),
    { reason: 'delivery-operation-restatement', forbiddenTerms: ['click', 'architecture', 'diagram'] },
  );
  assert.deepEqual(
    capabilityDescriptionProductLanguageViolation('Agents inspect edges and call chains before changes.', [], []),
    { reason: 'implementation-graph-inventory', forbiddenTerms: ['edges', 'call chains'] },
  );
  assert.deepEqual(
    capabilityDescriptionProductLanguageViolation('Runtime evidence maps CASEdge transitions to observed states.', [], [], ['CASEdge']),
    { reason: 'raw-related-entity-identifier', forbiddenTerms: ['CASEdge'] },
  );
  assert.deepEqual(
    capabilityDescriptionProductLanguageViolation('Changes resolve conflicts by analyzing CAS graph transitions.', [], [], ['CASGraphTransition']),
    { reason: 'raw-related-entity-identifier', forbiddenTerms: ['cas graph transition'] },
  );
  assert.deepEqual(
    capabilityDescriptionProductLanguageViolation('People compare capability maps and entry points across changes.', [], [], ['CapabilityMap', 'EntryPoint']),
    { reason: 'implementation-graph-inventory', forbiddenTerms: ['capability map', 'entry point'] },
  );
});

test('shared description failures preserve their exact offending terms in focused repair facts', () => {
  const rejected = catalogCapability({
    id: 'graph', name: 'Build a trustworthy relationship graph',
    description: 'Builds connected system components so people can inspect software relationships before making changes.',
    criticality_factors: ['catalog-candidate:graph', 'catalog-outcome-requirement:graph-slot'],
  });
  const validation = validateElementDescription(rejected.description || '', {
    name: rejected.name, kind: 'capability', relatedDomains: ['software relationships'],
  });
  const rejections = new Map();
  recordCapabilityPublishabilityRejection(
    rejections, rejected, `description-${validation.reason}`, validation.offendingTerms || [],
  );
  const [fact] = capabilityCatalogRepairEvidenceFacts([rejected], ['graph'], new Map(), rejections, ['graph-slot']);
  assert.deepEqual(fact.prior_rejections[0].forbidden_subject_terms, ['system components']);
});

test('preview and compare wording requires a narrowly cited operation family', () => {
  const broad = catalogCapability({
    id: 'aggregate', name: 'Agent context operations', structural_label: 'Agent context operations', evidence_kind: 'behavior-surface',
    operations: [
      { action: 'Handle', path_or_command: 'preview_codebase_iteration', entry_point_id: 'preview', entry_point_type: 'message' },
      { action: 'Handle', path_or_command: 'get_agent_context', entry_point_id: 'inspect', entry_point_type: 'message' },
      { action: 'Get agent context', path_or_command: 'get_agent_context', entry_point_id: 'context', entry_point_type: 'message' },
      { action: 'Handle', path_or_command: 'assess_change_risk', entry_point_id: 'validate', entry_point_type: 'message' },
    ],
  });
  const focused = catalogCapability({
    id: 'preview', name: 'Iteration preview', structural_label: 'Iteration preview', evidence_kind: 'behavior-surface',
    operations: [{ action: 'Handle', path_or_command: 'preview_codebase_iteration', entry_point_id: 'preview', entry_point_type: 'message' }],
  });

  assert.deepEqual(capabilityOutcomeScopeFailure('Preview and compare codebase iterations', [broad], undefined, true), ['delivery-action-evidence-too-broad']);
  assert.deepEqual(capabilityOutcomeScopeFailure('Preview and compare codebase iterations', [focused], undefined, true), []);
});

test('the seven-capability live catalog keeps outcomes and rejects implementation-shaped prose', () => {
  const liveIdentifiers = ['CASEdge', 'CASNode', 'SystemCapability', 'CASEntryPoint', 'CrossCodebaseSystemGraph'];
  const broad = catalogCapability({
    id: 'aggregate', name: 'Agent context operations', structural_label: 'Agent context operations', evidence_kind: 'behavior-surface',
    operations: [
      { action: 'Handle', path_or_command: 'preview_codebase_iteration', entry_point_id: 'preview', entry_point_type: 'message' },
      { action: 'Handle', path_or_command: 'get_agent_context', entry_point_id: 'inspect', entry_point_type: 'message' },
      { action: 'Handle', path_or_command: 'assess_change_risk', entry_point_id: 'validate', entry_point_type: 'message' },
    ],
  });
  const coordination = catalogCapability({ id: 'coordination', name: 'Fabric work concepts', structural_label: 'Fabric work concepts' });
  const collaboration = {
    id: 'collaboration', statement: 'collaboration across overlapping concepts', candidateIds: ['coordination'],
    subjectTokens: ['fabric', 'work'], subjectTokenAliases: [['fabric', 'work', 'collaborate', 'conflict']],
    subjectAliasAnchorTokens: [['collaborate']],
  };

  assert.equal(capabilityDescriptionProductLanguageViolation('Changes resolve conflicts through CAS graph transitions.', [], [], liveIdentifiers)?.reason, 'implementation-graph-inventory');
  assert.deepEqual(capabilityOutcomeScopeFailure('Preview and compare codebase analysis iterations', [broad], undefined, true), ['delivery-action-evidence-too-broad']);
  assert.equal(capabilityDescriptionProductLanguageViolation('People inspect CAS relationship graphs before changes.', [], [], liveIdentifiers)?.reason, 'implementation-graph-inventory');
  assert.equal(capabilityCatalogOutcomeNameFailure('Fabric work concepts across codebase changes', collaboration), 'required-outcome-visible-action-missing:collaboration');
  assert.equal(capabilityDescriptionProductLanguageViolation('Collaboration exposes conflicts across CAS graph nodes.', [], [], liveIdentifiers)?.reason, 'implementation-graph-inventory');
  assert.equal(capabilityDescriptionProductLanguageViolation('Static structure maps CASEdge transitions to runtime states.', [], [], liveIdentifiers)?.reason, 'raw-related-entity-identifier');
  assert.equal(capabilityDescriptionProductLanguageViolation('People compare capability maps and entry points across changes.', [], [], liveIdentifiers)?.reason, 'implementation-graph-inventory');
  assert.equal(capabilityDescriptionProductLanguageViolation('Connected software relationships expose change impact and conceptual conflicts.', [], [], ['CASRelationshipGraph']), undefined);
  assert.equal(capabilityDescriptionProductLanguageViolation('Agents understand connected software behavior before changing code.', [], [], ['AgentContext']), undefined);
  assert.equal(capabilityDescriptionProductLanguageViolation('The CAS graph exposes connected behavior.', [], [], liveIdentifiers, ['CAS graph']), undefined);
  assert.equal(capabilityDescriptionProductLanguageViolation('CASEdge exposes connected behavior.', [], [], ['CASEdge'], ['CAS edge relationships'])?.reason, 'raw-related-entity-identifier');
  assert.equal(capabilityDescriptionProductLanguageViolation('SystemCapability exposes connected behavior.', [], [], ['SystemCapability'], ['The system supports a product capability'])?.reason, 'raw-related-entity-identifier');
  assert.equal(capabilityDescriptionProductLanguageViolation('Users manage project access across teams.', [], [], ['UserConfig', 'ProjectConfig']), undefined);
});

test('only an exact bound first-party action bypasses broad delivery evidence', () => {
  const broad = catalogCapability({
    id: 'aggregate', name: 'Relationship graph agent context operations', structural_label: 'Relationship graph agent context operations', evidence_kind: 'behavior-surface',
    operations: [
      { action: 'Build', path_or_command: 'build_graph', entry_point_id: 'build', entry_point_type: 'message' },
      { action: 'Correlate', path_or_command: 'correlate_runtime', entry_point_id: 'runtime', entry_point_type: 'message' },
      { action: 'Handle', path_or_command: 'get_agent_context', entry_point_id: 'inspect', entry_point_type: 'message' },
      { action: 'Handle', path_or_command: 'assess_change_risk', entry_point_id: 'risk', entry_point_type: 'message' },
      { action: 'Handle', path_or_command: 'find_tests', entry_point_id: 'tests', entry_point_type: 'message' },
    ],
  });
  const graph = { id: 'graph', visibleActionTerms: ['build'] };
  const runtime = { id: 'runtime', visibleActionTerms: ['correlate'] };
  const signal = { productDocSummary: 'The product builds a trustworthy relationship graph and correlates static understanding with runtime evidence.' };

  assert.deepEqual(capabilityOutcomeScopeFailure('Build a trustworthy relationship graph', [broad], signal, true), ['delivery-action-evidence-too-broad']);
  assert.deepEqual(capabilityOutcomeScopeFailure('Build a trustworthy relationship graph', [broad], signal, false, '', [], graph), []);
  assert.deepEqual(capabilityOutcomeScopeFailure('Correlate static understanding with runtime evidence', [broad], signal, false, '', [], runtime), []);
  assert.deepEqual(capabilityOutcomeScopeFailure('Build banana vacation graph', [broad], signal, false, '', [], graph), ['banana', 'vacation']);
  assert.deepEqual(capabilityOutcomeScopeFailure('Handle agent context', [broad], undefined, true, '', [], { id: 'tool', visibleActionTerms: ['handle'] }), ['delivery-operation-restatement']);
});

test('renamed repairs replace pending identities by stable requirement without crossing shared-candidate slots', () => {
  const pending = (id: string, name: string, requirement: string) => catalogCapability({
    id, name, description: '', description_generation: { status: 'ai_rejected', attempted: true },
    criticality_factors: [`catalog-candidate:shared`, `catalog-outcome-requirement:${requirement}`],
  });
  const human = pending('human-old', 'Surface comprehension for people', 'human:understand');
  const agent = pending('agent-old', 'Give agents comprehension', 'agent:understand');
  const repaired = catalogCapability({
    id: 'human-new', name: 'Help people understand software behavior',
    description: 'People explore connected software behavior and understand the impact of changes.',
    description_generation: { status: 'ai_applied', attempted: true },
    criticality_factors: ['catalog-candidate:shared', 'catalog-outcome-requirement:human:understand'],
  });

  const merged = mergeCapabilityCatalogRepairResults([human, agent], [repaired]);

  assert.deepEqual(merged.map(capability => capability.id), ['agent-old', 'human-new']);
  assert.deepEqual(capabilityCatalogPendingRepairKeys(merged), ['requirement:agent:understand']);
});

test('candidate identity replaces a renamed pending repair but never overwrites a valid prior description', () => {
  const pending = catalogCapability({
    id: 'old', name: 'Surface architecture change through diagram click', description: '',
    description_generation: { status: 'ai_rejected', attempted: true }, criticality_factors: ['catalog-candidate:architecture'],
  });
  const repaired = catalogCapability({
    id: 'new', name: 'Explore architectural change', description: 'People compare connected software structure across revisions.',
    criticality_factors: ['catalog-candidate:architecture'],
  });
  const invalidReplacement = { ...pending, id: 'new-invalid', name: 'Click architecture diagram' };

  assert.deepEqual(mergeCapabilityCatalogRepairResults([pending], [repaired]).map(capability => capability.id), ['new']);
  assert.deepEqual(mergeCapabilityCatalogRepairResults([repaired], [invalidReplacement]).map(capability => capability.id), ['new']);
});

test('evidence batch collection preserves successful families when one focused call times out', async () => {
  const calls: string[][] = [];
  const values = await collectCapabilityCatalogEvidenceBatches({
    facts: ['workspace', 'fabric', 'history'], evidenceScoped: true, batchBudgetMs: 100,
    extract: async batch => {
      calls.push(batch);
      if (batch[0] === 'fabric') throw new Error('focused-deadline');
      return batch.map(value => `authored:${value}`);
    },
    isDeadlineError: error => error instanceof Error && error.message === 'focused-deadline',
  });

  assert.deepEqual(calls, [['workspace'], ['fabric'], ['history']]);
  assert.deepEqual(values, ['authored:workspace', 'authored:history']);
});

test('recognizes analysis verb variants as the same product outcome without merging other actions', () => {
  assert.equal(capabilityTitlesShareOutcome(
    { name: 'Analyze codebase' } as SystemCapability,
    { name: 'Run codebase analysis' } as SystemCapability,
  ), true);
  assert.equal(capabilityTitlesShareOutcome(
    { name: 'Generate codebase report' } as SystemCapability,
    { name: 'Analyze codebase report' } as SystemCapability,
  ), false);
});

test('recognizes mutually entailed outcomes only when their structural evidence substantially overlaps', () => {
  const analyze = catalogCapability({
    id: 'analyze', name: 'Analyze codebase', description: 'Analyzes a codebase and builds a trustworthy relationship graph.',
    related_entities: ['graph', 'node', 'edge'],
  });
  const graph = catalogCapability({
    id: 'graph', name: 'Build trustworthy relationship graph', description: 'Builds the relationship graph by analyzing codebase behavior.',
    related_entities: ['graph', 'node', 'edge'],
  });
  const agent = catalogCapability({
    id: 'agent', name: 'Ground agents in code context', description: 'Gives software agents evidence for safe code changes.',
    related_entities: ['graph', 'node', 'edge'],
  });

  assert.equal(capabilityDescriptionsShareOutcome(analyze, graph), true);
  assert.equal(capabilityDescriptionsShareOutcome(analyze, agent), false);
  assert.equal(capabilityDescriptionsShareOutcome(
    analyze,
    { ...graph, related_entities: ['unrelated'], operations: [] },
  ), false);
});

test('description repair schedules only rejected capabilities on detached values', async () => {
  const capabilities = [
    { id: 'accepted', name: 'Accepted', description: 'Already accepted' },
    { id: 'rejected', name: 'Rejected' },
  ] as any[];
  const scheduled = scheduleRejectedCapabilityDescriptions({
    capabilities,
    rejectedIds: new Set(['rejected']),
    authorDescriptions: async selected => {
      assert.deepEqual(selected.map(capability => capability.id), ['rejected']);
      selected[0].description = 'The repaired product description is grounded in supplied evidence.';
    },
  });

  assert.ok(scheduled);
  const outcome = await scheduled;
  assert.equal(outcome.status, 'fulfilled');
  if (outcome.status === 'fulfilled') {
    assert.equal(outcome.value[0].description, 'The repaired product description is grounded in supplied evidence.');
  }
  assert.equal(capabilities[1].description, undefined);
});

test('description repair captures rejection immediately and skips empty work', async () => {
  const error = new Error('provider unavailable');
  const rejected = scheduleRejectedCapabilityDescriptions({
    capabilities: [{ id: 'target', name: 'Target' } as any],
    rejectedIds: new Set(['target']),
    authorDescriptions: async () => { throw error; },
  });
  assert.ok(rejected);
  assert.deepEqual(await rejected, { status: 'rejected', reason: error });
  assert.equal(scheduleRejectedCapabilityDescriptions({
    capabilities: [],
    rejectedIds: new Set(),
    authorDescriptions: async () => undefined,
  }), undefined);
});

test('description scheduling preserves catalog outcomes beyond the element budget', () => {
  const capabilities = [
    { id: 'applied', description_generation: { status: 'ai_applied', attempted: true } },
    { id: 'rejected', description_generation: { status: 'ai_rejected', attempted: true, reason: 'missing-description' } },
    { id: 'undisposed' },
  ] as any[];

  assert.deepEqual(
    capabilitiesWithoutDescriptionDisposition(capabilities).map(capability => capability.id),
    ['undisposed'],
  );
  assert.equal(capabilities[1].description_generation.status, 'ai_rejected');
});

test('description rejection preserves the grounded identity but never the rejected prose', () => {
  const capability = {
    id: 'workspace', name: 'Understand workspace context', description: 'Unsupported tracking insights.',
    description_source: 'ai', description_generation: { status: 'ai_applied', attempted: true },
    criticality_factors: ['catalog-candidate:cap_workspace'],
  } as SystemCapability;

  const retained = capabilityIdentityPendingDescriptionRepair(capability, 'description-marketing-language');

  assert.equal(retained?.name, capability.name);
  assert.equal(retained?.description, '');
  assert.equal(retained?.description_source, undefined);
  assert.deepEqual(retained?.description_generation, {
    status: 'ai_rejected', attempted: true, reason: 'description-marketing-language',
  });
  assert.equal(capabilityIdentityPendingDescriptionRepair(capability, 'bare-noun-name'), undefined);
});

test('accepted grounded identity clears an earlier description-repair request for the same family', () => {
  const pending = new Set<string>();
  const candidate = (description?: string) => ({
    id: 'workspace', name: 'Understand workspace context', description,
    criticality_factors: ['catalog-candidate:cap_workspace'],
  }) as SystemCapability;

  updateCapabilityCatalogPublishabilityRepairIds(pending, [candidate()], [candidate('bad')]);

  assert.deepEqual([...pending], []);
});

test('targeted catalog repair converges when full passes omit different families', () => {
  const requiredGroups = Array.from({ length: 37 }, (_, index) => [`family-${index}`]);
  const capability = (id: string) => ({
    id,
    criticality_factors: [`catalog-candidate:${id}`],
  }) as any;
  const firstFullPass = requiredGroups.slice(0, 20).map(([id]) => capability(id));
  const firstRepairIds = uncoveredCapabilityCatalogCandidateIds(firstFullPass, [], requiredGroups);
  const firstRepair = firstRepairIds.filter((_, index) => index % 2 === 0).map(capability);
  const partiallyRepaired = [...firstFullPass, ...firstRepair];
  const secondRepairIds = uncoveredCapabilityCatalogCandidateIds(partiallyRepaired, [], requiredGroups);
  const fullyRepaired = [...partiallyRepaired, ...secondRepairIds.map(capability)];

  assert.equal(firstRepairIds.length, 17);
  assert.equal(secondRepairIds.length, 8);
  assert.deepEqual(uncoveredCapabilityCatalogCandidateIds(fullyRepaired, [], requiredGroups), []);
});

test('semantic outcome progress prevents the repair loop from stopping while obligations shrink', () => {
  const progress = trackCapabilityCatalogRepair(2, [], [], ['human', 'runtime']);

  assert.equal(progress.observe([], ['runtime']).stop, false);
  assert.equal(progress.observe([], ['runtime']).stop, false);
  assert.equal(progress.observe([], []).stop, false);
});

test('mandatory outcome reduction resets progress despite pending identity churn', () => {
  const progress = trackCapabilityCatalogRepair(4, [], [], ['graph', 'human', 'agent', 'runtime']);

  const reduced = progress.observe([], ['runtime'], ['pending:new-title']);
  const unchanged = progress.observe([], ['runtime'], ['pending:another-title']);

  assert.equal(reduced.noProgressCycles, 0);
  assert.equal(reduced.stop, false);
  assert.equal(unchanged.noProgressCycles, 1);
});

test('pending reduction resets progress only while mandatory sets are unchanged', () => {
  const progress = trackCapabilityCatalogRepair(2, [], [], ['human']);

  assert.equal(progress.observe([], ['human'], ['pending:one', 'pending:two']).noProgressCycles, 1);
  assert.equal(progress.observe([], ['human'], ['pending:one']).noProgressCycles, 0);
  assert.equal(progress.observe([], ['human'], ['pending:novel']).noProgressCycles, 1);
  assert.equal(progress.observe([], ['human'], ['pending:newer']).stop, true);
});

test('renaming a pending repair does not count as catalog progress', () => {
  const progress = trackCapabilityCatalogRepair(1, [], [], []);

  assert.equal(progress.observe([], [], ['requirement:human:understand']).stop, false);
  assert.equal(progress.observe([], [], ['requirement:human:understand']).stop, true);
});

test('novel rejected titles cannot extend repair to the full cycle budget', () => {
  const progress = trackCapabilityCatalogRepair(13, [], [], ['human', 'runtime']);
  let attempts = 0;
  for (; attempts < progress.maxCycles; attempts++) {
    if (progress.observe([], ['human', 'runtime'], []).stop) break;
  }

  assert.equal(progress.maxCycles, 16);
  assert.equal(attempts, 1);
});
