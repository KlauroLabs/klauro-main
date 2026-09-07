import type { EnhancedSystemPurpose, SystemCapability } from '../../types/cas.types';
import { uncoveredCapabilityCatalogOutcomeRequirements, type CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';

export interface CapabilityCatalogReconciliationInput {
  requiredOutcomes: readonly CapabilityCatalogOutcomeRequirement[];
  normalizedOutcomeRequirements: readonly CapabilityCatalogOutcomeRequirement[];
  publishedCapabilities: readonly SystemCapability[];
  intentGapRequirements: readonly CapabilityCatalogOutcomeRequirement[];
  unresolvedRejectedProductOutcomeIds: readonly string[];
  evidenceCandidates: readonly SystemCapability[];
}

export function buildCapabilityCatalogReconciliation({
  requiredOutcomes, normalizedOutcomeRequirements, publishedCapabilities,
  intentGapRequirements, unresolvedRejectedProductOutcomeIds, evidenceCandidates,
}: CapabilityCatalogReconciliationInput): NonNullable<EnhancedSystemPurpose['capability_reconciliation']> {
  const normalizedOutcomeRequirementById = new Map(normalizedOutcomeRequirements.map(requirement => [requirement.id, requirement]));
  const groundedCapabilityIdsFor = (requirement: CapabilityCatalogOutcomeRequirement): string[] => publishedCapabilities.filter(capability => uncoveredCapabilityCatalogOutcomeRequirements([capability], [normalizedOutcomeRequirementById.get(requirement.id) || requirement]).length === 0).map(capability => capability.id);
  const intentGapRequirementIds = new Set(intentGapRequirements.map(requirement => requirement.id));
  const groundedRequirementIds = new Set(requiredOutcomes.filter(requirement => !intentGapRequirementIds.has(requirement.id)).map(requirement => requirement.id));
  return {
    proposals: requiredOutcomes.map(requirement => {
      const capabilityIds = groundedCapabilityIdsFor(requirement);
      return {
        requirement_id: requirement.id,
        statement: requirement.statement,
        ...(requirement.firstPartyOutcomeText ? { first_party_outcome_text: requirement.firstPartyOutcomeText } : {}),
        ...(requirement.audience ? { audience: requirement.audience } : {}),
        candidate_ids: [...requirement.candidateIds],
        disposition: capabilityIds.length > 0 ? 'grounded' as const : 'intent-gap' as const,
        capability_ids: capabilityIds,
      };
    }),
    undocumented_capabilities: publishedCapabilities
      .filter(capability => requiredOutcomes.every(requirement =>
        !groundedRequirementIds.has(requirement.id) ||
        uncoveredCapabilityCatalogOutcomeRequirements([capability], [
          normalizedOutcomeRequirementById.get(requirement.id) || requirement,
        ]).length > 0))
      .map(capability => ({ capability_id: capability.id, name: capability.name })),
    ...(unresolvedRejectedProductOutcomeIds.length > 0 ? {
      structural_gaps: unresolvedRejectedProductOutcomeIds.map(candidateId => {
        const candidate = evidenceCandidates.find(item => item.id === candidateId);
        return {
          candidate_id: candidateId,
          name: candidate?.structural_label || candidate?.name || candidateId,
          reason: 'grounded product-outcome evidence was not reconciled into a publishable capability',
        };
      }),
    } : {}),
  };
}
