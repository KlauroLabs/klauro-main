import type { SystemCapability } from '../../types/cas.types';

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
  const requiredBehaviorCandidates = behaviorCandidates.filter(candidate => candidate.category !== 'internal');
  const requiredEntityCandidates = requiredEntityCandidateGroups
    .map(group => rankedCandidates.find(candidate => group.includes(candidate.id)))
    .filter((candidate): candidate is SystemCapability => Boolean(candidate));
  const requiredIds = new Set([...requiredBehaviorCandidates, ...requiredEntityCandidates].map(candidate => candidate.id));
  const requiredCandidates = rankedCandidates.filter(candidate => requiredIds.has(candidate.id));
  const structuralCandidates = rankedCandidates.filter(candidate =>
    !requiredIds.has(candidate.id) && candidate.evidence_kind !== 'behavior-surface');
  const internalBehaviorCandidates = behaviorCandidates.filter(candidate =>
    !requiredIds.has(candidate.id) && candidate.category === 'internal');
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
