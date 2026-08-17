import type {
  CASDataEntity,
  EnhancedSystemPurpose,
  SystemCapability,
} from '../../types/cas.types';
import {
  testCapabilityDescriptionAgainstAudience,
  testCapabilityNameAgainstIdentifierVocabulary,
} from './capability-audience-test';

export interface CapabilityCatalogProductText {
  concepts?: string[];
  manifestDescription?: string;
  productDocSummary?: string;
  productDocTitle?: string;
  summary?: string;
}

export interface CapabilityAudienceRejection {
  description?: string;
  flaggedTokens: string[];
  name: string;
  reasons: string[];
  target: 'description' | 'name';
}

export interface CapabilityAudienceEvaluation {
  accepted: SystemCapability[];
  descriptionRepairCandidates: SystemCapability[];
  rejections: CapabilityAudienceRejection[];
}

export function capabilityCatalogProductTerms(
  purpose: EnhancedSystemPurpose | undefined,
  productText: CapabilityCatalogProductText,
): string[] {
  return [
    purpose?.primary_domain,
    ...(purpose?.description_source && purpose.description_source !== 'ai'
      ? [purpose.inferred_description, ...(purpose.core_concepts || [])]
      : []),
    productText.productDocTitle,
    productText.productDocSummary,
    productText.manifestDescription,
    productText.summary,
    ...(productText.concepts || []),
  ].filter((value): value is string => Boolean(value));
}

export function capabilityCatalogIntegrationTerms(libraryNames: string[]): string[] {
  const terms = new Set<string>();
  for (const libraryName of libraryNames) {
    const packageSegments = String(libraryName || '').split('/').filter(Boolean);
    const packageName = packageSegments[packageSegments.length - 1] || '';
    const normalized = packageName.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const suffixed = normalized.match(/^(.{3,}?)(?:sdk|connector|integration)$/)?.[1];
    const prefixed = normalized.match(/^(?:sdk|connector|integration)(.{3,})$/)?.[1];
    const base = suffixed || prefixed;
    if (!base) continue;
    terms.add(base);
  }
  return [...terms].sort();
}

export function evaluateCapabilityCatalogAudience(
  capabilities: SystemCapability[],
  dataEntities: CASDataEntity[],
  libraryNames: string[],
  productTerms: string[],
): CapabilityAudienceEvaluation {
  const libraries = libraryNames.map(name => ({ name }));
  const integrationTerms = capabilityCatalogIntegrationTerms(libraryNames);
  const entityNamesById = new Map(dataEntities.map(entity => [entity.id, entity.name]));
  const accepted: SystemCapability[] = [];
  const descriptionRepairCandidates: SystemCapability[] = [];
  const rejections: CapabilityAudienceRejection[] = [];

  for (const capability of capabilities) {
    const operationTerms = (capability.operations || []).flatMap(operation => [
      operation.action,
      operation.path_or_command,
      operation.entry_point_id,
      operation.trigger?.path,
    ]).filter((value): value is string => Boolean(value));
    const relatedEntityTerms = (capability.related_entities || [])
      .map(entityId => entityNamesById.get(entityId))
      .filter((value): value is string => Boolean(value));
    const capabilityProductTerms = [...productTerms, ...integrationTerms, ...operationTerms, ...relatedEntityTerms];

    if (libraries.length > 0) {
      const nameVerdict = testCapabilityNameAgainstIdentifierVocabulary(
        capability.name,
        libraries,
        dataEntities,
        capabilityProductTerms,
      );
      if (nameVerdict.failsIdentifierTest) {
        rejections.push({
          name: capability.name,
          description: capability.description,
          target: 'name',
          reasons: ['identifier-vocabulary'],
          flaggedTokens: nameVerdict.flaggedTokens,
        });
        continue;
      }
    }

    const descriptionVerdict = testCapabilityDescriptionAgainstAudience(
      capability.name,
      capability.description,
      libraries,
      dataEntities,
      [...capabilityProductTerms, capability.name],
    );
    if (descriptionVerdict.failsAudienceTest) {
      const reason = `catalog-audience:${descriptionVerdict.reasons.join(',')}`;
      rejections.push({
        name: capability.name,
        description: capability.description,
        target: 'description',
        reasons: descriptionVerdict.reasons,
        flaggedTokens: descriptionVerdict.flaggedTokens,
      });
      descriptionRepairCandidates.push({
        ...capability,
        description: '',
        description_source: undefined,
        description_generation: {
          status: 'ai_rejected',
          attempted: true,
          reason,
          generated_at: new Date().toISOString(),
        },
        criticality_factors: Array.from(new Set([
          ...(capability.criticality_factors || []),
          'catalog-description-rejected',
        ])),
      });
      continue;
    }

    accepted.push(capability);
  }

  return { accepted, descriptionRepairCandidates, rejections };
}

export function capabilityAudienceRepairFeedback(rejections: CapabilityAudienceRejection[]): string | undefined {
  if (rejections.length === 0) return undefined;
  const rejectedItems = rejections.slice(0, 12).map(rejection => ({
    name: rejection.name,
    description: String(rejection.description || '').slice(0, 180),
    target: rejection.target,
    reasons: rejection.reasons,
    flagged_tokens: rejection.flaggedTokens.slice(0, 8),
  }));
  return `Replace every rejected item using only cited evidence: ${JSON.stringify(rejectedItems)}. Remove every flagged token. For marketing-language, state the concrete user outcome without promotional claims. For identifier-vocabulary, replace code-shaped terms with exact product nouns present in the evidence. For missing or restates-name, write a grounded 8-24 word explanation of who uses the ability and why.`;
}
