import type {
  CASDataEntity,
  EnhancedSystemPurpose,
  SystemCapability,
} from '../../types/cas.types';
import {
  splitIdentifierWords,
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

function normalizedEntityPhrase(value: string): string {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3)
    .map(token => token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)
    .join(' ');
}

function unrelatedEntityReferences(
  text: string,
  relatedEntityIds: Set<string>,
  entities: CASDataEntity[],
): string[] {
  const normalizedText = ` ${normalizedEntityPhrase(text)} `;
  return entities
    .filter(entity => !relatedEntityIds.has(entity.id))
    .map(entity => ({ name: entity.name, phrase: normalizedEntityPhrase(entity.name) }))
    .filter(entity => entity.phrase.includes(' ') || entity.phrase.length >= 5)
    .filter(entity => normalizedText.includes(` ${entity.phrase} `))
    .map(entity => entity.name);
}

function aggregateNameEntityNarrowing(capability: SystemCapability, entityNamesById: Map<string, string>): string[] {
  const citedCandidates = (capability.criticality_factors || []).filter(factor => factor.startsWith('catalog-candidate:'));
  const relatedNames = (capability.related_entities || [])
    .map(entityId => entityNamesById.get(entityId))
    .filter((name): name is string => Boolean(name));
  if (citedCandidates.length < 2 || relatedNames.length < 3) return [];
  const normalizedName = ` ${normalizedEntityPhrase(capability.name)} `;
  return relatedNames.filter(name => {
    const phrase = normalizedEntityPhrase(name);
    return phrase.length >= 5 && normalizedName.includes(` ${phrase} `);
  });
}

function capabilityNameProductLanguageFailures(name: string, productTerms: string[]): {
  flaggedTokens: string[];
  reasons: string[];
} {
  const reasons: string[] = [];
  const flaggedTokens: string[] = [];
  if (/\bwork context\b/i.test(name)) {
    reasons.push('internal-context-name');
    flaggedTokens.push('work context');
  }
  const trustedWords = new Set(productTerms.flatMap(splitIdentifierWords).map(word => word.toLowerCase()));
  const ordinaryShortWords = new Set(['api', 'app', 'code', 'data', 'map', 'run', 'task', 'user', 'view', 'work']);
  const shortenedTerms = splitIdentifierWords(name).filter(token => {
    if (!/^[a-z]{2,4}$/.test(token) || ordinaryShortWords.has(token)) return false;
    return [...trustedWords].some(word => word.length >= token.length + 2 && word.startsWith(token));
  });
  if (shortenedTerms.length > 0) {
    reasons.push('shortened-product-term');
    flaggedTokens.push(...shortenedTerms);
  }
  return { reasons, flaggedTokens };
}

export function unsupportedCapabilityOperationalClaims(description: string, evidenceTerms: string[]): string[] {
  const claims = (description || '').match(/\b(?:locks?|locked|locking|exclusive(?:ly| ownership)?|mutual exclusion|blocks? parallel|prevents? (?:concurrent|conflicts?|collisions?|overlaps?)|ensur(?:e|es|ed|ing) (?:a )?(?:consistent|conflict-free|exclusive|safe) state|ensur(?:e|es|ed|ing) [^.;]{0,40}\balignment|reduc(?:e|es|ed|ing) [^.;]{0,24}\b(?:conflicts?|collisions?|overlaps?)|reserv(?:e|es|ed|ing|ation)|assign(?:s|ed|ing|ment)?|ownership|every|all)\b/gi) || [];
  const evidence = normalizedEntityPhrase(evidenceTerms.join(' '));
  const evidenceIsAdvisory = /\b(?:advisory|non locking|non exclusive|never block)\b/.test(evidence);
  return claims.filter(claim => evidenceIsAdvisory || !evidence.includes(normalizedEntityPhrase(claim)));
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
    const relatedEntityIds = new Set(capability.related_entities || []);
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
    const productLanguageFailures = capabilityNameProductLanguageFailures(capability.name, productTerms);
    if (productLanguageFailures.reasons.length > 0) {
      rejections.push({
        name: capability.name,
        description: capability.description,
        target: 'name',
        reasons: productLanguageFailures.reasons,
        flaggedTokens: productLanguageFailures.flaggedTokens,
      });
      continue;
    }
    const narrowingEntities = aggregateNameEntityNarrowing(capability, entityNamesById);
    if (narrowingEntities.length > 0) {
      rejections.push({
        name: capability.name,
        description: capability.description,
        target: 'name',
        reasons: ['aggregate-name-narrows-to-entity'],
        flaggedTokens: narrowingEntities,
      });
      continue;
    }
    const unrelatedNameEntities = unrelatedEntityReferences(capability.name, relatedEntityIds, dataEntities);
    if (unrelatedNameEntities.length > 0) {
      rejections.push({
        name: capability.name,
        description: capability.description,
        target: 'name',
        reasons: ['unrelated-entity-vocabulary'],
        flaggedTokens: unrelatedNameEntities,
      });
      continue;
    }

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
    const unsupportedExclusivity = unsupportedCapabilityOperationalClaims(capability.description, capabilityProductTerms);
    if (unsupportedExclusivity.length > 0) {
      descriptionVerdict.failsAudienceTest = true;
      descriptionVerdict.reasons.push('unsupported-exclusivity-claim');
      descriptionVerdict.flaggedTokens.push(...unsupportedExclusivity);
    }
    const unrelatedDescriptionEntities = unrelatedEntityReferences(capability.description, relatedEntityIds, dataEntities);
    if (unrelatedDescriptionEntities.length > 0) {
      descriptionVerdict.failsAudienceTest = true;
      descriptionVerdict.reasons.push('unrelated-entity-vocabulary');
      descriptionVerdict.flaggedTokens.push(...unrelatedDescriptionEntities);
    }
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
  return `Replace every rejected item using only cited evidence: ${JSON.stringify(rejectedItems)}. Remove every flagged token. For marketing-language, state the concrete user outcome without promotional claims. For identifier-vocabulary or shortened-product-term, use exact product nouns from first-party product text rather than source identifiers or operation prefixes. For internal-context-name, name the observable action and subject instead of internal work context. For internal-mechanism-language, describe the observable user or operator outcome rather than tool registration, analyzers, storage reads, or source settings. For unsupported-exclusivity-claim, describe advisory detection or reporting; never claim prevention, conflict reduction, guaranteed alignment, exclusivity, ownership, assignment, reservation, universal coverage, or consistency guarantees unless cited evidence explicitly proves them. For missing or restates-name, write a grounded 8-24 word explanation of who uses the ability and why.`;
}

export function capabilityPublishabilityRepairFeedback(
  rejections: Array<{ name: string; description?: string; reason: string }>,
): string | undefined {
  if (rejections.length === 0) return undefined;
  const rejectedItems = rejections.slice(0, 12).map(rejection => ({
    name: rejection.name,
    description: String(rejection.description || '').slice(0, 180),
    reason: rejection.reason,
  }));
  return `Replace every non-publishable item using only its cited evidence: ${JSON.stringify(rejectedItems)}. For internal-analysis-vocabulary, translate inventory terms such as entities, nodes, entry points, capability maps, and analysis results into the concrete software behavior, risk, relationship, or change context visible to the user. For generic-structural-phrase, state the evidence-specific outcome directly without implementation scaffolding. Do not enumerate response objects, graph structures, commands, or configuration fields.`;
}
