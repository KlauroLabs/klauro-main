import type { SystemCapability } from '../../types/cas.types';
import { capabilityEvidenceSubjectTokens, capabilityRequiresCatalogCoverage } from './capability-catalog-evidence';

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

export function capabilityCatalogRepairCandidateIds(
  capabilities: SystemCapability[],
  requiredBehaviorCandidateIds: readonly string[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
  pendingPublishabilityIds: ReadonlySet<string>,
): string[] {
  return [...new Set([
    ...uncoveredCapabilityCatalogCandidateIds(capabilities, requiredBehaviorCandidateIds, requiredEntityCandidateGroups),
    ...pendingPublishabilityIds,
  ])];
}

export function capabilityCatalogRepairEvidenceFacts(
  candidates: SystemCapability[], repairCandidateIds: readonly string[], entityNamesById: ReadonlyMap<string, string>,
) {
  const repairIds = new Set(repairCandidateIds);
  return candidates.filter(candidate => repairIds.has(candidate.id)).map(candidate => {
    const entityNames = (candidate.related_entities || []).map(entityId => entityNamesById.get(entityId) || entityId);
    return {
      candidate_id: candidate.id,
      evidence_subject: candidate.structural_label || candidate.name,
      evidence_subject_terms: capabilityEvidenceSubjectTokens(candidate, entityNames),
      related_domains: candidate.related_domains || [],
      entity_names: entityNames,
      operations: (candidate.operations || []).slice(0, 8).map(operation => ({ action: operation.action, surface: operation.path_or_command })),
      examples: (candidate.evidence_examples || []).slice(0, 8),
    };
  });
}

export function capabilityCatalogTargetedRepairBatches<T>(facts: readonly T[], targetedRepair: boolean): T[][] {
  return targetedRepair && facts.length > 1 ? facts.map(fact => [fact]) : [[...facts]];
}

export function updateCapabilityCatalogPublishabilityRepairIds(
  pending: Set<string>, accepted: SystemCapability[], rejected: SystemCapability[],
): void {
  const ids = (capability: SystemCapability) => (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:'))
    .map(factor => factor.slice('catalog-candidate:'.length));
  accepted.flatMap(ids).forEach(candidateId => pending.delete(candidateId));
  rejected.flatMap(ids).forEach(candidateId => pending.add(candidateId));
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
) {
  const requiredFamilyCount = Math.max(
    distinctFamilyCount,
    requiredBehaviorCandidateIds.length + requiredEntityCandidateGroups.length,
  );
  const budget = capabilityCatalogRepairBudget(requiredFamilyCount);
  let previousUncoveredCount = uncoveredCapabilityCatalogCandidateIds(
    [], requiredBehaviorCandidateIds, requiredEntityCandidateGroups,
  ).length;
  let noProgressCycles = 0;
  return {
    maxCycles: budget.maxCycles,
    observe(capabilities: SystemCapability[]) {
      const uncoveredCount = uncoveredCapabilityCatalogCandidateIds(
        capabilities, requiredBehaviorCandidateIds, requiredEntityCandidateGroups,
      ).length;
      noProgressCycles = uncoveredCount < previousUncoveredCount ? 0 : noProgressCycles + 1;
      previousUncoveredCount = uncoveredCount;
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
