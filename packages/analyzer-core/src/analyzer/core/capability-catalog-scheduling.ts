import type { SystemCapability } from '../../types/cas.types';
import { capabilityEvidenceSubjectTokens, capabilityRequiresCatalogCoverage } from './capability-catalog-evidence';
import type { CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';

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
  record: (feedback: CapabilityCatalogRejection) => void;
  retry: () => Promise<T[]>;
}): Promise<T[]> {
  if (args.initial.length > 0 || !args.requirement) return args.initial;
  const expectedFeedbackExists = args.rejections.some(rejection => rejection.requirementId === args.requirement?.id &&
    args.candidateIds.every(candidateId => rejection.candidateIds.includes(candidateId)));
  if (!expectedFeedbackExists) {
    const feedback = capabilityCatalogOutcomeCorrectiveRetryFeedback(args.rejections, args.requirement, args.candidateIds);
    args.rejections.push(feedback);
    args.record(feedback);
  }
  return args.retry();
}

export type CapabilityCatalogRejectionsByCandidate = Map<string, CapabilityCatalogPriorRejection[]>;

export function selectCapabilityCatalogPromptCandidates(
  rankedCandidates: SystemCapability[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>> = [],
): SystemCapability[] {
  const behaviorCandidates = rankedCandidates.filter(candidate => candidate.evidence_kind === 'behavior-surface');
  const requiredBehaviorCandidates = behaviorCandidates.filter(capabilityRequiresCatalogCoverage);
  const requiredEntityCandidates = requiredEntityCandidateGroups
    .map(group => rankedCandidates.find(candidate => group.includes(candidate.id)))
    .filter((candidate): candidate is SystemCapability => Boolean(candidate));
  const requiredIds = new Set([...requiredBehaviorCandidates, ...requiredEntityCandidates].map(candidate => candidate.id));
  const requiredCandidates = rankedCandidates.filter(candidate => requiredIds.has(candidate.id));
  const structuralCandidates = rankedCandidates.filter(candidate =>
    !requiredIds.has(candidate.id) && candidate.evidence_kind !== 'behavior-surface');
  const internalBehaviorCandidates = behaviorCandidates.filter(candidate =>
    !requiredIds.has(candidate.id));
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
): string[] {
  const citedCandidateIds = new Set(capabilities.flatMap(capability =>
    (capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length))));
  return [...new Set([
    ...requiredBehaviorCandidateIds.filter(candidateId => !citedCandidateIds.has(candidateId)),
    ...requiredEntityCandidateGroups
      .filter(group => !group.some(candidateId => citedCandidateIds.has(candidateId)))
      .flat(),
  ])];
}

export function uncoveredCapabilityCatalogFamilyRepresentativeIds(
  capabilities: SystemCapability[],
  candidateFamilyGroups: ReadonlyArray<ReadonlyArray<string>>,
): string[] {
  const citedCandidateIds = new Set(capabilities.flatMap(capability =>
    (capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length))));
  return candidateFamilyGroups
    .filter(group => group.length > 0 && !group.some(candidateId => citedCandidateIds.has(candidateId)))
    .map(group => group[0]);
}

export function capabilityCatalogRepairCandidateIds(
  capabilities: SystemCapability[],
  requiredBehaviorCandidateIds: readonly string[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
  pendingPublishabilityIds: ReadonlySet<string>,
  candidateFamilyGroups: ReadonlyArray<ReadonlyArray<string>> = [],
): string[] {
  return [...new Set([
    ...uncoveredCapabilityCatalogCandidateIds(capabilities, requiredBehaviorCandidateIds, requiredEntityCandidateGroups),
    ...uncoveredCapabilityCatalogFamilyRepresentativeIds(capabilities, candidateFamilyGroups),
    ...pendingPublishabilityIds,
  ])];
}

function normalizedOutcomeNameTokens(name: string): string[] {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3)
    .map(token => token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token);
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
  const operations = new Map((outcome.operations || []).map(operation => [operationKey(operation), operation]));
  for (const operation of evidence.operations || []) operations.set(operationKey(operation), operation);
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
    criticality_factors: [...new Set([
      ...(outcome.criticality_factors || []),
      ...(evidence.criticality_factors || []),
      `catalog-candidate:${evidence.id}`,
    ])],
    evidence_examples: [...new Set([...(outcome.evidence_examples || []), ...(evidence.evidence_examples || [])])],
  };
}

export function mergeUniquelyMatchedBehaviorEvidence(
  capabilities: SystemCapability[],
  evidenceCandidates: readonly SystemCapability[],
  requiredCandidateIds: readonly string[],
): SystemCapability[] {
  const requiredIds = new Set(requiredCandidateIds);
  const merged = capabilities.map(capability => ({ ...capability }));
  const citedIds = new Set(merged.flatMap(capability =>
    (capability.criticality_factors || [])
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length))));
  for (const evidence of evidenceCandidates) {
    if (!requiredIds.has(evidence.id) || citedIds.has(evidence.id) || evidence.evidence_kind !== 'behavior-surface') continue;
    const evidenceTokens = capabilityEvidenceSubjectTokens(evidence);
    if (evidenceTokens.length === 0) continue;
    const matchingIndexes = merged.flatMap((capability, index) =>
      evidenceTokens.some(token => evidenceTokenMatchesOutcomeName(token, normalizedOutcomeNameTokens(capability.name)))
        ? [index]
        : []);
    if (matchingIndexes.length !== 1) continue;
    const index = matchingIndexes[0];
    merged[index] = mergeCapabilityEvidence(merged[index], evidence);
    citedIds.add(evidence.id);
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
): { added: boolean; feedback: { name: string; description?: string; reason: string; requirement_id?: string; forbidden_terms: string[] } } {
  const identity = capabilityCatalogRepairIdentity(capability);
  const requirementId = identity.requirements[0];
  const recorded = recordCapabilityCatalogRejection(rejectionsByCandidate, {
    candidateIds: identity.candidates, name: capability.name, reason, requirementId, forbiddenSubjectTerms: forbiddenTerms,
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

export function mergeCapabilityCatalogRepairResults(
  existing: SystemCapability[], incoming: SystemCapability[],
): SystemCapability[] {
  const merged = [...existing];
  for (const replacement of incoming) {
    const replacementIdentity = capabilityCatalogRepairIdentity(replacement);
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
  facts: readonly TFact[];
  evidenceScoped: boolean;
  hardDeadlineAt?: number;
  batchBudgetMs: number;
  extract: (facts: TFact[], deadlineAt?: number) => Promise<TValue[]>;
  isDeadlineError: (error: unknown) => boolean;
}): Promise<TValue[]> {
  const values: TValue[] = [];
  for (const batch of capabilityCatalogTargetedRepairBatches(args.facts, args.evidenceScoped)) {
    if (args.hardDeadlineAt !== undefined && Date.now() >= args.hardDeadlineAt) break;
    const deadlineAt = args.evidenceScoped
      ? Math.min(args.hardDeadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + args.batchBudgetMs)
      : args.hardDeadlineAt;
    try {
      values.push(...await args.extract(batch, deadlineAt));
    } catch (error) {
      const globalDeadlineReached = args.hardDeadlineAt !== undefined && Date.now() >= args.hardDeadlineAt;
      if (!args.evidenceScoped || !args.isDeadlineError(error) || globalDeadlineReached) throw error;
    }
  }
  return values;
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
  const descriptionFailure = failure === 'missing-description' ||
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
  const uncoveredEvidenceKeys = (capabilities: SystemCapability[]) => new Set([
    ...uncoveredCapabilityCatalogCandidateIds(capabilities, requiredBehaviorCandidateIds, requiredEntityCandidateGroups),
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
    observe(capabilities: SystemCapability[], uncoveredOutcomeIds: readonly string[] = [], pendingIdentityKeys: readonly string[] = []) {
      const evidenceKeys = uncoveredEvidenceKeys(capabilities);
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
    .split(/[^a-z0-9]+/).filter(Boolean);
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
