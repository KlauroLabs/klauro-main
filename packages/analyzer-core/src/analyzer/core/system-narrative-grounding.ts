import {
  unsupportedCapabilityAbsenceClaims,
  unsupportedCapabilityOperationalClaims,
} from './capability-catalog-audience';

export type SystemNarrativeGroundingFailure = {
  reason: 'unsupported-system-absence-claim' | 'unsupported-system-operational-claim';
  offendingTerms: string[];
};

export function systemNarrativeGroundingFailure(
  description: string,
  evidenceTerms: readonly string[],
): SystemNarrativeGroundingFailure | undefined {
  const absenceClaims = unsupportedCapabilityAbsenceClaims(description)
    .map(claim => claim.trim())
    .filter(Boolean);
  if (absenceClaims.length > 0) {
    return { reason: 'unsupported-system-absence-claim', offendingTerms: absenceClaims };
  }

  const unsupportedGuarantees = unsupportedCapabilityOperationalClaims(description, [...evidenceTerms])
    .filter(claim => /\b(?:immediate(?:ly)?|instant(?:ly|aneous(?:ly)?)?|permanent(?:ly)?)\b/i.test(claim));
  if (unsupportedGuarantees.length > 0) {
    return { reason: 'unsupported-system-operational-claim', offendingTerms: unsupportedGuarantees };
  }
  return undefined;
}
