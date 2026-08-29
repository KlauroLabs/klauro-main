import type { SystemCapability } from '../../types/cas.types';
import { canonicalCapabilityCatalogOutcomeToken, capabilityCatalogOutcomeRepairNudge, capabilityPotentiallySatisfiesCatalogOutcomeRequirement, capabilitySemanticallySatisfiesCatalogOutcomeRequirement, type CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';

export type CapabilityCatalogRepairBatch =
  | { mode: 'outcome'; candidateIds: string[]; requirements: CapabilityCatalogOutcomeRequirement[] }
  | { mode: 'evidence'; candidateIds: string[]; requirements: [] }
  | { mode: 'description'; candidateIds: string[]; requirements: CapabilityCatalogOutcomeRequirement[]; identity: SystemCapability };

const factors = (capability: Partial<Pick<SystemCapability, 'criticality_factors'>>, prefix: string): string[] =>
  (capability.criticality_factors || []).filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length));

export function capabilityCatalogRepairPlan(args: {
  evidenceCandidateIds: readonly string[];
  outcomeRequirements: readonly CapabilityCatalogOutcomeRequirement[];
  pendingCapabilities: readonly SystemCapability[];
}): CapabilityCatalogRepairBatch[] {
  const descriptionBatches = args.pendingCapabilities.map(identity => {
    const requirementIds = new Set(factors(identity, 'catalog-outcome-requirement:'));
    return {
      mode: 'description' as const,
      candidateIds: factors(identity, 'catalog-candidate:'),
      requirements: args.outcomeRequirements.filter(requirement => requirementIds.has(requirement.id)),
      identity,
    };
  });
  const pendingRequirements = new Set(descriptionBatches.flatMap(batch => batch.requirements.map(requirement => requirement.id)));
  const outcomeBatches = args.outcomeRequirements
    .filter(requirement => !pendingRequirements.has(requirement.id))
    .map(requirement => ({
      mode: 'outcome' as const,
      candidateIds: [...new Set(requirement.candidateIds)],
      requirements: [requirement],
    }));
  const reservedCandidates = new Set([
    ...descriptionBatches.flatMap(batch => batch.candidateIds),
    ...outcomeBatches.flatMap(batch => batch.candidateIds),
  ]);
  const evidenceBatches = [...new Set(args.evidenceCandidateIds)]
    .filter(candidateId => !reservedCandidates.has(candidateId))
    .map(candidateId => ({ mode: 'evidence' as const, candidateIds: [candidateId], requirements: [] as [] }));
  return [...descriptionBatches, ...outcomeBatches, ...evidenceBatches];
}

export function preserveCapabilityCatalogDescriptionIdentity(
  identity: SystemCapability,
  repair: SystemCapability,
): SystemCapability {
  return {
    ...identity,
    description: repair.description,
    description_source: repair.description_source,
    description_generation: repair.description_generation,
  };
}

export function capabilityCatalogPendingRequirementIds(
  capability: Pick<SystemCapability, 'name' | 'description'> & Partial<Pick<SystemCapability, 'criticality_factors'>>,
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): string[] {
  if (factors(capability, 'catalog-outcome-requirement:').length > 0) return [];
  return requirements
    .filter(requirement => capabilityPotentiallySatisfiesCatalogOutcomeRequirement(capability, requirement))
    .map(requirement => requirement.id);
}

export function captureCapabilityCatalogPendingRequirements(
  pendingRequirementIdsByCapabilityId: Map<string, string[]>,
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): void {
  for (const capability of capabilities) {
    if (!pendingRequirementIdsByCapabilityId.has(capability.id)) {
      pendingRequirementIdsByCapabilityId.set(capability.id, capabilityCatalogPendingRequirementIds(capability, requirements));
    }
  }
}

const outcomeNameTokens = (name: string): string[] => {
  const ignored = new Set(['a', 'an', 'across', 'and', 'for', 'from', 'in', 'of', 'on', 'the', 'through', 'to', 'with']);
  return [...new Set(String(name || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !ignored.has(token))
    .map(canonicalCapabilityCatalogOutcomeToken))];
};

function unboundNameIsCoveredByRequirementReplacement(
  pending: SystemCapability,
  replacement: SystemCapability,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  if (requirement.audience) return false;
  const pendingTokens = outcomeNameTokens(pending.name);
  const replacementTokens = outcomeNameTokens(replacement.name);
  if (!pendingTokens[0] || pendingTokens[0] !== replacementTokens[0]) return false;
  const replacementTokenSet = new Set(replacementTokens);
  const overlap = pendingTokens.filter(token => replacementTokenSet.has(token)).length;
  const subjectTerms = (requirement.requiredSubjectTerms || requirement.subjectTokens).map(canonicalCapabilityCatalogOutcomeToken);
  return overlap >= 3 && overlap === pendingTokens.length &&
    subjectTerms.some(term => pendingTokens.includes(term));
}

export function supersedeUnboundPendingOutcomeDuplicates(
  existing: readonly SystemCapability[], incoming: readonly SystemCapability[], requirements: readonly CapabilityCatalogOutcomeRequirement[],
  pendingRequirementIdsByCapabilityId: ReadonlyMap<string, readonly string[]>,
): { existing: SystemCapability[]; incoming: SystemCapability[] } {
  const requirementById = new Map(requirements.map(requirement => [requirement.id, requirement]));
  const validReplacements = new Map<string, SystemCapability[]>();
  for (const capability of [...existing, ...incoming]) {
    if (!capability.description || capability.description_generation?.status === 'ai_rejected' ||
        capability.criticality_factors?.some(factor => factor.startsWith('catalog-evidence-rejected:'))) continue;
    const candidateIds = factors(capability, 'catalog-candidate:');
    for (const requirementId of factors(capability, 'catalog-outcome-requirement:')) {
      const requirement = requirementById.get(requirementId);
      if (!requirement || !candidateIds.some(candidateId => requirement.candidateIds.includes(candidateId)) ||
          !capabilitySemanticallySatisfiesCatalogOutcomeRequirement(capability, requirement)) continue;
      validReplacements.set(requirementId, [...(validReplacements.get(requirementId) || []), capability]);
    }
  }
  const repairedRequirements = new Set(validReplacements.keys());
  if (repairedRequirements.size === 0) return { existing: [...existing], incoming: [...incoming] };
  const isSupersededPendingIdentity = (capability: SystemCapability): boolean => {
    if (factors(capability, 'catalog-outcome-requirement:').length > 0) return false;
    const capturedRequirementIds = pendingRequirementIdsByCapabilityId.get(capability.id) || [];
    const matchedRequirementIds = capturedRequirementIds.length > 0 ? capturedRequirementIds : requirements
      .filter(requirement => (validReplacements.get(requirement.id) || [])
        .some(replacement => unboundNameIsCoveredByRequirementReplacement(capability, replacement, requirement)))
      .map(requirement => requirement.id);
    return matchedRequirementIds.length > 0 && matchedRequirementIds.every(requirementId => repairedRequirements.has(requirementId));
  };
  return {
    existing: existing.filter(capability => !isSupersededPendingIdentity(capability)),
    incoming: incoming.filter(capability => !isSupersededPendingIdentity(capability)),

  };
}
export function capabilityCatalogFocusedTask(mode: CapabilityCatalogRepairBatch['mode'] | undefined, _identityName?: string, acceptsExistingOutcome = false): string {
  if (mode === 'description') return `Rewrite only the description for the existing capability identity retained by the server. Return exactly one object with the supplied candidate_ids. Preserve any supplied requirement_id exactly. The returned name is ignored; do not broaden or replace the outcome. Correct every reason and missing term named in prior_rejections.`;
  if (mode === 'outcome') return `Return exactly one object for the single required_outcomes entry and copy its requirement_id exactly. Independently express that entry's audience and outcome subjects. Use the supplied audience label itself when present; do not expand it into an inferred profession or role.`;
  return acceptsExistingOutcome
    ? 'Name only the common user or operator purpose of this evidence family. Reuse an accepted name only when its wording and evidence express that same outcome.'
    : 'Name only the common user or operator purpose of this evidence family. Do not emit requirement_id and do not reuse or restate an accepted global outcome.';
}

export function capabilityCatalogRepairNudge(
  batch: CapabilityCatalogRepairBatch,
  facts: unknown,
  qualityFailure?: string,
  publishabilityFeedback?: string,
): string {
  const obligation = batch.mode === 'description'
    ? `${publishabilityFeedback || ''} Repair only the rejected description for the stable accepted identity.`
    : batch.mode === 'outcome'
      ? capabilityCatalogOutcomeRepairNudge(batch.requirements, batch.candidateIds)
      : 'Cover only this missing evidence family; it has no product-outcome requirement and cannot reuse another accepted outcome.';
  return `Previous catalog failed a quality check (${qualityFailure}). ${obligation} Return only the evidence-grounded result requested in this ${batch.mode} batch. Missing evidence facts: ${JSON.stringify(facts)}. Each result must cite one or more of these candidate_ids and name the shared USER PURPOSE delivered by that evidence subject. A behavior-surface family label and its individual operation names are delivery evidence, never title templates. Never use MCP, tool, or surface as a capability title or description noun. Never begin a delivery-surface outcome with Get, List, Run, Release, Claim, Check, Extend, Install, Start, Stop, Sync, Fetch, Load, Read, or Show. Do not enumerate individual response objects, commands, or configuration fields.`;
}
