import type { SystemCapability } from '../../types/cas.types';
import { capabilityEvidenceSubjectTokens } from './capability-catalog-evidence';
import type { CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';
import { capabilityCatalogRepairLifecycleKey } from './capability-catalog-repair-plan';
import { scopeCapabilityObligationFactors, scopeCapabilityOperationsToOutcomeName } from './capability-operation-attribution';

export type CapabilityCatalogOutcome =
  | { status: 'fulfilled'; value: SystemCapability[] }
  | { status: 'rejected'; reason: unknown };

export interface ScheduledCapabilityCatalog<TTarget> {
  capabilities: SystemCapability[];
  authoredFacts: Array<Pick<SystemCapability, 'name' | 'description' | 'category'>>;
  targets: TTarget[];
  descriptionPromise?: Promise<void>;
}

export type CapabilityDescriptionRepairOutcome =
  | { status: 'fulfilled'; value: SystemCapability[] }
  | { status: 'rejected'; reason: unknown };

export function selectValidatedCapabilityDescriptionRepair<T>(
  validated: readonly T[],
  attempt: number,
  fallback: () => T | undefined,
): T | undefined {
  if (validated[0] !== undefined) return validated[0];
  return attempt >= 2 ? fallback() : undefined;
}

export interface CapabilityCatalogRejection {
  candidateIds: string[];
  missingAudience?: string;
  missingAudienceLocations?: Array<'description' | 'name'>;
  missingSubjectTerms?: string[];
  name: string;
  reason: string;
  requirementId?: string;
  forbiddenSubjectTerms?: string[];
  oppositeAudienceLabels?: string[];
  oppositeAudienceLocations?: Array<'description' | 'name'>;
}

export interface CapabilityCatalogPriorRejection {
  missing_audience?: string;
  missing_audience_locations?: Array<'description' | 'name'>;
  missing_subject_terms?: string[];
  name: string;
  reason: string;
  forbidden_subject_terms: string[];
  requirement_id?: string;
  opposite_audience_labels?: string[];
  opposite_audience_locations?: Array<'description' | 'name'>;
}

export function capabilityCatalogOutcomeCorrectiveRetryFeedback(
  rejections: readonly CapabilityCatalogRejection[],
  requirement: CapabilityCatalogOutcomeRequirement,
  candidateIds: readonly string[],
): CapabilityCatalogRejection {
  const observed = rejections[rejections.length - 1];
  return {
    candidateIds: [...candidateIds],
    name: observed?.name || requirement.statement,
    reason: observed?.reason || 'required-outcome-zero-result',
    requirementId: requirement.id,
    ...(observed?.missingAudience ? { missingAudience: observed.missingAudience } : {}),
    ...(observed?.missingAudienceLocations?.length ? { missingAudienceLocations: observed.missingAudienceLocations } : {}),
    ...(observed?.missingSubjectTerms?.length ? { missingSubjectTerms: observed.missingSubjectTerms } : {}),
    ...(observed?.oppositeAudienceLabels?.length ? { oppositeAudienceLabels: observed.oppositeAudienceLabels } : {}),
    ...(observed?.oppositeAudienceLocations?.length ? { oppositeAudienceLocations: observed.oppositeAudienceLocations } : {}),
  };
}

export async function retryEmptyCapabilityCatalogOutcome<T>(args: {
  candidateIds: readonly string[];
  initial: T[];
  rejections: CapabilityCatalogRejection[];
  requirement?: CapabilityCatalogOutcomeRequirement;
  retryEvidence?: boolean;
  deferEvidenceRetry?: boolean;
  record: (feedback: CapabilityCatalogRejection) => void;
  retry: () => Promise<T[]>;
}): Promise<T[]> {
  if (args.initial.length > 0 || (!args.requirement && !args.retryEvidence)) return args.initial;
  if (args.requirement) {
    const expectedFeedbackExists = args.rejections.some(rejection => rejection.requirementId === args.requirement?.id &&
      args.candidateIds.every(candidateId => rejection.candidateIds.includes(candidateId)));
    if (!expectedFeedbackExists) {
      const feedback = capabilityCatalogOutcomeCorrectiveRetryFeedback(args.rejections, args.requirement, args.candidateIds);
      args.rejections.push(feedback);
      args.record(feedback);
    }
  } else if (args.retryEvidence) {
    const expectedFeedbackExists = args.rejections.some(rejection =>
      rejection.reason === 'required-evidence-zero-result' &&
      args.candidateIds.every(candidateId => rejection.candidateIds.includes(candidateId)));
    if (!expectedFeedbackExists) {
      const feedback: CapabilityCatalogRejection = {
        candidateIds: [...args.candidateIds],
        name: 'Required evidence family',
        reason: 'required-evidence-zero-result',
      };
      args.rejections.push(feedback);
      args.record(feedback);
    }
  }
  if (args.deferEvidenceRetry && args.retryEvidence) return args.initial;
  return args.retry();
}

export type CapabilityCatalogRejectionsByCandidate = Map<string, CapabilityCatalogPriorRejection[]>;

export function selectCapabilityCatalogPromptCandidates(
  rankedCandidates: SystemCapability[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>> = [],
): SystemCapability[] {
  const behaviorCandidates = rankedCandidates.filter(candidate => candidate.evidence_kind === 'behavior-surface');
  const explicitlyRequiredIds = new Set(requiredEntityCandidateGroups.flat());
  const requiredBehaviorCandidates = behaviorCandidates.filter(candidate => explicitlyRequiredIds.has(candidate.id));
  const requiredEntityCandidates = requiredEntityCandidateGroups
    .map(group => rankedCandidates.find(candidate => group.includes(candidate.id)))
    .filter((candidate): candidate is SystemCapability => Boolean(candidate));
  const requiredIds = new Set([...requiredBehaviorCandidates, ...requiredEntityCandidates].map(candidate => candidate.id));
  const requiredCandidates = rankedCandidates.filter(candidate => requiredIds.has(candidate.id));
  const omitSupportingContext = requiredCandidates.length > 0;
  const isEligibleContext = (candidate: SystemCapability): boolean =>
    !omitSupportingContext ||
    (candidate.evidence_role !== 'supporting-mechanism' &&
      candidate.evidence_role !== 'verification-harness');
  const structuralCandidates = rankedCandidates.filter(candidate =>
    !requiredIds.has(candidate.id) && candidate.evidence_kind !== 'behavior-surface' && isEligibleContext(candidate));
  const internalBehaviorCandidates = behaviorCandidates.filter(candidate =>
    !requiredIds.has(candidate.id) && isEligibleContext(candidate));
  const baselineWindowSize = Math.min(64, Math.max(24, requiredBehaviorCandidates.length, Math.ceil(rankedCandidates.length / 6)));
  const windowSize = Math.max(
    baselineWindowSize,
    requiredCandidates.length + Math.min(24, Math.ceil(requiredEntityCandidates.length / 2)),
  );
  const remainingSlots = Math.max(0, windowSize - requiredCandidates.length);
  const structuralLimit = Math.min(structuralCandidates.length, Math.ceil(remainingSlots * 2 / 3));
  const internalLimit = Math.min(internalBehaviorCandidates.length, remainingSlots - structuralLimit);
  const unfilledSlots = remainingSlots - structuralLimit - internalLimit;
  const additionalStructural = Math.min(structuralCandidates.length - structuralLimit, unfilledSlots);
  const additionalInternal = Math.min(internalBehaviorCandidates.length - internalLimit, unfilledSlots - additionalStructural);
  return [
    ...requiredCandidates,
    ...structuralCandidates.slice(0, structuralLimit + additionalStructural),
    ...internalBehaviorCandidates.slice(0, internalLimit + additionalInternal),
  ];
}

export function scheduleRejectedCapabilityDescriptions(args: {
  capabilities: SystemCapability[];
  rejectedIds: ReadonlySet<string>;
  authorDescriptions: (capabilities: SystemCapability[]) => Promise<void>;
}): Promise<CapabilityDescriptionRepairOutcome> | undefined {
  const repairCapabilities = args.capabilities
    .filter(capability => args.rejectedIds.has(capability.id))
    .map(capability => structuredClone(capability));
  if (repairCapabilities.length === 0) return undefined;
  return args.authorDescriptions(repairCapabilities).then(
    () => ({ status: 'fulfilled' as const, value: repairCapabilities }),
    reason => ({ status: 'rejected' as const, reason }),
  );
}

export function capabilitiesWithoutDescriptionDisposition(
  capabilities: SystemCapability[],
): SystemCapability[] {
  return capabilities.filter(capability => !capability.description_generation);
}

export function uncoveredCapabilityCatalogCandidateIds(
  capabilities: SystemCapability[],
  requiredBehaviorCandidateIds: readonly string[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
  fullyCoveredAggregateCandidateIds: ReadonlySet<string> = new Set(),
): string[] {
  const citedCandidateIds = new Set(capabilities.flatMap(capability =>
    (capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length))));
  return [...new Set([
    ...requiredBehaviorCandidateIds.filter(candidateId => !citedCandidateIds.has(candidateId)),
    ...requiredEntityCandidateGroups
      .filter(group => !group.some(candidateId =>
        citedCandidateIds.has(candidateId) || fullyCoveredAggregateCandidateIds.has(candidateId)))
      .flat(),
  ])];
}

export function uncoveredCapabilityCatalogFamilyRepresentativeIds(
  capabilities: SystemCapability[],
  candidateFamilyGroups: ReadonlyArray<ReadonlyArray<string>>,
  fullyCoveredAggregateCandidateIds: ReadonlySet<string> = new Set(),
): string[] {
  const citedCandidateIds = new Set(capabilities.flatMap(capability =>
    (capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length))));
  return candidateFamilyGroups
    .filter(group => group.length > 0 && !group.some(candidateId =>
      citedCandidateIds.has(candidateId) || fullyCoveredAggregateCandidateIds.has(candidateId)))
    .map(group => group[0]);
}

export function capabilityCatalogRepairCandidateIds(
  capabilities: SystemCapability[],
  requiredBehaviorCandidateIds: readonly string[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
  pendingPublishabilityIds: ReadonlySet<string>,
  candidateFamilyGroups: ReadonlyArray<ReadonlyArray<string>> = [],
  fullyCoveredAggregateCandidateIds: ReadonlySet<string> = new Set(),
): string[] {
  return [...new Set([
    ...requiredBehaviorCandidateIds,
    ...uncoveredCapabilityCatalogCandidateIds(capabilities, [], requiredEntityCandidateGroups, fullyCoveredAggregateCandidateIds),
    ...uncoveredCapabilityCatalogFamilyRepresentativeIds(capabilities, candidateFamilyGroups, fullyCoveredAggregateCandidateIds),
    ...pendingPublishabilityIds,
  ])];
}

function normalizedOutcomeNameTokens(name: string): string[] {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b(?:log|sign)[ -]+in\b/gi, ' authenticate ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3)
    .map(token => token.length >= 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)
    .map(token => /^(?:auth|authenticate|authentication|login|signin|signon)$/.test(token) ? 'authenticate' : token);
}

const OUTCOME_ACTION_TOKENS = new Set([
  'add', 'authenticate', 'browse', 'create', 'delete', 'edit', 'find', 'get',
  'list', 'manage', 'read', 'remove', 'review', 'search', 'show', 'track',
  'update', 'view',
]);

function outcomeSubjectTokens(name: string): string[] {
  return normalizedOutcomeNameTokens(name).filter(token => !OUTCOME_ACTION_TOKENS.has(token));
}

function evidenceTokenMatchesOutcomeName(token: string, outcomeNameTokens: readonly string[]): boolean {
  return outcomeNameTokens.some(outcomeToken =>
    outcomeToken === token ||
    (Math.min(outcomeToken.length, token.length) >= 5 &&
      (outcomeToken.startsWith(token) || token.startsWith(outcomeToken) || outcomeToken.slice(0, 5) === token.slice(0, 5)))
  );
}

export function capabilityOutcomeMatchesEvidence(
  name: string,
  evidenceCandidates: readonly SystemCapability[],
): boolean {
  const outcomeTokens = normalizedOutcomeNameTokens(name);
  return evidenceCandidates.length > 0 && evidenceCandidates.every(candidate => {
    const evidenceTokens = capabilityEvidenceSubjectTokens(candidate);
    return evidenceTokens.length > 0 && evidenceTokens.some(token =>
      evidenceTokenMatchesOutcomeName(token, outcomeTokens));
  });
}

function mergeCapabilityEvidence(outcome: SystemCapability, evidence: SystemCapability): SystemCapability {
  const operationKey = (operation: SystemCapability['operations'][number]) => [
    operation.entry_point_id,
    operation.entry_point_type,
    operation.action,
    operation.path_or_command || '',
    operation.trigger?.method || '',
    operation.trigger?.path || '',
  ].join('|');
  const scopedOutcomeOperations = scopeCapabilityOperationsToOutcomeName(outcome.name, outcome.operations || []);
  const operations = new Map(scopedOutcomeOperations.map(operation => [operationKey(operation), operation]));
  for (const operation of scopeCapabilityOperationsToOutcomeName(outcome.name, evidence.operations || [])) operations.set(operationKey(operation), operation);
  const criticalityRank: Record<SystemCapability['criticality'], number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return {
    ...outcome,
    operations: [...operations.values()],
    related_entities: [...new Set([...(outcome.related_entities || []), ...(evidence.related_entities || [])])],
    related_domains: [...new Set([...(outcome.related_domains || []), ...(evidence.related_domains || [])])],
    criticality: criticalityRank[evidence.criticality] > criticalityRank[outcome.criticality]
      ? evidence.criticality
      : outcome.criticality,
    criticality_factors: scopeCapabilityObligationFactors(outcome.name, [...new Set([
      ...(outcome.criticality_factors || []),
      ...(evidence.criticality_factors || []),
      `catalog-candidate:${evidence.id}`,
    ])]),
    evidence_examples: [...new Set([...(outcome.evidence_examples || []), ...(evidence.evidence_examples || [])])],
  };
}

function uniquelyMatchedRepairOutcomeIndexes(
  outcomes: readonly SystemCapability[],
  repairHints: readonly SystemCapability[],
  evidence: SystemCapability,
): number[] {
  const evidenceCitation = `catalog-candidate:${evidence.id}`;
  const hints = repairHints.filter(hint =>
    (hint.criticality_factors || []).includes(evidenceCitation) &&
    capabilityOutcomeMatchesEvidence(hint.name, [evidence]));
  const matches = new Set<number>();
  const evidenceEntities = new Set(evidence.related_entities || []);
  const evidenceOperations = new Set((evidence.operations || []).map(operation => operation.entry_point_id));
  const exactOperationAnchors = new Set(outcomes.flatMap((outcome, index) =>
    (outcome.operations || []).some(operation => evidenceOperations.has(operation.entry_point_id)) ? [index] : []));
  for (const hint of hints) {
    const hintSubjects = outcomeSubjectTokens(hint.name);
    for (let index = 0; index < outcomes.length; index++) {
      const outcome = outcomes[index];
      const hasStructuralAnchor = exactOperationAnchors.size > 0
        ? exactOperationAnchors.has(index)
        : (outcome.related_entities || []).some(entity => evidenceEntities.has(entity));
      if (!hasStructuralAnchor) continue;
      const outcomeSubjects = outcomeSubjectTokens(outcome.name);
      const sharedSubjects = hintSubjects.filter(token => evidenceTokenMatchesOutcomeName(token, outcomeSubjects));
      const requiredSubjects = Math.min(2, hintSubjects.length, outcomeSubjects.length);
      if (requiredSubjects > 0 && sharedSubjects.length >= requiredSubjects) matches.add(index);
    }
  }
  return [...matches];
}

export function mergeUniquelyMatchedBehaviorEvidence(
  capabilities: SystemCapability[],
  evidenceCandidates: readonly SystemCapability[],
  requiredCandidateIds: readonly string[],
  repairHints: readonly SystemCapability[] = [],
): SystemCapability[] {
  const requiredIds = new Set(requiredCandidateIds);
  const merged = capabilities.map(capability => ({ ...capability }));
  const citedIds = new Set(merged.flatMap(capability =>
    (capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length))));
  for (const evidence of evidenceCandidates) {
    if (!requiredIds.has(evidence.id) ||
      citedIds.has(evidence.id) ||
      evidence.evidence_kind !== 'behavior-surface' ||
      evidence.id.startsWith('operation-obligation:')) {
      continue;
    }
    const evidenceTokens = capabilityEvidenceSubjectTokens(evidence);
    if (evidenceTokens.length === 0) continue;
    const matchingIndexes = merged.flatMap((capability, index) =>
      evidenceTokens.some(token => evidenceTokenMatchesOutcomeName(token, normalizedOutcomeNameTokens(capability.name)))
        ? [index]
        : []);
    const anchoredIndexes = matchingIndexes.length === 1
      ? matchingIndexes : uniquelyMatchedRepairOutcomeIndexes(merged, repairHints, evidence);
    if (anchoredIndexes.length !== 1) continue;
    const index = anchoredIndexes[0];
    merged[index] = mergeCapabilityEvidence(merged[index], evidence);
    citedIds.add(evidence.id);
  }
  return merged;
}


export function mergeGroundedEntityEvidenceFamilies(
  capabilities: SystemCapability[],
  evidenceCandidates: readonly SystemCapability[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
): SystemCapability[] {
  const merged = capabilities.map(capability => ({ ...capability }));
  const evidenceById = new Map(evidenceCandidates.map(candidate => [candidate.id, candidate]));
  const citedIds = new Set(merged.flatMap(capability =>
    (capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length))));

  for (const group of requiredEntityCandidateGroups) {
    if (group.some(candidateId => citedIds.has(candidateId))) continue;
    const matchesByCapability = new Map<number, Array<{ candidate: SystemCapability; score: number }>>();
    for (const candidateId of group) {
      const candidate = evidenceById.get(candidateId);
      if (!candidate ||
        candidate.evidence_kind === 'behavior-surface' ||
        candidate.evidence_role !== 'product-outcome') continue;
      const candidateEntities = new Set(candidate.related_entities || []);
      const evidenceTokens = (candidateEntities.size === 0 || candidate.structural_label
        ? normalizedOutcomeNameTokens(candidate.structural_label || candidate.name)
            .filter(token => !OUTCOME_ACTION_TOKENS.has(token) && token !== 'management')
        : capabilityEvidenceSubjectTokens({
            ...candidate,
            structural_label: undefined,
            related_domains: [],
            evidence_examples: [],
            operations: [],
          }));
      if (evidenceTokens.length === 0) continue;
      for (let index = 0; index < merged.length; index++) {
        const capability = merged[index];
        const capabilityCitationIds = (capability.criticality_factors || [])
          .filter(factor => factor.startsWith('catalog-candidate:'))
          .map(factor => factor.slice('catalog-candidate:'.length));
        const capabilityEntities = new Set([
          ...(capability.related_entities || []),
          ...capabilityCitationIds.flatMap(citationId => evidenceById.get(citationId)?.related_entities || []),
        ]);
        const entityOverlap = [...capabilityEntities].filter(entityId => candidateEntities.has(entityId)).length;
        if (candidateEntities.size > 0 && entityOverlap === 0) continue;
        const outcomeTokens = normalizedOutcomeNameTokens(capability.name);
        const matchingSubjectCount = evidenceTokens
          .filter(token => evidenceTokenMatchesOutcomeName(token, outcomeTokens)).length;
        if (matchingSubjectCount !== evidenceTokens.length) continue;
        if (outcomeSubjectTokens(capability.name).length === 0) continue;
        const leadingAction = outcomeTokens[0];
        const entityOutcomeActionScore = /^(?:manage|review|create|update|delete|edit|track)$/.test(leadingAction || '')
          ? 10
          : 0;
        const score = matchingSubjectCount * 100 + entityOverlap + entityOutcomeActionScore;
        matchesByCapability.set(index, [
          ...(matchesByCapability.get(index) || []),
          { candidate, score },
        ]);
      }
    }
    const ranked = [...matchesByCapability.entries()]
      .map(([index, matches]) => ({
        index,
        match: [...matches].sort((left, right) =>
          right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))[0],
      }))
      .sort((left, right) => right.match.score - left.match.score || left.index - right.index);
    if (process.env.KLAURO_DEBUG_CATALOG) {
      console.error('[catalog-debug] entity evidence bridge:', JSON.stringify({
        group,
        candidates: group.map(candidateId => {
          const candidate = evidenceById.get(candidateId);
          return { id: candidateId, kind: candidate?.evidence_kind, role: candidate?.evidence_role, entities: candidate?.related_entities };
        }),
        matches: ranked.map(item => ({ capability: merged[item.index]?.name, candidate: item.match.candidate.id, score: item.match.score })),
      }));
    }
    if (ranked.length === 0 || (ranked[1] && ranked[1].match.score === ranked[0].match.score)) continue;
    const selected = ranked[0];
    merged[selected.index] = mergeCapabilityEvidence(merged[selected.index], selected.match.candidate);
    citedIds.add(selected.match.candidate.id);
  }
  return merged;
}
export function capabilityCatalogRepairEvidenceFacts(
  candidates: SystemCapability[], repairCandidateIds: readonly string[], entityNamesById: ReadonlyMap<string, string>,
  rejectionsByCandidate: ReadonlyMap<string, CapabilityCatalogPriorRejection[]> = new Map(),
  requirementIds: readonly string[] = [],
) {
  const repairIds = new Set(repairCandidateIds);
  const scopedRequirements = new Set(requirementIds);
  return candidates.filter(candidate => repairIds.has(candidate.id)).map(candidate => {
    const entityNames = (candidate.related_entities || []).map(entityId => entityNamesById.get(entityId) || entityId);
    const subjectEntityNames = candidate.evidence_kind === 'behavior-surface' ? [] : entityNames;
    return {
      candidate_id: candidate.id,
      evidence_subject: candidate.structural_label || candidate.name,
      evidence_subject_terms: capabilityEvidenceSubjectTokens(candidate, subjectEntityNames),
      related_domains: candidate.related_domains || [],
      entity_names: subjectEntityNames,
      operations: (candidate.operations || []).slice(0, 8).map(operation => ({ action: operation.action, surface: operation.path_or_command })),
      examples: (candidate.evidence_examples || []).slice(0, 8),
      prior_rejections: (rejectionsByCandidate.get(candidate.id) || []).filter(rejection => scopedRequirements.size > 0
        ? !rejection.requirement_id || scopedRequirements.has(rejection.requirement_id)
        : !rejection.requirement_id),
    };
  });
}

export function recordCapabilityCatalogRejection(
  rejectionsByCandidate: CapabilityCatalogRejectionsByCandidate,
  feedback: CapabilityCatalogRejection,
): { added: boolean; explanation: string } {
  const unsupported = feedback.reason.match(/^outcome-scope-unsupported:(.+)$/)?.[1]?.split(',') || [];
  const forbiddenSubjectTerms = [...new Set([
    ...unsupported.filter(token => !['delivery-operation-restatement', 'delivery-subject-missing'].includes(token)),
    ...(feedback.forbiddenSubjectTerms || []),
  ].map(term => String(term).trim()).filter(Boolean))];
  let added = false;
  for (const candidateId of feedback.candidateIds) {
    const prior = rejectionsByCandidate.get(candidateId) || [];
    if (!prior.some(item => item.name === feedback.name && item.reason === feedback.reason && item.requirement_id === feedback.requirementId)) {
      const scope = feedback.requirementId || ''; const sameScope = prior.filter(item => (item.requirement_id || '') === scope);
      rejectionsByCandidate.set(candidateId, [...prior.filter(item => (item.requirement_id || '') !== scope), ...sameScope.slice(-3), {
        name: feedback.name,
        reason: feedback.reason,
        forbidden_subject_terms: forbiddenSubjectTerms,
        ...(feedback.missingAudience ? { missing_audience: feedback.missingAudience } : {}),
        ...(feedback.missingAudienceLocations?.length ? { missing_audience_locations: feedback.missingAudienceLocations } : {}),
        ...(feedback.missingSubjectTerms?.length ? { missing_subject_terms: feedback.missingSubjectTerms } : {}),
        ...(feedback.oppositeAudienceLabels?.length ? { opposite_audience_labels: feedback.oppositeAudienceLabels } : {}),
        ...(feedback.oppositeAudienceLocations?.length ? { opposite_audience_locations: feedback.oppositeAudienceLocations } : {}),
        ...(feedback.requirementId ? { requirement_id: feedback.requirementId } : {}),
      }]);
      added = true;
    }
  }
  const correction = [
    feedback.missingAudience ? `include audience ${JSON.stringify(feedback.missingAudience)} in ${JSON.stringify(feedback.missingAudienceLocations || ['name', 'description'])}` : '',
    feedback.oppositeAudienceLabels?.length ? `omit opposite audience ${JSON.stringify(feedback.oppositeAudienceLabels)} from ${JSON.stringify(feedback.oppositeAudienceLocations || ['name', 'description'])}` : '',
    feedback.missingSubjectTerms?.length ? `include subject terms ${JSON.stringify(feedback.missingSubjectTerms)}` : '',
  ].filter(Boolean).join(' and ');
  return { added, explanation: `The title "${feedback.name}" was rejected (${feedback.reason}); ${correction || 'do not repeat it, and use only the recurring evidence subject terms for a broader shared outcome'}.` };
}

export function capabilityCatalogCycleDiagnostic(capabilities: readonly SystemCapability[]): Array<{ name: string; requirement_ids: string[] }> {
  return capabilities.slice(0, 12).map(capability => ({
    name: String(capability.name || '').replace(/[\r\n\t]+/g, ' ').slice(0, 120),
    requirement_ids: capabilityCatalogRepairIdentity(capability).requirements.slice(0, 4).map(requirement => requirement.slice(0, 160)),
  }));
}

export function recordCapabilityPublishabilityRejection(
  rejectionsByCandidate: CapabilityCatalogRejectionsByCandidate,
  capability: SystemCapability,
  reason: string,
  forbiddenTerms: string[],
  correction: Pick<CapabilityCatalogRejection, 'missingAudience' | 'missingAudienceLocations'> = {},
): { added: boolean; feedback: { name: string; description?: string; reason: string; requirement_id?: string; forbidden_terms: string[] } } {
  const identity = capabilityCatalogRepairIdentity(capability);
  const requirementId = identity.requirements[0];
  const recorded = recordCapabilityCatalogRejection(rejectionsByCandidate, {
    candidateIds: identity.candidates, name: capability.name, reason, requirementId, forbiddenSubjectTerms: forbiddenTerms, ...correction,
  });
  return {
    added: recorded.added,
    feedback: { name: capability.name, description: capability.description, reason, ...(requirementId ? { requirement_id: requirementId } : {}), forbidden_terms: forbiddenTerms },
  };
}

const capabilityCatalogFactors = (capability: SystemCapability, prefix: string): string[] =>
  (capability.criticality_factors || []).filter(factor => factor.startsWith(prefix)).map(factor => factor.slice(prefix.length));

function capabilityCatalogRepairIdentity(capability: SystemCapability): { requirements: string[]; candidates: string[] } {
  return {
    requirements: capabilityCatalogFactors(capability, 'catalog-outcome-requirement:'),
    candidates: capabilityCatalogFactors(capability, 'catalog-candidate:'),
  };
}

function capabilityCatalogDescriptionPending(capability: SystemCapability): boolean {
  return !capability.description || capability.description_generation?.status === 'ai_rejected';
}

export function capabilityCatalogEvidenceRepairMatchIndexes(
  existing: readonly SystemCapability[],
  replacement: SystemCapability,
  knownEvidenceCandidates: readonly SystemCapability[],
  requestedCandidateIds: ReadonlySet<string>,
): number[] {
  const citedCandidateIds = capabilityCatalogRepairIdentity(replacement).candidates;
  if (citedCandidateIds.length !== 1 || !requestedCandidateIds.has(citedCandidateIds[0])) return [];
  const exactCandidateId = citedCandidateIds[0];
  const exactOperationRepair = exactCandidateId.startsWith('operation-obligation:');
  const evidence = knownEvidenceCandidates.find(candidate => candidate.id === citedCandidateIds[0]);
  if (!evidence) return [];
  const replacementOperations = new Set((evidence.operations || []).map(operation => operation.entry_point_id));
  const exactOperationMatches = existing.flatMap((capability, index) =>
    (capability.operations || []).some(operation => replacementOperations.has(operation.entry_point_id)) ? [index] : []);
  const structurallyMatched = exactOperationMatches.length > 0 ? exactOperationMatches : existing.flatMap((capability, index) => {
    const replacementEntities = new Set(evidence.related_entities || []);
    return (capability.related_entities || []).some(entity => replacementEntities.has(entity)) ? [index] : [];
  });
  const replacementSubjects = outcomeSubjectTokens(replacement.name);
  if (replacementSubjects.length === 0) return [];
  return structurallyMatched.filter(index => {
    if (exactOperationRepair) {
      const existingObligations = capabilityCatalogRepairIdentity(existing[index]).candidates
        .filter(candidateId => candidateId.startsWith('operation-obligation:'));
      if (existingObligations.length > 0 && !existingObligations.includes(exactCandidateId)) return false;
    }
    const capabilitySubjects = outcomeSubjectTokens(existing[index].name);
    if (capabilitySubjects.length === 0) return false;
    const shared = replacementSubjects.filter(token => evidenceTokenMatchesOutcomeName(token, capabilitySubjects));
    return shared.length >= Math.min(2, replacementSubjects.length, capabilitySubjects.length);
  });
}

function mergeKnownEvidenceRepair(outcome: SystemCapability, evidence: SystemCapability): SystemCapability {
  const allowedCitations = new Set([evidence.id]);
  const existingFactors = new Set(outcome.criticality_factors || []);
  const merged = mergeCapabilityEvidence(outcome, evidence);
  return {
    ...merged,
    criticality_factors: (merged.criticality_factors || []).filter(factor =>
      !factor.startsWith('catalog-candidate:') ||
      existingFactors.has(factor) ||
      allowedCitations.has(factor.slice('catalog-candidate:'.length))),
  };
}

export function mergeCapabilityCatalogRepairResults(
  existing: SystemCapability[], incoming: SystemCapability[],
  evidenceRepairCandidateIds: ReadonlySet<string> = new Set(),
  knownEvidenceCandidates: readonly SystemCapability[] = [],
  descriptionRepairLifecycleKeys: ReadonlySet<string> = new Set(),
  postSynthesisGroundedCandidateIds: ReadonlySet<string> = new Set(),
): SystemCapability[] {
  const merged = [...existing];
  for (const replacement of incoming) {
    const replacementIdentity = capabilityCatalogRepairIdentity(replacement);
    const lifecycleMarker = (replacement.criticality_factors || [])
      .find(factor => factor.startsWith('catalog-description-repair-lifecycle:'));
    const replacementLifecycleKey = lifecycleMarker
      ? lifecycleMarker.slice('catalog-description-repair-lifecycle:'.length)
      : capabilityCatalogRepairLifecycleKey(replacement);
    const lifecycleMatches = merged.flatMap((capability, index) =>
      capabilityCatalogRepairLifecycleKey(capability) === replacementLifecycleKey ? [index] : []);
    if (process.env.KLAURO_DEBUG_CATALOG && lifecycleMarker) {
      console.error('[catalog-debug] description repair lifecycle merge:', JSON.stringify({
        name: replacement.name,
        lifecycle_key: replacementLifecycleKey,
        planned: descriptionRepairLifecycleKeys.has(replacementLifecycleKey),
        matching_indexes: lifecycleMatches,
        replacement_candidates: replacementIdentity.candidates,
      }));
    }
    if (descriptionRepairLifecycleKeys.has(replacementLifecycleKey) &&
        lifecycleMatches.length === 1 &&
        !capabilityCatalogDescriptionPending(replacement)) {
      const stableIdentity = merged[lifecycleMatches[0]];
      merged[lifecycleMatches[0]] = {
        ...stableIdentity,
        name: replacement.name,
        name_source: replacement.name_source,
        description: replacement.description,
        ...(replacement.description_source !== undefined ? { description_source: replacement.description_source } : {}),
        ...(replacement.description_generation !== undefined ? { description_generation: replacement.description_generation } : {}),
      };
      continue;
    }
      if (replacementIdentity.candidates.length > 1 && replacementIdentity.candidates.some(candidateId => evidenceRepairCandidateIds.has(candidateId))) {
        const groupedEvidence = replacementIdentity.candidates.map(candidateId =>
          evidenceRepairCandidateIds.has(candidateId)
            ? knownEvidenceCandidates.find(candidate => candidate.id === candidateId)
            : undefined);
        if (groupedEvidence.some(candidate => !candidate)) continue;
        const citedCandidateIds = new Set(replacementIdentity.candidates);
        const overlapsExisting = merged.some(capability =>
          capabilityCatalogRepairIdentity(capability).candidates.some(candidateId => citedCandidateIds.has(candidateId)));
        if (overlapsExisting) continue;
        const groundedSeed: SystemCapability = {
          ...replacement,
          operations: [],
          related_entities: [],
          related_domains: [],
          evidence_examples: [],
          criticality_factors: (replacement.criticality_factors || []).filter(factor => !factor.startsWith('catalog-candidate:')),
        };
        const grounded = (groupedEvidence as SystemCapability[]).reduce(
          (capability, evidence) => mergeCapabilityEvidence(capability, evidence),
          groundedSeed,
        );
        grounded.criticality_factors = (grounded.criticality_factors || []).filter(factor =>
          !factor.startsWith('catalog-candidate:') ||
          citedCandidateIds.has(factor.slice('catalog-candidate:'.length)));
        merged.push(grounded);
        continue;
      }
    const evidenceRepair = replacementIdentity.candidates.some(candidateId => evidenceRepairCandidateIds.has(candidateId));
    if (evidenceRepair) {
      const exactEvidence = replacementIdentity.candidates.length === 1
        ? knownEvidenceCandidates.find(candidate => candidate.id === replacementIdentity.candidates[0] && evidenceRepairCandidateIds.has(candidate.id))
        : undefined;
      if (!exactEvidence) continue;
      const semanticallyMatched = capabilityCatalogEvidenceRepairMatchIndexes(merged, replacement, [exactEvidence], evidenceRepairCandidateIds);
      if (semanticallyMatched.length === 1) {
        const index = semanticallyMatched[0];
        merged[index] = mergeKnownEvidenceRepair(merged[index], exactEvidence);
      } else if (semanticallyMatched.length === 0 &&
          postSynthesisGroundedCandidateIds.has(exactEvidence.id) &&
          !merged.some(capability => capabilityCatalogRepairIdentity(capability).candidates.includes(exactEvidence.id))) {
        merged.push(mergeKnownEvidenceRepair(replacement, exactEvidence));
      }
      continue;
    }
    let matching = replacementIdentity.requirements.length > 0
      ? merged.flatMap((capability, index) => {
        const identity = capabilityCatalogRepairIdentity(capability);
        return identity.requirements.some(requirement => replacementIdentity.requirements.includes(requirement)) ? [index] : [];
      })
      : [];
    if (matching.length === 0 && replacementIdentity.requirements.length === 0) {
      const allCandidateMatches = merged.flatMap((capability, index) => {
        const identity = capabilityCatalogRepairIdentity(capability);
        return identity.requirements.length === 0 && identity.candidates.some(candidate => replacementIdentity.candidates.includes(candidate)) ? [index] : [];
      });
      const candidateMatches = allCandidateMatches.filter(index => capabilityCatalogDescriptionPending(merged[index]));
      if (candidateMatches.length === 1) matching = candidateMatches;
      else if (capabilityCatalogDescriptionPending(replacement) && allCandidateMatches.some(index => !capabilityCatalogDescriptionPending(merged[index]))) continue;
    }
    if (matching.some(index => !capabilityCatalogDescriptionPending(merged[index]))) continue;
    for (const index of matching.sort((left, right) => right - left)) merged.splice(index, 1);
    merged.push(replacement);
  }
  return merged;
}

export function capabilityCatalogPendingRepairKeys(capabilities: readonly SystemCapability[]): string[] {
  return [...new Set(capabilities.filter(capabilityCatalogDescriptionPending).flatMap(capability => {
    const identity = capabilityCatalogRepairIdentity(capability);
    if (identity.requirements.length > 0) return identity.requirements.map(requirement => `requirement:${requirement}`);
    if (identity.candidates.length > 0) return identity.candidates.map(candidate => `candidate:${candidate}`);
    return [`capability:${capability.id}`];
  }))].sort();
}

export function capabilityCatalogTargetedRepairBatches<T>(facts: readonly T[], targetedRepair: boolean): T[][] {
  return targetedRepair && facts.length > 1 ? facts.map(fact => [fact]) : [[...facts]];
}

export async function collectCapabilityCatalogEvidenceBatches<TFact, TValue>(args: {
  facts: readonly TFact[]; evidenceScoped: boolean; hardDeadlineAt?: number; batchBudgetMs: number;
  extract: (facts: TFact[], deadlineAt: number | undefined, batchIndex: number) => Promise<TValue[]>;
  isDeadlineError: (error: unknown) => boolean; conflictKeys?: (fact: TFact) => readonly string[]; concurrency?: number;
  onBatchSettled?: (values: readonly TValue[], batchIndex: number) => void;
}): Promise<TValue[]> {
  const batches = capabilityCatalogTargetedRepairBatches(args.facts, args.evidenceScoped);
  const valuesByIndex = new Map<number, TValue[]>();
  const concurrency = args.evidenceScoped ? Math.max(1, Math.min(4, args.concurrency ?? 4)) : 1;
  const pending = batches.map((batch, index) => ({ batch, index }));
  while (pending.length > 0) {
    if (args.hardDeadlineAt !== undefined && Date.now() >= args.hardDeadlineAt) break;
    const wave: Array<{ batch: TFact[]; index: number }> = []; const waveKeys = new Set<string>();
    for (let pendingIndex = 0; pendingIndex < pending.length && wave.length < concurrency;) {
      const item = pending[pendingIndex];
      const keys = new Set(args.conflictKeys ? item.batch.flatMap(fact => [...args.conflictKeys!(fact)]) : []);
      if (wave.length > 0 && [...keys].some(key => waveKeys.has(key))) { pendingIndex += 1; continue; }
      wave.push(item); keys.forEach(key => waveKeys.add(key)); pending.splice(pendingIndex, 1);
    }
    const results = await Promise.allSettled(wave.map(({ batch, index }) => {
      const deadlineAt = args.evidenceScoped ? Math.min(args.hardDeadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + args.batchBudgetMs) : args.hardDeadlineAt;
      return args.extract(batch, deadlineAt, index);
    }));
    for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
      const result = results[resultIndex]; const batchIndex = wave[resultIndex].index;
      if (result.status === 'fulfilled') { args.onBatchSettled?.(result.value, batchIndex); valuesByIndex.set(batchIndex, result.value); }
      else {
        const globalDeadlineReached = args.hardDeadlineAt !== undefined && Date.now() >= args.hardDeadlineAt;
        if (!args.evidenceScoped || !args.isDeadlineError(result.reason) || globalDeadlineReached) throw result.reason;
      }
    }
  }
  return [...valuesByIndex.entries()].sort(([left], [right]) => left - right).flatMap(([, values]) => values);
}

export function updateCapabilityCatalogPublishabilityRepairIds(
  pending: Set<string>, accepted: SystemCapability[], rejected: SystemCapability[],
): void {
  const ids = (capability: SystemCapability) => (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:'))
    .map(factor => factor.slice('catalog-candidate:'.length));
  rejected.flatMap(ids).forEach(candidateId => pending.add(candidateId));
  accepted.flatMap(ids).forEach(candidateId => pending.delete(candidateId));
}

export function capabilityIdentityPendingDescriptionRepair(
  capability: SystemCapability,
  failure: string,
): SystemCapability | undefined {
  const persistedDescriptionFailure = capability.description_generation?.status === 'ai_rejected' &&
    capability.description_generation.reason === failure &&
    !['name-is-not-authored', 'missing-structural-anchor', 'bare-noun-name'].includes(failure);
  const descriptionFailure = persistedDescriptionFailure || failure === 'missing-description' ||
    failure === 'structural-placeholder-description' ||
    failure === 'description-too-short' ||
    failure === 'description-too-long' ||
    failure.startsWith('description-');
  if (!descriptionFailure) return undefined;
  return {
    ...capability,
    description: '',
    description_source: undefined,
    description_generation: {
      ...(capability.description_generation || { attempted: true }),
      status: 'ai_rejected',
      attempted: true,
      reason: failure,
    },
  };
}

function capabilityCatalogRepairBudget(requiredFamilyCount: number): {
  maxCycles: number;
  noProgressRetries: number;
} {
  const families = Math.max(0, Math.floor(requiredFamilyCount));
  const noProgressRetries = families > 0 ? 2 : 0;
  return {
    maxCycles: 1 + families + noProgressRetries,
    noProgressRetries,
  };
}

export function trackCapabilityCatalogRepair(
  distinctFamilyCount: number,
  requiredBehaviorCandidateIds: readonly string[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
  requiredOutcomeIds: readonly string[] = [],
  candidateFamilyGroups: ReadonlyArray<ReadonlyArray<string>> = [],
) {
  const requiredFamilyCount = Math.max(
    distinctFamilyCount,
    requiredBehaviorCandidateIds.length + requiredEntityCandidateGroups.length,
    requiredOutcomeIds.length,
  );
  const budget = capabilityCatalogRepairBudget(requiredFamilyCount);
  const uncoveredEvidenceKeys = (capabilities: SystemCapability[], operationUncoveredIds: readonly string[] = requiredBehaviorCandidateIds) => new Set([
    ...operationUncoveredIds,
    ...uncoveredCapabilityCatalogCandidateIds(capabilities, [], requiredEntityCandidateGroups),
    ...uncoveredCapabilityCatalogFamilyRepresentativeIds(capabilities, candidateFamilyGroups),
  ]);
  let previousEvidenceKeys = uncoveredEvidenceKeys([]);
  let previousOutcomeKeys = new Set(requiredOutcomeIds);
  let previousPendingKeys = new Set<string>();
  let noProgressCycles = 0;
  const strictlyReduced = (current: ReadonlySet<string>, previous: ReadonlySet<string>) =>
    current.size < previous.size && [...current].every(key => previous.has(key));
  const unchanged = (current: ReadonlySet<string>, previous: ReadonlySet<string>) =>
    current.size === previous.size && [...current].every(key => previous.has(key));
  return {
    maxCycles: budget.maxCycles,
    observe(capabilities: SystemCapability[], uncoveredOutcomeIds: readonly string[] = [], pendingIdentityKeys: readonly string[] = [], operationUncoveredIds: readonly string[] = requiredBehaviorCandidateIds) {
      const evidenceKeys = uncoveredEvidenceKeys(capabilities, operationUncoveredIds);
      const outcomeKeys = new Set(uncoveredOutcomeIds);
      const pendingKeys = new Set(pendingIdentityKeys);
      const mandatoryProgress = strictlyReduced(evidenceKeys, previousEvidenceKeys) || strictlyReduced(outcomeKeys, previousOutcomeKeys);
      const mandatoryUnchanged = unchanged(evidenceKeys, previousEvidenceKeys) && unchanged(outcomeKeys, previousOutcomeKeys);
      const progressed = mandatoryProgress || (mandatoryUnchanged && strictlyReduced(pendingKeys, previousPendingKeys));
      noProgressCycles = progressed ? 0 : noProgressCycles + 1;
      previousEvidenceKeys = evidenceKeys;
      previousOutcomeKeys = outcomeKeys;
      previousPendingKeys = pendingKeys;
      const uncoveredCount = evidenceKeys.size + outcomeKeys.size + pendingKeys.size;
      return { noProgressCycles, uncoveredCount, stop: noProgressCycles >= budget.noProgressRetries };
    },
  };
}

export function capabilityTitlesShareOutcome(left: SystemCapability, right: SystemCapability): boolean {
  const tokens = (name: string) => name.toLowerCase()
    .replace(/^(?:lets|allows|enables)\s+users\s+(?:to\s+)?/, '')
    .split(/[^a-z0-9]+/).filter(Boolean)
    .map(token => /^(?:sync|synchronise|synchronize)$/.test(token) ? 'synchronize' : token);
  const leftTokens = tokens(left.name);
  const rightTokens = tokens(right.name);
  const analysisIdentity = (parts: string[]): string | undefined => {
    const direct = new Set(['analyze', 'analyse', 'assess', 'inspect']);
    if (direct.has(parts[0])) return parts.slice(1).filter(token => token !== 'analysis').sort().join('|');
    const execution = new Set(['execute', 'perform', 'run']);
    if (execution.has(parts[0]) && parts.includes('analysis')) {
      return parts.slice(1).filter(token => token !== 'analysis').sort().join('|');
    }
    return undefined;
  };
  const leftAnalysis = analysisIdentity(leftTokens);
  const rightAnalysis = analysisIdentity(rightTokens);
  if (leftAnalysis && leftAnalysis === rightAnalysis) return true;
  return leftTokens[0] === rightTokens[0] && leftTokens.filter(token => rightTokens.includes(token)).length >= 4;
}

function outcomeMeaningTokens(value: string): Set<string> {
  const ignored = new Set(['a', 'an', 'and', 'codebase', 'for', 'from', 'in', 'of', 'on', 'software', 'system', 'the', 'to', 'with']);
  const stem = (token: string) => {
    const normalized = token.replace(/(?:ing|ed|es|s)$/i, '');
    return /^analy[sz]e?$/.test(normalized) ? 'analyz' : normalized;
  };
  return new Set(String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !ignored.has(token))
    .map(stem)
    .filter(token => token.length >= 3));
}

function overlapAgainstSmaller(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  return [...left].filter(value => right.has(value)).length / Math.min(left.size, right.size);
}

export function capabilityDescriptionsShareOutcome(left: SystemCapability, right: SystemCapability): boolean {
  const leftTitle = outcomeMeaningTokens(left.name);
  const rightTitle = outcomeMeaningTokens(right.name);
  const leftDescription = outcomeMeaningTokens(left.description || '');
  const rightDescription = outcomeMeaningTokens(right.description || '');
  const mutuallyEntailed = overlapAgainstSmaller(leftTitle, rightDescription) >= 0.8 &&
    overlapAgainstSmaller(rightTitle, leftDescription) >= 0.8;
  if (!mutuallyEntailed) return false;

  const operationIds = (capability: SystemCapability) => new Set(
    (capability.operations || []).map(operation => operation.entry_point_id).filter(Boolean),
  );
  const entityIds = (capability: SystemCapability) => new Set(capability.related_entities || []);
  const citations = (capability: SystemCapability) => new Set((capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:')));
  return overlapAgainstSmaller(operationIds(left), operationIds(right)) >= 0.6 ||
    overlapAgainstSmaller(entityIds(left), entityIds(right)) >= 0.8 ||
    overlapAgainstSmaller(citations(left), citations(right)) >= 0.6;
}

export function scheduleCapabilityCatalog<TTarget>(args: {
  outcome: Promise<CapabilityCatalogOutcome>;
  capabilities: SystemCapability[];
  elementsEnabled: boolean;
  elementLimit: number;
  reauthorDescriptions: boolean;
  toTarget: (capability: SystemCapability) => TTarget;
  authorDescriptions: (capabilities: SystemCapability[]) => Promise<void>;
}): Promise<ScheduledCapabilityCatalog<TTarget>> {
  return args.outcome.then(outcome => {
    if (outcome.status === 'rejected') throw outcome.reason;
    const selected = outcome.value.length > 0
      ? outcome.value
      : args.capabilities.filter(capability =>
        capability.name_source === 'deterministic' ||
        capability.name_source === 'ai' ||
        capability.name_source === 'manual' ||
        capability.name_source === 'reused').map(capability => structuredClone(capability));
    const targetCapabilities = args.elementsEnabled
      ? selected.slice(0, args.elementLimit)
      : [];
    const descriptionPromise = args.reauthorDescriptions && targetCapabilities.length > 0
      ? args.authorDescriptions(targetCapabilities)
      : undefined;
    if (descriptionPromise) void descriptionPromise.catch(() => undefined);
    return {
      capabilities: selected,
      authoredFacts: selected.map(capability => ({
        name: capability.name,
        description: capability.description,
        category: capability.category,
      })),
      targets: targetCapabilities.map(args.toTarget),
      descriptionPromise,
    };
  });
}
