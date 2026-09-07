
test('bound outcome recovery preserves authored clauses instead of verbalizing normalized search tokens', () => {
  for (const name of [
    'Know what will break before changing something',
    'Understand what a codebase actually built',
    'Avoid outages when deploying services',
    'Decide whether to approve an application',
    'Compare eligible plans without sharing private records',
  ]) {
    const candidate = { ...capability('evidence', []), name, operations: [
      { entry_point_id: 'observed', entry_point_type: 'event' as const, action: 'read' },
    ] };
    const identity = { ...capability('outcome', [
      'catalog-candidate:evidence', 'catalog-outcome-requirement:authored',
    ]), name };
    const recovered = deterministicCapabilityDescriptionFallback({
      identity, evidenceCandidates: [candidate], audience: 'People', firstPartyTexts: [],
      validate: () => true,
    });
    assert.equal(recovered?.description, `People can ${name[0].toLowerCase()}${name.slice(1)}.`);
    assert.equal(recovered?.name, name);
    assert.equal(recovered?.description_source, 'deterministic');
    assert.deepEqual(recovered?.criticality_factors, identity.criticality_factors);
  }
});

test('bound outcome recovery never invents temporal behavior to pad a short description', () => {
  const candidate = { ...capability('jobs', []), name: 'Job applications', operations: [
    { entry_point_id: 'categorize', entry_point_type: 'event' as const, action: 'update' },
  ] };
  const identity = { ...capability('outcome', [
    'catalog-candidate:jobs', 'catalog-outcome-requirement:authored',
  ]), name: 'Categorize job applications' };
  assert.equal(deterministicCapabilityDescriptionFallback({
    identity, evidenceCandidates: [candidate], audience: 'Users', firstPartyTexts: [],
    validate: () => true,
  }), undefined);
  assert.equal(identity.name, 'Categorize job applications');
  assert.equal(candidate.operations.length, 1);
});
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SystemCapability } from '../../types/cas.types';
import type { CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';
import { groundedCapabilityAudience } from './capability-catalog-audience';
import { capabilityCatalogFocusedTask, capabilityCatalogPendingRequirementIds, capabilityCatalogRepairNudge, capabilityCatalogRepairPlan, captureCapabilityCatalogPendingRequirements, deterministicCapabilityActionIdentityFallback, deterministicCapabilityDescriptionFallback, establishPendingCapabilityEvidenceIdentity, pendingCapabilityEvidenceObservableActionFailure, preserveCapabilityCatalogDescriptionIdentity, supersedeUnboundPendingOutcomeDuplicates, type PendingCapabilityEvidenceIdentity } from './capability-catalog-repair-plan';

const capability = (id: string, factors: string[], description = '') => ({
  id, name: `Outcome ${id}`, description, category: 'core', criticality: 'high', criticality_factors: factors,
  operations: [], related_entities: [], related_domains: [],
}) as SystemCapability;

test('reusable libraries use their consumer audience for deterministic comprehension repair', () => {
  assert.equal(groundedCapabilityAudience(
    capability('routing', []),
    { concepts: [], evidence: [] },
    [],
    [],
    'library',
  ), 'Developers');
});

describe('capability catalog repair planning', () => {

  test('reports exact observable action parity without accepting adjacent action families', () => {
    const evidence = (action: string) => ({
      ...capability('operation', []),
      name: action + ' record',
      operations: [{ entry_point_id: action, entry_point_type: 'http', action }],
    });
    assert.equal(pendingCapabilityEvidenceObservableActionFailure({ name: 'Track records' }, evidence('read')), undefined);
    assert.equal(pendingCapabilityEvidenceObservableActionFailure({ name: 'Track records' }, evidence('create')), undefined);
    assert.equal(pendingCapabilityEvidenceObservableActionFailure({ name: 'View records' }, evidence('read')), undefined);
    assert.equal(pendingCapabilityEvidenceObservableActionFailure({ name: 'Create records' }, evidence('create')), undefined);
    assert.equal(pendingCapabilityEvidenceObservableActionFailure({ name: 'View records' }, evidence('create')), 'required-observable-action-missing:create');
  });

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

    assert.deepEqual(plan.map(batch => batch.mode), ['description', 'outcome', 'outcome', 'evidence', 'evidence']);
    assert.deepEqual(plan[0], { mode: 'description', candidateIds: ['graph'], requirements: [graphRequirement], identity: graph });
    assert.deepEqual(plan[1], { mode: 'outcome', candidateIds: ['mcp'], requirements: [human] });
    assert.deepEqual(plan[2], { mode: 'outcome', candidateIds: ['mcp'], requirements: [runtime] });
    assert.deepEqual(plan[3], { mode: 'evidence', candidateIds: ['architecture'], requirements: [] });
    assert.deepEqual(plan[4], { mode: 'evidence', candidateIds: ['mcp'], requirements: [] });
  });

  test('prioritizes exact pending confirmation while continuing direct operation repair beside outcome repair', () => {
    const pending = { ...capability('list', ['catalog-candidate:list']), name: 'View records' };
    const outcome = { id: 'status', statement: 'Manage record status', candidateIds: ['status'], subjectTokens: ['status'] };
    const plan = capabilityCatalogRepairPlan({
      evidenceCandidateIds: ['list', 'status'],
      outcomeRequirements: [outcome],
      pendingCapabilities: [pending],
    });

    assert.equal(plan[0].mode, 'description');
    assert.deepEqual(plan[0].candidateIds, ['list']);
    assert.deepEqual(plan.filter(batch => batch.mode === 'evidence').map(batch => batch.candidateIds), [['status']]);
    assert.deepEqual(plan.filter(batch => batch.mode === 'outcome').map(batch => batch.candidateIds), [['status']]);
  });

  test('prioritizes exact operation evidence after pending descriptions and before outcome repair', () => {
    const pending = { ...capability('pending', ['catalog-candidate:pending']), name: 'View records' };
    const requirement = { id: 'outcome', statement: 'Manage record status', candidateIds: ['status'], subjectTokens: ['status'] };
    const plan = capabilityCatalogRepairPlan({ evidenceCandidateIds: ['operation', 'family'], priorityEvidenceCandidateIds: ['operation'], outcomeRequirements: [requirement], pendingCapabilities: [pending] });
    assert.deepEqual(plan.map(batch => [batch.mode, batch.candidateIds]), [['description', ['pending']], ['evidence', ['operation']], ['outcome', ['status']], ['evidence', ['family']]]);
  });

  test('groups matching product subjects deterministically before lower-priority work', () => {
    const evidence = (id: string, label: string, action: string) => ({
      ...capability(id, []),
      name: label,
      structural_label: label,
      evidence_kind: 'behavior-surface' as const,
      evidence_role: 'product-outcome' as const,
      operations: [{ entry_point_id: id + '-entry', entry_point_type: 'event' as const, action }],
    });
    const updateFirst = evidence('operation-obligation:records:update-b', 'update application', 'update');
    const updateSecond = evidence('operation-obligation:records:update-a', 'update application', 'update');
    const remove = evidence('operation-obligation:records:delete', 'delete record', 'delete');
    const candidates = [updateFirst, updateSecond, remove];
    const plan = (ids: string[]) => capabilityCatalogRepairPlan({
      evidenceCandidateIds: ids,
      priorityEvidenceCandidateIds: ids,
      evidenceCandidates: candidates,
      outcomeRequirements: [],
      pendingCapabilities: [],
    }).map(batch => batch.candidateIds);

    const expected = [
      [remove.id],
      [updateSecond.id, updateFirst.id],
    ];
    assert.deepEqual(plan([updateFirst.id, remove.id, updateSecond.id]), expected);
    assert.deepEqual(plan([remove.id, updateSecond.id, updateFirst.id]), expected);
  });

  test('groups matching authoritative parent and entity subject across lifecycle actions without losing citations', () => {
    const item = (id: string, parent: string, action: string, entity: string, label: string) => ({
      ...capability(id, ['catalog-parent-candidate:' + parent]), name: label, structural_label: label,
      evidence_kind: 'behavior-surface' as const, evidence_role: 'product-outcome' as const, related_entities: [entity],
      operations: [{ entry_point_id: id + '-entry', entry_point_type: 'http' as const, action }],
    });
    const a = item('operation-obligation:members:a', 'members', 'read', 'member', 'list active members');
    const b = item('operation-obligation:members:b', 'members', 'read', 'member', 'get invited member profiles');
    const otherFamily = item('operation-obligation:spaces:a', 'spaces', 'read', 'member', 'list members');
    const otherAction = item('operation-obligation:members:c', 'members', 'update', 'member', 'update member');
    const otherSubject = item('operation-obligation:members:d', 'members', 'read', 'space', 'list spaces');
    const candidates = [otherSubject, b, otherAction, a, otherFamily];
    const batches = capabilityCatalogRepairPlan({ evidenceCandidateIds: candidates.map(candidate => candidate.id), priorityEvidenceCandidateIds: candidates.map(candidate => candidate.id), evidenceCandidates: candidates, outcomeRequirements: [], pendingCapabilities: [] }).map(batch => batch.candidateIds);
    assert.deepEqual(batches, [[a.id, b.id, otherAction.id], [otherSubject.id], [otherFamily.id]]);
    assert.deepEqual(batches.flat().sort(), candidates.map(candidate => candidate.id).sort());
  });



  test('a broad pending description cannot reserve an exact operation evidence repair', () => {
    const exact = 'operation-obligation:records:exact';
    const broad = { ...capability('broad', ['catalog-candidate:aggregate', `catalog-candidate:${exact}`]), name: 'Manage records' };
    const singleton = { ...capability('single', ['catalog-candidate:single']), name: 'View records' };
    const plan = capabilityCatalogRepairPlan({ evidenceCandidateIds: [exact, 'single'], priorityEvidenceCandidateIds: [exact, 'single'], outcomeRequirements: [], pendingCapabilities: [broad, singleton] });
    assert.deepEqual(plan.map(batch => [batch.mode, batch.candidateIds]), [['description', ['aggregate', exact]], ['description', ['single']], ['evidence', [exact]]]);
  });

  test('deduplicates pending lifecycle repairs and does not schedule their aggregate evidence twice', () => {
    const first = { ...capability('first', ['catalog-candidate:categories']), name: 'Manage categories' };
    const regenerated = { ...first, id: 'regenerated' };
    const plan = capabilityCatalogRepairPlan({
      evidenceCandidateIds: ['categories'], priorityEvidenceCandidateIds: ['categories'],
      outcomeRequirements: [], pendingCapabilities: [first, regenerated],
    });
    assert.deepEqual(plan.map(batch => [batch.mode, batch.candidateIds]), [['description', ['categories']]]);
  });


  test('marks deterministic fallback identities for name and description repair', () => {
    const identity = { ...capability('categories', ['catalog-candidate:categories', 'catalog-candidate:category']), name: 'Manage categories', name_source: 'deterministic' as const };
    const [batch] = capabilityCatalogRepairPlan({ evidenceCandidateIds: [], outcomeRequirements: [], pendingCapabilities: [identity] });
    assert.equal(batch.mode, 'description');
    assert.equal(batch.mode === 'description' && batch.repairName, true);
  });

  test('description repair preserves the stable identity while accepting only replacement prose', () => {
    const identity = { ...capability('graph', ['catalog-candidate:graph', 'catalog-outcome-requirement:graph-slot']), name: 'Access job sites by user' };
    const repaired = preserveCapabilityCatalogDescriptionIdentity(identity, { ...capability('renamed', ['catalog-candidate:other'], 'Users access saved job sites from each application record.'), name: 'Manage job applications' });

    assert.equal(repaired.id, 'graph');
    assert.equal(repaired.name, 'Access job sites by user');
    assert.equal(repaired.description, 'Users access saved job sites from each application record.');
    assert.deepEqual(repaired.criticality_factors, ['catalog-candidate:graph', 'catalog-outcome-requirement:graph-slot']);
  });

  test('builds established-identity descriptions only from grounded first-party or cited lifecycle evidence', () => {
    const evidence = (id: string, label: string, actions: string[]) => ({
      ...capability(id, []),
      name: label,
      structural_label: label,
      evidence_kind: 'behavior-surface' as const,
      evidence_role: 'product-outcome' as const,
      operations: actions.map((action, index) => ({ entry_point_id: `${id}-${index}`, entry_point_type: 'event', action })),
    });
    const allow = () => true;
    const categoryEvidence = evidence('category-evidence', 'Work Category', ['create', 'update', 'delete']);
    const category = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('category', ['catalog-candidate:category-evidence']), name: 'Create work categories' },
      evidenceCandidates: [categoryEvidence], audience: 'Users',
      firstPartyTexts: ['Users create work categories to organize active requests and can later edit or remove those categories.'],
      validate: allow,
    });
    assert.equal(category?.description, 'Users create work categories to organize active requests and can later edit or remove those categories.');
    assert.equal(category?.id, 'category');

    const sourceEvidence = evidence('source-evidence', 'Request Source', ['read']);
    const bySource = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('source', ['catalog-candidate:source-evidence']), name: 'Track requests by source' },
      evidenceCandidates: [sourceEvidence], audience: 'Operators', firstPartyTexts: [], validate: allow,
    });
    assert.equal(bySource?.description, 'Operators can track requests by source as part of their normal workflow whenever needed.');

    const managedEvidence = evidence('managed-evidence', 'Job Application', ['manage']);
    const boundOutcome = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('tracked', [
        'catalog-candidate:managed-evidence',
        'catalog-outcome-requirement:all:job-keep',
      ]), name: 'Keep track of job applications' },
      evidenceCandidates: [managedEvidence], audience: 'Users', firstPartyTexts: [], validate: allow,
    });
    assert.equal(boundOutcome?.description, 'Users can keep track of job applications.');

    const routingEvidence = evidence("routing-evidence", "Routing", ["route"]);
    const qualifiedOutcome = deterministicCapabilityDescriptionFallback({
      identity: { ...capability("routing", ["catalog-candidate:routing-evidence", "catalog-outcome-requirement:all:route"]), name: "Route requests to handlers with a macro free API" },
      evidenceCandidates: [routingEvidence], audience: "Developers", firstPartyTexts: [], validate: allow,
    });
    assert.equal(qualifiedOutcome?.name, "Route requests to handlers with a macro free API");
    assert.equal(qualifiedOutcome?.description, "Developers can route requests to handlers with a macro free API.");

    const responseEvidence = evidence('response-evidence', 'Into', ['generate']);
    const responseOutcome = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('responses', [
        'catalog-candidate:response-evidence',
        'catalog-outcome-requirement:all:generate-response',
      ]), name: 'Generate responses with minimal boilerplate' },
      evidenceCandidates: [responseEvidence], audience: 'Developers', firstPartyTexts: [], validate: allow,
    });
    assert.equal(responseOutcome?.description, 'Developers can generate responses with minimal boilerplate.');

    const extractorEvidence = evidence('extractor-evidence', 'Axum', ['extract']);
    const extractorOutcome = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('extractors', [
        'catalog-candidate:extractor-evidence',
        'catalog-outcome-requirement:all:extract-parse-request',
      ]), name: 'Declaratively parse requests using extractors' },
      evidenceCandidates: [extractorEvidence], audience: 'Developers', firstPartyTexts: [], validate: allow,
    });
    assert.equal(extractorOutcome?.description, 'Developers can declaratively parse requests using extractors.');

    const exactFirstPartyOverride = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('remove-source', ['catalog-candidate:source-evidence']), name: 'Remove tracked requests' },
      evidenceCandidates: [sourceEvidence], audience: 'Operators',
      firstPartyTexts: ['Operators remove tracked requests after they view and confirm the selected request source.'],
      validate: allow,
    });
    assert.equal(exactFirstPartyOverride?.description, 'Operators remove tracked requests after they view and confirm the selected request source.');

    const closureEvidence = evidence('closure-evidence', 'Tracked Request', ['read', 'update']);
    const automaticClosure = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('closure', ['catalog-candidate:closure-evidence']), name: 'Automatically close tracked requests' },
      evidenceCandidates: [closureEvidence], audience: 'People', firstPartyTexts: [], validate: allow,
    });
    assert.equal(automaticClosure, undefined);
    const groundedAutomaticClosure = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('closure', ['catalog-candidate:closure-evidence']), name: 'Automatically close tracked requests' },
      evidenceCandidates: [closureEvidence], audience: 'People',
      firstPartyTexts: ['People automatically close tracked requests after they view and update the request record.'], validate: allow,
    });
    assert.equal(groundedAutomaticClosure?.description, 'People automatically close tracked requests after they view and update the request record.');

    const destructiveEvidence = evidence('collection-evidence', 'Work Collection', ['create', 'delete']);
    const destructive = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('collection', ['catalog-candidate:collection-evidence']), name: 'Manage work collections' },
      evidenceCandidates: [destructiveEvidence], audience: 'Users',
      firstPartyTexts: ['Users create work collections to organize requests for later review by their teams.'],
      validate: allow,
    });
    assert.notEqual(destructive?.description, 'Users create work collections to organize requests for later review by their teams.');
    assert.match(destructive?.description || '', /no longer need/);

    const completeLifecycleEvidence = evidence('record-evidence', 'Work Record', ['create', 'update', 'delete']);
    const completeLifecycle = deterministicCapabilityDescriptionFallback({
      identity: { ...capability('record', ['catalog-candidate:record-evidence']), name: 'Manage work records' },
      evidenceCandidates: [completeLifecycleEvidence], audience: 'Users',
      firstPartyTexts: ['Users remove work records when they are no longer needed by their teams.'],
      validate: allow,
    });
    assert.notEqual(completeLifecycle?.description, 'Users remove work records when they are no longer needed by their teams.');
    assert.match(completeLifecycle?.description || '', /from first use/);
    assert.match(completeLifecycle?.description || '', /later changes/);
    assert.match(completeLifecycle?.description || '', /no longer need/);
    const accountEvidence = evidence('account-evidence', 'Account Record', ['create']);
    const invoiceEvidence = evidence('invoice-evidence', 'Invoice Record', ['delete']);
    const mixedIdentity = { ...capability('mixed', ['catalog-candidate:account-evidence', 'catalog-candidate:invoice-evidence']), name: 'Manage account records' };
    assert.equal(deterministicCapabilityDescriptionFallback({
      identity: mixedIdentity, evidenceCandidates: [accountEvidence, invoiceEvidence], audience: 'Users', firstPartyTexts: [], validate: allow,
    }), undefined);
    assert.equal(deterministicCapabilityDescriptionFallback({
      identity: mixedIdentity, evidenceCandidates: [accountEvidence, invoiceEvidence], audience: 'Users', firstPartyTexts: ['Users create account records and remove invoice records during the documented review workflow.'], validate: allow,
    })?.description, 'Users create account records and remove invoice records during the documented review workflow.');
  });

  test('refuses deterministic descriptions without singular grounding or unchanged validator approval', () => {
    const cited = {
      ...capability('request-evidence', []), name: 'Tracked Request', structural_label: 'Tracked Request',
      evidence_kind: 'behavior-surface' as const, evidence_role: 'product-outcome' as const,
      operations: [{ entry_point_id: 'request-read', entry_point_type: 'event', action: 'read' }],
    };
    const identity = { ...capability('request', ['catalog-candidate:request-evidence']), name: 'Track requests by source' };
    const base = { identity, evidenceCandidates: [cited], audience: 'Users', firstPartyTexts: [] as string[], validate: () => true };

    assert.equal(deterministicCapabilityDescriptionFallback({ ...base, audience: undefined }), undefined);
    assert.equal(deterministicCapabilityDescriptionFallback({ ...base, audience: undefined, firstPartyTexts: ['Users review requests. Operators review requests.'] }), undefined);
    assert.equal(deterministicCapabilityDescriptionFallback({ ...base, identity: { ...identity, criticality_factors: [] } }), undefined);
    assert.equal(deterministicCapabilityDescriptionFallback({ ...base, identity: { ...identity, criticality_factors: ['catalog-candidate:missing'] } }), undefined);
    assert.equal(deterministicCapabilityDescriptionFallback({ ...base, identity: { ...identity, name: 'Review invoices' } }), undefined);
    assert.equal(deterministicCapabilityDescriptionFallback({ ...base, identity: { ...identity, name: 'Delete tracked requests' } }), undefined);
    assert.equal(deterministicCapabilityDescriptionFallback({ ...base, identity: { ...identity, name: 'Update tracked requests' } }), undefined);
    assert.equal(deterministicCapabilityDescriptionFallback({ ...base, validate: () => false }), undefined);
  });

  test('keeps one stable internal pending identity for an exact uncovered evidence candidate', () => {
    const registry = new Map<string, PendingCapabilityEvidenceIdentity>();
    const candidate = {
      ...capability('source-evidence', []), name: 'Request Source', structural_label: 'Request Source',
      evidence_kind: 'behavior-surface' as const, evidence_role: 'product-outcome' as const,
      operations: [{ entry_point_id: 'source-read', entry_point_type: 'event', action: 'read' }],
      related_entities: ['entity_request'],
    };
    const pending = {
      ...capability('stable-pending', ['catalog-candidate:source-evidence']), name: 'Track requests by source',
      operations: candidate.operations, related_entities: ['entity_request'],
      description_generation: { attempted: true, status: 'ai_rejected' as const, reason: 'catalog-audience:missing' },
    };
    const establish = (value: SystemCapability, evidence = candidate) => establishPendingCapabilityEvidenceIdentity({
      registry, capability: value, candidate: evidence, requestedCandidateIds: ['source-evidence'],
      requiredUncoveredCandidateIds: new Set(['source-evidence']), familyKey: 'source-family', audience: 'Users',
      descriptionFailure: 'catalog-audience:missing', alreadyPublishedCandidateIds: new Set(),
    });

    assert.equal(establish(pending), true);
    assert.equal(registry.size, 1);
    assert.equal(registry.get('source-evidence')?.identity.id, 'stable-pending');
    assert.equal(establish({ ...pending, id: 'renamed', name: 'Browse request sources' }), true);
    assert.equal(registry.get('source-evidence')?.identity.id, 'stable-pending');

    const changedCandidate = {
      ...candidate,
      operations: [...candidate.operations, { entry_point_id: 'source-update', entry_point_type: 'event', action: 'update' }],
    };
    assert.equal(establish({ ...pending, id: 'reestablished', operations: changedCandidate.operations }, changedCandidate), true);
    assert.equal(registry.get('source-evidence')?.identity.id, 'reestablished');
    assert.equal(registry.get('source-evidence')?.fallbackAttempted, false);
  });

  test('refuses pending evidence identities across citation, grounding, family, audience, and publication boundaries', () => {
    const candidate = {
      ...capability('source-evidence', []), name: 'Request Source', structural_label: 'Request Source',
      evidence_kind: 'behavior-surface' as const, evidence_role: 'product-outcome' as const,
      operations: [{ entry_point_id: 'source-read', entry_point_type: 'event', action: 'read' }],
      related_entities: ['entity_request'],
    };
    const pending = {
      ...capability('pending', ['catalog-candidate:source-evidence']), name: 'Track requests by source',
      operations: candidate.operations, related_entities: ['entity_request'],
    };
    const base = {
      candidate, requestedCandidateIds: ['source-evidence'], requiredUncoveredCandidateIds: new Set(['source-evidence']),
      familyKey: 'source-family', audience: 'Users', descriptionFailure: 'catalog-audience:missing',
      alreadyPublishedCandidateIds: new Set<string>(),
    };
    const rejected: Array<Parameters<typeof establishPendingCapabilityEvidenceIdentity>[0]> = [
      { ...base, registry: new Map(), capability: { ...pending, criticality_factors: [...pending.criticality_factors, 'catalog-candidate:other'] } },
      { ...base, registry: new Map(), capability: pending, audience: undefined },
      { ...base, registry: new Map(), capability: pending, familyKey: undefined },
      { ...base, registry: new Map(), capability: { ...pending, name: 'Review invoices' } },
      { ...base, registry: new Map(), capability: { ...pending, name: 'Delete requests by source' } },
      { ...base, registry: new Map(), capability: { ...pending, name: 'Update requests by source' } },
      { ...base, registry: new Map(), capability: { ...pending, operations: [], related_entities: [] } },
      { ...base, registry: new Map(), capability: pending, alreadyPublishedCandidateIds: new Set(['source-evidence']) },
      { ...base, registry: new Map(), capability: { ...pending, criticality_factors: [...pending.criticality_factors, 'catalog-outcome-requirement:other'] } },
    ];
    for (const item of rejected) {
      assert.equal(establishPendingCapabilityEvidenceIdentity(item), false);
      assert.equal(item.registry.size, 0);
    }

    const registry = new Map<string, PendingCapabilityEvidenceIdentity>();
    assert.equal(establishPendingCapabilityEvidenceIdentity({ ...base, registry, capability: pending }), true);
    const otherCandidate = { ...candidate, id: 'other-evidence' };
    const otherPending = { ...pending, id: 'other-pending', criticality_factors: ['catalog-candidate:other-evidence'] };
    assert.equal(establishPendingCapabilityEvidenceIdentity({
      ...base, registry, capability: otherPending, candidate: otherCandidate,
      requestedCandidateIds: ['other-evidence'], requiredUncoveredCandidateIds: new Set(['other-evidence']),
    }), false);
    assert.equal(registry.size, 1);
  });

  test('captures a post-reconciliation description failure by exact candidate and preserves one stable identity', () => {
    const registry = new Map<string, PendingCapabilityEvidenceIdentity>();
    const candidate = {
      ...capability('request-list', []), name: 'POST /requests/list', structural_label: 'List request records',
      evidence_kind: 'behavior-surface' as const, evidence_role: 'product-outcome' as const,
      operations: [{ entry_point_id: 'request-list-route', entry_point_type: 'http', action: 'read' }],
      related_entities: ['entity_request'],
    };
    const pending = {
      ...capability('stable-request-list', ['catalog-candidate:request-list']), name: 'View requests',
      operations: candidate.operations, related_entities: candidate.related_entities,
    };
    const establish = (value: SystemCapability) => establishPendingCapabilityEvidenceIdentity({
      registry, capability: value, candidate, requestedCandidateIds: ['request-list'],
      requiredUncoveredCandidateIds: new Set(['request-list']), familyKey: 'request-list-family', audience: 'Users',
      descriptionFailure: 'description-target-not-grounded', alreadyPublishedCandidateIds: new Set(), postReconciliation: true,
    });

    assert.equal(establish(pending), true);
    assert.equal(establish({ ...pending, id: 'new-provider-identity', name: 'Browse requests' }), true);
    assert.equal(registry.size, 1);
    assert.equal(registry.get('request-list')?.identity.id, 'stable-request-list');
    assert.equal(establish({ ...pending, id: 'unrelated', name: 'Open invoices' }), false);
    assert.equal(registry.size, 1);
  });

  test('recognizes record as a create action without conflating other lifecycle actions', () => {
    const candidate = { ...capability('note-evidence', []), name: 'Note', structural_label: 'Note', evidence_kind: 'behavior-surface' as const, evidence_role: 'product-outcome' as const, operations: [{ entry_point_id: 'note-create', entry_point_type: 'event', action: 'create' }], related_entities: ['entity_note'] };
    const pending = { ...capability('record-notes', ['catalog-candidate:note-evidence']), name: 'Record notes', operations: candidate.operations, related_entities: candidate.related_entities };
    const establish = (evidence: SystemCapability) => establishPendingCapabilityEvidenceIdentity({ registry: new Map(), capability: pending, candidate: evidence, requestedCandidateIds: ['note-evidence'], requiredUncoveredCandidateIds: new Set(['note-evidence']), familyKey: 'note-family', audience: 'Users', descriptionFailure: 'description-omits-observed-deletion', alreadyPublishedCandidateIds: new Set(), postReconciliation: true });
    assert.equal(establish(candidate), true);
    assert.equal(establish({ ...candidate, operations: [{ ...candidate.operations[0], action: 'read' }] }), false);
    assert.equal(establish({ ...candidate, operations: [{ ...candidate.operations[0], action: 'update' }] }), false);
    assert.equal(establish({ ...candidate, operations: [{ ...candidate.operations[0], action: 'delete' }] }), false);
  });


  test('description repair names the stable identity and carries prior validator feedback', () => {
    const identity = { ...capability('access', ['catalog-candidate:job']), name: 'Access job sites by user' };
    const batch = { mode: 'description' as const, candidateIds: ['job'], requirements: [], identity };
    const task = capabilityCatalogFocusedTask(batch.mode, identity.name);
    const nudge = capabilityCatalogRepairNudge(batch, [{ candidate_id: 'candidate_1', stable_capability_name: identity.name }], 'missing description', 'Remove marketing-language token organized.');

    assert.match(task, /Access job sites by user/);
    assert.match(task, /stable_capability_name/);
    assert.match(task, /explain that exact audience outcome/);
    assert.match(task, /attached operations retain complete lifecycle proof/);
    assert.match(nudge, /missing description/);
    assert.match(nudge, /Remove marketing-language token organized/);
    assert.match(nudge, /forbidden_subject_terms is prohibited from both name and description/);
    assert.match(nudge, /observable_actions as attached evidence constraints, not prose quotas/);
    assert.doesNotMatch(nudge, /state every.*observable action/i);
    assert.match(nudge, /state that exact audience label in every required location/);
    assert.match(nudge, /description-target-not-grounded/);
    assert.match(nudge, /exact evidence_subject terms/);
    assert.match(nudge, /durable user-outcome language/);
    assert.match(nudge, /6-28 words and at least 30 characters/);
    assert.match(nudge, /returning the current rejected wording is invalid/);
    assert.match(nudge, /not by mechanically enumerating transport or CRUD operation labels/);
    assert.match(nudge, /Do not copy a route phrase/);
    assert.match(nudge, /unsupported-absence-claim/);
    assert.match(nudge, /remove the forbidden absence or benefit clause completely/);
    assert.match(nudge, /description-contradicts-observed-operations/);
    assert.match(nudge, /remove every action outside observable_actions/);
    assert.match(nudge, /destructive effect in ordinary audience language/);
  });

  test('evidence repair asks for scope-relative purpose instead of translating CRUD into the title', () => {
    const batch = { mode: 'evidence' as const, candidateIds: ['job-create'], requirements: [] };
    const nudge = capabilityCatalogRepairNudge(batch, [{
      candidate_id: 'candidate_1', evidence_subject: ['job'], observable_actions: ['create'],
      prior_rejections: [{ reason: 'required-observable-action-missing:create' }],
    }], 'required-observable-action-missing:create');

    assert.match(nudge, /durable, scope-relative user purpose/);
    assert.match(nudge, /Never mirror a CRUD action/);
    assert.match(nudge, /never begin with Manage, Handle, or Process/);
    assert.match(nudge, /return an empty list/);
    assert.match(nudge, /user-defined categories, tags, groups, folders, or profiles/);
    assert.match(nudge, /Never describe internal objects or entities/);
    assert.match(nudge, /do not add a purpose, benefit, or downstream effect/);
    assert.match(nudge, /required-observable-action-missing:create/);
  });
  test('evidence repair names a multi-action subject as one lifecycle outcome', () => {
    const batch = {
      mode: 'evidence' as const,
      candidateIds: ['category-create', 'category-read', 'category-update', 'category-delete'],
      requirements: [] as [],
    };
    const nudge = capabilityCatalogRepairNudge(batch, [], 'incomplete category lifecycle');

    assert.match(nudge, /one product-subject lifecycle as one durable outcome/);
    assert.match(nudge, /cite every supplied candidate_id/);
    assert.match(nudge, /Do not enumerate Create, Read, Update, or Delete in the name/);
    assert.match(nudge, /MUST be a 2-7 word verb phrase/);
    assert.match(nudge, /label ending in Management, Configuration, Tracking, or Maintenance is invalid/);
    assert.match(nudge, /Track budgets/);
    assert.match(nudge, /8-24 word description/);
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

  test('keeps an exact operation repair when its captured broad requirement does not own that candidate', () => {
    const requirement = { id: 'status', statement: 'Manage application status', candidateIds: ['aggregate-status'], subjectTokens: ['status'] };
    const exact = { ...capability('exact-update', ['catalog-candidate:exact-status']), name: 'Update application status', operations: [{ entry_point_id: 'status-change', entry_point_type: 'event', action: 'update' }] };
    const bound = { ...capability('bound-status', ['catalog-candidate:aggregate-status', 'catalog-outcome-requirement:status'], 'Users manage application status throughout review.'), name: 'Manage application status' };
    const result = supersedeUnboundPendingOutcomeDuplicates([bound], [exact], [requirement], new Map([['exact-update', ['status']]]), new Set(['exact-status']));
    assert.deepEqual(result.existing.map(item => item.id), ['bound-status']);
    assert.deepEqual(result.incoming.map(item => item.id), ['exact-update']);
  });

  test('consolidates a protected synonym after transferring its evidence into the authored outcome', () => {
    const requirement = {
      id: 'categorize', statement: 'categorize job applications',
      candidateIds: ['jobs', 'categories'],
      requiredSubjectTerms: ['job', 'application', 'category'],
      subjectTokens: ['job', 'application', 'category'], minimumSubjectMatches: 2,
    };
    const bound = {
      ...capability('bound-categorize', [
        'catalog-candidate:jobs',
        'catalog-outcome-requirement:categorize',
      ], 'Users categorize job applications as their categories change.'),
      name: 'Categorize job applications',
      operations: [{ entry_point_id: 'edit-job', entry_point_type: 'event', action: 'update' }],
    };
    const synonym = {
      ...capability('organize-categories', [
        'catalog-candidate:categories',
      ], 'Users organize job applications by category.'),
      name: 'Organize job applications by category',
      operations: [{ entry_point_id: 'edit-category', entry_point_type: 'http', action: 'update' }],
      related_entities: ['entity_category'],
    };
    const result = supersedeUnboundPendingOutcomeDuplicates(
      [bound], [synonym], [requirement],
      new Map([['candidate:categories', ['categorize']]]),
      new Set(['categories']),
    );
    assert.equal(result.existing.length, 1);
    assert.equal(result.existing[0].id, 'bound-categorize');
    assert.deepEqual(
      result.existing[0].criticality_factors.filter(factor => factor.startsWith('catalog-candidate:')).sort(),
      ['catalog-candidate:categories', 'catalog-candidate:jobs'],
    );
    assert.deepEqual(result.existing[0].operations.map(operation => operation.entry_point_id).sort(), ['edit-category', 'edit-job']);
    assert.deepEqual(result.existing[0].related_entities, ['entity_category']);
    assert.deepEqual(result.incoming, []);

    const inferred = supersedeUnboundPendingOutcomeDuplicates(
      [bound], [synonym], [requirement], new Map(), new Set(['categories']),
    );
    assert.equal(inferred.existing.length, 1);
    assert.equal(inferred.existing[0].id, 'bound-categorize');
    assert.ok(inferred.existing[0].criticality_factors.includes('catalog-candidate:categories'));
    assert.ok(inferred.existing[0].operations.some(operation => operation.entry_point_id === 'edit-category'));
    assert.deepEqual(inferred.incoming, []);
  });

  test('preserves previously covered exact obligations while a same-identity sibling is promoted later', () => {
    const requirement = { id: 'status', statement: 'Manage application status', candidateIds: ['aggregate-status'], subjectTokens: ['status'] };
    const bound = { ...capability('bound-status', ['catalog-candidate:aggregate-status', 'catalog-outcome-requirement:status'], 'Users manage application status throughout review.'), name: 'Manage application status' };
    const firstCandidate = 'operation-obligation:capability_job:804e94f90dbc44ec';
    const secondCandidate = 'operation-obligation:capability_job:aade3daad6ccf9ae';
    const exact = (candidateId: string, entryPointId: string) => ({
      ...capability('capability_update_job_status', [`catalog-candidate:${candidateId}`]),
      name: 'Update job status',
      operations: [{ entry_point_id: entryPointId, entry_point_type: 'event', action: 'update' }],
    });
    const first = exact(firstCandidate, 'status-change');
    const second = exact(secondCandidate, 'status-submit');
    const pendingMatches = new Map([['capability_update_job_status', ['status']]]);
    const protectedCandidates = new Set([firstCandidate, secondCandidate]);

    const cycleThree = supersedeUnboundPendingOutcomeDuplicates(
      [bound], [first], [requirement], pendingMatches, protectedCandidates,
    );
    assert.deepEqual(cycleThree.existing, [bound]);
    assert.deepEqual(cycleThree.incoming, [first]);

    const cycleFour = supersedeUnboundPendingOutcomeDuplicates(
      [...cycleThree.existing, ...cycleThree.incoming], [second], [requirement], pendingMatches, protectedCandidates,
    );
    assert.deepEqual(cycleFour.existing, [bound, first]);
    assert.deepEqual(cycleFour.incoming, [second]);
  });


  test('captures every unbound semantic identity before publishability mutation and preserves its first-seen slots', () => {
    const human = { id: 'human', statement: 'people understand behavior', audience: 'human' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const agent = { id: 'agent', statement: 'agents understand behavior', audience: 'agent' as const, candidateIds: ['shared'], subjectTokens: ['understand', 'behavior'] };
    const combined = { ...capability('combined', ['catalog-candidate:legacy'], 'People and agents understand connected software behavior.'), name: 'Behavior comprehension for people and agents' };
    const map = new Map<string, string[]>();

    captureCapabilityCatalogPendingRequirements(map, [combined], [human, agent]);
    captureCapabilityCatalogPendingRequirements(map, [{ ...combined, name: 'Unrelated renamed identity', description: 'No semantic match remains.' }], [human, agent]);

    assert.deepEqual(map.get('candidate:legacy'), ['human', 'agent']);
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
    const pendingMatches = new Map([['candidate:shared', ['human', 'agent']]]);

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
    const pendingMatches = new Map([['candidate:shared', ['human', 'agent']]]);

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
    const pendingMatches = new Map([['candidate:unrelated', ['graph', 'runtime']]]);

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
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([cleared], [incomingRepair, humanBound], [human], new Map([['candidate:legacy', matched]])), {
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

  test('keeps read filtering distinct from status management while allowing update and manage synonyms', () => {
    const status = { id: 'status', statement: 'manage application status', candidateIds: ['status-surface'], subjectTokens: ['application', 'statu'] };
    const filtering = {
      ...capability('filtering', ['catalog-candidate:list-surface'], 'Users filter applications by status while results update instantly.'),
      name: 'Filter applications by status',
    };
    const updating = { ...capability('updating', ['catalog-candidate:status-surface']), name: 'Update application status' };
    const bound = { ...capability('managed', ['catalog-candidate:status-surface', 'catalog-outcome-requirement:status'], 'Users manage application status through its supported lifecycle.'), name: 'Manage application status' };

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
      [filtering], [bound], [status], new Map([['candidate:list-surface', ['status']]]),
    ), { existing: [filtering], incoming: [bound] });
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
      [updating], [bound], [status], new Map([['candidate:status-surface', ['status']]]),
    ), { existing: [], incoming: [bound] });
  });

  test('keeps a captured pending identity when action evidence is absent or replacements are ambiguous', () => {
    const status = { id: 'status', statement: 'manage application status', candidateIds: ['status-surface'], subjectTokens: ['application', 'statu'] };
    const pending = { ...capability('pending-status', ['catalog-candidate:status-surface']), name: 'Application status' };
    const first = { ...capability('managed-a', ['catalog-candidate:status-surface', 'catalog-outcome-requirement:status'], 'Users manage application status through its supported lifecycle.'), name: 'Manage application status' };
    const second = { ...first, id: 'managed-b' };
    const pendingMatches = new Map([['pending-status', ['status']]]);

    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending], [first], [status], pendingMatches), {
      existing: [pending], incoming: [first],
    });
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates([pending], [first, second], [status], pendingMatches), {
      existing: [pending], incoming: [first, second],
    });
  });

  test('moves newly cited evidence into the unique bound identity for the captured semantic requirement', () => {
    const status = {
      id: 'status', statement: 'manage application status',
      candidateIds: ['cap_job_management', 'capability_job'],
      requiredSubjectTerms: ['application', 'statu'], subjectTokens: ['application', 'statu'], minimumSubjectMatches: 2,
    };
    const bound = {
      ...capability('status-bound', ['catalog-candidate:cap_job_management', 'catalog-outcome-requirement:status'], 'Users maintain the current status of each job application.'),
      name: 'Manage application status',
      operations: [{ entry_point_id: 'status-list', entry_point_type: 'route', action: 'read' }],
      related_entities: ['entity_status'],
    };
    const evidenceRepair = {
      ...capability('status-evidence', ['catalog-candidate:capability_job'], 'Users track job applications and update their current status.'),
      name: 'Track job applications and update their status',
      operations: [{ entry_point_id: 'job-change', entry_point_type: 'event', action: 'update' }],
      related_entities: ['entity_job'],
    };

    const result = supersedeUnboundPendingOutcomeDuplicates(
      [bound], [evidenceRepair], [status], new Map([['candidate:capability_job', ['status']]]),
    );

    assert.equal(result.existing.length, 1);
    assert.equal(result.existing[0].id, 'status-bound');
    assert.equal(result.existing[0].name, 'Manage application status');
    assert.equal(result.existing[0].description, bound.description);
    assert.deepEqual(result.existing[0].criticality_factors, [
      'catalog-candidate:cap_job_management',
      'catalog-outcome-requirement:status',
      'catalog-candidate:capability_job',
    ]);
    assert.deepEqual(result.existing[0].operations.map(operation => operation.entry_point_id), ['status-list', 'job-change']);
    assert.deepEqual(result.existing[0].related_entities, ['entity_status', 'entity_job']);
    assert.deepEqual(result.incoming, []);
  });

  test('does not move evidence across candidate, semantic, requirement, or replacement-uniqueness boundaries', () => {
    const status = {
      id: 'status', statement: 'manage application status',
      candidateIds: ['cap_job_management', 'capability_job'],
      requiredSubjectTerms: ['application', 'statu'], subjectTokens: ['application', 'statu'], minimumSubjectMatches: 2,
    };
    const notes = {
      id: 'notes', statement: 'manage application notes',
      candidateIds: ['cap_note_management'],
      requiredSubjectTerms: ['application', 'note'], subjectTokens: ['application', 'note'], minimumSubjectMatches: 2,
    };
    const bound = {
      ...capability('status-bound', ['catalog-candidate:cap_job_management', 'catalog-outcome-requirement:status'], 'Users maintain the current status of each job application.'),
      name: 'Manage application status',
    };
    const secondBound = { ...bound, id: 'status-bound-two' };
    const evidence = {
      ...capability('evidence', ['catalog-candidate:capability_job'], 'Users track job applications and update their current status.'),
      name: 'Track job applications and update their status',
      operations: [{ entry_point_id: 'job-change', entry_point_type: 'event', action: 'update' }],
      related_entities: ['entity_job'],
    };
    const cases: Array<{ existing: SystemCapability[]; repair: SystemCapability; requirements: CapabilityCatalogOutcomeRequirement[]; captured: string[] }> = [
      { existing: [bound], repair: { ...evidence, criticality_factors: ['catalog-candidate:foreign'] }, requirements: [status], captured: ['status'] },
      { existing: [bound], repair: { ...evidence, name: 'Review invoices', description: 'Users review invoices before payment.' }, requirements: [status], captured: ['status'] },
      { existing: [bound], repair: evidence, requirements: [status, notes], captured: ['status', 'notes'] },
      { existing: [bound, secondBound], repair: evidence, requirements: [status], captured: ['status'] },
    ];

    for (const item of cases) {
      const result = supersedeUnboundPendingOutcomeDuplicates(
        item.existing, [item.repair], item.requirements, new Map([[item.repair.id, item.captured]]),
      );
      for (const retained of result.existing) {
        assert.equal(retained.criticality_factors.includes('catalog-candidate:capability_job'), false);
        assert.equal(retained.operations.some(operation => operation.entry_point_id === 'job-change'), false);
      }
    }
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
      name: 'Equip AI agents to understand software for dependable change planning',
    };
    assert.deepEqual(supersedeUnboundPendingOutcomeDuplicates(
      [pending], [replacement], [requirement], new Map([['candidate:legacy', ['agent-understanding']]]),
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

  test('builds exact-action identities from obligation product subjects without UI container vocabulary', () => {
    const cases = [
      { action: 'delete', expected: 'Remove categories' },
      { action: 'update', expected: 'Update categories' },
      { action: 'read', expected: 'View categories' },
    ];
    for (const { action, expected } of cases) {
      const id = `operation-obligation:categories:${action}`;
      const candidate = {
        ...capability(id, [], ''),
        name: `${action} category card`,
        structural_label: `${action} category card modal component`,
        related_entities: ['entity_category'],
        operations: [{
          entry_point_id: `${action}-category`,
          entry_point_type: 'event',
          action,
          evidence_examples: ['CategoryCard modal component'],
        }],
      };
      const authored = {
        ...capability('shared-generated-id', ['catalog-source:grounded', 'catalog-candidate:wrong'], ''),
        name: 'Categorize records',
        related_entities: [],
        operations: [],
      };
      let validated = false;
      const fallback = deterministicCapabilityActionIdentityFallback({
        capability: authored,
        candidate,
        audience: 'Users',
        relatedEntityLabels: ['Category'],
        validate: item => {
          validated = true;
          return item.name === expected
            && !/card|component|modal/i.test(`${item.name} ${item.description}`)
            && String(item.description || '').trim().split(/\s+/).length >= 12;
        },
      });
      assert.equal(validated, true);
      assert.equal(fallback?.id, authored.id);
      assert.equal(fallback?.name, expected);
      assert.equal(fallback?.name_source, 'deterministic');
      assert.deepEqual(fallback?.operations, candidate.operations);
      assert.deepEqual(fallback?.criticality_factors, ['catalog-source:grounded', `catalog-candidate:${id}`]);
    }
  });

  test('grounds a plural structural subject to one authoritative entity despite incidental metadata entities', () => {
    const candidate = {
      ...capability('jobs-read', [], ''),
      name: 'Jobs',
      structural_label: 'Jobs Management',
      related_entities: ['entity_job', 'entity_note'],
      operations: [{ entry_point_id: 'jobs-route', entry_point_type: 'route', action: 'read' }],
    };
    const fallback = deterministicCapabilityActionIdentityFallback({
      capability: { ...capability('generated', [], ''), name: 'View records' },
      candidate,
      audience: 'Users',
      relatedEntityLabels: ['Job', 'Note'],
      allowUniqueStructuralSubject: true,
      validate: () => true,
    });
    assert.equal(fallback?.name, 'View jobs');
    const ambiguous = { ...candidate, structural_label: 'Jobs Notes Management' };
    assert.equal(deterministicCapabilityActionIdentityFallback({
      capability: { ...capability('generated', [], ''), name: 'View records' },
      candidate: ambiguous,
      audience: 'Users',
      relatedEntityLabels: ['Job', 'Note'],
      allowUniqueStructuralSubject: true,
      validate: () => true,
    }), undefined);
  });

  test('falls back to an exact related entity label and fails closed without a product subject', () => {
    const candidate = {
      ...capability('operation-obligation:categories:delete', [], ''),
      name: 'delete card',
      structural_label: 'delete card modal component',
      related_entities: ['entity_category'],
      operations: [{ entry_point_id: 'delete-category', entry_point_type: 'event', action: 'delete' }],
    };
    const authored = { ...capability('generated', [], ''), name: 'Delete records' };
    assert.equal(deterministicCapabilityActionIdentityFallback({
      capability: authored, candidate, audience: 'Users', relatedEntityLabels: ['Category'], validate: () => true,
    })?.name, 'Remove categories');
    assert.equal(deterministicCapabilityActionIdentityFallback({
      capability: authored, candidate, audience: 'Users', validate: () => true,
    }), undefined);
    const ambiguous = {
      ...candidate,
      name: 'delete category job',
      structural_label: 'delete category job',
      related_entities: ['entity_category', 'entity_job'],
    };
    assert.equal(deterministicCapabilityActionIdentityFallback({
      capability: authored, candidate: ambiguous, audience: 'Users',
      relatedEntityLabels: ['Category', 'Job'], validate: () => true,
    }), undefined);
  });

  test('uses exact page-operation subjects for bounded deterministic recovery', () => {
    const pageCandidate = {
      ...capability('capability_page_locationdisplay', [], ''),
      name: 'Page LocationDisplay',
      structural_label: 'read location display page',
      operations: [{ entry_point_id: 'page-location', entry_point_type: 'page', action: 'read' }],
      related_entities: ['entity_location', 'entity_media_location'],
    };
    const recovered = deterministicCapabilityActionIdentityFallback({
      capability: { ...capability('pending-location', [], ''), name: 'Location display' },
      candidate: pageCandidate,
      audience: 'Users',
      allowUniqueStructuralSubject: true,
      relatedEntityLabels: ['Location', 'MediaLocation'],
      validate: item => item.name === 'View location displays'
        && /Users/.test(item.description || '')
        && /location displays/.test(item.description || ''),
    });
    assert.equal(recovered?.name, 'View location displays');
  });

  test('uses the grounded audience rather than presentation nouns for authentication recovery', () => {
    const authCandidate = {
      ...capability('operation-obligation:capability_page:sign', [], ''),
      name: 'Page Sign In',
      structural_label: 'authenticate page sign',
      operations: [{ entry_point_id: 'page-sign-in', entry_point_type: 'page', action: 'authenticate' }],
    };
    const recovered = deterministicCapabilityActionIdentityFallback({
      capability: { ...capability('pending-auth', [], ''), name: 'Sign in' },
      candidate: authCandidate,
      audience: 'Users',
      allowUniqueStructuralSubject: true,
      validate: item => item.name === 'Authenticate users'
        && /Users/.test(item.description || '')
        && !/authenticate pages/i.test(item.description || ''),
    });
    assert.equal(recovered?.name, 'Authenticate users');
    assert.equal(recovered?.criticality_factors.includes(`catalog-candidate:${authCandidate.id}`), true);
  });


  test('retains an exact interactive fetch verb and grounded form subject in deterministic recovery', () => {
    const candidate = {
      ...capability('operation-obligation:job:fetch', [], ''),
      name: 'Fetch job details',
      structural_label: 'Fetch job details',
      related_entities: ['entity_job'],
      operations: [{ entry_point_id: 'fetch-job', entry_point_type: 'event', action: 'read' }],
      evidence_examples: ['Fetch job', 'jobDetails'],
    };
    const fallback = deterministicCapabilityActionIdentityFallback({
      capability: { ...capability('generated', [], ''), name: 'Categorize job applications' },
      candidate,
      audience: 'Users',
      relatedEntityLabels: ['Job'],
      validate: item => item.name === 'Fetch job details' && /Users/.test(item.description || ''),
    });
    assert.equal(fallback?.name, 'Fetch job details');
    assert.equal(fallback?.criticality_factors.includes(`catalog-candidate:${candidate.id}`), true);
  });


  test('requires the exact grounded interaction verb for a typed fetch-and-fill obligation', () => {
    const candidate = {
      ...capability('operation-obligation:job:fetch', [], ''),
      name: 'Fetch job details',
      structural_label: 'Fetch job details',
      operations: [{ entry_point_id: 'fetch-job', entry_point_type: 'event', action: 'read' }],
    };
    assert.equal(pendingCapabilityEvidenceObservableActionFailure({ name: 'View job details' }, candidate),
      'required-observable-interaction-missing:fetch');
    assert.equal(pendingCapabilityEvidenceObservableActionFailure({ name: 'Fetch job details' }, candidate), undefined);
  });

});
