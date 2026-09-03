import type { SystemCapability } from '../../types/cas.types';
import { canonicalCapabilityLifecycleAction } from './capability-lifecycle-actions';
import { hasAuthoritativeCapabilityOperationSubjectLineage, uncoveredRequiredCapabilityOperations, type CapabilityOperationCoverageContext } from './capability-operation-coverage';
import { normalizeCapabilityDescriptionForPublication } from './capability-catalog-audience';
import { capabilityEvidenceSubjectTokens } from './capability-catalog-evidence';
import { normalizedSubjectTokens, outcomeIdentityTokens, outcomeTokenMatches } from './capability-evidence-language';
import { capabilityCatalogOutcomeCoverageFailure, uncoveredCapabilityCatalogOutcomeRequirements, type CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';
import {
  capabilityCatalogEvidenceRepairMatchIndexes,
  capabilityIdentityPendingDescriptionRepair,
  selectValidatedCapabilityDescriptionRepair,
} from './capability-catalog-scheduling';
import {
  deterministicCapabilityDescriptionFallback,
  deterministicCapabilityActionIdentityFallback,
  capabilityCatalogRepairLifecycleKey,
  capabilityTextObservableActionFailure,
  establishPendingCapabilityEvidenceIdentity,
  pendingCapabilityEvidenceObservableActionFailure,
  preserveCapabilityCatalogDescriptionIdentity,
  type PendingCapabilityEvidenceIdentity,
} from './capability-catalog-repair-plan';

export function hasPendingCapabilityDescriptionAttempt(
  registry: ReadonlyMap<string, PendingCapabilityEvidenceIdentity>,
  attemptsByLifecycleKey: ReadonlyMap<string, number>,
): boolean {
  return [...registry.values()].some(entry => (attemptsByLifecycleKey.get(capabilityCatalogRepairLifecycleKey(entry.identity)) || 0) < 2);
}

export function hasPendingCapabilityLanguageAttempt(
  capabilities: readonly SystemCapability[],
  attemptsByLifecycleKey: ReadonlyMap<string, number>,
): boolean {
  return capabilities.some(capability =>
    capability.name_source === 'deterministic' &&
    (capability.criticality_factors || []).includes('catalog-deterministic-grouped-lifecycle') &&
    /^(?:manage|handle|process)(?:s|d|ing)?\b/i.test(String(capability.name || '').trim()) &&
    (attemptsByLifecycleKey.get(capabilityCatalogRepairLifecycleKey(capability)) || 0) < 2);
}

function validateExactGenericGroupedNameRepair(
  _original: SystemCapability,
  repaired: SystemCapability,
  validate: (capability: SystemCapability) => boolean,
): boolean {
  return validate(repaired);
}

export function resolveCapabilityCatalogDescriptionRepair(args: {
  validated: SystemCapability[];
  attempt: number;
  identity: SystemCapability;
  attemptedFallbackIdentityIds: Set<string>;
  pendingEvidenceIdentityByCandidateId: Map<string, PendingCapabilityEvidenceIdentity>;
  evidenceCandidates: readonly SystemCapability[];
  audience?: string;
  firstPartyTexts: readonly string[];
  allowNameRepair?: boolean;
  validate: (capability: SystemCapability) => boolean;
}): SystemCapability[] {
  const fullyValidatedRepairs: SystemCapability[] = [];
  const normalizedRepairs = args.validated.map(repair => {
    if (args.validate(repair)) {
      fullyValidatedRepairs.push(repair);
      return repair;
    }
    const description = String(repair.description || '')
      .replace(/(?:,\s*with\b|\s+to\s+(?:ensure|maintain|provide|support|enable|improve)\b)[^.!?]*[.!?]?$/i, '')
      .replace(/[,;:]\s*$/, '')
      .trim();
    if (!description || description === repair.description) return repair;
    const normalized = {
      ...repair,
      description: /[.!?]$/.test(description) ? description : description + '.',
      description_source: 'deterministic' as const,
      description_generation: { status: 'deterministic_kept' as const, attempted: true, reason: 'unsupported-description-claim-removed' },
    };
    if (args.validate(normalized)) fullyValidatedRepairs.push(normalized);
    return normalized;
  });
  const safeDescriptionIdentity = args.allowNameRepair
    ? deterministicCapabilityDescriptionFallback({
      identity: args.identity,
      evidenceCandidates: args.evidenceCandidates,
      audience: args.audience,
      firstPartyTexts: args.firstPartyTexts,
      validate: () => true,
    }) || args.identity
    : args.identity;
  const nameOnlyRepairs = args.allowNameRepair && fullyValidatedRepairs.length === 0
    ? normalizedRepairs.map(repair => ({
      ...safeDescriptionIdentity,
      name: repair.name,
      name_source: repair.name_source,
    })).filter(args.validate)
    : [];
  const validatedRepairs = fullyValidatedRepairs.length > 0 ? fullyValidatedRepairs : nameOnlyRepairs;
  const repaired = selectValidatedCapabilityDescriptionRepair(validatedRepairs, args.attempt, () => {
    const lifecycleKey = capabilityCatalogRepairLifecycleKey(args.identity);
    if (args.attemptedFallbackIdentityIds.has(lifecycleKey)) return undefined;
    args.attemptedFallbackIdentityIds.add(lifecycleKey);
    const pendingEvidence = [...args.pendingEvidenceIdentityByCandidateId.values()].find(entry => capabilityCatalogRepairLifecycleKey(entry.identity) === lifecycleKey);
    if (pendingEvidence) pendingEvidence.fallbackAttempted = true;
    return deterministicCapabilityDescriptionFallback({
      identity: args.identity,
      evidenceCandidates: args.evidenceCandidates,
      audience: pendingEvidence?.audience || args.audience,
      firstPartyTexts: args.firstPartyTexts,
      repairGenericGroupedName: args.allowNameRepair,
      validate: capability => args.allowNameRepair
        ? validateExactGenericGroupedNameRepair(args.identity, capability, args.validate)
        : args.validate(capability),
    });
  });
  if (!repaired) return [];
  if (!validatedRepairs[0]) return [repaired];
  const preserved = preserveCapabilityCatalogDescriptionIdentity(args.identity, repaired);
  return [args.allowNameRepair ? {
    ...preserved,
    name: repaired.name,
    name_source: repaired.name_source,
    criticality_factors: [...new Set([
      ...(preserved.criticality_factors || []),
      `catalog-description-repair-lifecycle:${capabilityCatalogRepairLifecycleKey(args.identity)}`,
    ])],
  } : preserved];
}

export function resolvePendingCapabilityDescriptionsWithoutProvider(args: {
  capabilities: readonly SystemCapability[];
  pendingEvidenceIdentityByCandidateId: ReadonlyMap<string, PendingCapabilityEvidenceIdentity>;
  evidenceCandidates: readonly SystemCapability[];
  firstPartyTexts: readonly string[];
  audienceFor: (capability: SystemCapability) => string | undefined;
  validate: (capability: SystemCapability) => boolean;
}): SystemCapability[] {
  const pendingByLifecycleKey = new Map([...args.pendingEvidenceIdentityByCandidateId.values()]
    .map(pending => [capabilityCatalogRepairLifecycleKey(pending.identity), pending]));
  return args.capabilities.map(capability => {
    const pending = pendingByLifecycleKey.get(capabilityCatalogRepairLifecycleKey(capability));
    const repairGenericGroupedName = capability.name_source === "deterministic" &&
      (capability.criticality_factors || []).includes("catalog-deterministic-grouped-lifecycle") &&
      /^(?:manage|handle|process)(?:s|d|ing)?\b/i.test(String(capability.name || "").trim());
    const boundOutcomePending = (capability.criticality_factors || [])
      .some(factor => factor.startsWith("catalog-outcome-requirement:")) &&
      (!String(capability.description || "").trim() || capability.description_generation?.status === "ai_rejected");
    const descriptionWordCount = String(capability.description || "").trim().split(/s+/).filter(Boolean).length;
    const weakDescription = capability.description_generation?.status !== "ai_rejected" && (descriptionWordCount < 6 || descriptionWordCount > 32);
    if (!pending && !repairGenericGroupedName && !boundOutcomePending && !weakDescription) return capability;
    const repaired = deterministicCapabilityDescriptionFallback({
      identity: repairGenericGroupedName ? capability : pending?.identity || capability, evidenceCandidates: args.evidenceCandidates,
      audience: pending?.audience || args.audienceFor(capability), firstPartyTexts: args.firstPartyTexts,
      repairGenericGroupedName,
      validate: candidate => repairGenericGroupedName
        ? validateExactGenericGroupedNameRepair(capability, candidate, args.validate)
        : args.validate(candidate),
    });
    if (!repaired) return capability;
    const preserved = preserveCapabilityCatalogDescriptionIdentity(capability, repaired);
    return repairGenericGroupedName
      ? { ...preserved, name: repaired.name, name_source: repaired.name_source }
      : preserved;
  });
}

export function retireIndependentlyCoveredPendingDescriptions(args: {
  capabilities: readonly SystemCapability[];
  pendingEvidenceIdentityByCandidateId: ReadonlyMap<string, PendingCapabilityEvidenceIdentity>;
  evidenceCandidates: readonly SystemCapability[];
  operationCoverageContext: CapabilityOperationCoverageContext;
  outcomeRequirements: readonly CapabilityCatalogOutcomeRequirement[];
  isPublishable: (capability: SystemCapability) => boolean;
}): SystemCapability[] {
  const pendingLifecycleKeys = new Set([...args.pendingEvidenceIdentityByCandidateId.values()]
    .map(pending => capabilityCatalogRepairLifecycleKey(pending.identity)));
  const evidenceById = new Map(args.evidenceCandidates.map(candidate => [candidate.id, candidate]));
  const requirementsById = new Map(args.outcomeRequirements.map(requirement => [requirement.id, requirement]));
  const factorIds = (capability: SystemCapability, prefix: string): string[] => [...new Set((capability.criticality_factors || [])
    .filter(factor => factor.startsWith(prefix)).map(factor => factor.slice(prefix.length)).filter(Boolean))];
  return args.capabilities.filter((capability, index) => {
    if (args.isPublishable(capability) || !pendingLifecycleKeys.has(capabilityCatalogRepairLifecycleKey(capability))) return true;
    const authoritativeIds = [...new Set([
      ...factorIds(capability, 'catalog-candidate:'),
      ...factorIds(capability, 'catalog-operation-obligation:'),
    ])];
    const authoritativeCandidates = authoritativeIds.map(id => evidenceById.get(id));
    if (authoritativeIds.length === 0 || authoritativeCandidates.some(candidate => !candidate)) return true;
    const independentlyPublishable = args.capabilities.filter((candidate, candidateIndex) =>
      candidateIndex !== index && args.isPublishable(candidate));
    if (authoritativeCandidates.some(candidate => {
      if (!candidate) return true;
      const required = uncoveredRequiredCapabilityOperations(candidate, [], args.operationCoverageContext);
      return required.length === 0 || uncoveredRequiredCapabilityOperations(candidate, independentlyPublishable, args.operationCoverageContext).length > 0;
    })) return true;
    const outcomeIds = factorIds(capability, 'catalog-outcome-requirement:');
    const boundRequirements = outcomeIds.map(id => requirementsById.get(id));
    if (boundRequirements.some(requirement => !requirement)) return true;
    if (uncoveredCapabilityCatalogOutcomeRequirements(
      independentlyPublishable,
      boundRequirements.filter((requirement): requirement is CapabilityCatalogOutcomeRequirement => Boolean(requirement)),
      args.isPublishable,
    ).length > 0) return true;
    return false;
  });
}

export function normalizeTargetedCapabilityCatalogDescriptions(
  capabilities: SystemCapability[],
  publicationEvidenceTerms: readonly string[],
): SystemCapability[] {
  return capabilities.map(capability => {
    const description = normalizeCapabilityDescriptionForPublication(capability.description, [...publicationEvidenceTerms]);
    if (description === capability.description) return capability;
    return {
      ...capability,
      description,
      description_source: 'deterministic',
      description_generation: { status: 'deterministic_kept', attempted: true, reason: 'unsupported-description-claim-removed' },
    };
  });
}



export function filterMismatchedOperationObligationCapabilities(args: {
  capabilities: readonly SystemCapability[];
  evidenceCandidates: readonly SystemCapability[];
  recordRejection?: (feedback: { candidateIds: string[]; name: string; reason: string }) => void;
  actionMismatchAttemptsByCandidateId?: Map<string, number>;
  recoverActionMismatch?: (capability: SystemCapability, candidate: SystemCapability) => SystemCapability | undefined;
  actionEvidenceDescriptionFor?: (capability: SystemCapability) => string | undefined;
}): SystemCapability[] {
  const evidenceById = new Map(args.evidenceCandidates.map(candidate => [candidate.id, candidate]));
  const handledMismatchCandidateIds = new Set<string>();
  const authoredSubjectTokens = (capability: SystemCapability): string[] =>
    outcomeIdentityTokens([capability.name, capability.description].filter(Boolean).join(' '));
  const subjectFailure = (capability: SystemCapability, candidate: SystemCapability): string | undefined => {
    const semanticEvidenceSubjects = capabilityEvidenceSubjectTokens(candidate);
    const actionWords = new Set([
      'add', 'archive', 'browse', 'cancel', 'categorize', 'change', 'close', 'create', 'delete', 'edit', 'fetch',
      'filter', 'find', 'get', 'list', 'maintain', 'manage', 'organize', 'publish', 'read', 'record', 'register',
      'remove', 'retrieve', 'search', 'show', 'submit', 'track', 'update', 'view', 'withdraw',
    ]);
    let foundSubject = false;
    const labelTokens = [...normalizedSubjectTokens(candidate.structural_label || candidate.name)];
    const labelSubjects = labelTokens.filter((token, index) => {
      if (!foundSubject && index < labelTokens.length - 1 && (actionWords.has(token) || token === 'and')) return false;
      foundSubject = true;
      return true;
    });
    const evidenceSubjects = semanticEvidenceSubjects.length > 0 ? semanticEvidenceSubjects : labelSubjects;
    const authoredSubjects = new Set(authoredSubjectTokens(capability));
    return evidenceSubjects.length > 0 && evidenceSubjects.some(subject => outcomeTokenMatches(subject, authoredSubjects))
      ? undefined
      : 'required-observable-subject-missing:' + evidenceSubjects.join(',');
  };
  const scopeToCandidates = (capability: SystemCapability, candidates: readonly SystemCapability[]): SystemCapability => {
    const operations = [...new Map(candidates.flatMap(candidate => candidate.operations || [])
      .map(operation => [JSON.stringify(operation), operation])).values()];
    return {
      ...capability,
      operations,
      related_entities: [...new Set(candidates.flatMap(candidate => candidate.related_entities || []))],
      related_domains: [...new Set(candidates.flatMap(candidate => candidate.related_domains || []))],
      criticality_factors: [...new Set([
        ...(capability.criticality_factors || []).filter(factor =>
          !factor.startsWith('catalog-candidate:') &&
          !factor.startsWith('catalog-parent-candidate:') &&
          !factor.startsWith('catalog-operation-obligation:')),
        ...candidates.flatMap(candidate => [
          'catalog-candidate:' + candidate.id,
          'catalog-operation-obligation:' + candidate.id,
        ]),
      ])],
    };
  };
  return args.capabilities.flatMap(capability => {
    const citations = [...new Set((capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length)))];
    const obligationCitations = citations.filter(candidateId => candidateId.startsWith('operation-obligation:'));
    if (obligationCitations.length === 0) return [capability];
    const actionEvidenceDescription = args.actionEvidenceDescriptionFor?.(capability);
    const actionEvidenceCapability = actionEvidenceDescription
      ? { ...capability, description: actionEvidenceDescription } : capability;

    const compatibleCandidates: SystemCapability[] = [];
    const rejectedCandidates: SystemCapability[] = [];
    for (const candidateId of obligationCitations) {
      const candidate = evidenceById.get(candidateId);
      if (!candidate) {
        args.recordRejection?.({ candidateIds: [candidateId], name: capability.name, reason: 'operation-obligation-citation-unresolved' });
        continue;
      }
      const failure = capabilityTextObservableActionFailure(actionEvidenceCapability, candidate) || subjectFailure(capability, candidate);
      if (failure) {
        args.recordRejection?.({ candidateIds: [candidateId], name: capability.name, reason: failure });
        rejectedCandidates.push(candidate);
      }
      else compatibleCandidates.push(candidate);
    }
    if (compatibleCandidates.length > 0) return [scopeToCandidates(capability, compatibleCandidates)];

    const recovered: SystemCapability[] = [];
    for (const candidate of rejectedCandidates) {
      if (handledMismatchCandidateIds.has(candidate.id)) continue;
      handledMismatchCandidateIds.add(candidate.id);
      const attempts = args.actionMismatchAttemptsByCandidateId;
      attempts?.set(candidate.id, (attempts.get(candidate.id) || 0) + 1);
      const fallback = args.recoverActionMismatch?.(capability, candidate);
      if (!fallback || capabilityTextObservableActionFailure(fallback, candidate) || subjectFailure(fallback, candidate)) continue;
      recovered.push(scopeToCandidates(fallback, [candidate]));
    }
    return recovered;
  });
}

export function stageRejectedCapabilityNameRepair(args: {
  capability: SystemCapability;
  reason: string;
  repairableCandidateIds: ReadonlySet<string>;
  evidenceCandidates: readonly SystemCapability[];
  registry: Map<string, PendingCapabilityEvidenceIdentity>;
  audience?: string;
}): boolean {
  const candidateIds = (args.capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:'))
    .map(factor => factor.slice('catalog-candidate:'.length));
  if (candidateIds.length !== 1 || !args.repairableCandidateIds.has(candidateIds[0])) return false;
  const candidate = args.evidenceCandidates.find(item => item.id === candidateIds[0]);
  if (!candidate) return false;
  const identity: SystemCapability = {
    ...args.capability,
    description: '',
    criticality_factors: [...new Set([...(args.capability.criticality_factors || []), 'catalog-name-repair-required'])],
    description_source: undefined,
    description_generation: { attempted: true, status: 'ai_rejected', reason: args.reason },
  };
  return establishPendingCapabilityEvidenceIdentity({
    registry: args.registry, capability: identity, candidate, requestedCandidateIds: candidateIds,
    requiredUncoveredCandidateIds: new Set(candidateIds), familyKey: `product-outcome:${candidate.id}`,
    audience: args.audience, descriptionFailure: args.reason, alreadyPublishedCandidateIds: new Set(),
  });
}

export function stagePendingCapabilityEvidenceRepairs(args: {
  cycleCapabilities: SystemCapability[];
  reconciled: SystemCapability[];
  registry: Map<string, PendingCapabilityEvidenceIdentity>;
  evidenceCandidates: readonly SystemCapability[];
  evidenceRepairCandidateIds: ReadonlySet<string>;
  requiredUncoveredCandidateIds: ReadonlySet<string>;
  exactOperationCandidateIds?: ReadonlySet<string>;
  familyKeyByCandidateId: ReadonlyMap<string, string>;
  descriptionFailureByCapabilityId: ReadonlyMap<string, string>;
  isPublishable: (capability: SystemCapability) => boolean;
  audienceFor: (capability: SystemCapability) => string | undefined;
  recordRejection?: (feedback: { candidateIds: string[]; name: string; reason: string }) => void;
  promotedIdentityIds?: Set<string>;
  promotedCandidateIds?: Set<string>;
  promotedCapabilitiesByCandidateId?: Map<string, SystemCapability>;
  stagedCandidateIds?: Set<string>;
}): Set<string> {
  const registryIdentityIds = new Set<string>();
  const publishedCandidateIds = new Set(args.reconciled.flatMap(capability => (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:')).map(factor => factor.slice('catalog-candidate:'.length))
    .filter(candidateId => !args.exactOperationCandidateIds?.has(candidateId))));
  for (const capability of args.cycleCapabilities) {
    const citations = (capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:')).map(factor => factor.slice('catalog-candidate:'.length));
    const citedCandidateId = citations.length === 1 ? citations[0] : undefined;
    const existingPending = citedCandidateId ? args.registry.get(citedCandidateId) : undefined;
    if (existingPending) {
      const preserved = preserveCapabilityCatalogDescriptionIdentity(existingPending.identity, capability);
      const repairsName = (existingPending.identity.criticality_factors || []).includes('catalog-name-repair-required');
      const replacement = repairsName ? {
        ...preserved,
        name: capability.name,
        name_source: capability.name_source,
        criticality_factors: (preserved.criticality_factors || []).filter(factor => factor !== 'catalog-name-repair-required'),
      } : preserved;
      if (args.isPublishable(replacement)) {
        args.registry.delete(existingPending.candidateId);
        args.promotedIdentityIds?.add(existingPending.identity.id);
        args.promotedCandidateIds?.add(existingPending.candidateId);
        args.promotedCapabilitiesByCandidateId?.set(existingPending.candidateId, replacement);
      }
      else {
        registryIdentityIds.add(existingPending.identity.id);
        args.stagedCandidateIds?.add(existingPending.candidateId);
      }
      continue;
    }
    if (citations.length !== 1 || !args.evidenceRepairCandidateIds.has(citations[0])) continue;
    const matches = capabilityCatalogEvidenceRepairMatchIndexes(
      args.reconciled, capability, args.evidenceCandidates, args.evidenceRepairCandidateIds,
    );
    if (matches.length === 1) continue;
    const candidate = args.evidenceCandidates.find(item => item.id === citations[0]);
    const descriptionFailure = args.descriptionFailureByCapabilityId.get(capabilityCatalogRepairLifecycleKey(capability)) || 'description-evidence-repair-confirmation-required';
    const pendingCapability = args.isPublishable(capability)
      ? capabilityIdentityPendingDescriptionRepair(capability, descriptionFailure)
      : capability;
    if (!pendingCapability) continue;
    const established = establishPendingCapabilityEvidenceIdentity({
      registry: args.registry,
      capability: pendingCapability,
      candidate,
      requestedCandidateIds: citations,
      requiredUncoveredCandidateIds: args.requiredUncoveredCandidateIds,
      familyKey: args.familyKeyByCandidateId.get(citations[0]) || (args.exactOperationCandidateIds?.has(citations[0]) ? 'operation:' + citations[0] : undefined),
      audience: args.audienceFor(capability),
      descriptionFailure,
      alreadyPublishedCandidateIds: publishedCandidateIds,
      postReconciliation: true,
    });
    if (established) {
      registryIdentityIds.add(capability.id);
      args.stagedCandidateIds?.add(citations[0]);
    }
    else if (candidate) {
      const actionFailure = pendingCapabilityEvidenceObservableActionFailure(capability, candidate);
      if (actionFailure) args.recordRejection?.({ candidateIds: [candidate.id], name: capability.name, reason: actionFailure });
    }
  }
  return registryIdentityIds;
}

export function validatedDeterministicAtomicClosures(args: {
  candidateIds: readonly string[]; evidenceCandidates: readonly SystemCapability[];
  audienceFor: (candidate: SystemCapability) => string | undefined;
  entityLabelsFor: (candidate: SystemCapability) => readonly string[];
  operationCoverageContext?: CapabilityOperationCoverageContext;
  completeLifecycleCandidateIds?: ReadonlySet<string>;
  validate: (capability: SystemCapability) => boolean;
}): SystemCapability[] {
  const evidenceById = new Map(args.evidenceCandidates.map(candidate => [candidate.id, candidate]));
  const closures: SystemCapability[] = [];
  for (const candidateId of [...new Set(args.candidateIds)].sort()) {
    const candidate = evidenceById.get(candidateId);
    if (!candidate || (candidate.operations || []).length === 0) continue;
    const authoritativeLineage = args.operationCoverageContext
      ? hasAuthoritativeCapabilityOperationSubjectLineage(candidate, args.operationCoverageContext)
      : false;
    const exactHttpRouteLineage = (candidate.operations || []).every(operation => {
      const method = String(operation.trigger?.method || '').trim();
      const triggerPath = String(operation.trigger?.path || '').trim();
      const commandPath = String(operation.path_or_command || '').trim();
      return operation.entry_point_type === 'http' && Boolean(method && triggerPath && triggerPath === commandPath);
    });
    const completeLifecycleLineage = authoritativeLineage || exactHttpRouteLineage;
    const obligationFactor = candidateId.startsWith('operation-obligation:')
      ? [`catalog-operation-obligation:${candidateId}`] : [];
    const identity: SystemCapability = {
      ...candidate, id: `capability_atomic_${candidateId.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`,
      name: candidate.structural_label || candidate.name, description: '', name_source: 'deterministic',
      operations: [...(candidate.operations || [])], related_entities: [...(candidate.related_entities || [])],
      criticality_factors: [`catalog-candidate:${candidateId}`, ...obligationFactor, 'catalog-deterministic-atomic-closure',
        ...(exactHttpRouteLineage ? ['catalog-deterministic-route-lineage'] : []),
        ...(!candidateId.startsWith('operation-obligation:') && candidate.evidence_kind !== 'behavior-surface' ? ['catalog-deterministic-single-operation-aggregate'] : [])],
    };
    const audience = args.audienceFor(candidate) || (exactHttpRouteLineage &&
      (candidate.evidence_role_reasons || []).some(reason => reason.startsWith('user-facing-'))
      ? 'Users' : undefined);
    const draft = deterministicCapabilityActionIdentityFallback({
      capability: identity, candidate, audience,
      relatedEntityLabels: args.entityLabelsFor(candidate),
      allowUniqueStructuralSubject: completeLifecycleLineage,
      allowGroupedLifecycle: completeLifecycleLineage && Boolean(args.completeLifecycleCandidateIds?.has(candidateId)),
      validate: () => true,
    });
    const accepted = Boolean(draft && args.validate(draft));
    if (process.env.KLAURO_DEBUG_CATALOG) {
      console.error('[catalog-debug] deterministic atomic closure:', JSON.stringify({
        candidate_id: candidateId, authoritative_lineage: authoritativeLineage,
        exact_http_route_lineage: exactHttpRouteLineage,
        audience: args.audienceFor(candidate), entity_labels: args.entityLabelsFor(candidate),
        structural_label: candidate.structural_label, operations: candidate.operations,
        draft_name: draft?.name, accepted,
      }));
    }
    if (draft && accepted) closures.push(draft);
  }
  return closures;
}

function groupedLifecycleOutcomeName(
  subject: string,
  operations: readonly SystemCapability['operations'][number][],
  actions: readonly string[],
): string | undefined {
  const routeTokens = new Set(operations.flatMap(operation =>
    String(operation.trigger?.path || operation.path_or_command || '')
      .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)));
  const normalizedSubject = subject.trim();
  if (!normalizedSubject) return undefined;
  if (routeTokens.has('download')) return `Download ${normalizedSubject}`;
  if (['approve', 'reject', 'join', 'leave', 'complete'].filter(token => routeTokens.has(token)).length >= 2) {
    return `Control ${normalizedSubject}`;
  }
  const actionSet = new Set(actions.map(action => /^(?:browse|fetch|get|list|read|retrieve|search|show)/.test(action) ? 'view' : /^(?:delete|archive|cancel)/.test(action) ? 'remove' : action));
  if (actionSet.has('follow') && actionSet.has('unfollow')) return `Follow and unfollow ${normalizedSubject}`;
  if (actionSet.has('favorite') && actionSet.has('unfavorite')) return `Favorite and unfavorite ${normalizedSubject}`;
  if (['create', 'view', 'update', 'remove'].every(action => actionSet.has(action))) return `Organize ${normalizedSubject}`;
  if (actionSet.has('create') && actionSet.has('update')) return `Track ${normalizedSubject}`;
  if (actionSet.has('create') && actionSet.has('view')) return `Organize ${normalizedSubject}`;
  return undefined;
}

export function validatedDeterministicGroupedOperationClosures(args: {
  uncoveredIdsByParent: ReadonlyMap<string, readonly string[]>;
  scopes: ReadonlyMap<string, { id: string; parentCandidateId: string }>;
  evidenceCandidates: readonly SystemCapability[];
  audienceFor: (candidate: SystemCapability) => string | undefined;
  entityLabelsFor: (candidate: SystemCapability) => readonly string[];
  validate: (capability: SystemCapability) => boolean;
}): SystemCapability[] {
  const evidenceById = new Map(args.evidenceCandidates.map(candidate => [candidate.id, candidate]));
  const closures: SystemCapability[] = [];
  for (const parentId of [...args.uncoveredIdsByParent.keys()].sort()) {
    const candidateIds = [...args.scopes.values()]
      .filter(scope => scope.parentCandidateId === parentId)
      .map(scope => scope.id)
      .sort();
    if (candidateIds.length < 2) continue;
    const candidates = candidateIds.map(candidateId => evidenceById.get(candidateId));
    if (candidates.some(candidate => !candidate)) continue;
    const resolved = candidates.filter((candidate): candidate is SystemCapability => Boolean(candidate));
    const operations = resolved.flatMap(candidate => candidate.operations || []);
    const relatedEntities = [...new Set(resolved.flatMap(candidate => candidate.related_entities || []))];
    const relatedDomains = [...new Set(resolved.flatMap(candidate => candidate.related_domains || []))];
    const first = resolved[0];
    const synthetic: SystemCapability = {
      ...first,
      id: `grouped-operation-obligation:${parentId}`,
      name: first.structural_label || first.name,
      description: '',
      operations,
      related_entities: relatedEntities,
      related_domains: relatedDomains,
      criticality_factors: ['catalog-deterministic-grouped-lifecycle'],
    };
    const exactHttpRouteLineage = operations.every(operation => {
      const method = String(operation.trigger?.method || '').trim();
      const triggerPath = String(operation.trigger?.path || '').trim();
      const commandPath = String(operation.path_or_command || '').trim();
      return operation.entry_point_type === 'http' && Boolean(method && triggerPath && triggerPath === commandPath);
    });
    const audience = args.audienceFor(first) || (exactHttpRouteLineage ? 'Users' : undefined);
    const entityLabels = [...new Set(resolved.flatMap(candidate => args.entityLabelsFor(candidate)))];
    let draft = deterministicCapabilityActionIdentityFallback({
      capability: synthetic,
      candidate: synthetic,
      audience,
      relatedEntityLabels: entityLabels,
      allowUniqueStructuralSubject: true,
      allowGroupedLifecycle: true,
      validate: () => true,
    });
    if (!draft) {
      const routeSegments = operations.map(operation => String(operation.trigger?.path || operation.path_or_command || '')
        .split('/').filter(segment => segment && !/^[:{]/.test(segment) && !/^v\d+$/i.test(segment) && segment !== 'api'));
      const sharedSegment = routeSegments[0]?.slice().reverse().find(segment =>
        routeSegments.slice(1).every(segments => segments.includes(segment)));
      if (sharedSegment) {
        const normalizedSubject = sharedSegment.replace(/[-_.]+/g, ' ').toLowerCase();
        const subject = normalizedSubject === 'auth' ? 'authentication'
          : /s$/.test(normalizedSubject) ? normalizedSubject : `${normalizedSubject}s`;
        draft = { ...synthetic, name: `Maintain ${subject}`, name_source: 'deterministic' };
      }
    }
    if (!draft) continue;
    const subject = draft.name.replace(/^\S+\s+/, '');
    const lifecycleActions = [...new Set(operations.map(operation => {
      const canonical = canonicalCapabilityLifecycleAction(operation);
      if (['favorite', 'unfavorite', 'follow', 'unfollow'].includes(canonical)) return canonical;
      const method = String(operation.trigger?.method || '').toUpperCase();
      const path = String(operation.trigger?.path || operation.path_or_command || '').toLowerCase();
      if (/^(?:GET|HEAD|OPTIONS)$/.test(method)) return 'read';
      if (method === 'POST' && !/(?:auth|login|sign[ _-]?in|token)/.test(path)) return 'create';
      if (/^(?:PUT|PATCH)$/.test(method)) return 'update';
      if (method === 'DELETE') return 'delete';
      return String(operation.action || '').toLowerCase();
    }))];
    const outcomeName = groupedLifecycleOutcomeName(subject, operations, lifecycleActions);
    if (!outcomeName) continue;
    const identity: SystemCapability = {
      ...draft,
      id: `capability_grouped_${parentId.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()}`,
      name: outcomeName,
      description: '',
      name_source: 'deterministic',
      operations,
      related_entities: relatedEntities,
      related_domains: relatedDomains,
      criticality_factors: [
        ...candidateIds.map(candidateId => `catalog-candidate:${candidateId}`),
        ...candidateIds.map(candidateId => `catalog-operation-obligation:${candidateId}`),
        'catalog-deterministic-grouped-lifecycle',
      ],
    };
    const closure = deterministicCapabilityDescriptionFallback({
      identity,
      evidenceCandidates: resolved,
      evidenceEntityNames: entityLabels,
      audience,
      firstPartyTexts: [],
      validate: args.validate,
    });
    if (closure) closures.push(closure);
  }
  return closures;
}


export function deterministicAtomicClosuresForObligationIds(
  capabilities: readonly SystemCapability[],
  obligationIds: ReadonlySet<string>,
): SystemCapability[] {
  return capabilities.filter(capability => {
    const factors = capability.criticality_factors || [];
    if (!factors.includes('catalog-deterministic-atomic-closure')) return false;
    return factors.some(factor =>
      (factor.startsWith('catalog-candidate:') && obligationIds.has(factor.slice('catalog-candidate:'.length))) ||
      (factor.startsWith('catalog-operation-obligation:') && obligationIds.has(factor.slice('catalog-operation-obligation:'.length))));
  });
}

export function withoutSubsumedDeterministicAtomicClosures(
  capabilities: readonly SystemCapability[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
  establishedCapabilities: readonly SystemCapability[] = capabilities,
  operationCoverageContext?: CapabilityOperationCoverageContext,
): SystemCapability[] {
  const exactObligationIds = (capability: SystemCapability): string[] => [...new Set((capability.criticality_factors || []).flatMap(factor => {
    if (factor.startsWith('catalog-operation-obligation:')) return [factor.slice('catalog-operation-obligation:'.length)];
    if (factor.startsWith('catalog-candidate:operation-obligation:')) return [factor.slice('catalog-candidate:'.length)];
    return [];
  }))];
  const citedCandidateIds = (capability: SystemCapability): string[] => (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:'))
    .map(factor => factor.slice('catalog-candidate:'.length));
  const retainedNonAtomic = establishedCapabilities.filter(capability =>
    !(capability.criticality_factors || []).includes('catalog-deterministic-atomic-closure'));
  const groupedCapabilities = establishedCapabilities.filter(capability => {
    if ((capability.criticality_factors || []).includes('catalog-deterministic-grouped-lifecycle')) return true;
    if (!operationCoverageContext?.obligationScopes) return false;
    const entryPointIds = new Set((capability.operations || []).map(operation => operation.entry_point_id));
    return citedCandidateIds(capability).some(candidateId => {
      const siblingScopes = [...operationCoverageContext.obligationScopes!.values()]
        .filter(scope => scope.parentCandidateId === candidateId);
      return siblingScopes.length > 1 && siblingScopes.every(scope =>
        scope.entryPointIds.every(entryPointId => entryPointIds.has(entryPointId)));
    });
  });
  const groupedParents = new Set(groupedCapabilities.flatMap(citedCandidateIds));
  const eligibleParents = groupedParents;
  const operationKey = (operation: SystemCapability['operations'][number]): string => [
    operation.entry_point_id, operation.entry_point_type, operation.action,
    operation.trigger?.method || '', operation.trigger?.path || operation.path_or_command || '',
  ].join('|');
  const exactLifecycleCoveredByAuthoredCapability = (capability: SystemCapability): boolean => {
    const requiredCandidateIds = citedCandidateIds(capability);
    const requiredOperations = new Set((capability.operations || []).map(operationKey));
    return requiredCandidateIds.length > 0 && requiredOperations.size > 0 && establishedCapabilities.some(established => {
      if (established === capability || established.name_source === 'deterministic') return false;
      if (pendingCapabilityEvidenceObservableActionFailure(established, capability)) return false;
      const establishedCandidateIds = new Set(citedCandidateIds(established));
      if (!requiredCandidateIds.every(candidateId => establishedCandidateIds.has(candidateId))) return false;
      const establishedOperations = new Set((established.operations || []).map(operationKey));
      return [...requiredOperations].every(key => establishedOperations.has(key));
    });
  };
  const exactlyCoveredElsewhere = (capability: SystemCapability, obligationId: string): boolean => retainedNonAtomic.some(retained => {
    const factors = retained.criticality_factors || [];
    const citesExact = factors.includes(`catalog-candidate:${obligationId}`) || factors.includes(`catalog-operation-obligation:${obligationId}`);
    if (!citesExact) return false;
    if (pendingCapabilityEvidenceObservableActionFailure(retained, capability)) return false;
    if (operationCoverageContext) return uncoveredRequiredCapabilityOperations(capability, [retained], operationCoverageContext).length === 0;
    const retainedOperations = new Set((retained.operations || []).map(operationKey));
    return (capability.operations || []).every(operation => retainedOperations.has(operationKey(operation)));
  });
  const completeGroupedParent = (capability: SystemCapability, obligationId: string): boolean => {
    if (!operationCoverageContext) return false;
    const scopes = operationCoverageContext.obligationScopes;
    const scope = scopes?.get(obligationId);
    if (!scopes || !scope || !eligibleParents.has(scope.parentCandidateId)) {
      if (process.env.KLAURO_DEBUG_CATALOG && groupedParents.size > 0) {
        console.error('[catalog-debug] atomic closure has no eligible grouped parent:', JSON.stringify({
          obligation_id: obligationId,
          scope_parent_candidate_id: scope?.parentCandidateId,
          grouped_parent_candidate_ids: [...groupedParents],
        }));
      }
      return false;
    }
    const siblingScopes = [...scopes.values()]
      .filter(candidateScope => candidateScope.parentCandidateId === scope.parentCandidateId);
    if (siblingScopes.length === 0) return false;
    const matchingParents = groupedCapabilities.filter(grouped =>
      citedCandidateIds(grouped).includes(scope.parentCandidateId));
    const complete = matchingParents.some(grouped => {
      const groupedEntryPoints = new Set((grouped.operations || []).map(operation => operation.entry_point_id));
      if (siblingScopes.some(candidateScope => candidateScope.entryPointIds.some(entryPointId => !groupedEntryPoints.has(entryPointId)))) return false;
      const groupedOperations = new Set((grouped.operations || []).map(operationKey));
      return (capability.operations || []).every(operation => groupedOperations.has(operationKey(operation)));
    });
    if (!complete && process.env.KLAURO_DEBUG_CATALOG) {
      console.error('[catalog-debug] grouped parent did not subsume atomic closure:', JSON.stringify({
        obligation_id: obligationId,
        parent_candidate_id: scope.parentCandidateId,
        sibling_entry_point_ids: siblingScopes.flatMap(candidateScope => candidateScope.entryPointIds),
        parents: matchingParents.map(grouped => ({
          id: grouped.id,
          candidate_ids: citedCandidateIds(grouped),
          entry_point_ids: (grouped.operations || []).map(operation => operation.entry_point_id),
          operation_keys: (grouped.operations || []).map(operationKey),
        })),
        atomic_entry_point_ids: (capability.operations || []).map(operation => operation.entry_point_id),
        atomic_operation_keys: (capability.operations || []).map(operationKey),
      }));
    }
    return complete;
  };
  return capabilities.filter(capability => {
    const factors = capability.criticality_factors || [];
    if (!factors.includes('catalog-deterministic-atomic-closure')) return true;
    if (factors.includes('catalog-deterministic-grouped-lifecycle')) {
      return !exactLifecycleCoveredByAuthoredCapability(capability);
    }
    const obligationIds = exactObligationIds(capability);
    if (obligationIds.length === 0) return true;
    return !obligationIds.every(obligationId =>
      exactlyCoveredElsewhere(capability, obligationId) || completeGroupedParent(capability, obligationId));
  });
}

export function isExactValidatedDeterministicRecovery(capability: SystemCapability): boolean {
  if ((capability.criticality_factors || []).includes('catalog-deterministic-grouped-lifecycle') &&
    /^(?:manage|handle|process)(?:s|d|ing)?\b/i.test(String(capability.name || '').trim())) return false;
  const deterministicDescription = capability.description_generation?.status === "deterministic_kept" &&
    ["grounded-first-party-outcome", "grounded-cited-lifecycle"].includes(capability.description_generation.reason || "");
  const validatedAiDescription = capability.description_generation?.status === "ai_applied" && capability.description_source === "ai";
  if (!deterministicDescription && !validatedAiDescription) return false;
  const candidateIds = (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:'))
    .map(factor => factor.slice('catalog-candidate:'.length));
  const obligationIds = (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-operation-obligation:'))
    .map(factor => factor.slice('catalog-operation-obligation:'.length));
  if (candidateIds.length === 0 || (capability.operations || []).length === 0) return false;
  if ((capability.criticality_factors || []).includes('catalog-deterministic-grouped-lifecycle')) {
    return candidateIds.length > 1 ||
      (candidateIds.length === 1 && obligationIds.length > 1 &&
        obligationIds.every(obligationId => obligationId.startsWith(`operation-obligation:${candidateIds[0]}:`))) ||
      (candidateIds.length === 1 && (capability.operations || []).length === 1 &&
        /^(?:get|list|read|retrieve|show|view)/i.test(String(capability.operations?.[0]?.action || '')));
  }

  if ((capability.criticality_factors || []).includes('catalog-deterministic-atomic-closure')) {
    return candidateIds.length === 1 ||
      (capability.criticality_factors || []).includes('catalog-deterministic-grouped-lifecycle');
  }
  if (candidateIds.length !== 1) return false;
  return candidateIds[0].startsWith('operation-obligation:') &&
    (capability.criticality_factors || []).includes(`catalog-operation-obligation:${candidateIds[0]}`);
}


export function capabilityCatalogCycleQualityFailure(args: {
  reconciled: SystemCapability[];
  distinctFamilyCount: number;
  requiredBehaviorCandidateIds: string[];
  requiredEntityCandidateGroups: string[][];
  requiredOutcomes: readonly CapabilityCatalogOutcomeRequirement[];
  candidateFamilyGroups: ReadonlyArray<ReadonlyArray<string>>;
  fullyCoveredAggregateCandidateIds?: ReadonlySet<string>;
  isBareNoun: (name: string) => boolean;
  isStructuralPlaceholder: (description?: string) => boolean;
  isValidatedDeterministicRecovery?: (capability: SystemCapability) => boolean;
}): string | undefined {
  if (args.reconciled.length === 0) return capabilityCatalogOutcomeCoverageFailure([], args.requiredOutcomes);
  const coverageFailure = capabilityCatalogOutcomeCoverageFailure(args.reconciled, args.requiredOutcomes);
  if (coverageFailure) return coverageFailure;
  const evidenceRejected = args.reconciled.filter(capability =>
    (capability.criticality_factors || []).some(factor => factor.startsWith('catalog-evidence-rejected:')));
  if (evidenceRejected.length > 0) return `catalog contains ${evidenceRejected.length} authored capability ${evidenceRejected.length === 1 ? 'claim' : 'claims'} without product-outcome evidence: ${evidenceRejected.slice(0, 3).map(capability => capability.name).join(', ')}`;
  const bareNouns = args.reconciled.filter(capability => args.isBareNoun(String(capability.name || '')));
  if (bareNouns.length > 0) return `bare-noun capability names survived reconciliation: ${bareNouns.slice(0, 3).map(capability => `"${capability.name}"`).join(', ')}`;
  const placeholders = args.reconciled.filter(capability => args.isStructuralPlaceholder(capability.description));
  if (placeholders.length > 0) return `structural template descriptions survived reconciliation: ${placeholders.slice(0, 3).map(capability => `"${capability.name}"`).join(', ')}`;
  const unauthored = args.reconciled.filter(capability => !['deterministic', 'ai', 'manual', 'reused'].includes(String(capability.name_source || '')));
  if (unauthored.length > 0) return `unauthored capability names survived reconciliation: ${unauthored.slice(0, 3).map(capability => `"${capability.name}"`).join(', ')}`;
  const deterministicRecoveries = args.reconciled.filter(capability => capability.name_source === 'deterministic' &&
    !(args.isValidatedDeterministicRecovery?.(capability) || isExactValidatedDeterministicRecovery(capability)));
  if (deterministicRecoveries.length > 0 && process.env.KLAURO_DEBUG_CATALOG) {
    console.error('[catalog-debug] rejected deterministic recoveries:', JSON.stringify(deterministicRecoveries.map(capability => ({
      id: capability.id,
      name: capability.name,
      description_source: capability.description_source,
      description_generation: capability.description_generation,
      candidate_factors: (capability.criticality_factors || []).filter(factor =>
        factor.startsWith('catalog-candidate:') || factor.startsWith('catalog-operation-obligation:')),
      operations: capability.operations,
    }))));
  }
  if (deterministicRecoveries.length > 0) return `catalog contains ${deterministicRecoveries.length} evidence-grounded deterministic ${deterministicRecoveries.length === 1 ? 'recovery' : 'recoveries'} awaiting higher-quality language: ${deterministicRecoveries.slice(0, 3).map(capability => `"${capability.name}"`).join(', ')}`;
  const weakDescriptions = args.reconciled.filter(capability => capability.description_generation?.status !== 'ai_rejected' && (() => {
    const count = String(capability.description || '').trim().split(/\s+/).filter(Boolean).length;
    return count < 6 || count > 32;
  })());
  if (weakDescriptions.length > 0) return `capability descriptions fall outside the product-language quality range: ${weakDescriptions.slice(0, 3).map(capability => `"${capability.name}"`).join(', ')}`;
  const unanchored = args.reconciled.filter(capability => (capability.related_entities || []).length === 0 && (capability.operations || []).length === 0);
  return unanchored.length > 0
    ? `unanchored capabilities survived reconciliation (no resolvable operation, entity, or entry point): ${unanchored.slice(0, 3).map(capability => `"${capability.name}"`).join(', ')}`
    : undefined;
}
