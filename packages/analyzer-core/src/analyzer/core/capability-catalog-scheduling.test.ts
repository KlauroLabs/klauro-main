import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import {
  capabilitiesWithoutDescriptionDisposition,
  capabilityCatalogPendingRepairKeys,
  capabilityCatalogEvidenceRepairMatchIndexes,
  capabilityCatalogCycleDiagnostic,
  capabilityCatalogOutcomeCorrectiveRetryFeedback,
  capabilityIdentityPendingDescriptionRepair,
  scheduleRejectedCapabilityDescriptions,
  selectCapabilityCatalogPromptCandidates,
  uncoveredCapabilityCatalogCandidateIds,
  uncoveredCapabilityCatalogFamilyRepresentativeIds,
  capabilityCatalogRepairCandidateIds,
  capabilityTitlesShareOutcome,
  capabilityDescriptionsShareOutcome,
  capabilityCatalogTargetedRepairBatches,
  collectCapabilityCatalogEvidenceBatches,
  capabilityCatalogRepairEvidenceFacts,
  capabilityOutcomeMatchesEvidence,
  mergeUniquelyMatchedBehaviorEvidence,
  mergeGroundedEntityEvidenceFamilies,
  mergeCapabilityCatalogRepairResults,
  recordCapabilityCatalogRejection,
  recordCapabilityPublishabilityRejection,
  retryEmptyCapabilityCatalogOutcome,
  trackCapabilityCatalogRepair,
  updateCapabilityCatalogPublishabilityRepairIds,
} from './capability-catalog-scheduling';
import { capabilityCatalogCycleQualityFailure, deterministicAtomicClosuresForObligationIds, isExactValidatedDeterministicRecovery, filterMismatchedOperationObligationCapabilities, hasPendingCapabilityDescriptionAttempt, hasPendingCapabilityLanguageAttempt, normalizeTargetedCapabilityCatalogDescriptions, resolveCapabilityCatalogDescriptionRepair, resolvePendingCapabilityDescriptionsWithoutProvider, retireIndependentlyCoveredPendingDescriptions, stagePendingCapabilityEvidenceRepairs, stageRejectedCapabilityNameRepair, validatedDeterministicAtomicClosures, validatedDeterministicGroupedOperationClosures, withoutSubsumedDeterministicAtomicClosures } from './capability-catalog-cycle-repair';
import { capabilityDescriptionProductLanguageViolation, capabilityOutcomeScopeFailure, catalogEntityCandidateGroups } from './capability-catalog-evidence';
import { capabilityCatalogOutcomeNameFailure, type CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';
import { validateElementDescription } from '../../ai/element-description-validator';
import { evaluateCapabilityCatalogAudience } from './capability-catalog-audience';
import { capabilityCatalogRepairPlan, deterministicCapabilityActionIdentityFallback, deterministicCapabilityDescriptionFallback } from './capability-catalog-repair-plan';

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

test('no-progress termination waits only for bounded attempts on registered pending identities', () => {
  const identity = catalogCapability({ id: 'pending' });
  const registry = new Map([['candidate', { audience: 'Users', candidateId: 'candidate', evidenceDigest: 'digest', familyKey: 'family', fallbackAttempted: false, identity }]]);
  assert.equal(hasPendingCapabilityDescriptionAttempt(registry, new Map()), true);
  assert.equal(hasPendingCapabilityDescriptionAttempt(registry, new Map([['pending', 1]])), true);
  assert.equal(hasPendingCapabilityDescriptionAttempt(registry, new Map([['pending', 2], ['novel-title', 0]])), false);
});

test('no-progress termination waits for bounded language attempts on deterministic lifecycle identities', () => {
  const pending = catalogCapability({
    id: 'pending-language',
    name: 'Manage transfers',
    name_source: 'deterministic',
    criticality_factors: ['catalog-deterministic-grouped-lifecycle'],
  });
  const attempts = new Map<string, number>();
  assert.equal(hasPendingCapabilityLanguageAttempt([pending], attempts), true);
  attempts.set('pending-language', 1);
  assert.equal(hasPendingCapabilityLanguageAttempt([pending], attempts), true);
  attempts.set('pending-language', 2);
  assert.equal(hasPendingCapabilityLanguageAttempt([pending], attempts), false);
  assert.equal(hasPendingCapabilityLanguageAttempt([], attempts), false);
  assert.equal(hasPendingCapabilityLanguageAttempt([
    catalogCapability({ id: 'ordinary', name: 'Create transfer', name_source: 'deterministic' }),
  ], new Map()), false);
});

test('focused repair removes only a trailing unsupported claim before accepting grounded actions', () => {
test('publication normalization removes model-written evidence citations without discarding the product behavior', () => {
  const [normalized] = normalizeTargetedCapabilityCatalogDescriptions([
    catalogCapability({
      name: 'Create and update categories',
      description: 'Users create new categories or update existing ones while organizing transactions, as shown in cap_categories_management and Category entity.',
    }),
  ], []);
  assert.equal(
    normalized.description,
    'Users create new categories or update existing ones while organizing transactions.',
  );
});

  const identity = catalogCapability({
    id: 'holdings', name: 'View and manage investment holdings', description: '',
    operations: [
      { entry_point_id: 'create', entry_point_type: 'http', action: 'create' },
      { entry_point_id: 'view', entry_point_type: 'http', action: 'read' },
      { entry_point_id: 'update', entry_point_type: 'http', action: 'update' },
      { entry_point_id: 'remove', entry_point_type: 'http', action: 'delete' },
    ],
    criticality_factors: ['catalog-candidate:investments', 'catalog-candidate:holdings'],
  });
  const proposed = {
    ...identity,
    description: 'Users view, create, update, and remove investment holdings to maintain an accurate record of their portfolio positions.',
    name_source: 'ai' as const,
    description_source: 'ai' as const,
  };
  const result = resolveCapabilityCatalogDescriptionRepair({
    validated: [proposed], attempt: 1, identity, attemptedFallbackIdentityIds: new Set(),
    pendingEvidenceIdentityByCandidateId: new Map(), evidenceCandidates: [], allowNameRepair: true,
    firstPartyTexts: [], validate: capability => !/accurate/i.test(capability.description || '') &&
      /view, create, update, and remove investment holdings\.$/i.test(capability.description || ''),
  });
  assert.equal(result[0]?.description, 'Users view, create, update, and remove investment holdings.');
  assert.equal(result[0]?.description_generation?.reason, 'unsupported-description-claim-removed');
});

test('resolves exact pending descriptions without a provider at the deadline and preserves validator failure', () => {
  const evidence = catalogCapability({
    id: 'memo-file', name: 'Memo files', structural_label: 'Memo files',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    operations: [{ entry_point_id: 'attach-file', entry_point_type: 'event', action: 'update' }],
    related_entities: ['entity_memo'], related_domains: ['files', 'memos'],
  });
  const identity = catalogCapability({
    id: 'pending-attachment', name: 'Attach files to memos', description: '',
    description_generation: { status: 'ai_rejected', attempted: true, reason: 'missing-description' },
    operations: evidence.operations, related_entities: evidence.related_entities,
    criticality_factors: ['catalog-candidate:memo-file'],
  });
  const registry = new Map([['memo-file', {
    audience: 'Users', candidateId: 'memo-file', evidenceDigest: 'digest', familyKey: 'memo-file',
    fallbackAttempted: false, identity,
  }]]);
  const validate = (capability: SystemCapability) => capability.description === 'Users can attach files to memos as part of their normal workflow whenever needed.';
  const [repaired] = resolvePendingCapabilityDescriptionsWithoutProvider({
    capabilities: [identity], pendingEvidenceIdentityByCandidateId: registry,
    evidenceCandidates: [evidence], firstPartyTexts: [], audienceFor: () => undefined, validate,
  });
  assert.equal(repaired.name, identity.name);
  assert.equal(repaired.description, 'Users can attach files to memos as part of their normal workflow whenever needed.');
  assert.equal(repaired.description_generation?.reason, 'grounded-cited-lifecycle');
  const [stillPending] = resolvePendingCapabilityDescriptionsWithoutProvider({
    capabilities: [identity], pendingEvidenceIdentityByCandidateId: registry,
    evidenceCandidates: [evidence], firstPartyTexts: [], audienceFor: () => undefined, validate: () => false,
  });
  assert.equal(stillPending.description, '');
});

test('repairs a weak final description without requiring a pending registry entry', () => {
  const evidence = catalogCapability({
    id: 'jobs', name: 'Job applications', structural_label: 'Job applications',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    operations: [{ entry_point_id: 'update-job', entry_point_type: 'http', action: 'update' }],
    related_entities: ['entity_job'], related_domains: ['jobs'],
  });
  const identity = catalogCapability({
    id: 'update-jobs', name: 'Update job applications', description: 'Update job applications quickly.',
    description_generation: { status: 'ai_applied', attempted: true },
    operations: evidence.operations, related_entities: evidence.related_entities,
    criticality_factors: ['catalog-candidate:jobs'],
  });
  const expected = 'Users can update job applications as part of their normal workflow whenever needed.';
  const [repaired] = resolvePendingCapabilityDescriptionsWithoutProvider({
    capabilities: [identity], pendingEvidenceIdentityByCandidateId: new Map(),
    evidenceCandidates: [evidence], firstPartyTexts: [], audienceFor: () => 'Users',
    validate: capability => capability.description === expected,
  });
  assert.equal(repaired.description, expected);
  assert.equal(repaired.description_generation?.reason, 'grounded-cited-lifecycle');
});

test('does not treat a normal multiword description as weak at the repair deadline', () => {
  const description = 'People review each account record before any change.';
  const identity = catalogCapability({
    id: 'review-accounts', name: 'Review account records', description,
    description_generation: { status: 'ai_applied', attempted: true },
  });
  let validationCalls = 0;
  const [preserved] = resolvePendingCapabilityDescriptionsWithoutProvider({
    capabilities: [identity], pendingEvidenceIdentityByCandidateId: new Map(),
    evidenceCandidates: [], firstPartyTexts: [], audienceFor: () => 'People',
    validate: () => { validationCalls += 1; return false; },
  });
  assert.equal(preserved.description, description);
  assert.equal(validationCalls, 0);
});

test('repairs a bound authored outcome across multiple evidence families without a pending registry entry', () => {
  const jobs = catalogCapability({
    id: 'jobs', name: 'Job applications', structural_label: 'Job applications',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    operations: [{ entry_point_id: 'update-job', entry_point_type: 'http', action: 'update' }],
    related_entities: ['entity_job'], related_domains: ['jobs'],
  });
  const categories = catalogCapability({
    id: 'categories', name: 'Application categories', structural_label: 'Application categories',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    operations: [
      { entry_point_id: 'create-category', entry_point_type: 'http', action: 'create' },
      { entry_point_id: 'update-category', entry_point_type: 'http', action: 'update' },
      { entry_point_id: 'delete-category', entry_point_type: 'http', action: 'delete' },
    ],
    related_entities: ['entity_category'], related_domains: ['categories'],
  });
  const identity = catalogCapability({
    id: 'categorize-jobs', name: 'Categorize job applications', description: '',
    description_generation: { status: 'ai_rejected', attempted: true, reason: 'description-unsupported-target-value-claim:tracking' },
    operations: [...jobs.operations, ...categories.operations],
    related_entities: [...jobs.related_entities, ...categories.related_entities],
    criticality_factors: [
      'catalog-outcome-requirement:all:categorize-job-applications',
      'catalog-candidate:jobs', 'catalog-candidate:categories',
    ],
  });
  const expected = 'Users can categorize job applications as those job applications change over time.';
  const [repaired] = resolvePendingCapabilityDescriptionsWithoutProvider({
    capabilities: [identity], pendingEvidenceIdentityByCandidateId: new Map(),
    evidenceCandidates: [jobs, categories], firstPartyTexts: [], audienceFor: () => 'Users',
    validate: capability => capability.description === expected,
  });
  assert.equal(repaired.name, identity.name);
  assert.equal(repaired.description, expected);
  assert.deepEqual(
    repaired.criticality_factors?.filter(factor => factor.startsWith('catalog-candidate:')).sort(),
    ['catalog-candidate:categories', 'catalog-candidate:jobs'],
  );
});

test('retires an invalid pending description only when exact cited operations are independently publishable', () => {
  const evidence = catalogCapability({
    id: 'profile-update', name: 'Update user profile', structural_label: 'Update user profile',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    operations: [{ entry_point_id: 'update-profile', entry_point_type: 'http', action: 'update', path_or_command: '/users/profile', trigger: { method: 'PATCH', path: '/users/profile' } }],
    related_entities: ['entity_user'], related_domains: ['profile'],
  });
  const pending = catalogCapability({
    id: 'pending-profile', name: 'Update user profile', description: '',
    operations: evidence.operations, related_entities: evidence.related_entities,
    criticality_factors: ['catalog-candidate:profile-update', 'catalog-operation-obligation:profile-update'],
  });
  const published = catalogCapability({
    id: 'manage-profile', name: 'Manage user profiles', description: 'Users can update their profile details.',
    operations: evidence.operations, related_entities: evidence.related_entities,
    criticality_factors: ['catalog-candidate:profile-update'],
  });
  const registry = new Map([['profile-update', {
    audience: 'Users', candidateId: 'profile-update', evidenceDigest: 'digest', familyKey: 'profile',
    fallbackAttempted: true, identity: pending,
  }]]);
  const result = retireIndependentlyCoveredPendingDescriptions({
    capabilities: [pending, published], pendingEvidenceIdentityByCandidateId: registry,
    evidenceCandidates: [evidence], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    outcomeRequirements: [], isPublishable: capability => Boolean(capability.description),
  });
  assert.deepEqual(result.map(capability => capability.id), ['manage-profile']);
});

test('retains an invalid pending description when it is the sole exact operation coverage', () => {
  const evidence = catalogCapability({
    id: 'profile-update', name: 'Update user profile', structural_label: 'Update user profile',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    operations: [{ entry_point_id: 'update-profile', entry_point_type: 'http', action: 'update', path_or_command: '/users/profile', trigger: { method: 'PATCH', path: '/users/profile' } }],
    related_entities: ['entity_user'], related_domains: ['profile'],
  });
  const pending = catalogCapability({
    id: 'pending-profile', name: 'Update user profile', description: '', operations: evidence.operations,
    criticality_factors: ['catalog-candidate:profile-update'],
  });
  const registry = new Map([['profile-update', {
    audience: 'Users', candidateId: 'profile-update', evidenceDigest: 'digest', familyKey: 'profile',
    fallbackAttempted: true, identity: pending,
  }]]);
  const result = retireIndependentlyCoveredPendingDescriptions({
    capabilities: [pending], pendingEvidenceIdentityByCandidateId: registry,
    evidenceCandidates: [evidence], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    outcomeRequirements: [], isPublishable: capability => Boolean(capability.description),
  });
  assert.deepEqual(result.map(capability => capability.id), ['pending-profile']);
});

test('retains an invalid pending description when its bound outcome is not independently covered', () => {
  const evidence = catalogCapability({
    id: 'profile-update', name: 'Update user profile', structural_label: 'Update user profile',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    operations: [{ entry_point_id: 'update-profile', entry_point_type: 'http', action: 'update', path_or_command: '/users/profile', trigger: { method: 'PATCH', path: '/users/profile' } }],
    related_entities: ['entity_user'], related_domains: ['profile'],
  });
  const pending = catalogCapability({
    id: 'pending-profile', name: 'Update user profile', description: '', operations: evidence.operations,
    criticality_factors: ['catalog-candidate:profile-update', 'catalog-outcome-requirement:personalize-profile'],
  });
  const published = catalogCapability({
    id: 'manage-profile', name: 'Manage user profiles', description: 'Users can update their profile details.',
    operations: evidence.operations, criticality_factors: ['catalog-candidate:profile-update'],
  });
  const registry = new Map([['profile-update', {
    audience: 'Users', candidateId: 'profile-update', evidenceDigest: 'digest', familyKey: 'profile',
    fallbackAttempted: true, identity: pending,
  }]]);
  const result = retireIndependentlyCoveredPendingDescriptions({
    capabilities: [pending, published], pendingEvidenceIdentityByCandidateId: registry,
    evidenceCandidates: [evidence], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    outcomeRequirements: [{
      id: 'personalize-profile', statement: 'Users personalize their profiles', audience: 'human',
      candidateIds: ['profile-update'], subjectTokens: ['personalize', 'profile'], requiredSubjectTerms: ['personalize'], minimumSubjectMatches: 1,
    }],
    isPublishable: capability => Boolean(capability.description),
  });
  assert.deepEqual(result.map(capability => capability.id), ['pending-profile', 'manage-profile']);
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

test('retries one empty focused evidence batch without broadening its candidate scope', async () => {
  let retries = 0;
  const recorded: Array<{ reason: string }> = [];
  const result = await retryEmptyCapabilityCatalogOutcome({
    candidateIds: ['ambiguous-family'],
    initial: [],
    rejections: [{ candidateIds: ['ambiguous-family'], name: 'Rejected result', reason: 'outcome-scope-unsupported:execution' }],
    retryEvidence: true,
    record: feedback => recorded.push(feedback),
    retry: async () => {
      retries++;
      return ['grounded'];
    },
  });

  assert.deepEqual(result, ['grounded']);
  assert.equal(retries, 1);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].reason, 'required-evidence-zero-result');
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

test('a focused supporting repair enriches exactly one structurally anchored product outcome', () => {
  const status = catalogCapability({
    id: 'status', name: 'Manage job application status',
    description: 'Users maintain the current status of each job application.',
    related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'status', entry_point_type: 'http', action: 'Update' }],
  });
  const category = catalogCapability({
    id: 'category', name: 'Categorize job applications', related_entities: ['entity_category'],
  });
  const surface = catalogCapability({
    id: 'capability_job', name: 'Add Job Modal Change', evidence_kind: 'behavior-surface',
    related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'job-change', entry_point_type: 'event', action: 'Change' }],
  });
  const repair = catalogCapability({
    id: 'repair', name: 'Track job applications and update their status',
    description: 'Users track job applications and update their status as each application progresses.',
    criticality_factors: [`catalog-candidate:${surface.id}`],
  });

  const merged = mergeUniquelyMatchedBehaviorEvidence(
    [status, category], [surface], [surface.id], [repair],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, status.name);
  assert.equal(merged[0].description, status.description);
  assert.ok(merged[0].criticality_factors.includes(`catalog-candidate:${surface.id}`));
  assert.ok(merged[0].operations.some(operation => operation.entry_point_id === 'job-change'));
  assert.ok(!merged[1].criticality_factors.includes(`catalog-candidate:${surface.id}`));
});

test('an exact operation anchor takes precedence over a shared entity anchor', () => {
  const sharedOperation = { entry_point_id: 'job-change', entry_point_type: 'event' as const, action: 'Change' };
  const outcomes = [
    catalogCapability({
      id: 'status', name: 'Manage job application status', related_entities: ['entity_job'],
      operations: [sharedOperation],
    }),
    catalogCapability({
      id: 'category', name: 'Categorize job applications', related_entities: ['entity_job'],
      operations: [{ entry_point_id: 'category-change', entry_point_type: 'event', action: 'Change' }],
    }),
  ];
  const surface = catalogCapability({
    id: 'capability_job', name: 'Add Job Modal Change', evidence_kind: 'behavior-surface',
    related_entities: ['entity_job'], operations: [sharedOperation],
  });
  const repair = catalogCapability({
    id: 'repair', name: 'Track job applications and update their status',
    criticality_factors: [`catalog-candidate:${surface.id}`],
  });

  const merged = mergeUniquelyMatchedBehaviorEvidence(outcomes, [surface], [surface.id], [repair]);

  assert.ok(merged[0].criticality_factors.includes(`catalog-candidate:${surface.id}`));
  assert.ok(!merged[1].criticality_factors.includes(`catalog-candidate:${surface.id}`));
});

test('a tied exact operation anchor remains uncovered', () => {
  const sharedOperation = { entry_point_id: 'job-change', entry_point_type: 'event' as const, action: 'Change' };
  const outcomes = [
    catalogCapability({ id: 'status-manage', name: 'Manage job application status', related_entities: ['entity_job'], operations: [sharedOperation] }),
    catalogCapability({ id: 'status-review', name: 'Review job application status', related_entities: ['entity_job'], operations: [sharedOperation] }),
  ];
  const surface = catalogCapability({
    id: 'capability_job', name: 'Add Job Modal Change', evidence_kind: 'behavior-surface',
    related_entities: ['entity_job'], operations: [sharedOperation],
  });
  const repair = catalogCapability({
    id: 'repair', name: 'Track job applications and update their status',
    criticality_factors: [`catalog-candidate:${surface.id}`],
  });

  const merged = mergeUniquelyMatchedBehaviorEvidence(outcomes, [surface], [surface.id], [repair]);

  assert.ok(merged.every(capability => !capability.criticality_factors.includes(`catalog-candidate:${surface.id}`)));
});

test('a focused supporting repair remains uncovered when its product anchor is ambiguous', () => {
  const outcomes = [
    catalogCapability({ id: 'status-manage', name: 'Manage job application status', related_entities: ['entity_job'] }),
    catalogCapability({ id: 'status-review', name: 'Review job application status', related_entities: ['entity_job'] }),
  ];
  const surface = catalogCapability({
    id: 'capability_job', name: 'Add Job Modal Change', evidence_kind: 'behavior-surface', related_entities: ['entity_job'],
  });
  const repair = catalogCapability({
    id: 'repair', name: 'Track job applications and update their status', related_entities: ['entity_job'],
    criticality_factors: [`catalog-candidate:${surface.id}`],
  });

  const merged = mergeUniquelyMatchedBehaviorEvidence(outcomes, [surface], [surface.id], [repair]);

  assert.ok(merged.every(capability => !capability.criticality_factors.includes(`catalog-candidate:${surface.id}`)));
});

test('a focused supporting repair cannot publish standalone or cross an unrelated structural anchor', () => {
  const outcomes = [
    catalogCapability({ id: 'status', name: 'Manage job application status', related_entities: ['entity_account'] }),
    catalogCapability({ id: 'category', name: 'Categorize job applications', related_entities: ['entity_category'] }),
  ];
  const surface = catalogCapability({
    id: 'capability_job', name: 'Add Job Modal Change', evidence_kind: 'behavior-surface', related_entities: ['entity_job'],
  });
  const repair = catalogCapability({
    id: 'repair', name: 'Track job applications and update their status', related_entities: ['entity_job'],
    criticality_factors: [`catalog-candidate:${surface.id}`],
  });

  assert.deepEqual(mergeUniquelyMatchedBehaviorEvidence([], [surface], [surface.id], [repair]), []);
  const merged = mergeUniquelyMatchedBehaviorEvidence(outcomes, [surface], [surface.id], [repair]);
  assert.ok(merged.every(capability => !capability.criticality_factors.includes(`catalog-candidate:${surface.id}`)));
});

test('login behavior evidence enriches a uniquely matching sign-in outcome', () => {

  const accepted = catalogCapability({
    id: 'sign-in',
    name: 'Sign in with Google',
    description: 'Users sign in with Google before accessing their application records.',
    operations: [{ entry_point_id: 'google', entry_point_type: 'http', action: 'Authenticate' }],
    criticality_factors: ['catalog-candidate:google-sign-in'],
  });
  const login = catalogCapability({
    id: 'login',
    name: 'Manage Login',
    description: '',
    evidence_kind: 'behavior-surface',
    operations: [{ entry_point_id: 'login-click', entry_point_type: 'event', action: 'action' }],
    evidence_examples: ['Login click'],
  });

  const merged = mergeUniquelyMatchedBehaviorEvidence(
    [accepted],
    [login],
    [login.id],
  );

  assert.equal(merged.length, 1);
  assert.ok(merged[0].criticality_factors.includes('catalog-candidate:login'));
  assert.deepEqual(merged[0].operations.map(operation => operation.entry_point_id), ['google', 'login-click']);
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

test('behavior evidence cannot bridge exact operation obligations across entity families', () => {
  const category = catalogCapability({
    id: 'create-category',
    name: 'Create categories',
    related_entities: ['entity_category'],
    operations: [{ entry_point_id: 'create-category', entry_point_type: 'event', action: 'create' }],
  });
  const deleteJob = catalogCapability({
    id: 'operation-obligation:jobs:delete',
    name: 'delete job',
    structural_label: 'delete job',
    evidence_kind: 'behavior-surface',
    related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'delete-job', entry_point_type: 'event', action: 'delete' }],
  });
  const createNote = catalogCapability({
    id: 'operation-obligation:notes:create',
    name: 'create note',
    structural_label: 'create note',
    evidence_kind: 'behavior-surface',
    related_entities: ['entity_note'],
    operations: [{ entry_point_id: 'create-note', entry_point_type: 'event', action: 'create' }],
  });
  const repairs = [
    catalogCapability({ id: 'job-repair', name: 'Create and delete job records', criticality_factors: [`catalog-candidate:${deleteJob.id}`] }),
    catalogCapability({ id: 'note-repair', name: 'Create notes for job records', criticality_factors: [`catalog-candidate:${createNote.id}`] }),
  ];

  const merged = mergeUniquelyMatchedBehaviorEvidence(
    [category],
    [deleteJob, createNote],
    [deleteJob.id, createNote.id],
    repairs,
  );

  assert.deepEqual(merged[0].criticality_factors, []);
  assert.deepEqual(merged[0].related_entities, ['entity_category']);
  assert.deepEqual(merged[0].operations.map(operation => operation.entry_point_id), ['create-category']);
});


test('entity evidence families bind only to a unique capability with matching subject and entity evidence', () => {
  const capabilities = [
    catalogCapability({ id: 'jobs', name: 'Manage Job Applications', related_entities: ['entity_job'] }),
    catalogCapability({ id: 'categories', name: 'Manage Job Categories', related_entities: ['entity_category'] }),
    catalogCapability({ id: 'notes', name: 'Create Note', related_entities: ['entity_note'] }),
  ];
  const candidates = [
    catalogCapability({ id: 'cap_auth_management', name: 'Auth Note', evidence_kind: 'entity', evidence_role: 'product-outcome', related_entities: ['entity_note'] }),
    catalogCapability({ id: 'cap_job_management', name: 'Job', evidence_kind: 'entity', evidence_role: 'product-outcome', related_entities: ['entity_job'] }),
    catalogCapability({ id: 'cap_jobs_management', name: 'Jobs', evidence_kind: 'entity', evidence_role: 'product-outcome', related_entities: ['entity_job', 'entity_note'] }),
    catalogCapability({ id: 'cap_category_management', name: 'Category', evidence_kind: 'entity', evidence_role: 'product-outcome', related_entities: ['entity_category'] }),
  ];

  const merged = mergeGroundedEntityEvidenceFamilies(
    capabilities,
    candidates,
    [['cap_auth_management', 'cap_job_management', 'cap_jobs_management'], ['cap_category_management']],
  );

  assert.ok(merged[0].criticality_factors.includes('catalog-candidate:cap_job_management'));
  assert.ok(merged[1].criticality_factors.includes('catalog-candidate:cap_category_management'));
  assert.ok(!merged[2].criticality_factors.includes('catalog-candidate:cap_auth_management'));
});


test('distinct deterministic evidence attaches after its shared entity group is already covered', () => {
  const jobs = catalogCapability({
    id: 'cap_jobs_management', name: 'Jobs', evidence_role: 'product-outcome',
    related_entities: ['entity_job', 'entity_note'],
  });
  const notes = catalogCapability({
    id: 'cap_note_management', name: 'read and create and delete note', structural_label: 'Note Management',
    evidence_role: 'product-outcome', related_entities: ['entity_note'], related_domains: ['note'],
    operations: [{
      entry_point_id: 'note-create', entry_point_type: 'http', action: 'Create',
      path_or_command: '/note/add-note/:userId', trigger: { method: 'POST', path: '/note/add-note/:userId' },
    }],
  });
  const accepted = catalogCapability({
    id: 'notes', name: 'Add notes to job applications', related_entities: ['entity_job', 'entity_note'],
    criticality_factors: [`catalog-candidate:${jobs.id}`],
  });

  const merged = mergeGroundedEntityEvidenceFamilies(
    [accepted], [jobs, notes], [[jobs.id, notes.id], [notes.id]],
  );

  assert.equal(merged.length, 1);
  assert.ok(merged[0].criticality_factors.includes(`catalog-candidate:${jobs.id}`));
  assert.ok(merged[0].criticality_factors.includes(`catalog-candidate:${notes.id}`));
  assert.ok(merged[0].operations.some(operation => operation.entry_point_id === 'note-create'));
});

test('a uniquely anchored entity outcome retains the complete lifecycle as step evidence', () => {
  const notes = catalogCapability({
    id: 'cap_note_management', name: 'read and create and delete note', structural_label: 'Note Management',
    evidence_role: 'product-outcome', related_entities: ['entity_note'], related_domains: ['note'],
    operations: [
      { entry_point_id: 'note-read', entry_point_type: 'http', action: 'read', path_or_command: '/note/notes/:userId' },
      { entry_point_id: 'note-create', entry_point_type: 'http', action: 'create', path_or_command: '/note/add-note/:userId' },
      { entry_point_id: 'note-delete', entry_point_type: 'http', action: 'delete', path_or_command: '/note/delete-note/:userId' },
    ],
  });
  const obligations = notes.operations.map(operation => catalogCapability({
    id: `operation-obligation:cap_note_management:${operation.entry_point_id}`,
    name: `${operation.action} note`,
    structural_label: `${operation.action} note`,
    evidence_role: 'product-outcome',
    related_entities: ['entity_note'],
    operations: [operation],
    criticality_factors: [
      'catalog-parent-candidate:cap_note_management',
      `catalog-operation-obligation:operation-obligation:cap_note_management:${operation.entry_point_id}`,
    ],
  }));
  const capability = catalogCapability({
    id: 'notes', name: 'Attach notes to job applications', related_entities: ['entity_note'],
    operations: obligations.slice(0, 2).flatMap(obligation => obligation.operations),
    criticality_factors: obligations.slice(0, 2).map(obligation => `catalog-candidate:${obligation.id}`),
  });

  const [merged] = mergeGroundedEntityEvidenceFamilies(
    [capability], [notes, ...obligations], [[notes.id]],
  );

  assert.ok(merged.criticality_factors.includes('catalog-candidate:cap_note_management'));
  assert.ok(obligations.every(obligation =>
    merged.criticality_factors.includes(`catalog-operation-obligation:${obligation.id}`)));
  assert.deepEqual(
    merged.operations.map(operation => operation.entry_point_id).sort(),
    ['note-create', 'note-delete', 'note-read'],
  );
});

test('a cited parent family is enriched with every missing lifecycle obligation', () => {
  const categories = catalogCapability({
    id: 'cap_category_management', name: 'Category records', structural_label: 'Category',
    evidence_role: 'product-outcome', related_entities: ['entity_category'], related_domains: ['category'],
    operations: [
      { entry_point_id: 'category-read', entry_point_type: 'http', action: 'read' },
      { entry_point_id: 'category-create', entry_point_type: 'http', action: 'create' },
      { entry_point_id: 'category-update', entry_point_type: 'http', action: 'update' },
      { entry_point_id: 'category-delete', entry_point_type: 'http', action: 'delete' },
    ],
  });
  const obligations = categories.operations.map(operation => catalogCapability({
    id: `operation-obligation:cap_category_management:${operation.entry_point_id}`,
    name: `${operation.action} category`, structural_label: `${operation.action} category`,
    evidence_role: 'product-outcome', related_entities: ['entity_category'], operations: [operation],
    criticality_factors: [
      'catalog-parent-candidate:cap_category_management',
      `catalog-operation-obligation:operation-obligation:cap_category_management:${operation.entry_point_id}`,
    ],
  }));
  const capability = catalogCapability({
    id: 'categories', name: 'Categorize job applications', related_entities: ['entity_category'],
    operations: [categories.operations[2]],
    criticality_factors: ['catalog-candidate:cap_category_management'],
  });

  const [merged] = mergeGroundedEntityEvidenceFamilies(
    [capability], [categories, ...obligations], [[categories.id, ...obligations.map(obligation => obligation.id)]],
  );

  assert.deepEqual(
    merged.operations.map(operation => operation.entry_point_id).sort(),
    ['category-create', 'category-delete', 'category-read', 'category-update'],
  );
  assert.ok(obligations.every(obligation =>
    merged.criticality_factors.includes(`catalog-operation-obligation:${obligation.id}`)));
});

test('entity evidence resolves related entities through an accepted capability citation', () => {
  const behavior = catalogCapability({
    id: 'capability_job',
    name: 'Add Job Modal Change',
    evidence_kind: 'behavior-surface',
    related_entities: ['entity_job'],
  });
  const entity = catalogCapability({
    id: 'cap_job_management',
    name: 'Job',
    evidence_kind: 'entity',
    evidence_role: 'product-outcome',
    related_entities: ['entity_job'],
  });
  const capability = catalogCapability({
    id: 'jobs',
    name: 'Manage Job Applications',
    related_entities: [],
    criticality_factors: ['catalog-candidate:capability_job'],
  });

  const [merged] = mergeGroundedEntityEvidenceFamilies(
    [capability],
    [behavior, entity],
    [[entity.id]],
  );

  assert.ok(merged.criticality_factors.includes('catalog-candidate:cap_job_management'));
});

test('entity evidence does not let a broad entity family inflate a narrower outcome', () => {
  const entity = catalogCapability({
    id: 'cap_job_management',
    name: 'Job',
    evidence_kind: 'entity',
    evidence_role: 'product-outcome',
    related_entities: ['entity_job'],
  });
  const capabilities = [
    catalogCapability({ id: 'jobs', name: 'Manage Jobs', related_entities: ['entity_job'] }),
    catalogCapability({ id: 'job-sites', name: 'View Job Sites', related_entities: ['entity_job'] }),
  ];

  const merged = mergeGroundedEntityEvidenceFamilies(
    capabilities,
    [entity],
    [[entity.id]],
  );

  assert.ok(merged[0].criticality_factors.includes('catalog-candidate:cap_job_management'));
  assert.ok(!merged[1].criticality_factors.includes('catalog-candidate:cap_job_management'));
});

test('entity evidence remains uncovered when multiple capabilities are equally grounded', () => {
  const candidate = catalogCapability({
    id: 'cap_job_management',
    name: 'Job',
    evidence_kind: 'entity',
    evidence_role: 'product-outcome',
    related_entities: ['entity_job'],
  });
  const capabilities = [
    catalogCapability({ id: 'jobs', name: 'Manage Job Applications', related_entities: ['entity_job'] }),
    catalogCapability({ id: 'job-history', name: 'Review Job History', related_entities: ['entity_job'] }),
  ];

  const merged = mergeGroundedEntityEvidenceFamilies(capabilities, [candidate], [[candidate.id]]);

  assert.ok(merged.every(capability => !capability.criticality_factors.includes('catalog-candidate:' + candidate.id)));
});

test('route-backed evidence without an entity binds only to its unique authored outcome', () => {
  const settings = catalogCapability({
    id: 'cap_settings_management',
    name: 'Settings',
    structural_label: 'Settings Management',
    evidence_kind: 'route',
    evidence_role: 'product-outcome',
    related_entities: [],
  });
  const capabilities = [
    catalogCapability({ id: 'settings', name: 'Manage settings', related_entities: [] }),
    catalogCapability({ id: 'billing', name: 'Manage billing', related_entities: [] }),
  ];

  const merged = mergeGroundedEntityEvidenceFamilies(capabilities, [settings], [[settings.id]]);

  assert.ok(merged[0].criticality_factors.includes('catalog-candidate:cap_settings_management'));
  assert.ok(!merged[1].criticality_factors.includes('catalog-candidate:cap_settings_management'));
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

test('prompt selection keeps balanced evidence context without treating evidence roles as semantic truth', () => {
  const selected = selectCapabilityCatalogPromptCandidates([
    { id: 'required', name: 'Review work', category: 'core', evidence_kind: 'behavior-surface', evidence_role: 'product-outcome' },
    { id: 'support', name: 'Coordinate transport', category: 'supporting', evidence_kind: 'behavior-surface', evidence_role: 'supporting-mechanism' },
    { id: 'proof', name: 'Exercise proof', category: 'supporting', evidence_kind: 'behavior-surface', evidence_role: 'verification-harness' },
    { id: 'database', name: 'Database', category: 'supporting', evidence_kind: 'entity', evidence_role: 'supporting-mechanism' },
    { id: 'ambiguous', name: 'Account settings', category: 'supporting', evidence_kind: 'entity', evidence_role: 'unresolved' },
  ] as any[]);

  assert.deepEqual(selected.map(candidate => candidate.id), ['database', 'ambiguous', 'required', 'support', 'proof']);
});

test('prompt selection retains supporting and verification context when no product family is established', () => {
  const selected = selectCapabilityCatalogPromptCandidates([
    { id: 'support', name: 'Coordinate transport', category: 'supporting', evidence_kind: 'behavior-surface', evidence_role: 'supporting-mechanism' },
    { id: 'proof', name: 'Exercise proof', category: 'supporting', evidence_kind: 'behavior-surface', evidence_role: 'verification-harness' },
    { id: 'database', name: 'Database', category: 'supporting', evidence_kind: 'entity', evidence_role: 'supporting-mechanism' },
  ] as any[]);

  assert.deepEqual(selected.map(candidate => candidate.id), ['database', 'support', 'proof']);
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
    missingAudienceLocations: ['name'],
    missingSubjectTerms: ['understand', 'behavior'],
    oppositeAudienceLabels: ['people'],
    oppositeAudienceLocations: ['description'],
    name: 'Evaluate agent readiness and task proof',
    reason: 'outcome-scope-unsupported:readiness,task,proof',
  });

  const facts = capabilityCatalogRepairEvidenceFacts(candidates, ['agent', 'analysis'], new Map(), rejections);

  assert.deepEqual(facts[0].prior_rejections, [{
    name: 'Evaluate agent readiness and task proof',
    reason: 'outcome-scope-unsupported:readiness,task,proof',
    forbidden_subject_terms: ['readiness', 'task', 'proof'],
    missing_audience: 'agents',
    missing_audience_locations: ['name'],
    missing_subject_terms: ['understand', 'behavior'],
    opposite_audience_labels: ['people'],
    opposite_audience_locations: ['description'],
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
    { reason: 'ui-delivery-scaffolding', forbiddenTerms: ['click'] },
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
    { reason: 'capability-self-reference', forbiddenTerms: ['capability'] },
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

test('aggregate entity evidence supports an outcome-level management label', () => {
  const aggregate = catalogCapability({
    id: 'jobs', name: 'Job', structural_label: 'Job', evidence_kind: 'entity',
    operations: [
      { action: 'Create', entry_point_id: 'create', entry_point_type: 'http' },
      { action: 'Delete', entry_point_id: 'delete', entry_point_type: 'http' },
    ],
  });
  assert.deepEqual(capabilityOutcomeScopeFailure('Manage Job Applications', [aggregate], undefined, true), []);
});

test('first-party product language plus aggregate lifecycle evidence supports management over mixed delivery evidence', () => {
  const aggregate = catalogCapability({
    id: 'jobs', name: 'Job', structural_label: 'Job Management', evidence_kind: 'entity',
    operations: [
      { action: 'Manage', path_or_command: '/job/add-job', entry_point_id: 'create', entry_point_type: 'http' },
      { action: 'Manage', path_or_command: '/job/edit-job', entry_point_id: 'update', entry_point_type: 'http' },
      { action: 'Manage', path_or_command: '/job/delete-job', entry_point_id: 'delete', entry_point_type: 'http' },
    ],
  });
  const delivery = catalogCapability({
    id: 'job-form', name: 'Add Job Modal Change', structural_label: 'Add Job Modal Change', evidence_kind: 'behavior-surface',
    operations: [
      { action: 'Create', path_or_command: 'change', entry_point_id: 'change', entry_point_type: 'event' },
    ],
  });
  const signal = { productDocSummary: 'Users can manage job applications by adding, editing, and deleting them.' };

  assert.deepEqual(capabilityOutcomeScopeFailure('Manage Job Applications', [aggregate, delivery], signal, false), []);
  assert.deepEqual(
    capabilityOutcomeScopeFailure('Manage Job Applications', [aggregate, delivery], { productDocSummary: 'Users browse job listings.' }, false),
    ['delivery-operation-restatement'],
  );
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
  assert.equal(capabilityDescriptionProductLanguageViolation('People compare capability maps and entry points across changes.', [], [], liveIdentifiers)?.reason, 'capability-self-reference');
  assert.equal(capabilityDescriptionProductLanguageViolation('Connected software relationships expose change impact and conceptual conflicts.', [], [], ['CASRelationshipGraph']), undefined);
  assert.equal(capabilityDescriptionProductLanguageViolation('Agents understand connected software behavior before changing code.', [], [], ['AgentContext']), undefined);
  assert.equal(capabilityDescriptionProductLanguageViolation('The CAS graph exposes connected behavior.', [], [], liveIdentifiers, ['CAS graph']), undefined);
  assert.equal(capabilityDescriptionProductLanguageViolation('CASEdge exposes connected behavior.', [], [], ['CASEdge'], ['CAS edge relationships'])?.reason, 'raw-related-entity-identifier');
  assert.equal(capabilityDescriptionProductLanguageViolation('SystemCapability exposes connected behavior.', [], [], ['SystemCapability'], ['The system supports a product capability'])?.reason, 'raw-related-entity-identifier');
  assert.deepEqual(
    capabilityDescriptionProductLanguageViolation('Category objects remain linked by family_id across lifecycle actions.', [], []),
    { reason: 'raw-related-entity-identifier', forbiddenTerms: ['family_id'] },
  );
  assert.deepEqual(
    capabilityDescriptionProductLanguageViolation('Category objects remain linked to one family.', ['entity_category']),
    { reason: 'generic-structural-phrase', forbiddenTerms: ['Category objects'] },
  );
  assert.equal(capabilityDescriptionProductLanguageViolation('Users manage project access across teams.', [], [], ['UserConfig', 'ProjectConfig']), undefined);
  assert.equal(
    capabilityDescriptionProductLanguageViolation(
      'Users can create, view, update, and remove identity providers throughout their complete lifecycle whenever needed.',
      ['IdentityProvider', 'ListIdentityProvidersResponse', 'Status'], [], ['IdentityProvider', 'ListIdentityProvidersResponse', 'Status'],
    ),
    undefined,
  );
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

test('accepts evidence-equivalent product language without admitting invented domain claims', () => {
  const budgets = catalogCapability({
    id: 'budgets', name: 'read and update budget', structural_label: 'read and update budget',
    evidence_kind: 'behavior-surface',
    operations: [
      { action: 'read', entry_point_id: 'budget-read', entry_point_type: 'http' },
      { action: 'update', entry_point_id: 'budget-update', entry_point_type: 'http' },
    ],
  });
  const exports = catalogCapability({
    id: 'family-exports', name: 'export family data', structural_label: 'export family data',
    evidence_kind: 'behavior-surface', evidence_examples: ['export family data'],
    operations: [{ action: 'create', entry_point_id: 'export-create', entry_point_type: 'http' }],
  });
  const signal = { concepts: ['budget'], productVocabulary: ['family', 'financial', 'export', 'bank', 'account'], productDocSummary: 'People organize personal finances.' };

  assert.deepEqual(capabilityOutcomeScopeFailure('Track and adjust budgets', [budgets], signal), []);
  assert.deepEqual(capabilityOutcomeScopeFailure('Export family data', [exports], signal), []);
  assert.deepEqual(capabilityOutcomeScopeFailure('Track bank accounts', [budgets], signal), ['delivery-subject-missing']);
  assert.deepEqual(capabilityOutcomeScopeFailure('Track banana vacation budgets', [budgets], signal), ['banana', 'vacation']);
});

test('accepts an inverse lifecycle action only when the cited operation proves it', () => {
  const favorite = catalogCapability({
    id: 'favorite',
    name: 'Favorite (Article)',
    operations: [
      { entry_point_id: 'favorite', entry_point_type: 'http', action: 'Create', trigger: { method: 'POST', path: '/articles/:slug/favorite' } },
      { entry_point_id: 'unfavorite', entry_point_type: 'http', action: 'Delete', trigger: { method: 'DELETE', path: '/articles/:slug/favorite' } },
    ],
  });
  assert.deepEqual(capabilityOutcomeScopeFailure('Favorite or unfavorite an article', [favorite]), []);
  assert.deepEqual(capabilityOutcomeScopeFailure('Favorite or unfavorite an article', [{ ...favorite, operations: favorite.operations.slice(0, 1) }]), ['unfavorite']);
});

test('evidence-mode repair enriches one existing identity without replacing authored fields', () => {
  const sharedOperation = { entry_point_id: 'job-change', entry_point_type: 'event' as const, action: 'Change' };
  const accepted = catalogCapability({
    id: 'accepted-status', name: 'Manage application status',
    description: 'Users maintain the current state of each application.', related_entities: ['entity_job'],
    operations: [sharedOperation], criticality_factors: ['catalog-candidate:job-status'],
  });
  const repair = catalogCapability({
    id: 'fresh-repair', name: 'Track job applications and update their status',
    description: 'Users track job applications and update their status as applications progress.',
    related_entities: ['entity_job'], operations: [sharedOperation],
    criticality_factors: ['catalog-candidate:capability_job'],
  });
  const evidence = catalogCapability({
    id: 'capability_job', name: 'Job application status', structural_label: 'Job application status',
    related_entities: ['entity_job'], operations: [sharedOperation], evidence_kind: 'behavior-surface',
  });

  const merged = mergeCapabilityCatalogRepairResults(
    [accepted], [repair], new Set(['capability_job']), [evidence],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, accepted.id);
  assert.equal(merged[0].name, accepted.name);
  assert.equal(merged[0].description, accepted.description);
  assert.ok(merged[0].criticality_factors.includes('catalog-candidate:capability_job'));
  assert.ok(!merged[0].criticality_factors.includes('catalog-candidate:fresh-repair'));
});

test('evidence-mode repair appends only a post-synthesis-grounded evidence identity', () => {
  const repair = catalogCapability({
    id: 'fresh-repair', name: 'Track job applications and update their status',
    related_entities: ['entity_job'], criticality_factors: ['catalog-candidate:capability_job'],
  });
  const evidence = catalogCapability({ id: 'capability_job', name: 'Job application status', related_entities: ['entity_job'], evidence_kind: 'behavior-surface' });
  const ambiguous = [
    catalogCapability({ id: 'one', name: 'Manage job application status', related_entities: ['entity_job'] }),
    catalogCapability({ id: 'two', name: 'Review job application status', related_entities: ['entity_job'] }),
  ];

  assert.deepEqual(mergeCapabilityCatalogRepairResults([], [repair], new Set(['capability_job']), [evidence]), []);
  assert.deepEqual(mergeCapabilityCatalogRepairResults(ambiguous, [repair], new Set(['capability_job']), [evidence]), ambiguous);

  const unresolved = { ...evidence, evidence_role: 'unresolved' as const };
  assert.deepEqual(
    mergeCapabilityCatalogRepairResults([], [repair], new Set(['capability_job']), [unresolved]),
    [],
  );
  const appended = mergeCapabilityCatalogRepairResults(
    [], [repair], new Set(['capability_job']), [unresolved], new Set(), new Set(['capability_job']),
  );
  assert.equal(appended.length, 1);
  assert.equal(appended[0].name, repair.name);
  assert.deepEqual(appended[0].related_entities, ['entity_job']);
  const productOutcome = { ...evidence, evidence_role: 'product-outcome' as const };
  assert.equal(mergeCapabilityCatalogRepairResults(
    [], [repair], new Set(['capability_job']), [productOutcome], new Set(), new Set(['capability_job']),
  ).length, 1);
});

test('evidence-mode repair appends a fully cited grouped lifecycle and grounds it to known evidence', () => {
  const first = catalogCapability({
    id: 'budget-read', name: 'read budget', related_entities: ['entity_budget'],
    operations: [{ entry_point_id: 'budget-read-entry', entry_point_type: 'http', action: 'read' }],
    evidence_kind: 'behavior-surface',
  });
  const second = catalogCapability({
    id: 'budget-update', name: 'update budget', related_entities: ['entity_budget'],
    operations: [{ entry_point_id: 'budget-update-entry', entry_point_type: 'http', action: 'update' }],
    evidence_kind: 'behavior-surface',
  });
  const repair = catalogCapability({
    id: 'track-budgets', name: 'Track budgets',
    description: 'Budgets can be reviewed and updated throughout each planning period.',
    related_entities: ['forged_entity'],
    operations: [{ entry_point_id: 'forged-entry', entry_point_type: 'http', action: 'delete' }],
    criticality_factors: ['catalog-candidate:budget-read', 'catalog-candidate:budget-update'],
  });

  const merged = mergeCapabilityCatalogRepairResults(
    [], [repair], new Set(['budget-read', 'budget-update']), [first, second],
  );

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].related_entities, ['entity_budget']);
  assert.deepEqual(merged[0].operations.map(operation => operation.entry_point_id).sort(), [
    'budget-read-entry', 'budget-update-entry',
  ]);
  assert.deepEqual(
    merged[0].criticality_factors.filter(factor => factor.startsWith('catalog-candidate:')).sort(),
    ['catalog-candidate:budget-read', 'catalog-candidate:budget-update'],
  );
});

test('evidence-mode repair rejects grouped lifecycle citations that are partial, unknown, or overlap published evidence', () => {
  const evidence = catalogCapability({ id: 'budget-read', name: 'read budget', evidence_kind: 'behavior-surface' });
  const repair = catalogCapability({
    id: 'track-budgets', name: 'Track budgets',
    criticality_factors: ['catalog-candidate:budget-read', 'catalog-candidate:budget-update'],
  });
  assert.deepEqual(mergeCapabilityCatalogRepairResults(
    [], [repair], new Set(['budget-read']), [evidence],
  ), []);
  assert.deepEqual(mergeCapabilityCatalogRepairResults(
    [catalogCapability({ id: 'existing', criticality_factors: ['catalog-candidate:budget-read'] })],
    [repair], new Set(['budget-read', 'budget-update']), [evidence, { ...evidence, id: 'budget-update' }],
  ).map(capability => capability.id), ['existing']);
});

test('invalid evidence-mode description transfers only grounded evidence into its unique accepted identity', () => {
  const accepted = catalogCapability({
    id: 'accepted-status', name: 'Manage application status',
    description: 'Users maintain the current state of each application.', related_entities: ['entity_job'],
  });
  const rejectedRepair = catalogCapability({
    id: 'fresh-repair', name: 'Track job applications and update their status', description: '',
    description_generation: { status: 'ai_rejected', attempted: true }, related_entities: ['entity_job'],
    criticality_factors: ['catalog-candidate:capability_job'],
  });
  const evidence = catalogCapability({ id: 'capability_job', name: 'Job application status', related_entities: ['entity_job'], evidence_kind: 'behavior-surface' });

  const merged = mergeCapabilityCatalogRepairResults(
    [accepted], [rejectedRepair], new Set(['capability_job']), [evidence],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, accepted.id);
  assert.equal(merged[0].description, accepted.description);
  assert.ok(merged[0].criticality_factors.includes('catalog-candidate:capability_job'));
  assert.ok(!merged[0].criticality_factors.includes('catalog-candidate:fresh-repair'));
});

test('valid new-family evidence has no existing merge target while ambiguous evidence remains unresolved', () => {
  const repair = catalogCapability({
    id: 'authored-repair', name: 'Track job application status', related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'status', entry_point_type: 'event', action: 'Track' }],
    criticality_factors: ['catalog-candidate:capability_job'],
  });
  const evidence = catalogCapability({
    id: 'capability_job', name: 'Job application status', related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'status', entry_point_type: 'event', action: 'Track' }], evidence_kind: 'behavior-surface',
  });
  assert.deepEqual(capabilityCatalogEvidenceRepairMatchIndexes([], repair, [evidence], new Set(['capability_job'])), []);
  assert.equal(capabilityCatalogEvidenceRepairMatchIndexes([
    catalogCapability({ id: 'one', name: 'Track job application status', related_entities: ['entity_job'] }),
    catalogCapability({ id: 'two', name: 'Review job application status', related_entities: ['entity_job'] }),
  ], repair, [evidence], new Set(['capability_job'])).length, 2);
});

test('evidence repair ignores forged operations, entities, and unknown citations', () => {
  const accepted = catalogCapability({ id: 'accepted', name: 'Track job status', related_entities: ['entity_job'] });
  const evidence = catalogCapability({
    id: 'capability_job', name: 'Job status', evidence_kind: 'behavior-surface', related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'real-status', entry_point_type: 'event', action: 'Track' }],
  });
  const forged = catalogCapability({
    id: 'authored', name: 'Track job status', related_entities: ['entity_secret'],
    operations: [{ entry_point_id: 'forged-delete', entry_point_type: 'http', action: 'Delete' }],
    criticality_factors: ['catalog-candidate:capability_job'],
  });
  const merged = mergeCapabilityCatalogRepairResults([accepted], [forged], new Set(['capability_job']), [evidence]);
  assert.deepEqual(merged[0].related_entities, ['entity_job']);
  assert.deepEqual(merged[0].operations.map(operation => operation.entry_point_id), ['real-status']);
  assert.ok(merged[0].criticality_factors.includes('catalog-candidate:capability_job'));

  const extraCitation = { ...forged, criticality_factors: ['catalog-candidate:capability_job', 'catalog-candidate:unknown'] };
  assert.deepEqual(mergeCapabilityCatalogRepairResults([accepted], [extraCitation], new Set(['capability_job']), [evidence]), [accepted]);
});

test('a validated second description response wins without evaluating deterministic fallback', () => {
  const accepted = catalogCapability({ id: 'accepted', description: 'Users track application status throughout the review process.' });
  const attemptedFallbackIdentityIds = new Set(['accepted']);
  let validationCalls = 0;
  const selected = resolveCapabilityCatalogDescriptionRepair({
    validated: [accepted], attempt: 2, identity: accepted, attemptedFallbackIdentityIds,
    pendingEvidenceIdentityByCandidateId: new Map(), evidenceCandidates: [], firstPartyTexts: [],
    validate: () => { validationCalls++; return true; },
  });
  assert.equal(validationCalls, 1);
  assert.equal(selected[0].id, accepted.id);
  assert.equal(selected[0].description, accepted.description);
  assert.deepEqual([...attemptedFallbackIdentityIds], ['accepted']);
});

test("generic grouped lifecycle wording fails closed when no authored product outcome validates", () => {
  const candidate = catalogCapability({
    id: "categories", name: "Categories", structural_label: "categories", evidence_kind: "behavior-surface",
    operations: [
      { entry_point_id: "create-category", entry_point_type: "http", action: "create" },
      { entry_point_id: "view-category", entry_point_type: "http", action: "read" },
      { entry_point_id: "update-category", entry_point_type: "http", action: "update" },
      { entry_point_id: "remove-category", entry_point_type: "http", action: "delete" },
    ],
  });
  const identity = catalogCapability({
    id: "category-lifecycle", name: "Manage categories", name_source: "deterministic", description: "",
    operations: candidate.operations,
    criticality_factors: ["catalog-candidate:categories", "catalog-deterministic-grouped-lifecycle"],
  });
  const repaired = resolveCapabilityCatalogDescriptionRepair({
    validated: [], attempt: 2, identity, allowNameRepair: true,
    attemptedFallbackIdentityIds: new Set(), pendingEvidenceIdentityByCandidateId: new Map(),
    evidenceCandidates: [candidate], audience: "Users", firstPartyTexts: [],
    validate: () => false,
  });
  assert.deepEqual(repaired, []);
});
test('repairs an authored exact grouped lifecycle description from cited operations', () => {
  const evidence = (action: string) => catalogCapability({
    id: `operation-obligation:transfers:${action}`,
    name: `${action} transfer`,
    structural_label: `${action} transfer`,
    related_domains: ['transfer'],
    operations: [{ entry_point_id: `transfer-${action}`, entry_point_type: 'http', action }],
  });
  const candidates = ['create', 'read', 'update', 'delete'].map(evidence);
  const identity = catalogCapability({
    id: 'track-transfers',
    name: 'Track transfers',
    name_source: 'ai',
    description: '',
    criticality_factors: candidates.map(candidate => 'catalog-candidate:' + candidate.id),
  });

  const repaired = deterministicCapabilityDescriptionFallback({
    identity,
    evidenceCandidates: candidates,
    audience: 'Users',
    firstPartyTexts: [],
    validate: capability =>
      capability.name === 'Track transfers' &&
      !capabilityDescriptionProductLanguageViolation(
        capability.description || '', ['Transfer'],
        candidates.flatMap(candidate => candidate.operations || []).map(operation => JSON.stringify([operation.action, operation.entry_point_id])),
      ) &&
      validateElementDescription(capability.description || '', {
        name: capability.name, kind: 'capability', relatedEntities: ['Transfer'], relatedDomains: ['transfer'],
      }).ok,
  });

  assert.equal(repaired?.name, 'Track transfers');
  assert.equal(
    repaired?.description,
    'Users can track transfers so their recorded details remain current and available over time.',
  );
});


test('a validated deterministic identity repair keeps evidence while accepting an authored name', () => {
  const identity = catalogCapability({
    id: 'stable-categories', name: 'Manage categories', name_source: 'deterministic',
    description: 'Users can maintain categories over time as the information they represent changes.',
    operations: [{ entry_point_id: 'categories', entry_point_type: 'http', action: 'update' }],
    criticality_factors: ['catalog-candidate:categories', 'catalog-candidate:category'],
  });
  const authored = { ...identity, id: 'provider-id', name: 'Organize transaction categories', name_source: 'ai' as const,
    description: 'Users organize transaction categories and remove obsolete choices as their financial records change.' };
  const [repaired] = resolveCapabilityCatalogDescriptionRepair({
    validated: [authored], attempt: 1, identity, allowNameRepair: true,
    attemptedFallbackIdentityIds: new Set(), pendingEvidenceIdentityByCandidateId: new Map(),
    evidenceCandidates: [], firstPartyTexts: [], validate: () => true,
  });
  assert.equal(repaired.id, identity.id);
  assert.equal(repaired.name, authored.name);
  assert.equal(repaired.name_source, 'ai');
  assert.deepEqual(repaired.operations, identity.operations);
  assert.deepEqual(repaired.criticality_factors, [
    ...identity.criticality_factors,
    'catalog-description-repair-lifecycle:candidates:categories|category',
  ]);
});

test('a grounded authored name can repair a deterministic identity without accepting invented prose', () => {
  const identity = catalogCapability({
    id: 'stable-imports', name: 'Manage imports', name_source: 'deterministic',
    description: 'Users can create, view, update, and remove imports.',
    operations: [{ entry_point_id: 'imports', entry_point_type: 'http', action: 'create' }],
    criticality_factors: ['catalog-candidate:imports', 'catalog-candidate:upload'],
  });
  const authored = {
    ...identity, id: 'provider-id', name: 'Import CSV records', name_source: 'ai' as const,
    description: 'Imports permanently synchronize every financial account.',
  };
  const [repaired] = resolveCapabilityCatalogDescriptionRepair({
    validated: [authored], attempt: 1, identity, allowNameRepair: true,
    attemptedFallbackIdentityIds: new Set(), pendingEvidenceIdentityByCandidateId: new Map(),
    evidenceCandidates: [], firstPartyTexts: [],
    validate: capability => capability.name === 'Import CSV records' &&
      capability.description === identity.description,
  });

  assert.equal(repaired.id, identity.id);
  assert.equal(repaired.name, authored.name);
  assert.equal(repaired.description, identity.description);
  assert.deepEqual(repaired.operations, identity.operations);
  assert.ok(repaired.criticality_factors.includes('catalog-description-repair-lifecycle:candidates:imports|upload'));
});

test('a nonempty invalid first description response yields a validated deterministic fallback without another provider cycle', () => {
  const evidence = catalogCapability({
    id: 'invoice-list', name: 'Invoice records', structural_label: 'Invoice records',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    related_entities: ['entity_invoice'],
    operations: [{ entry_point_id: 'invoice-list-route', entry_point_type: 'http', action: 'read' }],
  });
  const identity = catalogCapability({
    id: 'stable-invoices', name: 'View invoice records', description: '',
    related_entities: ['entity_invoice'], operations: evidence.operations,
    criticality_factors: ['catalog-candidate:invoice-list'],
  });
  const invalid = { ...identity, description: 'Operators delete unrelated credentials.' };
  const repaired = resolveCapabilityCatalogDescriptionRepair({
    validated: [invalid], attempt: 1, identity, attemptedFallbackIdentityIds: new Set(),
    pendingEvidenceIdentityByCandidateId: new Map(), evidenceCandidates: [evidence], audience: 'Operators',
    firstPartyTexts: ['Operators view invoice records to understand current billing status before reviewing customer follow-up work.'],
    validate: capability => capability.description === 'Operators view invoice records to understand current billing status before reviewing customer follow-up work.',
  });
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].id, identity.id);
  assert.equal(repaired[0].name, identity.name);
  assert.equal(repaired[0].description, 'Operators view invoice records to understand current billing status before reviewing customer follow-up work.');
});

test('valid and invalid exact-candidate new-family repairs share one stable non-coverage identity', () => {
  const evidence = catalogCapability({
    id: 'capability_job', name: 'Job status', structural_label: 'Job status', evidence_kind: 'behavior-surface',
    evidence_role: 'product-outcome', related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'status', entry_point_type: 'event', action: 'Track' }],
  });
  const valid = catalogCapability({
    id: 'stable-job', name: 'Track job status', description: 'Users track job status throughout the application review process.',
    related_entities: ['entity_job'], operations: evidence.operations,
    criticality_factors: ['catalog-candidate:capability_job'],
  });
  const registry = new Map();
  const base = {
    reconciled: [], registry, evidenceCandidates: [evidence], evidenceRepairCandidateIds: new Set(['capability_job']),
    requiredUncoveredCandidateIds: new Set(['capability_job']), familyKeyByCandidateId: new Map([['capability_job', 'job-family']]),
    audienceFor: () => 'Users',
  };
  const staged = stagePendingCapabilityEvidenceRepairs({
    ...base, cycleCapabilities: [valid], descriptionFailureByCapabilityId: new Map(), isPublishable: () => true,
  });
  assert.deepEqual([...staged], ['stable-job']);
  assert.equal(registry.get('capability_job').identity.description, '');

  const invalid = { ...valid, description: '', description_generation: { status: 'ai_rejected' as const, attempted: true, reason: 'description-rejected' } };
  stagePendingCapabilityEvidenceRepairs({
    ...base, cycleCapabilities: [invalid], descriptionFailureByCapabilityId: new Map([['candidate:capability_job', 'description-rejected']]), isPublishable: () => false,
  });
  assert.equal(registry.size, 1);
  assert.equal(registry.get('capability_job').identity.id, 'stable-job');

  const promoted = new Set<string>();
  assert.deepEqual([...stagePendingCapabilityEvidenceRepairs({ ...base, cycleCapabilities: [valid], promotedIdentityIds: promoted, descriptionFailureByCapabilityId: new Map(), isPublishable: () => true })], []);
  assert.deepEqual([...promoted], ['stable-job']);
  assert.equal(registry.size, 0);
});

test('stages an audience-rejected product outcome for explicit AI name repair', () => {
  const evidence = catalogCapability({
    id: 'categories', name: 'Categories', structural_label: 'create read update delete category',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome', related_entities: ['entity_category'],
    operations: [
      { entry_point_id: 'create-category', entry_point_type: 'http', action: 'create' },
      { entry_point_id: 'update-category', entry_point_type: 'http', action: 'update' },
      { entry_point_id: 'delete-category', entry_point_type: 'http', action: 'delete' },
    ],
  });
  const rejected = catalogCapability({
    id: 'crud-categories', name: 'Create and update categories', related_entities: ['entity_category'],
    operations: evidence.operations, criticality_factors: ['catalog-candidate:categories'],
  });
  const registry = new Map();

  assert.equal(stageRejectedCapabilityNameRepair({
    capability: rejected, reason: 'catalog-audience:crud-inventory-label',
    repairableCandidateIds: new Set(['categories']), evidenceCandidates: [evidence],
    registry, audience: 'Users',
  }), true);
  const identity = registry.get('categories')?.identity;
  assert.ok(identity?.criticality_factors?.includes('catalog-name-repair-required'));
  const [batch] = capabilityCatalogRepairPlan({ evidenceCandidateIds: ['categories'], outcomeRequirements: [], pendingCapabilities: [identity!] });
  assert.equal(batch.mode === 'description' && batch.repairName, true);

  const rejectedRepair = { ...rejected, name: 'Create category', description: 'Users create, update, and delete categories.' };
  stagePendingCapabilityEvidenceRepairs({
    cycleCapabilities: [rejectedRepair], reconciled: [], registry, evidenceCandidates: [evidence],
    evidenceRepairCandidateIds: new Set(['categories']), requiredUncoveredCandidateIds: new Set(['categories']),
    familyKeyByCandidateId: new Map([['categories', 'product-outcome:categories']]),
    descriptionFailureByCapabilityId: new Map(), isPublishable: () => false, audienceFor: () => 'Users',
  });
  assert.equal(registry.get('categories')?.identity.name, 'Create and update categories');
  assert.ok(registry.get('categories')?.identity.criticality_factors?.includes('catalog-name-repair-required'));

  const repaired = {
    ...rejected, name: 'Organize spending categories',
    description: 'Users organize spending categories by creating, updating, and deleting labels with supported colors and icons.',
  };
  const promoted = new Map<string, SystemCapability>();
  stagePendingCapabilityEvidenceRepairs({
    cycleCapabilities: [repaired], reconciled: [], registry, evidenceCandidates: [evidence],
    evidenceRepairCandidateIds: new Set(['categories']), requiredUncoveredCandidateIds: new Set(['categories']),
    familyKeyByCandidateId: new Map([['categories', 'product-outcome:categories']]),
    descriptionFailureByCapabilityId: new Map(), isPublishable: () => true, audienceFor: () => 'Users',
    promotedCapabilitiesByCandidateId: promoted,
  });
  assert.equal(promoted.get('categories')?.name, 'Organize spending categories');
  assert.equal(promoted.get('categories')?.criticality_factors?.includes('catalog-name-repair-required'), false);
});

test('stages an exact-candidate identity instead of starving behind ambiguous broad matches', () => {
  const evidence = catalogCapability({
    id: 'invoice-list', name: 'List invoices', structural_label: 'List invoices', evidence_kind: 'behavior-surface',
    evidence_role: 'product-outcome', related_entities: ['entity_invoice'],
    operations: [{ entry_point_id: 'invoice-list-route', entry_point_type: 'http', action: 'read' }],
  });
  const existing = [
    catalogCapability({ id: 'status', name: 'Manage invoice status', related_entities: ['entity_invoice'] }),
    catalogCapability({ id: 'filter', name: 'Filter invoices', related_entities: ['entity_invoice'] }),
  ];
  const incoming = catalogCapability({
    id: 'list', name: 'View invoices', related_entities: ['entity_invoice'], operations: evidence.operations,
    criticality_factors: ['catalog-candidate:invoice-list'],
  });
  assert.ok(capabilityCatalogEvidenceRepairMatchIndexes(existing, incoming, [evidence], new Set(['invoice-list'])).length > 1);
  const registry = new Map();
  const rejections: Array<{ candidateIds: string[]; name: string; reason: string }> = [];
  const base = {
    reconciled: existing, registry, evidenceCandidates: [evidence], evidenceRepairCandidateIds: new Set(['invoice-list']),
    requiredUncoveredCandidateIds: new Set(['invoice-list']), familyKeyByCandidateId: new Map([['invoice-list', 'invoice-list-family']]),
    descriptionFailureByCapabilityId: new Map(), isPublishable: () => true, audienceFor: () => 'Users',
    recordRejection: (feedback: { candidateIds: string[]; name: string; reason: string }) => rejections.push(feedback),
  };
  assert.deepEqual([...stagePendingCapabilityEvidenceRepairs({ ...base, cycleCapabilities: [incoming] })], ['list']);
  assert.equal(registry.get('invoice-list')?.identity.id, 'list');

  registry.clear();
  assert.deepEqual([...stagePendingCapabilityEvidenceRepairs({ ...base, cycleCapabilities: [incoming], familyKeyByCandidateId: new Map(), exactOperationCandidateIds: new Set(['invoice-list']) })], ['list']);
  assert.equal(registry.get('invoice-list')?.familyKey, 'operation:invoice-list');

  registry.clear();
  const citedButUncovered = { ...existing[0], criticality_factors: ['catalog-candidate:invoice-list'] };
  assert.deepEqual([...stagePendingCapabilityEvidenceRepairs({ ...base, reconciled: [citedButUncovered, existing[1]], cycleCapabilities: [incoming], familyKeyByCandidateId: new Map(), exactOperationCandidateIds: new Set(['invoice-list']) })], ['list']);
  assert.equal(registry.get('invoice-list')?.identity.id, 'list');

  registry.clear();
  assert.deepEqual([...stagePendingCapabilityEvidenceRepairs({
    ...base, cycleCapabilities: [{ ...incoming, id: 'tracking', name: 'Track invoices' }],
  })], ['tracking']);
  assert.equal(registry.get('invoice-list')?.identity.id, 'tracking');
  assert.deepEqual(rejections, []);
});

test('same-name synthetic obligations retain independent pending and promotion lifecycles', () => {
  const candidate = (id: string, entryPointId: string) => catalogCapability({
    id, name: 'update job status', structural_label: 'update job status', evidence_kind: 'behavior-surface',
    evidence_role: 'product-outcome', related_entities: ['entity_job'],
    operations: [{ entry_point_id: entryPointId, entry_point_type: 'event', action: 'update' }],
  });
  const firstId = 'operation-obligation:capability_job:804e94f90dbc44ec';
  const secondId = 'operation-obligation:capability_job:aade3daad6ccf9ae';
  const evidence = [candidate(firstId, 'status-change'), candidate(secondId, 'status-submit')];
  const repair = (candidateId: string, description: string) => catalogCapability({
    id: 'capability_update_job_status', name: 'Update job status', description,
    related_entities: ['entity_job'], operations: evidence.find(item => item.id === candidateId)!.operations,
    criticality_factors: [`catalog-candidate:${candidateId}`],
  });
  const registry = new Map();
  const base = {
    reconciled: [], registry, evidenceCandidates: evidence,
    evidenceRepairCandidateIds: new Set([firstId, secondId]), requiredUncoveredCandidateIds: new Set([firstId, secondId]),
    exactOperationCandidateIds: new Set([firstId, secondId]), familyKeyByCandidateId: new Map(),
    descriptionFailureByCapabilityId: new Map(), audienceFor: () => 'Users',
  };
  const stagedCandidates = new Set<string>();
  stagePendingCapabilityEvidenceRepairs({
    ...base, cycleCapabilities: [repair(firstId, 'first'), repair(secondId, 'second')],
    isPublishable: () => true, stagedCandidateIds: stagedCandidates,
  });
  assert.deepEqual([...registry.keys()].sort(), [firstId, secondId].sort());
  assert.deepEqual([...stagedCandidates].sort(), [firstId, secondId].sort());

  const promotedCandidates = new Set<string>();
  const stillStagedCandidates = new Set<string>();
  stagePendingCapabilityEvidenceRepairs({
    ...base, cycleCapabilities: [repair(firstId, 'valid'), repair(secondId, '')],
    isPublishable: capability => capability.description === 'valid',
    promotedCandidateIds: promotedCandidates, stagedCandidateIds: stillStagedCandidates,
  });
  assert.deepEqual([...promotedCandidates], [firstId]);
  assert.deepEqual([...stillStagedCandidates], [secondId]);
  assert.deepEqual([...registry.keys()], [secondId]);
});

test('same generated capability id cannot cross-contaminate exact obligation attempts or fallbacks', () => {
  const firstId = 'operation-obligation:capability_job:804e94f90dbc44ec';
  const secondId = 'operation-obligation:capability_job:aade3daad6ccf9ae';
  const candidate = (id: string, entryPointId: string) => catalogCapability({
    id, name: 'update job status', structural_label: 'update job status', evidence_kind: 'behavior-surface',
    evidence_role: 'product-outcome', related_entities: ['entity_job'],
    operations: [{ entry_point_id: entryPointId, entry_point_type: 'event', action: 'update' }],
  });
  const evidence = [candidate(firstId, 'status-change'), candidate(secondId, 'status-submit')];
  const identity = (candidateId: string) => catalogCapability({
    id: 'capability_update_job_status', name: 'Update job status', description: '',
    related_entities: ['entity_job'], operations: evidence.find(item => item.id === candidateId)!.operations,
    criticality_factors: [`catalog-candidate:${candidateId}`],
  });
  const registry = new Map([
    [firstId, { audience: 'Users', candidateId: firstId, evidenceDigest: 'first', familyKey: `operation:${firstId}`, fallbackAttempted: false, identity: identity(firstId) }],
    [secondId, { audience: 'Users', candidateId: secondId, evidenceDigest: 'second', familyKey: `operation:${secondId}`, fallbackAttempted: false, identity: identity(secondId) }],
  ]);
  const attempts = new Map([
    [`candidate:${firstId}`, 2],
    [`candidate:${secondId}`, 1],
  ]);
  assert.equal(hasPendingCapabilityDescriptionAttempt(registry, attempts), true);
  attempts.set(`candidate:${secondId}`, 2);
  assert.equal(hasPendingCapabilityDescriptionAttempt(registry, attempts), false);

  const attemptedFallbacks = new Set<string>();
  const firstPartyText = 'Users update job status to coordinate application reviews across active hiring workflows.';
  const resolve = (candidateId: string) => resolveCapabilityCatalogDescriptionRepair({
    validated: [], attempt: 2, identity: registry.get(candidateId)!.identity,
    attemptedFallbackIdentityIds: attemptedFallbacks,
    pendingEvidenceIdentityByCandidateId: registry, evidenceCandidates: evidence,
    firstPartyTexts: [firstPartyText],
    validate: capability => capability.description === firstPartyText,
  });
  const firstRepair = resolve(firstId);
  assert.equal(firstRepair.length, 1);
  assert.deepEqual([...attemptedFallbacks], [`candidate:${firstId}`]);
  assert.equal(registry.get(firstId)?.fallbackAttempted, true);
  assert.equal(registry.get(secondId)?.fallbackAttempted, false);

  const secondRepair = resolve(secondId);
  assert.equal(secondRepair.length, 1);
  assert.deepEqual([...attemptedFallbacks].sort(), [`candidate:${firstId}`, `candidate:${secondId}`].sort());
  assert.equal(registry.get(secondId)?.fallbackAttempted, true);

  const promotedCandidates = new Set<string>();
  stagePendingCapabilityEvidenceRepairs({
    cycleCapabilities: [...firstRepair, ...secondRepair], reconciled: [], registry, evidenceCandidates: evidence,
    evidenceRepairCandidateIds: new Set([firstId, secondId]), requiredUncoveredCandidateIds: new Set([firstId, secondId]),
    exactOperationCandidateIds: new Set([firstId, secondId]), familyKeyByCandidateId: new Map(),
    descriptionFailureByCapabilityId: new Map(), isPublishable: () => true, audienceFor: () => 'Users',
    promotedCandidateIds: promotedCandidates,
  });
  assert.deepEqual([...promotedCandidates].sort(), [firstId, secondId].sort());
  assert.equal(registry.size, 0);
});

test('a unique existing evidence match bypasses the pending registry for direct merge', () => {
  const evidence = catalogCapability({
    id: 'invoice-list', name: 'List invoices', structural_label: 'List invoices', evidence_kind: 'behavior-surface',
    evidence_role: 'product-outcome', related_entities: ['entity_invoice'],
    operations: [{ entry_point_id: 'invoice-list-route', entry_point_type: 'http', action: 'read' }],
  });
  const existing = catalogCapability({ id: 'existing', name: 'View invoices', related_entities: ['entity_invoice'] });
  const incoming = catalogCapability({
    id: 'incoming', name: 'View invoices', related_entities: ['entity_invoice'], operations: evidence.operations,
    criticality_factors: ['catalog-candidate:invoice-list'],
  });
  assert.equal(capabilityCatalogEvidenceRepairMatchIndexes([existing], incoming, [evidence], new Set(['invoice-list'])).length, 1);
  const registry = new Map();
  const staged = stagePendingCapabilityEvidenceRepairs({
    cycleCapabilities: [incoming], reconciled: [existing], registry, evidenceCandidates: [evidence],
    evidenceRepairCandidateIds: new Set(['invoice-list']), requiredUncoveredCandidateIds: new Set(['invoice-list']),
    familyKeyByCandidateId: new Map([['invoice-list', 'invoice-list-family']]), descriptionFailureByCapabilityId: new Map(),
    isPublishable: () => true, audienceFor: () => 'Users',
  });
  assert.equal(staged.size, 0);
  assert.equal(registry.size, 0);
});

test('a same-named sibling operation obligation cannot consume a distinct exact repair', () => {
  const firstId = 'operation-obligation:job:first-update';
  const secondId = 'operation-obligation:job:second-update';
  const evidence = catalogCapability({
    id: secondId, name: 'update job', structural_label: 'update job', evidence_kind: 'behavior-surface',
    evidence_role: 'product-outcome', related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'second-status-update', entry_point_type: 'event', action: 'update' }],
  });
  const existing = catalogCapability({
    id: 'capability_update_job_status', name: 'Update job status',
    description: 'Users update job application status throughout the review process.',
    related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'first-status-update', entry_point_type: 'event', action: 'update' }],
    criticality_factors: [`catalog-candidate:${firstId}`],
  });
  const incoming = catalogCapability({
    ...existing,
    operations: evidence.operations,
    criticality_factors: [`catalog-candidate:${secondId}`],
  });
  assert.deepEqual(capabilityCatalogEvidenceRepairMatchIndexes(
    [existing], incoming, [evidence], new Set([secondId]),
  ), []);
  const merged = mergeCapabilityCatalogRepairResults([existing], [incoming], new Set([secondId]), [evidence]);
  assert.deepEqual(merged, [existing]);
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

test('accepted same-identity description repair replaces the pending rejection and clears its repair key', () => {
  const pending = catalogCapability({
    id: 'old', name: 'Access external records', description: '',
    description_generation: { status: 'ai_rejected', attempted: true, reason: 'implementation-surface-restatement' },
    criticality_factors: ['catalog-candidate:external-records'],
  });
  const repaired = catalogCapability({
    id: 'new', name: 'Access external records',
    description: 'People open verified external records associated with their account.',
    description_generation: { status: 'ai_applied', attempted: true },
    criticality_factors: ['catalog-candidate:external-records'],
  });
  const merged = mergeCapabilityCatalogRepairResults([pending], [repaired]);
  assert.deepEqual(merged.map(capability => capability.id), ['new']);
  assert.deepEqual(capabilityCatalogPendingRepairKeys(merged), []);
});

test('accepted same-ID authored repair replaces a publishable deterministic fallback', () => {
  const fallback = catalogCapability({
    id: 'stable', name: 'Manage imports', description: 'Users create and remove imports.',
    name_source: 'deterministic', description_generation: { status: 'deterministic_kept', attempted: true },
    criticality_factors: ['catalog-candidate:imports', 'catalog-deterministic-grouped-lifecycle'],
  });
  const repaired = catalogCapability({
    ...fallback, id: 'provider-generated', name: 'Upload and import records',
    description: 'Users upload records and remove imports when they are no longer needed.',
    operations: [], related_entities: [],
    name_source: 'ai', description_generation: { status: 'ai_applied', attempted: true },
    criticality_factors: [
      ...fallback.criticality_factors,
      'catalog-description-repair-lifecycle:candidate:imports',
    ],
  });

  assert.deepEqual(mergeCapabilityCatalogRepairResults(
    [fallback], [repaired], new Set(), [], new Set(['candidate:imports']),
  ), [{
    ...fallback,
    name: repaired.name,
    description: repaired.description,
    name_source: repaired.name_source,
    description_generation: repaired.description_generation,
  }]);
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

test('runs two disjoint evidence batches concurrently while preserving plan order', async () => {
  let active = 0; let peak = 0; const settled: number[] = []; let seenBeforeLater: number[] = [];
  const facts = [{ id: 'slow', candidateIds: ['a'] }, { id: 'fast', candidateIds: ['b'] }, { id: 'later', candidateIds: ['a'] }];
  const values = await collectCapabilityCatalogEvidenceBatches({ facts, evidenceScoped: true, batchBudgetMs: 1000, concurrency: 2, conflictKeys: fact => fact.candidateIds, onBatchSettled: (_values, index) => settled.push(index), isDeadlineError: () => false, extract: async batch => { if (batch[0].id === 'later') seenBeforeLater = [...settled]; active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, batch[0].id === 'slow' ? 20 : 1)); active -= 1; return [batch[0].id]; } });
  assert.equal(peak, 2);
  assert.deepEqual(values, ['slow', 'fast', 'later']);
  assert.deepEqual(seenBeforeLater, [0, 1]);
  assert.deepEqual(settled, [0, 1, 2]);
});

test('does not overlap evidence batches that share a candidate and bounds their deadlines', async () => {
  let active = 0; let peak = 0; const deadlines: number[] = []; const hardDeadlineAt = Date.now() + 5000;
  await collectCapabilityCatalogEvidenceBatches({ facts: [{ candidateIds: ['same'] }, { candidateIds: ['same'] }], evidenceScoped: true, hardDeadlineAt, batchBudgetMs: 100, concurrency: 2, conflictKeys: fact => fact.candidateIds, isDeadlineError: () => false, extract: async (_batch, deadlineAt) => { active += 1; peak = Math.max(peak, active); deadlines.push(deadlineAt || 0); await new Promise(resolve => setTimeout(resolve, 2)); active -= 1; return []; } });
  assert.equal(peak, 1);
  assert.equal(deadlines.every(deadline => deadline <= hardDeadlineAt && deadline > 0), true);
});


test('recognizes analysis verb variants as the same product outcome without merging other actions', () => {
  assert.equal(capabilityTitlesShareOutcome(
    { name: 'Analyze codebase' } as SystemCapability,
    { name: 'Run codebase analysis' } as SystemCapability,
  ), true);
  assert.equal(capabilityTitlesShareOutcome(
    { name: 'Sync financial accounts from Plaid' } as SystemCapability,
    { name: 'Synchronize financial accounts via Plaid' } as SystemCapability,
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
  assert.equal(capabilityIdentityPendingDescriptionRepair(capability, 'generated-label-prefix'), undefined);
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

test('collapsed catalog repair schedules one representative for each uncovered semantic family', () => {
  const familyGroups = [
    ['jobs-create', 'jobs-create-route'],
    ['jobs-category', 'jobs-category-route'],
    ['jobs-notes'],
    ['jobs-search', 'jobs-search-route'],
  ];
  const capability = (id: string) => ({
    id: `authored-${id}`,
    criticality_factors: [`catalog-candidate:${id}`],
  }) as SystemCapability;

  assert.deepEqual(
    uncoveredCapabilityCatalogFamilyRepresentativeIds([capability('jobs-create-route')], familyGroups),
    ['jobs-category', 'jobs-notes', 'jobs-search'],
  );
  assert.deepEqual(
    uncoveredCapabilityCatalogFamilyRepresentativeIds(
      [capability('jobs-create-route')],
      familyGroups,
      new Set(['jobs-category', 'jobs-notes']),
    ),
    ['jobs-search'],
  );
  assert.deepEqual(
    capabilityCatalogRepairCandidateIds([capability('jobs-create-route')], [], [], new Set(), familyGroups),
    ['jobs-category', 'jobs-notes', 'jobs-search'],
  );
});

test('entity grouping does not let a broad multi-entity page conflate a distinct product family regardless of order', () => {
  const jobs = catalogCapability({
    id: 'cap_jobs_management', name: 'read jobs', structural_label: 'read job',
    evidence_kind: 'entity', evidence_role: 'product-outcome', related_entities: ['entity_job', 'entity_note'],
    operations: [{
      entry_point_id: 'jobs-route', entry_point_type: 'route', action: 'read',
      trigger: { method: 'GET', path: '/jobs' },
    }],
  });
  const notes = catalogCapability({
    id: 'cap_note_management', name: 'read and create and delete notes', structural_label: 'note lifecycle',
    evidence_kind: 'entity', evidence_role: 'product-outcome', related_entities: ['entity_note'],
    operations: [
      { entry_point_id: 'notes-read', entry_point_type: 'http', action: 'read', trigger: { method: 'POST', path: '/note/notes/:userId' } },
      { entry_point_id: 'notes-create', entry_point_type: 'http', action: 'create', trigger: { method: 'POST', path: '/note/add-note/:userId' } },
      { entry_point_id: 'notes-delete', entry_point_type: 'http', action: 'delete', trigger: { method: 'POST', path: '/note/delete-note/:userId' } },
    ],
  });
  const expected = [['cap_jobs_management'], ['cap_note_management']];

  assert.deepEqual(catalogEntityCandidateGroups([jobs, notes]), expected);
  assert.deepEqual(catalogEntityCandidateGroups([notes, jobs]), expected);
});

test('operation-complete aggregate coverage closes an entity family without laundering a citation', () => {
  const group = [['cap_jobs_management', 'cap_note_management']];
  assert.deepEqual(
    uncoveredCapabilityCatalogCandidateIds([], [], group, new Set(['cap_note_management'])),
    [],
  );
  assert.deepEqual(
    uncoveredCapabilityCatalogCandidateIds([], [], group),
    ['cap_jobs_management', 'cap_note_management'],
  );
  assert.deepEqual(
    capabilityCatalogRepairCandidateIds([], [], group, new Set(), [], new Set(['cap_note_management'])),
    [],
  );
});

test('operation-level obligations remain scheduled when the candidate is already cited', () => {
  const cited = {
    id: 'authored-jobs',
    criticality_factors: ['catalog-candidate:jobs'],
  } as SystemCapability;

  assert.deepEqual(
    capabilityCatalogRepairCandidateIds([cited], ['jobs'], [], new Set()),
    ['jobs'],
  );

  const progress = trackCapabilityCatalogRepair(1, ['jobs'], []);
  assert.equal(progress.observe([cited], [], [], ['jobs']).uncoveredCount, 1);
  assert.equal(progress.observe([cited], [], [], []).uncoveredCount, 0);
});

test('semantic family coverage counts progress when any grouped candidate is cited', () => {
  const familyGroups = [['create', 'create-route'], ['category', 'category-route'], ['notes']];
  const capability = (id: string) => ({
    id: `authored-${id}`,
    criticality_factors: [`catalog-candidate:${id}`],
  }) as SystemCapability;
  const progress = trackCapabilityCatalogRepair(3, [], [], [], familyGroups);

  const first = progress.observe([capability('create-route')]);
  const second = progress.observe([capability('create-route'), capability('category-route')]);

  assert.equal(first.noProgressCycles, 0);
  assert.equal(first.uncoveredCount, 2);
  assert.equal(second.noProgressCycles, 0);
  assert.equal(second.uncoveredCount, 1);
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


test('rejects wrong-action operation obligations before merge and preserves candidate feedback', () => {
  const evidence = (id: string, action: string) => ({
    ...catalogCapability({ id, related_entities: ['entity_record'] }),
    name: action + ' record',
    operations: [{ entry_point_id: id + '-entry', entry_point_type: 'http', action }],
  }) as SystemCapability;
  const read = evidence('operation-obligation:parent:read', 'read');
  const create = evidence('operation-obligation:parent:create', 'create');
  const authored = (name: string, evidenceCandidate: SystemCapability, citations = [evidenceCandidate.id]) => ({
    ...catalogCapability({ id: name.toLowerCase().replace(/ /g, '-'), related_entities: ['entity_record'] }),
    name,
    operations: evidenceCandidate.operations,
    criticality_factors: citations.map(id => 'catalog-candidate:' + id),
  }) as SystemCapability;
  const feedback: Array<{ candidateIds: string[]; name: string; reason: string }> = [];
  const accepted = filterMismatchedOperationObligationCapabilities({
    capabilities: [
      authored('Categorize records', read),
      authored('Categorize records', create),
      authored('View records', read),
      authored('Create records', create),
      authored('View records', read, [read.id, 'broad-records']),
    ],
    evidenceCandidates: [read, create],
    recordRejection: rejection => feedback.push(rejection),
  });
  assert.deepEqual(accepted.map(item => item.name), ['View records', 'Create records', 'View records']);
  assert.deepEqual(feedback.map(item => item.reason), [
    'required-observable-action-missing:view',
    'required-observable-action-missing:create',
  ]);
  assert.deepEqual(feedback.map(item => item.candidateIds), [[read.id], [create.id]]);
  assert.deepEqual(accepted[2].criticality_factors, [
    'catalog-candidate:' + read.id,
    'catalog-operation-obligation:' + read.id,
  ]);
});

test('retains read provenance when audience language says information is displayed or surfaced', () => {
  const readNotes = catalogCapability({
    id: 'operation-obligation:note:read',
    name: 'read note',
    structural_label: 'read note',
    related_entities: ['entity_note'],
    operations: [{ entry_point_id: 'read-note', entry_point_type: 'http', action: 'read' }],
  });
  for (const verb of ['displays', 'surfaces']) {
    const capability = catalogCapability({
      id: verb, name: 'Attach notes to job applications',
      description: `Job applications ${verb} a note count when users add notes.`,
      criticality_factors: ['catalog-candidate:' + readNotes.id],
    });
    assert.equal(filterMismatchedOperationObligationCapabilities({ capabilities: [capability], evidenceCandidates: [readNotes] }).length, 1);
  }
});

test('validates multi-obligation citations independently and retains only exact compatible provenance', () => {
  const evidence = (id: string, label: string, action: string, entries: string[], entity: string) => catalogCapability({
    id,
    name: label,
    structural_label: label,
    related_entities: [entity],
    operations: entries.map(entry_point_id => ({ entry_point_id, entry_point_type: 'event', action })),
  });
  const readCategories = evidence('operation-obligation:category:read', 'read category', 'read', ['read-category-a', 'read-category-b'], 'entity_category');
  const deleteCategories = evidence('operation-obligation:category:delete', 'delete category', 'delete', ['delete-category'], 'entity_category');
  const createNotes = evidence('operation-obligation:note:create', 'create note', 'create', ['create-note'], 'entity_note');
  const feedback: Array<{ candidateIds: string[]; name: string; reason: string }> = [];
  const authored = catalogCapability({
    id: 'manage-categories',
    name: 'Manage categories',
    description: 'Users can view and delete categories while keeping each category organized for their application workflow.',
    related_entities: ['entity_category', 'entity_note', 'forged_entity'],
    operations: [
      ...readCategories.operations,
      ...deleteCategories.operations,
      ...createNotes.operations,
      { entry_point_id: 'forged-operation', entry_point_type: 'event', action: 'delete' },
    ],
    criticality_factors: [
      'catalog-candidate:' + readCategories.id,
      'catalog-candidate:' + deleteCategories.id,
      'catalog-candidate:' + createNotes.id,
      'catalog-candidate:foreign-family',
      'catalog-operation-obligation:forged-obligation',
    ],
  });
  const [accepted] = filterMismatchedOperationObligationCapabilities({

    capabilities: [authored],
    evidenceCandidates: [readCategories, deleteCategories, createNotes],
    recordRejection: rejection => feedback.push(rejection),
  });

  assert.ok(accepted);
  assert.deepEqual(accepted.operations.map(operation => operation.entry_point_id).sort(), [
    'delete-category', 'read-category-a', 'read-category-b',
  ]);
  assert.deepEqual(accepted.related_entities, ['entity_category']);
  assert.deepEqual(accepted.criticality_factors, [
    'catalog-candidate:' + readCategories.id,
    'catalog-operation-obligation:' + readCategories.id,
    'catalog-candidate:' + deleteCategories.id,
    'catalog-operation-obligation:' + deleteCategories.id,
  ]);
  assert.deepEqual(feedback, [{
    candidateIds: [createNotes.id],
    name: 'Manage categories',
    reason: 'required-observable-subject-missing:create,note',
  }]);

  const subjectFeedback: typeof feedback = [];
  assert.deepEqual(filterMismatchedOperationObligationCapabilities({
    capabilities: [catalogCapability({
      id: 'wrong-subject',
      name: 'View notes',
      description: 'Users view notes while reviewing application details and saved note history.',
      criticality_factors: ['catalog-candidate:' + readCategories.id],
    })],
    evidenceCandidates: [readCategories],
    recordRejection: rejection => subjectFeedback.push(rejection),
  }), []);
  assert.deepEqual(subjectFeedback, [{
    candidateIds: [readCategories.id],
    name: 'View notes',
    reason: 'required-observable-subject-missing:category',
  }]);
});

test('retains grouped operation facts while a rejected description is awaiting audience repair', () => {
  const evidence = (id: string, action: string) => catalogCapability({
    id: `operation-obligation:transactions:${id}`,
    name: `${action} transaction`,
    structural_label: `${action} transaction`,
    related_entities: ['entity_transaction'],
    operations: [{ entry_point_id: `${id}-transaction`, entry_point_type: 'http', action }],
  });
  const create = evidence('create', 'create');
  const read = evidence('read', 'read');
  const remove = evidence('remove', 'delete');
  const capability = catalogCapability({
    id: 'track-transactions',
    name: 'Track transactions',
    description: '',
    related_entities: ['entity_transaction'],
    criticality_factors: [create, read, remove].map(candidate => 'catalog-candidate:' + candidate.id),
  });

  const accepted = filterMismatchedOperationObligationCapabilities({
    capabilities: [capability],
    evidenceCandidates: [create, read, remove],
    actionEvidenceDescriptionFor: () =>
      'Users see the creation, update, and deletion of transactions throughout their lifecycle.',
  });

  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].operations.map(operation => operation.entry_point_id).sort(), [
    'create-transaction', 'read-transaction', 'remove-transaction',
  ]);

  const feedback: Array<{ candidateIds: string[]; name: string; reason: string }> = [];
  const [partiallyAccepted] = filterMismatchedOperationObligationCapabilities({
    capabilities: [capability],
    evidenceCandidates: [create, read, remove],
    actionEvidenceDescriptionFor: () => 'Users see transaction creation throughout their lifecycle.',
    recordRejection: rejection => feedback.push(rejection),
  });
  assert.deepEqual(partiallyAccepted.operations.map(operation => operation.entry_point_id).sort(), [
    'create-transaction', 'read-transaction',
  ]);
  assert.deepEqual(feedback, [{
    candidateIds: [remove.id],
    name: 'Track transactions',
    reason: 'required-observable-action-missing:remove',
  }]);
});

test('an unambiguous exact action mismatch recovers after one authored attempt', () => {
  const candidate = catalogCapability({
    id: 'operation-obligation:notes:delete', name: 'delete note', structural_label: 'delete note',
    related_entities: ['entity_note'],
    operations: [{ entry_point_id: 'delete-note', entry_point_type: 'event', action: 'delete' }],
  });
  const invalid = catalogCapability({
    id: 'shared-generated-id', name: 'Edit notes',
    criticality_factors: ['catalog-candidate:operation-obligation:notes:delete'],
  });
  const recovered = { ...invalid, name: 'Remove notes', name_source: 'deterministic' as const };
  const attempts = new Map<string, number>();
  let recoveryCalls = 0;
  const run = () => filterMismatchedOperationObligationCapabilities({
    capabilities: [invalid], evidenceCandidates: [candidate],
    actionMismatchAttemptsByCandidateId: attempts,
    recoverActionMismatch: () => { recoveryCalls++; return recovered; },
  });
  const [acceptedRecovery] = run();
  assert.equal(acceptedRecovery.name, 'Remove notes');
  assert.deepEqual(acceptedRecovery.operations, candidate.operations);
  assert.deepEqual(acceptedRecovery.related_entities, ['entity_note']);
  assert.ok(acceptedRecovery.criticality_factors?.includes('catalog-operation-obligation:' + candidate.id));
  assert.equal(recoveryCalls, 1);
  assert.equal(attempts.get(candidate.id), 1);

  const accepted = filterMismatchedOperationObligationCapabilities({
    capabilities: [{ ...invalid, name: 'Remove notes' }], evidenceCandidates: [candidate],
    actionMismatchAttemptsByCandidateId: attempts,
    recoverActionMismatch: () => { throw new Error('valid exact action must not use fallback'); },
  });
  assert.equal(accepted.length, 1);
});

test('an ambiguous exact action mismatch remains fail closed across two authored attempts', () => {
  const candidate = catalogCapability({
    id: 'operation-obligation:records:create', name: 'create record', structural_label: 'create record',
    operations: [{ entry_point_id: 'create-record', entry_point_type: 'event', action: 'create' }],
  });
  const invalid = catalogCapability({
    id: 'generated', name: 'Categorize records',
    criticality_factors: [`catalog-candidate:${candidate.id}`],
  });
  const attempts = new Map<string, number>();
  let recoveryCalls = 0;
  const run = () => filterMismatchedOperationObligationCapabilities({
    capabilities: [invalid], evidenceCandidates: [candidate], actionMismatchAttemptsByCandidateId: attempts,
    recoverActionMismatch: () => { recoveryCalls++; return undefined; },
  });
  assert.deepEqual(run(), []);
  assert.deepEqual(run(), []);
  assert.equal(recoveryCalls, 2);
  assert.equal(attempts.get(candidate.id), 2);
});

test('counts duplicate exact-action mismatches once per repair batch', () => {
  const candidate = catalogCapability({
    id: 'operation-obligation:records:read', name: 'read record', structural_label: 'read record',
    related_entities: ['entity_record'],
    operations: [{ entry_point_id: 'read-record', entry_point_type: 'http', action: 'read' }],
  });
  const invalid = catalogCapability({
    id: 'generated', name: 'Categorize records',
    criticality_factors: ['catalog-candidate:operation-obligation:records:read'],
  });
  const attempts = new Map<string, number>();
  let recoveryCalls = 0;
  const first = filterMismatchedOperationObligationCapabilities({
    capabilities: [invalid, { ...invalid }], evidenceCandidates: [candidate],
    actionMismatchAttemptsByCandidateId: attempts,
    recoverActionMismatch: () => { recoveryCalls++; return { ...invalid, name: 'View records' }; },
  });
  assert.deepEqual(first.map(item => item.name), ['View records']);
  assert.equal(attempts.get(candidate.id), 1);
  assert.equal(recoveryCalls, 1);
});

test('grounds short singular evidence subjects after deterministic title pluralization', () => {
  const expected = { create: 'Create jobs', update: 'Update jobs', delete: 'Remove jobs' } as const;
  for (const action of Object.keys(expected) as Array<keyof typeof expected>) {
    const candidate = catalogCapability({
      id: `operation-obligation:job:${action}`,
      name: `${action} job`,
      structural_label: `${action} job`,
      evidence_kind: 'behavior-surface',
      evidence_role: 'product-outcome',
      related_entities: ['entity_job'],
      operations: [{ entry_point_id: `job-${action}`, entry_point_type: 'event', action }],
    });
    const [result] = validatedDeterministicAtomicClosures({
      candidateIds: [candidate.id], evidenceCandidates: [candidate],
      audienceFor: () => 'Users', entityLabelsFor: () => ['Job'],
      validate: capability => Boolean(capability.description),
    });
    assert.equal(result?.name, expected[action]);
    assert.equal(result?.description, `Users can ${expected[action].toLowerCase()} as part of their normal workflow whenever needed.`);
  }
});

test('retains a typed interactive fetch repair independently of catalog order and companion outputs', () => {
  const candidate = catalogCapability({
    id: 'operation-obligation:job:fetch-details',
    name: 'Fetch job details',
    structural_label: 'Fetch job details',
    evidence_kind: 'behavior-surface',
    evidence_role: 'product-outcome',
    related_entities: ['entity_job'],
    operations: [{
      entry_point_id: 'add-job-fetch-click',
      entry_point_type: 'event',
      action: 'read',
      path_or_command: '/fetch-job',
    }],
  });
  const mismatched = catalogCapability({
    id: 'capability_view_job_details',
    name: 'View job details',
    description: 'Users view job details and status while reviewing an application before making changes.',
    related_entities: ['entity_job'],
    operations: candidate.operations,
    criticality_factors: [`catalog-candidate:${candidate.id}`],
  });
  const companion = catalogCapability({
    id: 'capability_delete_notes',
    name: 'Delete notes',
    description: 'Users delete notes from job applications when the notes are no longer needed.',
  });
  const run = (capabilities: SystemCapability[]) => filterMismatchedOperationObligationCapabilities({
    capabilities,
    evidenceCandidates: [candidate],
    recoverActionMismatch: (capability, evidence) => deterministicCapabilityActionIdentityFallback({
      capability,
      candidate: evidence,
      audience: 'Users',
      relatedEntityLabels: ['Job'],
      validate: recovered => recovered.name === 'Fetch job details'
        && /Users/.test(recovered.description || '')
        && recovered.operations?.length === 1,
    }),
  }).filter(capability => capability.criticality_factors?.includes(`catalog-candidate:${candidate.id}`));

  for (const capabilities of [[mismatched], [companion, mismatched], [mismatched, companion]]) {
    const retained = run(capabilities);
    assert.equal(retained.length, 1);
    assert.equal(retained[0].name, 'Fetch job details');
    assert.deepEqual(retained[0].operations, candidate.operations);
    assert.deepEqual(retained[0].criticality_factors, [
      `catalog-candidate:${candidate.id}`,
      `catalog-operation-obligation:${candidate.id}`,
    ]);
  }
});

test('promotes exact pending evidence by candidate lifecycle when reconciliation regenerates its id', () => {
  const candidateId = 'operation-obligation:categories:read';
  const operation = { entry_point_id: 'categories-read', entry_point_type: 'http', action: 'read' };
  const candidate = catalogCapability({ id: candidateId, name: 'read category', structural_label: 'read category', evidence_kind: 'behavior-surface', evidence_role: 'product-outcome', related_entities: ['entity_category'], operations: [operation] });
  const pending = catalogCapability({ id: 'stable-category-read', name: 'View categories', description: '', name_source: 'deterministic', related_entities: ['entity_category'], operations: [operation], criticality_factors: [`catalog-candidate:${candidateId}`, `catalog-operation-obligation:${candidateId}`] });
  const replacement = catalogCapability({ ...pending, id: 'regenerated-view-categories', description: 'Users view categories associated with their job applications before organizing the current list.', description_source: 'deterministic', description_generation: { status: 'deterministic_kept', attempted: true, reason: 'grounded-cited-lifecycle' } });
  const companion = catalogCapability({ id: 'companion', name: 'Create categories' });

  for (const cycleCapabilities of [[replacement, companion], [companion, replacement]]) {
    const registry = new Map([[candidateId, { audience: 'Users', candidateId, evidenceDigest: 'digest', familyKey: `operation:${candidateId}`, fallbackAttempted: true, identity: pending }]]);
    const promoted = new Map<string, SystemCapability>();
    stagePendingCapabilityEvidenceRepairs({
      cycleCapabilities, reconciled: [], registry, evidenceCandidates: [candidate], evidenceRepairCandidateIds: new Set([candidateId]),
      requiredUncoveredCandidateIds: new Set([candidateId]), exactOperationCandidateIds: new Set([candidateId]), familyKeyByCandidateId: new Map(),
      descriptionFailureByCapabilityId: new Map(), isPublishable: capability => Boolean(capability.description), audienceFor: () => 'Users',
      promotedCapabilitiesByCandidateId: promoted,
    });
    assert.equal(registry.size, 0);
    assert.equal(promoted.get(candidateId)?.id, pending.id);
    assert.equal(promoted.get(candidateId)?.name, pending.name);
    assert.equal(promoted.get(candidateId)?.description, replacement.description);
  }
});

test('requires every independently grounded product-evidence family without imposing an arbitrary catalog count', () => {
  const capability = catalogCapability({
    id: 'review-invoices',
    name: 'Review invoices',
    description: 'Accountants review issued invoices before completing monthly financial reconciliation.',
    name_source: 'ai',
    description_source: 'ai',
    related_entities: ['entity_invoice'],
    operations: [{ entry_point_id: 'invoice-list', entry_point_type: 'http', action: 'read' }],
    criticality_factors: ['catalog-candidate:invoices'],
  });
  const quality = (requiredOutcomes: CapabilityCatalogOutcomeRequirement[]) => capabilityCatalogCycleQualityFailure({
    reconciled: [capability],
    distinctFamilyCount: 4,
    requiredBehaviorCandidateIds: ['uncited-behavior'],
    requiredEntityCandidateGroups: [['uncited-entity']],
    requiredOutcomes,
    candidateFamilyGroups: [['uncited-family']],
    isBareNoun: () => false,
    isStructuralPlaceholder: () => false,
  });

  assert.match(quality([]) || '', /omits 1 grounded product-evidence family: uncited-family/);
  assert.match(quality([{
    id: 'all:capture-note',
    statement: 'Capture notes',
    candidateIds: ['notes'],
    subjectTokens: ['note'],
    requiredSubjectTerms: ['note'],
    visibleActionTerms: ['capture'],
  }]) || '', /first-party product outcome/);
});

test('accepts only exact grounded deterministic recoveries after bad provider wording', () => {
  const candidateId = 'operation-obligation:categories:read';
  const recovered = catalogCapability({
    id: 'stable-category-read', name: 'View categories', description: 'Users view categories associated with their job applications before organizing the current list.',
    name_source: 'deterministic', description_source: 'deterministic', description_generation: { status: 'deterministic_kept', attempted: true, reason: 'grounded-cited-lifecycle' },
    operations: [{ entry_point_id: 'categories-read', entry_point_type: 'http', action: 'read' }], related_entities: ['entity_category'],
    criticality_factors: [`catalog-candidate:${candidateId}`, `catalog-operation-obligation:${candidateId}`],
  });
  const quality = (capability: SystemCapability) => capabilityCatalogCycleQualityFailure({
    reconciled: [capability], distinctFamilyCount: 0, requiredBehaviorCandidateIds: [], requiredEntityCandidateGroups: [], requiredOutcomes: [], candidateFamilyGroups: [],
    isBareNoun: () => false, isStructuralPlaceholder: () => false,
  });
  assert.equal(quality(recovered), undefined);
  assert.match(quality({ ...recovered, criticality_factors: [`catalog-candidate:${candidateId}`] }) || '', /deterministic recovery/);
  assert.match(quality({ ...recovered, criticality_factors: ['catalog-candidate:cap_categories', 'catalog-operation-obligation:cap_categories'] }) || '', /deterministic recovery/);
});

test('generic grouped lifecycle names remain pending even with exact deterministic grounding', () => {
  const grouped = catalogCapability({
    id: 'category-lifecycle', name: 'Manage categories',
    name_source: 'deterministic', description_source: 'deterministic',
    description: 'Users can create, view, update, and remove categories whenever needed.',
    description_generation: { status: 'deterministic_kept', attempted: true, reason: 'grounded-cited-lifecycle' },
    operations: [
      { entry_point_id: 'create-category', entry_point_type: 'http', action: 'create' },
      { entry_point_id: 'view-category', entry_point_type: 'http', action: 'read' },
      { entry_point_id: 'update-category', entry_point_type: 'http', action: 'update' },
      { entry_point_id: 'remove-category', entry_point_type: 'http', action: 'delete' },
    ],
    criticality_factors: ['catalog-candidate:cap_categories', 'catalog-deterministic-atomic-closure', 'catalog-deterministic-grouped-lifecycle'],
  });
  const quality = capabilityCatalogCycleQualityFailure({
    reconciled: [grouped], distinctFamilyCount: 0, requiredBehaviorCandidateIds: [], requiredEntityCandidateGroups: [], requiredOutcomes: [], candidateFamilyGroups: [],
    isBareNoun: () => false, isStructuralPlaceholder: () => false,
  });
  assert.match(quality || '', /deterministic recovery/);
});

test('a non-generic grouped lifecycle can retain multiple exact candidate identities', () => {
  const grouped = catalogCapability({
    id: 'category-lifecycle', name: 'Maintain categories',
    name_source: 'deterministic', description_source: 'deterministic',
    description: 'Users can create, view, update, and remove categories whenever needed.',
    description_generation: { status: 'deterministic_kept', attempted: true, reason: 'grounded-cited-lifecycle' },
    operations: [
      { entry_point_id: 'categories-index', entry_point_type: 'http', action: 'read' },
      { entry_point_id: 'category-dropdown', entry_point_type: 'http', action: 'read' },
    ],
    criticality_factors: ['catalog-candidate:cap_categories', 'catalog-candidate:cap_category', 'catalog-deterministic-atomic-closure', 'catalog-deterministic-grouped-lifecycle'],
  });
  const quality = capabilityCatalogCycleQualityFailure({
    reconciled: [grouped], distinctFamilyCount: 0, requiredBehaviorCandidateIds: [], requiredEntityCandidateGroups: [], requiredOutcomes: [], candidateFamilyGroups: [],
    isBareNoun: () => false, isStructuralPlaceholder: () => false,
  });
  assert.equal(quality, undefined);
});

test('closes grounded atomic obligations deterministically in stable order with exact provenance', () => {
  const cases = [
    ['read', 'category', 'View categories'],
    ['create', 'note', 'Create notes'],
    ['update', 'category', 'Update categories'],
    ['delete', 'category', 'Remove categories'],
    ['filter', 'job site', 'Filter job sites'],
  ] as const;
  const candidates: SystemCapability[] = cases.map(([action, subject], index) => catalogCapability({
    id: index === cases.length - 1 ? 'jobsites' : `operation-obligation:atomic:${action}`,
    name: `${action} ${subject}`, structural_label: `${action} ${subject}`,
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    related_entities: subject === 'job site' ? ['entity_job', 'entity_user'] : [`entity_${subject}`],
    operations: [{ entry_point_id: `entry-${action}`, entry_point_type: 'event', action }],
  }));
  candidates.push(catalogCapability({
    id: 'operation-obligation:atomic:fetch', name: 'read job detail', structural_label: 'Fetch job detail',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome', related_entities: ['entity_job'],
    operations: [{ entry_point_id: 'entry-fetch', entry_point_type: 'event', action: 'read' }],
  }));
  const validate = (value: SystemCapability) => Boolean(value.description?.startsWith('Users can ')) && value.operations.length > 0;
  const run = (candidateIds: string[]) => validatedDeterministicAtomicClosures({
    candidateIds, evidenceCandidates: candidates, audienceFor: () => 'Users',
    entityLabelsFor: candidate => candidate.related_entities.map(id => id.replace('entity_', '')), validate,
  });
  const first = run(candidates.map(candidate => candidate.id).reverse());
  const second = run(candidates.map(candidate => candidate.id));
  assert.deepEqual(first.map(item => item.id), second.map(item => item.id));
  assert.deepEqual(new Set(first.map(item => item.name)), new Set([...cases.map(item => item[2]), 'Fetch job details']));
  for (const item of first) {
    const candidateId = item.criticality_factors.find(factor => factor.startsWith('catalog-candidate:'))!.slice('catalog-candidate:'.length);
    const candidate = candidates.find(value => value.id === candidateId)!;
    assert.deepEqual(item.operations, candidate.operations);
    assert.equal(item.criticality_factors.filter(factor => factor.startsWith('catalog-candidate:')).length, 1);
    if (candidateId.startsWith('operation-obligation:')) assert.ok(item.criticality_factors.includes(`catalog-operation-obligation:${candidateId}`));
  }
});

test('atomic closure abstains on ambiguous subjects, unknown actions, or failed validation', () => {
  const ambiguous = catalogCapability({ id: 'ambiguous', name: 'Records', evidence_kind: 'entity', related_entities: ['entity_job', 'entity_note'], operations: [{ entry_point_id: 'read', entry_point_type: 'http', action: 'read' }] });
  const unknown = catalogCapability({ id: 'unknown', name: 'handle category', structural_label: 'handle category', evidence_kind: 'behavior-surface', operations: [{ entry_point_id: 'unknown', entry_point_type: 'event', action: 'process' }] });
  const args = { candidateIds: [ambiguous.id, unknown.id], evidenceCandidates: [ambiguous, unknown], audienceFor: () => 'Users', entityLabelsFor: (candidate: SystemCapability) => candidate.related_entities, validate: () => true };
  assert.deepEqual(validatedDeterministicAtomicClosures(args), []);
  const grounded = catalogCapability({ id: 'operation-obligation:read', name: 'read category', structural_label: 'read category', evidence_kind: 'behavior-surface', operations: [{ entry_point_id: 'read', entry_point_type: 'http', action: 'read' }] });
  assert.deepEqual(validatedDeterministicAtomicClosures({ ...args, candidateIds: [grounded.id], evidenceCandidates: [grounded], validate: () => false }), []);
});

test('grounds empty-entity atomic subjects only through exact terminal or interactive lineage', () => {
  const terminal = catalogCapability({
    id: 'operation-obligation:category:update-terminal', name: 'update category', structural_label: 'update category',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome', related_entities: [],
    operations: [{ entry_point_id: 'update-route', entry_point_type: 'http', action: 'update', trigger: { method: 'POST', path: '/category/edit' } }],
  });
  const interactive = (action: 'update' | 'delete') => catalogCapability({
    id: 'operation-obligation:category:' + action + '-interactive', name: action + ' category', structural_label: action + ' category',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome', related_entities: [],
    operations: [{ entry_point_id: action + '-click', entry_point_type: 'event', action }],
  });
  const update = interactive('update');
  const remove = interactive('delete');
  const entries = [update, remove].map(candidate => {
    const action = candidate.operations[0].action;
    const id = candidate.operations[0].entry_point_id;
    const bindingId = action + '-handler';
    return {
      id, type: 'event', name: 'Category ' + action, source_analyzer: 'react',
      handler: { file: 'Categories.tsx' },
      metadata: {
        source_analyzer: 'react', handler_file: 'Categories.tsx', handler_binding_node_ids: [bindingId],
        handler_component_id: 'categories', callback_origin_component_id: 'sidebar',
        callback_component_path: ['categories', 'sidebar'],
        handler_references: [{ name: 'handleCategory' + action, binding_node_id: bindingId, binding_origin_component_id: 'sidebar' }],
      },
    };
  });
  const context = {
    entryPoints: entries,
    nodes: [
      { id: 'categories', name: 'Categories', type: 'functional_component', source: { file: 'Categories.tsx', line: 1 }, metadata: {} },
      { id: 'sidebar', name: 'SideBar', type: 'functional_component', source: { file: 'SideBar.tsx', line: 1 }, metadata: {} },
      ...entries.map(entry => ({
      id: entry.metadata.handler_binding_node_ids[0], name: 'handleCategory' + (entry.id.startsWith('delete') ? 'Delete' : 'Update'),
      type: 'function', source: { file: 'SideBar.tsx', line: 10 }, metadata: {},
    }))],
    edges: [
      { id: 'renders', source: 'sidebar', target: 'categories', type: 'renders' },
      ...entries.map(entry => ({ id: 'trigger-' + entry.id, source: entry.id, target: entry.metadata.handler_binding_node_ids[0], type: 'triggers' })),
    ],
    exitPoints: [],
  } as any;
  const candidates = [terminal, update, remove];
  const results = validatedDeterministicAtomicClosures({
    candidateIds: candidates.map(candidate => candidate.id), evidenceCandidates: candidates,
    audienceFor: () => 'Users', entityLabelsFor: () => [], operationCoverageContext: context,
    validate: capability => Boolean(capability.description),
  });
  assert.deepEqual(new Set(results.map(result => result.name)), new Set(['Update categories', 'Remove categories']));
  assert.ok(results.every(result => result.operations.length === 1));
});

test('closes an opted-in authoritative multi-action entity lifecycle from one exact shared route subject', () => {
  const candidate = catalogCapability({
    id: 'cap_identity_providers', name: 'Identity provider management',
    evidence_kind: 'entity', evidence_role: 'product-outcome', related_entities: ['entity_identity_provider'],
    operations: [
      { entry_point_id: 'identity-create', entry_point_type: 'http', action: 'create', trigger: { method: 'POST', path: '/api/v1/identity-providers' } },
      { entry_point_id: 'identity-read', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/api/v1/identity-providers/:id' } },
      { entry_point_id: 'identity-update', entry_point_type: 'http', action: 'update', trigger: { method: 'PATCH', path: '/api/v1/identity-providers/:id' } },
      { entry_point_id: 'identity-delete', entry_point_type: 'http', action: 'delete', trigger: { method: 'DELETE', path: '/api/v1/identity-providers/:id' } },
    ],
  });
  const context = { entryPoints: [], nodes: [], edges: [], exitPoints: [] } as any;
  const run = (completeLifecycleCandidateIds?: ReadonlySet<string>) => validatedDeterministicAtomicClosures({
    candidateIds: [candidate.id], evidenceCandidates: [candidate], audienceFor: () => 'Users',
    entityLabelsFor: () => ['IdentityProvider'], operationCoverageContext: context,
    completeLifecycleCandidateIds, validate: capability => Boolean(capability.description) &&
      capabilityDescriptionProductLanguageViolation(
        capability.description || '', ['IdentityProvider'],
        capability.operations.map(operation => JSON.stringify([operation.action, operation.path_or_command || operation.trigger?.path || ''])),
      ) === undefined,
  });
  assert.deepEqual(run(), []);
  const [closure] = run(new Set([candidate.id]));
  assert.equal(closure?.name, 'Manage identity providers');
  assert.equal(closure?.description, 'Users can manage identity providers so their recorded details remain current and available over time.');
  assert.deepEqual(closure?.operations, candidate.operations);
  assert.ok(closure?.criticality_factors.includes('catalog-deterministic-grouped-lifecycle'));
});

test('an atomic entity-free lifecycle abstains when its only identity is generic management wording', () => {
  const candidate = catalogCapability({
    id: 'cap_auth_management', name: 'Authentication', structural_label: 'Authentication',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome', related_entities: [],
    evidence_role_reasons: ['user-facing-terminal-journey'],
    operations: [
      { entry_point_id: 'login', entry_point_type: 'http', action: 'authenticate', trigger: { method: 'POST', path: '/api/v1/auth/login' }, path_or_command: '/api/v1/auth/login' },
      { entry_point_id: 'refresh', entry_point_type: 'http', action: 'authenticate', trigger: { method: 'POST', path: '/api/v1/auth/refresh' }, path_or_command: '/api/v1/auth/refresh' },
      { entry_point_id: 'signup', entry_point_type: 'http', action: 'create', trigger: { method: 'POST', path: '/api/v1/auth/signup' }, path_or_command: '/api/v1/auth/signup' },
    ],
  });
  const closures = validatedDeterministicAtomicClosures({
    candidateIds: [candidate.id], evidenceCandidates: [candidate], audienceFor: () => 'Users',
    entityLabelsFor: () => [], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    completeLifecycleCandidateIds: new Set([candidate.id]), validate: () => true,
  });
  assert.deepEqual(closures, []);
});

test('uses an exact controller namespace when a shared route subject is also an action word', () => {
  const candidate = catalogCapability({
    id: 'cap_import_upload_management', name: 'Import Upload', structural_label: 'Import Upload Management',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome', related_entities: [],
    related_domains: ['import-upload'], evidence_role_reasons: ['user-facing-terminal-journey'],
    operations: [
      { entry_point_id: 'upload-view', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/upload' }, path_or_command: '/upload' },
      { entry_point_id: 'upload-update', entry_point_type: 'http', action: 'update', trigger: { method: 'PATCH', path: '/upload' }, path_or_command: '/upload' },
    ],
  });
  const [closure] = validatedDeterministicAtomicClosures({
    candidateIds: [candidate.id], evidenceCandidates: [candidate], audienceFor: () => 'Users',
    entityLabelsFor: () => [], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    completeLifecycleCandidateIds: new Set([candidate.id]), validate: () => true,
  });
  assert.equal(closure?.name, 'Manage uploads');
  assert.equal(closure?.description, 'Users can manage uploads so their recorded details remain current and available over time.');
  assert.equal(closure?.operations.length, 2);
});

test('groups a lifecycle across a resource route and its nested category route by their shared subject', () => {
  const candidate = catalogCapability({
    id: 'cap_budgets_management', name: 'Budgets', structural_label: 'Budgets Management',
    evidence_kind: 'entity', evidence_role: 'product-outcome', related_entities: ['entity_budget'],
    operations: [
      { entry_point_id: 'budget-index', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/budgets' }, path_or_command: '/budgets' },
      { entry_point_id: 'budget-update', entry_point_type: 'http', action: 'update', trigger: { method: 'PATCH', path: '/budgets/:id' }, path_or_command: '/budgets/:id' },
      { entry_point_id: 'budget-categories', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/budget_categories' }, path_or_command: '/budget_categories' },
    ],
  });
  const [closure] = validatedDeterministicAtomicClosures({
    candidateIds: [candidate.id], evidenceCandidates: [candidate], audienceFor: () => 'Users',
    entityLabelsFor: () => ['Budget'], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    completeLifecycleCandidateIds: new Set([candidate.id]),
    validate: () => true,
  });

  assert.equal(closure?.name, 'Manage budgets');
  assert.equal(closure?.description, 'Users can manage budgets so their recorded details remain current and available over time.');
  assert.equal(closure?.operations.length, 3);
  assert.equal(capabilityDescriptionProductLanguageViolation(
    closure?.description || '', ['Budget'],
    (closure?.operations || []).map(operation => JSON.stringify([operation.action, operation.path_or_command || operation.trigger?.path || ''])),
  ), undefined);
});

test('multi-action lifecycle closure fails closed without one literal route subject shared by every operation', () => {
  const candidate = catalogCapability({
    id: 'cap_ambiguous_lifecycle', name: 'Account management',
    evidence_kind: 'entity', evidence_role: 'product-outcome', related_entities: ['entity_account'],
    operations: [
      { entry_point_id: 'identity-read', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/api/v1/identities' } },
      { entry_point_id: 'token-delete', entry_point_type: 'http', action: 'delete', trigger: { method: 'DELETE', path: '/api/v1/tokens/:id' } },
    ],
  });
  assert.deepEqual(validatedDeterministicAtomicClosures({
    candidateIds: [candidate.id], evidenceCandidates: [candidate], audienceFor: () => 'Users',
    entityLabelsFor: () => ['Account'], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    completeLifecycleCandidateIds: new Set([candidate.id]), validate: () => true,
  }), []);
});

test('grounds a compound product noun from an exact route action without mixing unrelated entities', () => {
  const jobsites = catalogCapability({
    id: 'capability_jobsites', name: 'read job and site', structural_label: 'read job and site',
    evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    related_entities: ['entity_job', 'entity_user'],
    operations: [{ entry_point_id: 'job-sites', entry_point_type: 'http', action: 'read job and site', trigger: { method: 'GET', path: '/job/job-sites/:userId' } }],
  });
  const result = validatedDeterministicAtomicClosures({
    candidateIds: [jobsites.id], evidenceCandidates: [jobsites], audienceFor: () => 'Users',
    entityLabelsFor: () => ['Job', 'User'], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    validate: capability => Boolean(capability.description),
  });
  assert.equal(result[0]?.name, 'View job sites');
  const camelCaseRoute = catalogCapability({
    id: 'space-invitations', name: 'Spaceinvitations Management', structural_label: 'Spaceinvitations Management',
    evidence_kind: 'entity', evidence_role: 'product-outcome',
    operations: [{ entry_point_id: 'space-invitations', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/api/v1/users/{user}/spaceInvitations' }, path_or_command: '/api/v1/users/{user}/spaceInvitations' }],
  });
  const camelClosure = validatedDeterministicAtomicClosures({
    candidateIds: [camelCaseRoute.id], evidenceCandidates: [camelCaseRoute], audienceFor: () => 'Users',
    entityLabelsFor: () => [], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    completeLifecycleCandidateIds: new Set([camelCaseRoute.id]), validate: () => true,
  })[0];
  assert.equal(camelClosure?.name, 'View space invitations');
  assert.equal(camelClosure?.description, 'Users can view space invitations, returning the recorded state for those space invitations through the product.');
  assert.ok(camelClosure?.related_domains.includes('space'));
  assert.ok(camelClosure?.criticality_factors.includes('catalog-deterministic-route-lineage'));
  const rulePromptSettings = catalogCapability({
    id: 'cap_rule_prompt_settings_workflow', name: 'Rule Prompt Settings',
    structural_label: 'Rule Prompt Settings Workflow', evidence_kind: 'entity', evidence_role: 'product-outcome',
    related_entities: [], related_domains: ['rule-prompt-settings'],
    operations: [{ entry_point_id: 'rule-prompt-settings', entry_point_type: 'http', action: 'update', trigger: { method: 'PATCH', path: '/users/:id/rule_prompt_settings' }, path_or_command: '/users/:id/rule_prompt_settings' }],
  });
  const rulePromptSettingsClosure = validatedDeterministicAtomicClosures({
    candidateIds: [rulePromptSettings.id], evidenceCandidates: [rulePromptSettings], audienceFor: () => 'Users',
    entityLabelsFor: () => [], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    completeLifecycleCandidateIds: new Set([rulePromptSettings.id]), validate: capability => Boolean(capability.description),
  })[0];
  assert.equal(rulePromptSettingsClosure?.name, 'Configure rule prompt settings');
  assert.equal(rulePromptSettingsClosure?.description, 'Users can configure rule prompt settings, changing the recorded state for those rule prompt settings in the product.');
  const signingSecret = catalogCapability({
    id: 'operation-obligation:user-service:webhook-secret', name: 'read secret and signing and user and webhook',
    structural_label: 'read secret and signing and user and webhook', evidence_kind: 'entity', evidence_role: 'product-outcome',
    evidence_role_reasons: ['user-facing-terminal-journey'], related_entities: [],
    operations: [{ entry_point_id: 'webhook-secret', entry_point_type: 'http', action: 'read', trigger: { method: 'POST', path: '/memos.api.v1.UserService/GetUserWebhookSigningSecret' }, path_or_command: '/memos.api.v1.UserService/GetUserWebhookSigningSecret' }],
  });
  const signingSecretClosure = validatedDeterministicAtomicClosures({
    candidateIds: [signingSecret.id], evidenceCandidates: [signingSecret], audienceFor: () => 'Users',
    entityLabelsFor: () => [], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    validate: capability => capability.name === 'View webhook signing secrets' && capability.related_domains.includes('user') && capability.related_domains.includes('webhook'),
  })[0];
  assert.equal(signingSecretClosure?.name, 'View webhook signing secrets');
  assert.equal(signingSecretClosure?.description, 'Users can view webhook signing secrets as part of their normal workflow whenever needed.');
  assert.equal(evaluateCapabilityCatalogAudience([signingSecretClosure!], [], [], []).accepted.length, 1);
  const impersonation = catalogCapability({
    id: 'cap_impersonation_sessions_management', name: 'Impersonation Sessions',
    structural_label: 'Impersonation Sessions Management', evidence_kind: 'entity', evidence_role: 'product-outcome',
    related_entities: ['entity_impersonationsession'],
    operations: [{ entry_point_id: 'impersonation-session', entry_point_type: 'http', action: 'create', trigger: { method: 'POST', path: '/impersonation_sessions' }, path_or_command: '/impersonation_sessions' }],
  });
  const impersonationClosure = validatedDeterministicAtomicClosures({
    candidateIds: [impersonation.id], evidenceCandidates: [impersonation], audienceFor: () => 'Users',
    entityLabelsFor: () => ['ImpersonationSession'], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    completeLifecycleCandidateIds: new Set([impersonation.id]), validate: capability => Boolean(capability.description),
  })[0];
  assert.equal(impersonationClosure?.name, 'Create impersonation sessions');
  assert.equal(impersonationClosure?.description, 'Users can create impersonation sessions, producing a recorded impersonation sessions outcome in the product.');
  const forgedSigningSecret = {
    ...signingSecret, id: 'operation-obligation:user-service:forged-secret',
    operations: [{ ...signingSecret.operations[0], entry_point_id: 'audit-event', trigger: { method: 'POST', path: '/memos.api.v1.UserService/GetAuditEvent' }, path_or_command: '/memos.api.v1.UserService/GetAuditEvent' }],
  };
  assert.deepEqual(validatedDeterministicAtomicClosures({
    candidateIds: [forgedSigningSecret.id], evidenceCandidates: [forgedSigningSecret], audienceFor: () => 'Users',
    entityLabelsFor: () => [], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    validate: capability => capability.name === 'View webhook signing secrets',
  }), []);
  const avatar = catalogCapability({
    id: 'cap_avatar', name: 'Avatar management', structural_label: 'Avatar management', evidence_kind: 'entity', evidence_role: 'product-outcome',
    related_entities: ['entity_user'], operations: [{ entry_point_id: 'avatar', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/file/users/:identifier/avatar' }, path_or_command: '/file/users/:identifier/avatar' }],
  });
  const avatarClosure = validatedDeterministicAtomicClosures({
    candidateIds: [avatar.id], evidenceCandidates: [avatar], audienceFor: () => 'Users', entityLabelsFor: () => ['User'],
    operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] }, completeLifecycleCandidateIds: new Set([avatar.id]), validate: () => true,
  })[0];
  assert.equal(avatarClosure?.name, 'View avatars');
  assert.ok(avatarClosure?.related_domains.includes('user'));
  const linked = catalogCapability({
    id: 'capability_linked_identities', name: 'Linked identities management', structural_label: 'Linked identities management',
    evidence_kind: 'entity', evidence_role: 'product-outcome',
    operations: [
      { entry_point_id: 'linked-create', entry_point_type: 'http', action: 'create', trigger: { method: 'POST', path: '/api/v1/linked-identities' } },
      { entry_point_id: 'linked-delete', entry_point_type: 'http', action: 'delete', trigger: { method: 'DELETE', path: '/api/v1/linked-identities/:id' } },
    ],
  });
  const linkedClosure = validatedDeterministicAtomicClosures({
    candidateIds: [linked.id], evidenceCandidates: [linked], audienceFor: () => 'Users',
    entityLabelsFor: () => [], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] },
    completeLifecycleCandidateIds: new Set([linked.id]), validate: () => true,
  })[0];
  assert.equal(linkedClosure?.name, 'Manage linked identities');
  assert.equal(linkedClosure?.description, 'Users can manage linked identities so their recorded details remain current and available over time.');
  const subordinate = catalogCapability({
    id: 'capability_linked_identity_service', name: 'View linked identity service',
    criticality_factors: ['catalog-candidate:capability_linked_identity_service', 'catalog-deterministic-atomic-closure'],
  });
  const unrelated = catalogCapability({
    id: 'capability_reports', name: 'View reports',
    criticality_factors: ['catalog-candidate:capability_reports', 'catalog-deterministic-atomic-closure'],
  });
  assert.deepEqual(withoutSubsumedDeterministicAtomicClosures(
    [linkedClosure!, subordinate, unrelated],
    [[linked.id, subordinate.id], [unrelated.id]],
  ).map(capability => capability.name), [
    'Manage linked identities', 'View linked identity service', 'View reports',
  ]);
  const decline = catalogCapability({ id: 'operation-obligation:space:decline', name: 'decline decline and invitation and space', structural_label: 'decline decline and invitation and space', evidence_kind: 'entity', evidence_role: 'product-outcome', evidence_role_reasons: ['user-facing-terminal-journey'], operations: [{ entry_point_id: 'decline', entry_point_type: 'http', action: 'decline', trigger: { method: 'POST', path: '/memos.api.v1.SpaceService/DeclineSpaceInvitation' }, path_or_command: '/memos.api.v1.SpaceService/DeclineSpaceInvitation' }] });
  const declineClosure = validatedDeterministicAtomicClosures({ candidateIds: [decline.id], evidenceCandidates: [decline], audienceFor: () => undefined, entityLabelsFor: () => [], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] }, validate: () => true })[0];
  assert.equal(declineClosure?.name, 'Decline space invitations');
  const stats = catalogCapability({ id: 'operation-obligation:user:stats', name: 'read all and stat and user', structural_label: 'read all and stat and user', evidence_kind: 'entity', evidence_role: 'product-outcome', evidence_role_reasons: ['user-facing-terminal-journey'], operations: [{ entry_point_id: 'stats', entry_point_type: 'http', action: 'read', trigger: { method: 'POST', path: '/memos.api.v1.UserService/ListAllUserStats' }, path_or_command: '/memos.api.v1.UserService/ListAllUserStats' }] });
  const statsClosure = validatedDeterministicAtomicClosures({ candidateIds: [stats.id], evidenceCandidates: [stats], audienceFor: () => undefined, entityLabelsFor: () => [], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] }, validate: () => true })[0];
  assert.equal(statsClosure?.name, 'View user stats');
  assert.ok(statsClosure?.criticality_factors.includes('catalog-deterministic-route-lineage'));
  const ambiguous = { ...jobsites, id: 'ambiguous-jobsites', name: 'read job and account', structural_label: 'read job and account', related_entities: ['entity_job', 'entity_account'] };
  assert.deepEqual(validatedDeterministicAtomicClosures({
    candidateIds: [ambiguous.id], evidenceCandidates: [ambiguous], audienceFor: () => 'Users',
    entityLabelsFor: () => ['Job', 'Account'], operationCoverageContext: { entryPoints: [], nodes: [], edges: [], exitPoints: [] }, validate: () => true,
  }), []);
});

test('restores only exact validator-approved atomic obligations lost after subsumption or same-name merging', () => {
  const firstId = 'operation-obligation:user-service:get-stats';
  const requiredId = 'operation-obligation:user-service:list-all-stats';
  const closure = (id: string, entryPointId: string): SystemCapability => catalogCapability({
    id: `closure:${id}`, name: 'View user stats', description: 'Users can view user stats when needed.',
    name_source: 'deterministic', description_source: 'deterministic',
    operations: [{ entry_point_id: entryPointId, entry_point_type: 'http', action: 'read' }],
    criticality_factors: [`catalog-candidate:${id}`, 'catalog-deterministic-atomic-closure'],
  });
  const getStats = closure(firstId, 'get-stats');
  const listAllStats = closure(requiredId, 'list-all-stats');
  const unvalidatedSameName = catalogCapability({
    id: 'provider-stats', name: 'View user stats', description: 'Users can view user stats when needed.',
    criticality_factors: [`catalog-candidate:${requiredId}`],
  });
  const foreign = closure('operation-obligation:other-service:list-stats', 'foreign-stats');
  assert.deepEqual(deterministicAtomicClosuresForObligationIds(
    [getStats, unvalidatedSameName, listAllStats, foreign], new Set([requiredId]),
  ).map(capability => capability.id), [listAllStats.id]);
  assert.deepEqual(deterministicAtomicClosuresForObligationIds(
    [getStats, listAllStats], new Set(['operation-obligation:user-service:missing']),
  ), []);
});

test('preserves same-name sibling obligations unless one complete validated parent retains every exact scope', () => {
  const parentId = 'cap_user_service';
  const getId = `operation-obligation:${parentId}:get-stats`;
  const listId = `operation-obligation:${parentId}:list-all-stats`;
  const operation = (entryPointId: string) => ({ entry_point_id: entryPointId, entry_point_type: 'http', action: 'read', trigger: { method: 'POST', path: `/rpc/${entryPointId}` }, path_or_command: `/rpc/${entryPointId}` });
  const atomic = (id: string, entryPointId: string) => catalogCapability({
    id: `atomic:${entryPointId}`, name: 'View user stats', description: 'Users can view user stats when needed.',
    operations: [operation(entryPointId)], criticality_factors: [
      `catalog-candidate:${id}`, `catalog-operation-obligation:${id}`, 'catalog-deterministic-atomic-closure',
    ],
  });
  const getStats = atomic(getId, 'get-stats');
  const listStats = atomic(listId, 'list-all-stats');
  const partialParent = catalogCapability({
    id: 'partial-parent', name: 'Manage users', operations: [operation('get-stats')],
    criticality_factors: [`catalog-candidate:${parentId}`, 'catalog-deterministic-grouped-lifecycle'],
  });
  const scopes = new Map([
    [getId, { id: getId, parentCandidateId: parentId, entryPointIds: ['get-stats'], terminalKeysByEntryPoint: new Map() }],
    [listId, { id: listId, parentCandidateId: parentId, entryPointIds: ['list-all-stats'], terminalKeysByEntryPoint: new Map() }],
  ]);
  const context = { entryPoints: [], nodes: [], edges: [], exitPoints: [], obligationScopes: scopes };
  assert.deepEqual(withoutSubsumedDeterministicAtomicClosures(
    [getStats, listStats], [[parentId]], [partialParent, getStats, listStats], context,
  ).map(capability => capability.id), [getStats.id, listStats.id]);

  const completeParent = { ...partialParent, id: 'complete-parent', operations: [operation('get-stats'), operation('list-all-stats')] };
  assert.deepEqual(withoutSubsumedDeterministicAtomicClosures(
    [getStats, listStats], [[parentId]], [completeParent, getStats, listStats], context,
  ), []);
  assert.deepEqual(withoutSubsumedDeterministicAtomicClosures(
    [getStats, listStats], [], [completeParent, getStats, listStats], context,
  ), []);
  const authoredCompleteParent = {
    ...completeParent,
    id: 'authored-complete-parent',
    name: 'Review user statistics',
    name_source: 'ai' as const,
    criticality_factors: [`catalog-candidate:${parentId}`],
  };
  assert.deepEqual(withoutSubsumedDeterministicAtomicClosures(
    [getStats, listStats], [], [authoredCompleteParent, getStats, listStats], context,
  ), []);
  assert.deepEqual(withoutSubsumedDeterministicAtomicClosures(
    [authoredCompleteParent, getStats, listStats], [], [authoredCompleteParent, getStats, listStats], context,
  ).map(capability => capability.id), [authoredCompleteParent.id]);
  const sameIdentityAuthored = {
    ...authoredCompleteParent,
    id: getStats.id,
    name: getStats.name,
    operations: [operation('get-stats')],
    criticality_factors: [`catalog-candidate:${getId}`],
  };
  const sameIdentityResult = withoutSubsumedDeterministicAtomicClosures(
    [sameIdentityAuthored, getStats], [], [sameIdentityAuthored, getStats], context,
  );
  assert.deepEqual(sameIdentityResult.map(capability => capability.name_source), ['ai']);
});

test('empty-entity atomic subject grounding rejects ambiguous, generic, support-only, and forged lineage', () => {
  const candidate = (id: string, label: string, entryPointId: string) => catalogCapability({
    id, name: label, structural_label: label, evidence_kind: 'behavior-surface', evidence_role: 'product-outcome',
    related_entities: [], operations: [{ entry_point_id: entryPointId, entry_point_type: 'event', action: label.split(' ')[0] }],
  });
  const ambiguous = candidate('operation-obligation:ambiguous', 'delete category job', 'ambiguous');
  const generic = candidate('operation-obligation:generic', 'update item', 'generic');
  const support = candidate('operation-obligation:support', 'update category', 'support');
  const forged = candidate('operation-obligation:forged', 'delete category', 'forged');
  const entry = (id: string, binding: string, kind?: string) => ({ id, type: 'event', name: id, source_analyzer: 'react', handler: { file: 'Categories.tsx' }, metadata: { source_analyzer: 'react', handler_file: 'Categories.tsx', handler_binding_node_ids: [binding], handler_references: [{ name: binding, kind: 'direct', binding_node_id: binding }], ...(kind ? { local_handler_kind: kind } : {}) } });
  const context = {
    entryPoints: [entry('ambiguous', 'ambiguous-handler'), entry('generic', 'generic-handler'), entry('support', 'state', 'state-setter'), entry('forged', 'forged-handler')],
    nodes: [
      { id: 'ambiguous-handler', name: 'deleteCategoryJob', type: 'function', source: { file: 'Categories.tsx', line: 1 }, metadata: {} },
      { id: 'generic-handler', name: 'updateItem', type: 'function', source: { file: 'Categories.tsx', line: 2 }, metadata: {} },
      { id: 'state', name: '[category, setCategory]', type: 'react_handler_binding', primaryAnalyzer: 'react', source: { file: 'Categories.tsx', line: 3 }, metadata: { attributes: { value: 'useState()', binding_kind: 'state-setter', binding_names: ['state'] } } },
      { id: 'forged-handler', name: 'deleteCategory', type: 'function', source: { file: 'Other.tsx', line: 4 }, metadata: {} },
    ],
    edges: ['ambiguous', 'generic', 'support', 'forged'].map(id => ({ id: 'trigger-' + id, source: id, target: id === 'support' ? 'state' : id + '-handler', type: 'triggers' })),
    exitPoints: [],
  } as any;
  assert.deepEqual(validatedDeterministicAtomicClosures({
    candidateIds: [ambiguous.id, generic.id, support.id, forged.id], evidenceCandidates: [ambiguous, generic, support, forged],
    audienceFor: () => 'Users', entityLabelsFor: () => [], operationCoverageContext: context, validate: () => true,
  }), []);
});

test('a copied authored outcome is not an exact validated closure, even after description repair', () => {
  for (const description_source of ['deterministic', 'ai'] as const) {
    const value = catalogCapability({
      name: 'Know what will break before changing something',
      description: 'People know what will break before changing something.',
      description_source,
      description_generation: { attempted: true,
        status: description_source === 'ai' ? 'ai_applied' : 'deterministic_kept',
        reason: 'grounded-first-party-outcome' },
      operations: [{ entry_point_id: 'helper', entry_point_type: 'internal', action: 'Handle' }],
      criticality_factors: ['catalog-candidate:helper', 'catalog-deterministic-atomic-closure', 'catalog-grounded-authored-outcome-recovery'],
    });
    assert.equal(isExactValidatedDeterministicRecovery(value), false);
  }
});

test('scan-ahead fills four-wide disjoint waves and preserves plan order', async () => {
  let active = 0; let peak = 0; const starts: string[] = [];
  const facts = [{ id: 'a1', candidateIds: ['a'] }, { id: 'a2', candidateIds: ['a'] }, { id: 'b', candidateIds: ['b'] }, { id: 'c', candidateIds: ['c'] }, { id: 'd', candidateIds: ['d'] }];
  const values = await collectCapabilityCatalogEvidenceBatches({
    facts, evidenceScoped: true, batchBudgetMs: 1000, concurrency: 4, conflictKeys: fact => fact.candidateIds, isDeadlineError: () => false,
    extract: async batch => { starts.push(batch[0].id); active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, batch[0].id === 'a1' ? 10 : 1)); active--; return [batch[0].id]; },
  });
  assert.equal(peak, 4);
  assert.deepEqual(starts.slice(0, 4), ['a1', 'b', 'c', 'd']);
  assert.deepEqual(values, ['a1', 'a2', 'b', 'c', 'd']);
});

test('defers an empty evidence retry after recording candidate feedback', async () => {
  let retries = 0; const recorded: string[] = [];
  const result = await retryEmptyCapabilityCatalogOutcome({
    candidateIds: ['first'], initial: [], rejections: [], retryEvidence: true, deferEvidenceRetry: true,
    record: feedback => recorded.push(feedback.reason), retry: async () => { retries++; return ['late']; },
  });
  assert.deepEqual(result, []);
  assert.equal(retries, 0);
  assert.deepEqual(recorded, ['required-evidence-zero-result']);
});
test('closes an incomplete aggregate with one evidence-cited lifecycle capability', () => {
  const parentId = 'cap_categories_management';
  const actions = [
    ['create', 'POST', '/categories'],
    ['read', 'GET', '/categories'],
    ['update', 'PATCH', '/categories/:id'],
    ['delete', 'DELETE', '/categories/:id'],
  ] as const;
  const candidates = actions.map(([action, method, path], index) => catalogCapability({
    id: `operation-obligation:${parentId}:${index}`,
    name: `${action} category`,
    structural_label: `${action} category`,
    related_entities: ['entity_category'],
    related_domains: ['categories'],
    operations: [{
      entry_point_id: `category-${index}`,
      entry_point_type: 'http',
      action: `authenticate and ${action}`,
      path_or_command: path,
      trigger: { method, path },
    }],
  }));
  const scopes = new Map(candidates.map(candidate => [candidate.id, {
    id: candidate.id,
    parentCandidateId: parentId,
  }]));
  const [closure] = validatedDeterministicGroupedOperationClosures({
    uncoveredIdsByParent: new Map([[parentId, [candidates[0].id]]]),
    scopes,
    evidenceCandidates: candidates,
    audienceFor: () => undefined,
    entityLabelsFor: () => ['Category'],
    validate: capability => Boolean(capability.description),
  });
  assert.equal(closure?.name, 'Organize categories');
  assert.equal(isExactValidatedDeterministicRecovery(closure!), true);
  assert.equal(closure?.description, 'Users can organize categories so their recorded details remain current and available over time.');
  assert.deepEqual(
    closure?.criticality_factors?.filter(factor => factor.startsWith('catalog-candidate:')),
    candidates.map(candidate => `catalog-candidate:${candidate.id}`),
  );
});

test('deterministically recovers a reversible user-action lifecycle', () => {
  const parentId = 'cap_follow_management';
  const candidates = [
    catalogCapability({
      id: `operation-obligation:${parentId}:follow`,
      name: 'follow profile',
      structural_label: 'follow profile',
      operations: [{
        entry_point_id: 'follow-profile',
        entry_point_type: 'http',
        action: 'Create',
        path_or_command: '/profiles/:username/follow',
        trigger: { method: 'POST', path: '/profiles/:username/follow' },
      }],
    }),
    catalogCapability({
      id: `operation-obligation:${parentId}:unfollow`,
      name: 'unfollow profile',
      structural_label: 'unfollow profile',
      operations: [{
        entry_point_id: 'unfollow-profile',
        entry_point_type: 'http',
        action: 'Delete',
        path_or_command: '/profiles/:username/follow',
        trigger: { method: 'DELETE', path: '/profiles/:username/follow' },
      }],
    }),
  ];
  const scopes = new Map(candidates.map(candidate => [candidate.id, {
    id: candidate.id,
    parentCandidateId: parentId,
  }]));
  const [closure] = validatedDeterministicGroupedOperationClosures({
    uncoveredIdsByParent: new Map([[parentId, candidates.map(candidate => candidate.id)]]),
    scopes,
    evidenceCandidates: candidates,
    audienceFor: () => undefined,
    entityLabelsFor: () => [],
    validate: capability => Boolean(capability.description),
  });
  assert.equal(closure?.name, 'Follow and unfollow profiles');
  assert.equal(closure?.description, 'Users can follow and unfollow profiles so their recorded details remain current and available over time.');
  assert.deepEqual(closure?.operations, candidates.flatMap(candidate => candidate.operations));
});


test('evidence merging prunes unrelated operations already attached to a focused reversible outcome', () => {
  const operations = [
    { entry_point_id: 'create-article', entry_point_type: 'http' as const, action: 'create', path_or_command: '/articles', trigger: { method: 'POST', path: '/articles' } },
    { entry_point_id: 'read-article', entry_point_type: 'http' as const, action: 'read', path_or_command: '/articles/:slug', trigger: { method: 'GET', path: '/articles/:slug' } },
    { entry_point_id: 'favorite-article', entry_point_type: 'http' as const, action: 'favorite', path_or_command: '/articles/:slug/favorite', trigger: { method: 'POST', path: '/articles/:slug/favorite' } },
    { entry_point_id: 'unfavorite-article', entry_point_type: 'http' as const, action: 'unfavorite', path_or_command: '/articles/:slug/favorite', trigger: { method: 'DELETE', path: '/articles/:slug/favorite' } },
  ];
  const accepted = catalogCapability({
    id: 'accepted-favorites',
    name: 'Favorite and unfavorite articles',
    operations,
    criticality_factors: [
      'catalog-candidate:cap_article_management',
      'catalog-operation-obligation:operation-obligation:cap_article_management:create',
      'catalog-candidate:operation-obligation:cap_article_management:read',
    ],
  });
  const evidence = catalogCapability({
    id: 'cap_favorite_management',
    name: 'Favorite articles',
    structural_label: 'Favorite articles',
    evidence_kind: 'behavior-surface',
    operations,
  });

  const [merged] = mergeUniquelyMatchedBehaviorEvidence(
    [accepted],
    [evidence],
    [evidence.id],
  );

  assert.deepEqual(
    merged.operations.map(operation => operation.entry_point_id),
    ['favorite-article', 'unfavorite-article'],
  );
  assert.deepEqual(
    merged.criticality_factors.filter(factor => factor.includes('operation-obligation:')),
    [],
  );
});

test('an empty catalog with grounded evidence families is rejected, not accepted as complete', () => {
  const quality = (candidateFamilyGroups: string[][], emptyCatalogRepairEligible = true) => capabilityCatalogCycleQualityFailure({
    reconciled: [], distinctFamilyCount: candidateFamilyGroups.length, requiredBehaviorCandidateIds: [], requiredEntityCandidateGroups: [],
    requiredOutcomes: [], candidateFamilyGroups, emptyCatalogRepairEligible, isBareNoun: () => false, isStructuralPlaceholder: () => false,
  });
  assert.match(quality([['post-lifecycle'], ['comment-lifecycle']]) || '', /omits 2 grounded product-evidence families/);
  assert.equal(quality([]), undefined);
  // after the one granted repair, an empty catalog is the honest answer
  assert.equal(quality([['post-lifecycle']], false), undefined);
});

test('an empty catalog with uncovered product-outcome obligations is rejected; tool-shaped or supporting obligations never force a fill', () => {
  // The candidate pool had entity-backed product operations (sign up, toggle a
  // post) that never earned structural-family status; an empty answer omits
  // them. Uncovered supporting surfaces alone keep the empty answer honest.
  const quality = (requiredBehaviorCandidateIds: string[], uncoveredProductOutcomeCandidateIds: string[]) => capabilityCatalogCycleQualityFailure({
    reconciled: [], distinctFamilyCount: 0, requiredBehaviorCandidateIds, requiredEntityCandidateGroups: [],
    requiredOutcomes: [], candidateFamilyGroups: [], uncoveredProductOutcomeCandidateIds, emptyCatalogRepairEligible: true, isBareNoun: () => false, isStructuralPlaceholder: () => false,
  });
  const obligations = ['operation-obligation:capability_signup:1', 'operation-obligation:capability_toggle:2'];
  assert.match(quality(obligations, obligations) || '', /empty while 2 grounded product-outcome behavior obligation\(s\) remain uncovered/);
  assert.equal(quality(obligations, []), undefined);
  assert.equal(quality([], []), undefined);
});
