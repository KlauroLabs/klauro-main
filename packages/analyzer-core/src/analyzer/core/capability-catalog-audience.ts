import type {
  CASDataEntity,
  CASEntryPoint,
  CASUserJourney,
  EnhancedSystemPurpose,
  SystemCapability,
} from '../../types/cas.types';
import {
  splitIdentifierWords,
  testCapabilityDescriptionAgainstAudience,
  capabilityMarketingLanguageTerms,
  testCapabilityNameAgainstIdentifierVocabulary,
} from './capability-audience-test';
import { capabilityGroundedEntityIds } from './capability-entity-grounding';

export interface CapabilityCatalogProductText {
  concepts?: string[];
  manifestDescription?: string;
  productDocSummary?: string;
  productDocTitle?: string;
  summary?: string;
}

export interface CapabilityAudienceRejection {
  capabilityId: string;
  capabilityIndex: number;
  description?: string;
  flaggedTokens: string[];
  name: string;
  reasons: string[];
  missingAudience?: string;
  missingAudienceLocations?: Array<'description' | 'name'>;
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
    .map(token => token.length > 4 && token.endsWith('ies')
      ? `${token.slice(0, -3)}y`
      : token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)
    .join(' ');
}

function productTextGroundsEntityRelationship(
  productTerms: string[],
  relatedEntityIds: Set<string>,
  entities: CASDataEntity[],
  unrelatedEntityName: string,
): boolean {
  const unrelatedPhrase = normalizedEntityPhrase(unrelatedEntityName);
  const relatedPhrases = entities
    .filter(entity => relatedEntityIds.has(entity.id))
    .map(entity => normalizedEntityPhrase(entity.name))
    .filter(Boolean);
  if (!unrelatedPhrase || relatedPhrases.length === 0) return false;
  return productTerms
    .flatMap(term => String(term || '').split(/(?<=[.!?;])\s+|[\r\n]+/))
    .map(normalizedEntityPhrase)
    .some(clause => clause.includes(unrelatedPhrase) &&
      relatedPhrases.some(relatedPhrase => clause.includes(relatedPhrase)));
}

function unrelatedEntityReferences(
  text: string,
  relatedEntityIds: Set<string>,
  entities: CASDataEntity[],
  productTerms: string[] = [],
): string[] {
  const normalizedText = ` ${normalizedEntityPhrase(text)} `;
  return entities
    .filter(entity => !relatedEntityIds.has(entity.id))
    .map(entity => ({ name: entity.name, phrase: normalizedEntityPhrase(entity.name) }))
    .filter(entity => entity.phrase.includes(' ') || entity.phrase.length >= 5)
    .filter(entity => normalizedText.includes(` ${entity.phrase} `))
    .filter(entity => !productTextGroundsEntityRelationship(productTerms, relatedEntityIds, entities, entity.name))
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
  const marketingTerms = capabilityMarketingLanguageTerms(name);
  if (marketingTerms.length > 0) {
    reasons.push('marketing-language');
    flaggedTokens.push(...marketingTerms);
  }
  const trustedWords = new Set(productTerms.flatMap(splitIdentifierWords).map(word => word.toLowerCase()));
  const ordinaryShortWords = new Set(['api', 'app', 'code', 'data', 'map', 'run', 'task', 'user', 'view', 'work']);
  const grammaticalConnectors = new Set([
    'a', 'an', 'and', 'as', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'through', 'to', 'via', 'with',
  ]);
  const shortenedTerms = splitIdentifierWords(name).filter(token => {
    if (grammaticalConnectors.has(token.toLowerCase())) return false;
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
  const claims = (description || '').match(/\b(?:locks?|locked|locking|exclusive(?:ly| ownership)?|mutual exclusion|immutab(?:le|ility)|immediate(?:ly)?|instant(?:ly|aneous(?:ly)?)?|permanent(?:ly)?|real[- ]time|blocks? parallel|prevents? (?:concurrent|conflicts?|collisions?|overlaps?)|enforc(?:e|es|ed|ing) [^.;]{0,60}\b(?:access|authentication|authorization|identity|permissions?|security)\b|ensur(?:e|es|ed|ing) (?:a )?(?:consistent|conflict-free|exclusive|safe) state|ensur(?:e|es|ed|ing) [^.;]{0,60}\balign(?:ed|ment)?|reduc(?:e|es|ed|ing) [^.;]{0,24}\b(?:conflicts?|collisions?|overlaps?)|manag(?:e|es|ed|ing)(?=\s+and\s+synchroniz)|synchroniz(?:e|es|ed|ing) (?:tasks?|work|changes?|state)|manag(?:e|es|ed|ing) (?:agent )?tasks?|reserv(?:e|es|ed|ing|ation)|assign(?:s|ed|ing)?(?=\s+(?:agents?|tasks?|work|changes?|areas?|ownership)\b)|ownership|every|all)\b/gi) || [];
  const evidence = normalizedEntityPhrase(evidenceTerms.join(' '));
  const evidenceIsAdvisory = /\b(?:advisory|non locking|non exclusive|never block)\b/.test(evidence);
  const operationalKey = (value: string): string => normalizedEntityPhrase(value)
    .replace(/\bsynchroniz(?:e|es|ed|ing)\b/g, 'synchronize')
    .replace(/\bensur(?:e|es|ed|ing)\b/g, 'ensure')
    .replace(/\balign(?:ed|ment)?\b/g, 'align')
    .replace(/\b(tasks?|changes?)\b/g, token => token.replace(/s$/, ''));
  const evidenceKey = operationalKey(evidence);
  return claims.filter(claim => evidenceIsAdvisory || !evidenceKey.includes(operationalKey(claim)));
}
export function unsupportedCapabilityAbsenceClaims(description: string): string[] {
  return (description || '').match(
    /\b(?:without\b[^.;]*|(?:does|do)\s+not\s+require\s+[^.;]*|no\s+[^.;]*\s+(?:is|are)\s+required)\b/gi,
  ) || [];
}
export function removeUnsupportedCapabilityAbsenceClaims(description: string): string {
  let sanitized = String(description || '').trim();
  for (let pass = 0; pass < 8; pass++) {
    const claim = unsupportedCapabilityAbsenceClaims(sanitized)[0];
    if (!claim) break;
    const index = sanitized.toLowerCase().indexOf(claim.toLowerCase());
    if (index < 0) break;
    const before = sanitized.slice(0, index).replace(/[\s,;:\-]+$/, '');
    const after = sanitized.slice(index + claim.length).replace(/^[\s,;:\-]+/, '');
    sanitized = `${before}${before && after ? ' ' : ''}${after}`;
  }
  sanitized = sanitized
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[,;:]\s*([.!?])$/, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (sanitized && !/[.!?]$/.test(sanitized)) sanitized += '.';
  return sanitized;
}

function capabilityOperationSemanticContradictions(capability: SystemCapability): string[] {
  const operationPaths = (capability.operations || [])
    .flatMap(operation => [operation.path_or_command, operation.trigger?.path])
    .filter((value): value is string => Boolean(value))
    .map(value => value.toLowerCase());
  const authenticationOnly = operationPaths.length > 0 &&
    operationPaths.every(value => /(?:^|[/_-])(?:auth(?:enticate)?|login|sign[ _-]?in|token)(?:$|[/_?&#-])/.test(value)) &&
    !operationPaths.some(value => /(?:^|[/_-])(?:register|registration|sign[ _-]?up)(?:$|[/_?&#-])/.test(value));
  if (!authenticationOnly || !/^(?:authenticate|sign[ -]?in|log[ -]?in)\b/i.test(capability.name.trim())) {
    return [];
  }
  return [
    ...(capability.description || '').match(
      /\b(?:(?:user\s+)?(?:accounts?|identit(?:y|ies)|records?)\s+(?:are|is)\s+(?:created|registered|provisioned)|(?:creates?|registers?|provisions?)\s+(?:an?\s+)?(?:new\s+)?(?:user\s+)?(?:accounts?|identit(?:y|ies)|records?))\b/gi,
    ) || [],
  ];
}

export function normalizeCapabilityDescriptionForPublication(
  description: string,
  evidenceTerms: string[] = [],
): string {
  let normalized = removeUnsupportedCapabilityAbsenceClaims(description);
  for (const claim of unsupportedCapabilityOperationalClaims(normalized, evidenceTerms)) {
    normalized = normalized.replace(claim, '');
  }
  normalized = normalized
    .replace(/\s+(?:in response to|after|when)\s+(?:an?\s+)?(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+requests?(?:\s+(?:to|through|against)\s+[^,.;]+)?/gi, '')
    .replace(/\s+(?:via|through|using)\s+(?:the\s+)?(?:API(?:\s+endpoint)?|endpoint|route)(?:\s+[^,.;]+)?/gi, '')
    .replace(/\s+(?:using|via|by|based on)\s+(?:the\s+)?(?:article(?:'s)?\s+)?slug(?:\s+as\s+(?:an?\s+)?identifier)?/gi, '')
    .replace(/(?:,\s*)?(?:reflecting|using|via|through|in|from|after|when|with)\b[^.;]*(?:\b(?:api|endpoint|http|route|slug|requests?|responses?)\b|\/[a-z0-9{}:_/-]+)[^.;]*/gi, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[,;:]\s*([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (normalized && !/[.!?]$/.test(normalized)) normalized += '.';
  return normalized;
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

function groundedCapabilityAudience(
  capability: SystemCapability,
  productText: CapabilityCatalogProductText | undefined,
  userJourneys: readonly CASUserJourney[],
): string | undefined {
  const firstPartyText = [
    productText?.productDocTitle,
    productText?.productDocSummary,
    productText?.manifestDescription,
    productText?.summary,
  ].filter(Boolean).join(' ');
  const namedAudience = firstPartyText.match(/\b(?:users?|people|humans?|operators?|customers?)\b/i)?.[0];
  if (namedAudience) return namedAudience;
  const operationEntryPoints = new Set((capability.operations || []).map(operation => operation.entry_point_id));
  return userJourneys.some(journey => journey.journey_kind === 'user-facing' && operationEntryPoints.has(journey.entry_point_id))
    ? 'Users'
    : undefined;
}

export function evaluateCapabilityCatalogAudience(
  capabilities: SystemCapability[],
  dataEntities: CASDataEntity[],
  libraryNames: string[],
  productTerms: string[],
  context: { productText?: CapabilityCatalogProductText; userJourneys?: readonly CASUserJourney[]; entryPoints?: readonly CASEntryPoint[] } = {},
): CapabilityAudienceEvaluation {
  const libraries = libraryNames.map(name => ({ name }));
  const integrationTerms = capabilityCatalogIntegrationTerms(libraryNames);
  const entityNamesById = new Map(dataEntities.map(entity => [entity.id, entity.name]));
  const accepted: SystemCapability[] = [];
  const descriptionRepairCandidates: SystemCapability[] = [];
  const rejections: CapabilityAudienceRejection[] = [];

  for (const [capabilityIndex, capability] of capabilities.entries()) {
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
        capabilityId: capability.id,
        capabilityIndex,
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
        capabilityId: capability.id,
        capabilityIndex,
        name: capability.name,
        description: capability.description,
        target: 'name',
        reasons: ['aggregate-name-narrows-to-entity'],
        flaggedTokens: narrowingEntities,
      });
      continue;
    }
    const unrelatedNameEntities = unrelatedEntityReferences(capability.name, relatedEntityIds, dataEntities, productTerms);
    if (unrelatedNameEntities.length > 0) {
      rejections.push({
        capabilityId: capability.id,
        capabilityIndex,
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
          capabilityId: capability.id,
          capabilityIndex,
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
      capabilityProductTerms,
    );
    if (/\bmessage handling\b/i.test(capability.description || '') &&
      !/\b(?:message|messaging)\b/i.test(productTerms.join(' '))) {
      descriptionVerdict.failsAudienceTest = true;
      descriptionVerdict.reasons.push('internal-mechanism-language');
      descriptionVerdict.flaggedTokens.push('message handling');
    }
    const unsupportedExclusivity = unsupportedCapabilityOperationalClaims(capability.description, [...operationTerms, ...productTerms]);
    if (unsupportedExclusivity.length > 0) {
      descriptionVerdict.failsAudienceTest = true;
      descriptionVerdict.reasons.push('unsupported-exclusivity-claim');
      descriptionVerdict.flaggedTokens.push(...unsupportedExclusivity);
    }
    const unsupportedAbsence = unsupportedCapabilityAbsenceClaims(capability.description);
    if (unsupportedAbsence.length > 0) {
      descriptionVerdict.failsAudienceTest = true;
      descriptionVerdict.reasons.push('unsupported-absence-claim');
      descriptionVerdict.flaggedTokens.push(...unsupportedAbsence);
    }
    const semanticContradictions = capabilityOperationSemanticContradictions(capability);
    if (semanticContradictions.length > 0) {
      descriptionVerdict.failsAudienceTest = true;
      descriptionVerdict.reasons.push('operation-semantic-contradiction');
      descriptionVerdict.flaggedTokens.push(...semanticContradictions);
    }
    const descriptionEntityIds = capabilityGroundedEntityIds(capability, dataEntities, context.entryPoints || []);
    const unrelatedDescriptionEntities = unrelatedEntityReferences(capability.description, descriptionEntityIds, dataEntities, productTerms);
    if (unrelatedDescriptionEntities.length > 0) {
      descriptionVerdict.failsAudienceTest = true;
      descriptionVerdict.reasons.push('unrelated-entity-vocabulary');
      descriptionVerdict.flaggedTokens.push(...unrelatedDescriptionEntities);
    }
    if (descriptionVerdict.failsAudienceTest) {
      const reason = `catalog-audience:${descriptionVerdict.reasons.join(',')}`;
      const groundedAudience = groundedCapabilityAudience(capability, context.productText, context.userJourneys || []);
      rejections.push({
        capabilityId: capability.id,
        capabilityIndex,
        name: capability.name,
        description: capability.description,
        target: 'description',
        reasons: descriptionVerdict.reasons,
        flaggedTokens: descriptionVerdict.flaggedTokens,
        ...(groundedAudience ? { missingAudience: groundedAudience } : {}),
        ...(groundedAudience ? { missingAudienceLocations: ['description' as const] } : {}),
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
  return `Replace every rejected item using only cited evidence: ${JSON.stringify(rejectedItems)}. Remove every flagged token. For marketing-language, state the concrete user outcome without promotional claims. For identifier-vocabulary or shortened-product-term, use exact product nouns from first-party product text rather than source identifiers or operation prefixes. For internal-context-name, name the observable action and subject instead of internal work context. For internal-mechanism-language, describe the observable user or operator outcome rather than tool registration, analyzers, storage reads, or source settings. For operation-semantic-contradiction, describe the route's evidenced outcome and never translate an HTTP method into account, identity, or record creation when the route identifies authentication. For unsupported-exclusivity-claim, describe advisory detection or reporting; never claim prevention, conflict reduction, guaranteed alignment, exclusivity, ownership, assignment, reservation, universal coverage, or consistency guarantees unless cited evidence explicitly proves them. For missing or restates-name, write a grounded 8-24 word explanation of who uses the ability and why.`;
}

export function capabilityPublishabilityRepairFeedback(
  rejections: Array<{ name: string; description?: string; reason: string; requirement_id?: string; forbidden_terms?: string[] }>,
): string | undefined {
  if (rejections.length === 0) return undefined;
  const rejectedItems = rejections.slice(0, 12).map(rejection => ({
    name: rejection.name,
    description: String(rejection.description || '').slice(0, 180),
    reason: rejection.reason,
    ...(rejection.requirement_id ? { requirement_id: rejection.requirement_id } : {}),
    forbidden_terms: rejection.forbidden_terms || [],
  }));
  return `Replace every non-publishable item using only its cited evidence: ${JSON.stringify(rejectedItems)}. Preserve each requirement_id exactly and remove every forbidden_terms phrase. For internal-analysis-vocabulary, translate inventory terms into the concrete software behavior, risk, relationship, or change context visible to the user. For implementation-graph-inventory, state the behavior-level understanding or relationship outcome without enumerating graph contents. For raw-related-entity-identifier, replace source identifiers with audience-readable product language grounded by the same evidence. For delivery-operation-restatement, describe the durable user outcome shared by the evidence instead of a click, command, event, or handler. For generic-structural-phrase, state the evidence-specific outcome directly without implementation scaffolding. Do not enumerate response objects, graph structures, commands, or configuration fields.`;
}
