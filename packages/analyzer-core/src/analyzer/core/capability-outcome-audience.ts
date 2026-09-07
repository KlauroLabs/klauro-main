import type { SystemCapability } from '../../types/cas.types';
import type { CapabilityCatalogOutcomeRequirement, CapabilityCatalogOutcomeBindingFailure } from './capability-catalog-outcome-coverage';

const humanAudienceSource = '(?:humans?|people|persons?|users?)';
const agentAudienceSource = '(?:agents?|assistants?)';
export const humanAudience = new RegExp(`\\b${humanAudienceSource}\\b`, 'i');
export const agentAudience = new RegExp(`\\b${agentAudienceSource}\\b`, 'i');
export const coordinatedAudienceList = new RegExp(
  `\\b(?:${humanAudienceSource}\\s*(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*|\\s*\\/\\s*)(?:AI\\s+)?${agentAudienceSource}|(?:AI\\s+)?${agentAudienceSource}\\s*(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*|\\s*\\/\\s*)${humanAudienceSource})\\b`,
  'i',
);

export function requirementAudiences(clause: string): Array<'agent' | 'human' | undefined> {
  const shared = clause.match(coordinatedAudienceList);
  const preceding = shared ? clause.slice(0, shared.index) : '';
  if (shared && !humanAudience.test(preceding) && !agentAudience.test(preceding)) {
    return [undefined];
  }
  const audiences: Array<'agent' | 'human'> = [];
  if (humanAudience.test(clause)) audiences.push('human');
  if (agentAudience.test(clause)) audiences.push('agent');
  return audiences.length > 0 ? audiences : [undefined];
}

export function requirementAudienceLabel(clause: string, audience?: 'agent' | 'human'): string | undefined {
  if (!audience) return undefined;
  return clause.match(audience === 'human' ? humanAudience : agentAudience)?.[0]?.toLowerCase();
}

export function audienceScopedCapabilityCatalogOutcomeText(
  clause: string,
  audience?: 'agent' | 'human',
  audienceLabel?: string,
): string | undefined {
  if (!audience || !audienceLabel || !humanAudience.test(clause) || !agentAudience.test(clause)) return undefined;
  const coordinated = clause.match(coordinatedAudienceList);
  const index = coordinated?.index;
  if (!coordinated || index === undefined) return undefined;
  const governingText = clause.slice(0, index);
  const isClauseSubject = governingText.trim().length === 0;
  const hasAudienceMarker = /\b(?:for|to|by)\s*$/i.test(governingText);
  if (!isClauseSubject && !hasAudienceMarker) return undefined;
  return governingText + audienceLabel + clause.slice(index + coordinated[0].length);
}

export function capabilityMatchesAudience(capabilityText: string, audience?: 'agent' | 'human'): boolean {
  if (!audience) return true;
  return audience === 'human' ? humanAudience.test(capabilityText) : agentAudience.test(capabilityText);
}

function missingBeneficiaryAudiences(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  requirement: CapabilityCatalogOutcomeRequirement,
): Array<'human' | 'agent'> {
  const audiences = requirement.beneficiaryAudiences || [];
  const text = `${capability.name || ''} ${capability.description || ''}`;
  const mentioned = audiences.filter(audience => capabilityMatchesAudience(text, audience));
  return mentioned.length > 0 ? audiences.filter(audience => !mentioned.includes(audience)) : [];
}

export function capabilityMatchesBoundAudience(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  if (missingBeneficiaryAudiences(capability, requirement).length > 0) return false;
  if (!requirement.audience) return true;
  const opposite = requirement.audience === 'human' ? agentAudience : humanAudience;
  if (opposite.test(capability.name || '') || opposite.test(capability.description || '')) return false;
  if (requirement.firstPartyOutcomeText && !requirement.audienceScopedOutcomeText) return true;
  return capabilityMatchesAudience(capability.name || '', requirement.audience) &&
    capabilityMatchesAudience(capability.description || '', requirement.audience);
}

export function capabilityAudienceBindingFailure(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  requirement: CapabilityCatalogOutcomeRequirement,
): Omit<CapabilityCatalogOutcomeBindingFailure, 'missingSubjectTerms'> | undefined {
  const missing = missingBeneficiaryAudiences(capability, requirement);
  if (missing.length > 0) return {
    missingAudience: missing.join(', '),
    missingAudienceLocations: ['name', 'description'],
    reason: `required-outcome-audience-missing:${missing.join(',')}`,
  };
  if (!requirement.audience) return undefined;
  const required = requirement.audience === 'human' ? humanAudience : agentAudience;
  const opposite = requirement.audience === 'human' ? agentAudience : humanAudience;
  const missingAudienceLocations = (['name', 'description'] as const).filter(location => !required.test(capability[location] || ''));
  const oppositeAudienceLocations = (['name', 'description'] as const).filter(location => opposite.test(capability[location] || ''));
  const oppositeAudienceLabels = [...new Set(oppositeAudienceLocations.map(location =>
    (capability[location] || '').match(opposite)?.[0]?.toLowerCase()).filter((label): label is string => Boolean(label)))];
  if ((!requirement.firstPartyOutcomeText || requirement.audienceScopedOutcomeText) && missingAudienceLocations.length > 0) return {
    missingAudience: requirement.audienceLabel || requirement.audience,
    missingAudienceLocations: [...missingAudienceLocations],
    ...(oppositeAudienceLabels.length ? { oppositeAudienceLabels, oppositeAudienceLocations: [...oppositeAudienceLocations] } : {}),
    reason: `required-outcome-audience-missing:${requirement.audience}`,
  };
  if (oppositeAudienceLocations.length > 0) return {
    oppositeAudienceLabels,
    oppositeAudienceLocations: [...oppositeAudienceLocations],
    reason: `required-outcome-audience-conflict:${requirement.audience}`,
  };
  return undefined;
}
