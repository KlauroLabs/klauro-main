import { CASDataEntity, CASEntryPoint, CASNode, CASUserJourney, SystemCapability } from '../../types/cas.types';
export { comprehensionAiPhaseStatus, synchronizeCapabilityCatalogCoverage } from './comprehension-status';
import type { ProductDocumentStatement } from './product-document-framing';
import { capabilityEvidenceSubjectTokens, capabilityOperationEvidenceTexts } from './capability-subject-evidence';
export { capabilityEvidenceSubjectTokens } from './capability-subject-evidence';
import { capabilityMarketingLanguageTerms } from './capability-audience-test';
import { USER_FACING_ENTRY_TYPES } from './journey-builder';
import { isScaffoldOrTestPath } from './scaffold-paths';
import { analyzeTerminality } from './terminality';
import { observedCapabilityLifecycleActions } from './capability-lifecycle-actions';
import { normalizedSubjectTokens, outcomeIdentityTokens, outcomeTokenMatches, productTextCorroboratesActionAndSubject, productTextCorroboratesCapability } from './capability-evidence-language';
import { CAPABILITY_PURPOSE_VERBS, isBareNounCapabilityLabel, isCrudInventoryCapabilityLabel, isGenericManagementCapabilityLabel } from "./capability-naming";
import { capabilityHasReversibleUserActionLifecycle } from './capability-reversible-lifecycle';
export { catalogCandidateEntityFacts, catalogPromptResponseComplexity, catalogRelatedEntityIds, uniquelyMatchingCapabilityEntityIds } from './capability-catalog-metrics';
import { isStructuralExecutableCliEntry } from './entry-point-product-role';
import { demoteCoveredImplementationAggregates as demoteCoveredImplementationAggregatesImpl } from './capability-catalog-aggregate-demotion';
export type CapabilityEvidenceRole = NonNullable<SystemCapability['evidence_role']>;
export interface CapabilityEvidenceContext {
  entryPoints?: CASEntryPoint[];
  nodes?: CASNode[];
  userJourneys?: CASUserJourney[];
}
export interface CapabilityEvidenceRoleSummary {
  product: number;
  supporting: number;
  verification: number;
  unresolved: number;
}
export interface CapabilityCatalogProjectSignal {
  concepts?: string[];
  productDocTitle?: string;
  productDocSummary?: string;
  productDocStatements?: ProductDocumentStatement[];
  manifestDescription?: string;
  summary?: string;
  productVocabulary?: string[];
}
export { catalogPromptEntities, type CapabilityCatalogEntityFact } from './capability-catalog-prompt-entities';
function capabilityOutcomeCorroboratedByProductText(
  name: string,
  citedCandidates: SystemCapability[],
  signal?: CapabilityCatalogProjectSignal,
  requireCandidateSubject = true,
): boolean {
  const words = outcomeIdentityTokens(name);
  const productTokens = new Set(outcomeIdentityTokens([
    ...(signal?.concepts || []),
    ...(signal?.productVocabulary || []),
    signal?.productDocTitle,
    signal?.productDocSummary,
    signal?.manifestDescription,
    signal?.summary,
  ].filter(Boolean).join(' ')));
  if (words.length <= 1 || !outcomeTokenMatches(words[0], productTokens)) return false;
  const subjects = words.slice(1);
  if (!subjects.some(token => outcomeTokenMatches(token, productTokens))) return false;
  const evidenceTokens = new Set(citedCandidates.flatMap(candidate => capabilityEvidenceSubjectTokens(candidate)));
  if (requireCandidateSubject && !subjects.some(token => outcomeTokenMatches(token, evidenceTokens))) return false;
  return subjects.every(token =>
    outcomeTokenMatches(token, productTokens) || outcomeTokenMatches(token, evidenceTokens));
}
function capabilityOutcomeHasSpecificFirstPartySupport(
  name: string,
  citedCandidates: SystemCapability[],
  signal?: CapabilityCatalogProjectSignal,
): boolean {
  const subjects = outcomeIdentityTokens(name).slice(1);
  const productTokens = new Set(outcomeIdentityTokens([
    ...(signal?.concepts || []),
    ...(signal?.productVocabulary || []),
    signal?.productDocTitle,
    signal?.productDocSummary,
    signal?.manifestDescription,
    signal?.summary,
  ].filter(Boolean).join(' ')));
  const genericSubjects = new Set(['agent', 'code', 'codebase', 'people', 'platform', 'software', 'system', 'user', 'work']);
  const hasSpecificProductSubject = subjects.some(token =>
    !genericSubjects.has(token) && outcomeTokenMatches(token, productTokens));
  if (!hasSpecificProductSubject) return false;
  const evidenceTokens = new Set(citedCandidates.flatMap(candidate => capabilityEvidenceSubjectTokens(candidate)));
  return subjects.some(token => outcomeTokenMatches(token, evidenceTokens));
}
export function narrowCapabilityEvidenceCandidates(
  outcomeName: string,
  citedCandidates: readonly SystemCapability[],
): SystemCapability[] {
  if (citedCandidates.length <= 1) return [...citedCandidates];
  const deliveryActions = new Set([
    'add', 'build', 'create', 'delete', 'edit', 'get', 'list', 'load', 'manage',
    'patch', 'post', 'provide', 'put', 'read', 'remove', 'run', 'set', 'show',
    'update', 'view',
  ]);
  const identityTokens = outcomeIdentityTokens(outcomeName);
  const leadingOutcomeToken = identityTokens[0];
  const outcomeTokens = identityTokens.filter(token => !deliveryActions.has(token));
  if (outcomeTokens.length === 0) return [...citedCandidates];
  const evidenceTokens = citedCandidates.map(candidate =>
    new Set(capabilityEvidenceSubjectTokens(candidate)));
  const frequencies = outcomeTokens.map(token => ({
    token,
    count: evidenceTokens.filter(evidence => outcomeTokenMatches(token, evidence)).length,
  })).filter(item => item.count > 0);
  if (frequencies.length === 0) return [...citedCandidates];

  const minimumFrequency = Math.min(...frequencies.map(item => item.count));
  const domainLeadingAnchor: { token: string; count: number } | undefined =
    typeof leadingOutcomeToken === 'string' &&
    leadingOutcomeToken.length > 0 &&
    !deliveryActions.has(leadingOutcomeToken)
      ? frequencies.find(item => item.token === leadingOutcomeToken)
      : undefined;
  const anchors: string[] = domainLeadingAnchor
    ? [domainLeadingAnchor.token]
    : frequencies
        .filter(item => item.count === minimumFrequency)
        .map(item => item.token);
  const narrowed = citedCandidates.filter((_, index) =>
    anchors.some(anchor => outcomeTokenMatches(anchor, evidenceTokens[index])));
  return narrowed.length > 0 ? narrowed : [...citedCandidates];
}

export function capabilityOutcomeRestatesDeliveryOperation(
  name: string,
  citedCandidates: SystemCapability[],
  signal?: CapabilityCatalogProjectSignal,
  acceptedOutcome = false,
): boolean {
  if (!citedCandidates.some(candidate => candidate.evidence_kind === 'behavior-surface')) return false;
  const words = outcomeIdentityTokens(name);
  const namePhrase = words.join(' ');
  const copiesOperationPhrase = citedCandidates.some(candidate => capabilityOperationEvidenceTexts(candidate).some(example => {
    const operationPhrase = outcomeIdentityTokens(example).join(' ');
    return operationPhrase.split(' ').length >= 2 && (` ${namePhrase} `).includes(` ${operationPhrase} `);
  }));
  const corroboratedProductOutcome = capabilityOutcomeCorroboratedByProductText(name, citedCandidates, signal);
  const usesDeliveryScaffolding = /\b(?:mcp|tools?|surfaces?)\b/i.test(name);
  const usesInternalDeliveryAction = /^(?:handle|process)(?:s|es|ing)?\b/i.test(name.trim());
  const usesBroadManagementAction = /^manage(?:s|d|ing)?\b/i.test(name.trim());
  const genericDeliveryAction = /^(?:add|create|delete|edit|fetch|get|list|load|read|remove|run|show|update|view)\b/i.test(name.trim());
  const repeatsActionAsSubject = words.length === 2 && outcomeTokenMatches(words[0], new Set([words[1]]));
  const ungroundedBroadManagementAction = usesBroadManagementAction && !acceptedOutcome && !corroboratedProductOutcome;
  return words.length === 0 || usesDeliveryScaffolding || usesInternalDeliveryAction || ungroundedBroadManagementAction || repeatsActionAsSubject ||
    (!acceptedOutcome && !corroboratedProductOutcome && genericDeliveryAction && copiesOperationPhrase) ||
    /\b(?:at|by|for|from|in|of|on|to|via|with)$/i.test(name.trim());
}

export function capabilityOutcomeMisusesCoordination(
  name: string,
  citedCandidates: SystemCapability[],
): boolean {
  if (!/^coordinate(?:s|d|ing)?\b/i.test(name.trim())) return false;
  const coordinationEvidence = new Set(citedCandidates.flatMap(candidate => outcomeIdentityTokens([
    candidate.name,
    candidate.structural_label,
    ...(candidate.related_domains || []),
    ...capabilityOperationEvidenceTexts(candidate),
  ].filter(Boolean).join(' '))));
  return !['claim', 'collision', 'conflict', 'concurrent', 'collaborat', 'overlap', 'participant', 'reserv'].some(signal =>
    [...coordinationEvidence].some(token => token.startsWith(signal))
  );
}

function capabilityOutcomeUsesBroadDeliveryAction(
function capabilityDeliveryActionTokens(operation: SystemCapability['operations'][number]): Set<string> {
  const action = outcomeIdentityTokens(operation.action || '')[0];
  const commandActions = [operation.path_or_command, operation.trigger?.path]
    .filter((value): value is string => Boolean(value))
    .map(value => outcomeIdentityTokens(value).find(token => CAPABILITY_PURPOSE_VERBS.has(token)));
  return new Set([action, ...commandActions].filter((value): value is string => Boolean(value)));
}

  name: string,
  citedCandidates: SystemCapability[],
  signal?: CapabilityCatalogProjectSignal,
): boolean {
  if (!citedCandidates.some(candidate => candidate.evidence_kind === 'behavior-surface')) return false;
  const leading = outcomeIdentityTokens(name)[0];
  if (!leading) return false;
  const lifecycleBreadth = (candidate: SystemCapability): number => {
    const stages = new Set<string>();
    for (const operation of candidate.operations || []) {
      const text = [operation.action, operation.path_or_command, operation.trigger?.path]
        .filter(Boolean).join(' ').toLowerCase();
      if (/\b(?:add|create|insert|new|post)\b/.test(text)) stages.add('create');
      if (/\b(?:fetch|get|list|read|search|view)\b/.test(text)) stages.add('read');
      if (/\b(?:change|edit|patch|put|status|update)\b/.test(text)) stages.add('update');
      if (/\b(?:delete|remove)\b/.test(text)) stages.add('delete');
    }
    return stages.size;
  };
  const groundedAggregateManagement = /^manage(?:s|d|ing)?\b/i.test(name.trim()) &&
    capabilityOutcomeCorroboratedByProductText(name, citedCandidates, signal) &&
    citedCandidates.some(candidate =>
      candidate.evidence_kind !== 'behavior-surface' && lifecycleBreadth(candidate) >= 3);
  if (groundedAggregateManagement) return false;
  const matching = citedCandidates.filter(candidate => (candidate.operations || []).some(operation =>
    outcomeTokenMatches(leading, capabilityDeliveryActionTokens(operation))));
  if (matching.length === 0) return false;
  return !matching.some(candidate => {
    const identity = new Set(outcomeIdentityTokens([candidate.name, candidate.structural_label].filter(Boolean).join(' ')));
    if (outcomeTokenMatches(leading, identity)) return true;
    const actions = (candidate.operations || []).map(capabilityDeliveryActionTokens).filter(value => value.size > 0);
    return actions.length > 0 && actions.filter(action => outcomeTokenMatches(leading, action)).length * 2 >= actions.length;
  });
}

export function capabilityOutcomeUsesDeliverySubject(name: string, citedCandidates: SystemCapability[], description = ''): boolean {
  if (citedCandidates.length !== 1 || citedCandidates[0].evidence_kind !== 'behavior-surface') return true;
  const nameTokens = outcomeIdentityTokens(name).slice(1);
  const evidenceTokens = new Set(capabilityEvidenceSubjectTokens(citedCandidates[0]));
  return nameTokens.some(token => outcomeTokenMatches(token, evidenceTokens)) ||
    outcomeIdentityTokens(description).some(token => outcomeTokenMatches(token, evidenceTokens));
}

export function capabilityOutcomeNameUnsupportedTokens(
  name: string,
  citedCandidates: SystemCapability[],
  signal?: CapabilityCatalogProjectSignal,
): string[] {
  const nameTokens = outcomeIdentityTokens(name);
  if (nameTokens.length <= 1) return [];
  const coordinatedActionMatch = String(name || '').trim().match(/^([A-Za-z]+)\s+and\s+([A-Za-z]+)\b/i);
  const coordinatedActions = new Set<string>();
  if (coordinatedActionMatch) {
    const actionTokens = coordinatedActionMatch.slice(1)
      .flatMap(value => outcomeIdentityTokens(value));
    if (actionTokens.length === 2 && actionTokens.every(token => CAPABILITY_PURPOSE_VERBS.has(token))) {
      actionTokens.forEach(token => coordinatedActions.add(token));
    }
  }
  const subjectTokens = nameTokens.slice(1).filter(token => !coordinatedActions.has(token));
  const firstPartyTokens = new Set(outcomeIdentityTokens([
    ...(signal?.concepts || []),
    ...(signal?.productVocabulary || []),
    signal?.productDocTitle,
    signal?.productDocSummary,
    signal?.manifestDescription,
    signal?.summary,
  ].filter(Boolean).join(' ')));
  const focusedBehaviorSurface = citedCandidates.length === 1 && citedCandidates[0].evidence_kind === 'behavior-surface';
  const citedIdentityTokens = new Set(citedCandidates.flatMap(candidate => focusedBehaviorSurface
    ? capabilityEvidenceSubjectTokens(candidate)
    : outcomeIdentityTokens([
      candidate.name,
      candidate.structural_label,
      ...(candidate.related_domains || []),
      ...(candidate.related_entities || []).map(entityId => entityId.replace(/^entity[_:-]?/i, '')),
      ...capabilityOperationEvidenceTexts(candidate),
      ...(candidate.operations || []).flatMap(operation => [operation.action, operation.entry_point_id, operation.path_or_command, operation.trigger?.path]),
    ].filter(Boolean).join(' '))));
  const leadingAction = nameTokens[0];
  const authenticationEvidence = [...citedIdentityTokens].some(token =>
    ['auth', 'authenticate', 'login', 'signin'].includes(token));
  citedCandidates.flatMap(candidate => observedCapabilityLifecycleActions(candidate.operations || []))
    .flatMap(outcomeIdentityTokens)
    .forEach(token => citedIdentityTokens.add(token));
  const visualProfileEvidence = ['avatar', 'color', 'icon', 'image', 'logo', 'style', 'theme']
    .filter(token => citedIdentityTokens.has(token));
  if (visualProfileEvidence.length >= 2) citedIdentityTokens.add('appearance');
  if (leadingAction === 'authenticate' && authenticationEvidence) {
    ['access', 'account', 'credential', 'identity', 'session', 'user'].forEach(token =>
      citedIdentityTokens.add(token));
  }
  const neutralQualifiers = new Set([
    'between', 'data', 'detail', 'record', 'state',
  ]);
  const unsupportedTokens = subjectTokens.filter(token =>
    !neutralQualifiers.has(token) &&
    !outcomeTokenMatches(token, firstPartyTokens) &&
    !outcomeTokenMatches(token, citedIdentityTokens)
  );
  if (!focusedBehaviorSurface || unsupportedTokens.length < 2 || !/\band\b/i.test(name)) return unsupportedTokens;
  const hasRecurringSubject = subjectTokens.some(token => outcomeTokenMatches(token, citedIdentityTokens));
  const operationTokenSets = capabilityOperationEvidenceTexts(citedCandidates[0]).map(example =>
    new Set(outcomeIdentityTokens(example)));
  const matchedOperations = new Set<number>();
  const everyUnsupportedTokenIsOperationBacked = unsupportedTokens.every(token => {
    let matched = false;
    operationTokenSets.forEach((operationTokens, index) => {
      if (outcomeTokenMatches(token, operationTokens)) {
        matched = true;
        matchedOperations.add(index);
      }
    });
    return matched;
  });
  return hasRecurringSubject && everyUnsupportedTokenIsOperationBacked && matchedOperations.size >= 2
    ? []
    : unsupportedTokens;
}

export function capabilityOutcomeScopeFailure(
  name: string,
  citedCandidates: SystemCapability[],
  signal?: CapabilityCatalogProjectSignal,
  acceptedOutcome = false,
  description = '',
  evidenceBackedAudienceTokens: readonly string[] = [],
  boundRequirement?: { id: string; visibleActionTerms?: readonly string[] },
): string[] {
  if (capabilityOutcomeRestatesDeliveryOperation(name, citedCandidates, signal, acceptedOutcome)) return ['delivery-operation-restatement'];
  if (capabilityOutcomeMisusesCoordination(name, citedCandidates)) return ['coordination-outcome-unsupported'];
  const leading = outcomeIdentityTokens(name)[0];
  const boundVisibleActions = new Set((boundRequirement?.visibleActionTerms || []).flatMap(outcomeIdentityTokens));
  if (capabilityOutcomeUsesBroadDeliveryAction(name, citedCandidates, signal) && !boundVisibleActions.has(leading || '')) return ['delivery-action-evidence-too-broad'];
  const productTextCorroborates = capabilityOutcomeCorroboratedByProductText(name, citedCandidates, signal, !boundRequirement);
  if (!productTextCorroborates && !capabilityOutcomeUsesDeliverySubject(name, citedCandidates, description)) return ['delivery-subject-missing'];
  if (acceptedOutcome) return [];
  const audienceTokens = new Set(evidenceBackedAudienceTokens.flatMap(outcomeIdentityTokens));
  return capabilityOutcomeNameUnsupportedTokens(name, citedCandidates, signal)
    .filter(token => !outcomeTokenMatches(token, audienceTokens));
}

export function capabilityDescriptionProductLanguageFailure(
  description: string,
  relatedEntities: readonly string[],
  operations: readonly string[] = [],
  evidenceIdentifiers: readonly string[] = [],
  firstPartyOutcomeText: readonly string[] = [],
): string | undefined {
  return capabilityDescriptionProductLanguageViolation(description, relatedEntities, operations, evidenceIdentifiers, firstPartyOutcomeText)?.reason;
}

export function capabilityDescriptionProductLanguageViolation(
  description: string,
  relatedEntities: readonly string[],
  operations: readonly string[] = [],
  evidenceIdentifiers: readonly string[] = [],
  firstPartyOutcomeText: readonly string[] = [],
): { reason: string; forbiddenTerms: string[] } | undefined {
  const surfaceScaffolding = description.match(/\bmcp\s+(?:tools?|surfaces?|endpoints?)\b|\bcli\s+(?:commands?|interfaces?|surfaces?)\b/i);
  if (surfaceScaffolding) return { reason: 'delivery-surface-scaffolding', forbiddenTerms: [surfaceScaffolding[0]] };
  const uiScaffolding = description.match(/\b(?:modals?|clicks?|mouse(?:leave|enter)|submit interactions?|form submissions?|(?:[a-z]+\s+){0,2}(?:creation|create|edit|editing|input|login|registration|update) forms?)\b/i);
  if (uiScaffolding) return { reason: 'ui-delivery-scaffolding', forbiddenTerms: [uiScaffolding[0]] };
  const selfReference = description.match(/\bcapabilit(?:y|ies)\b/i);
  if (selfReference) return { reason: 'capability-self-reference', forbiddenTerms: [selfReference[0]] };
  const rawSourceIdentifier = description.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/);
  if (rawSourceIdentifier) return { reason: 'raw-related-entity-identifier', forbiddenTerms: [rawSourceIdentifier[0]] };
  const messageScaffolding = description.match(/\b(?:handles?|process(?:es|ed|ing)?)\s+(?:incoming\s+)?messages?\s+to\b/i);
  if (messageScaffolding) return { reason: 'message-handler-scaffolding', forbiddenTerms: [messageScaffolding[0]] };
  const normalizedDescription = outcomeIdentityTokens(description);
  const copiedOperation = operations.find(operation => {
    let operationParts: unknown;
    try {
      operationParts = JSON.parse(operation);
    } catch {
      operationParts = operation;
    }
    const pathOrCommand = Array.isArray(operationParts) ? operationParts[1] : operationParts;
    const phrase = [...new Set(outcomeIdentityTokens(String(pathOrCommand || '')))];
    const relatedEntityTokens = new Set(relatedEntities.flatMap(outcomeIdentityTokens));
    const routeSubjectTokens = phrase.filter(token => token !== 'id');
    const productEntitySubject = routeSubjectTokens.length > 0 &&
      routeSubjectTokens.every(token => outcomeTokenMatches(token, relatedEntityTokens));
    if (productEntitySubject) return false;
    if (phrase.length < 2) return false;
    return normalizedDescription.some((_, index) => phrase.every((token, offset) => normalizedDescription[index + offset] === token));
  });
  if (copiedOperation) return { reason: 'delivery-operation-restatement', forbiddenTerms: outcomeIdentityTokens(copiedOperation) };
  const firstPartyPhrases = firstPartyOutcomeText.map(outcomeIdentityTokens);
  const establishedByFirstParty = (value: string): boolean => {
    const valueTokens = outcomeIdentityTokens(value);
    return valueTokens.length > 0 && firstPartyPhrases.some(phrase => phrase.some((_, index) =>
      valueTokens.every((token, offset) => phrase[index + offset] && outcomeTokenMatches(token, new Set([phrase[index + offset]])))));
  };
  const entityObjectScaffolding = relatedEntities.flatMap(entity => {
    const subjectTokens = outcomeIdentityTokens(entity).filter(token => token !== 'entity');
    const subject = subjectTokens[subjectTokens.length - 1];
    if (!subject) return [];
    const match = description.match(new RegExp(`\\b${subject.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')}\\s+objects?\\b`, 'i'));
    return match && !establishedByFirstParty(match[0]) ? [match[0]] : [];
  });
  if (entityObjectScaffolding.length > 0) {
    return { reason: 'generic-structural-phrase', forbiddenTerms: [...new Set(entityObjectScaffolding)] };
  }
  const identifiers = [...new Set([...relatedEntities, ...evidenceIdentifiers].map(value => String(value || '')).filter(Boolean))];
  const marketingTerms = capabilityMarketingLanguageTerms(description)
    .filter(term => !establishedByFirstParty(term));
  if (marketingTerms.length > 0) {
    return { reason: 'marketing-language', forbiddenTerms: marketingTerms };
  }
  const copiedEntity = identifiers.find(entity =>
    /[a-z0-9][A-Z]|[A-Z]{2,}[A-Z][a-z]|[_:$]/.test(entity) &&
    new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(description)
  );
  if (copiedEntity) return { reason: 'raw-related-entity-identifier', forbiddenTerms: [copiedEntity] };
  const normalizedDescriptionText = description.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const implementationPhrases = identifiers.flatMap(identifier => {
    if (!/[a-z0-9][A-Z]|[A-Z]{2,}[A-Z][a-z]|[_:$./-]/.test(identifier)) return [];
    const phrase = identifier.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_:$./-]+/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    return phrase.split(' ').length >= 2 ? [{ phrase, acronymPrefixed: /^[A-Z]{2,}[A-Z][a-z]/.test(identifier) }] : [];
  });
  const copiedInventoryPhrases = implementationPhrases.filter(({ phrase }) => {
    const pattern = phrase.split(' ').map(token => `${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?`).join('\\s+');
    return new RegExp(`\\b${pattern}\\b`, 'i').test(normalizedDescriptionText);
  });
  const copiedPhrases = [...new Set(copiedInventoryPhrases.map(item => item.phrase))];
  const copiedPhraseFamilies = new Set(copiedPhrases.map(phrase => outcomeIdentityTokens(phrase).join(' ')));
  if (copiedPhraseFamilies.size >= 2) {
    return { reason: 'implementation-graph-inventory', forbiddenTerms: copiedPhrases };
  }
  if (copiedInventoryPhrases.some(item => item.acronymPrefixed)) {
    return { reason: 'raw-related-entity-identifier', forbiddenTerms: copiedPhrases };
  }
  const fragmentSources = new Map<string, Set<string>>();
  for (const identifier of identifiers.filter(value => /[a-z0-9][A-Z]|[A-Z]{2,}[A-Z][a-z]|[_:$./-]/.test(value))) {
    const parts = identifier.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_:$./-]+/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
    const fragments = parts.slice(0, -1).map((part, index) => `${part} ${parts[index + 1]}`);
    for (const fragment of fragments) {
      const pattern = fragment.split(' ').map(token => `${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?`).join('\\s+');
      if (establishedByFirstParty(fragment) || !new RegExp(`\\b${pattern}\\b`, 'i').test(normalizedDescriptionText)) continue;
      const sources = fragmentSources.get(fragment) || new Set<string>(); sources.add(identifier); fragmentSources.set(fragment, sources);
    }
  }
  const matchedFragments = [...fragmentSources.keys()];
  const matchedFragmentFamilies = new Set(matchedFragments.map(fragment => outcomeIdentityTokens(fragment).join(' ')));
  const matchedSources = new Set([...fragmentSources.values()].flatMap(sources => [...sources]));
  if (matchedFragmentFamilies.size >= 2 && matchedSources.size >= 2) {
    return { reason: 'implementation-graph-inventory', forbiddenTerms: matchedFragments };
  }
  const identifierParts = identifiers.map(identifier => identifier.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_:$./-]+/g, ' ').toLowerCase().split(/\s+/).filter(Boolean));
  const recurringNamespaces = new Set(identifierParts.flatMap(parts => parts.slice(0, 1)).filter((part, index, all) =>
    part.length >= 2 && all.indexOf(part) !== index));
  const structuralParts = new Set(identifierParts.flat());
  const structuralPhrases = description.match(/\b(?:relationship\s+graphs?|graphs?\s+(?:nodes?|edges?|transitions?)|capability\s+maps?|entry\s+points?|exit\s+points?|method\s+calls?|call\s+chains?)\b/gi) || [];
  const groundedStructuralPhrases = structuralPhrases.filter(phrase => phrase.toLowerCase().split(/\s+/)
    .map(token => token.endsWith('s') ? token.slice(0, -1) : token)
    .some(token => [...structuralParts].some(part => outcomeTokenMatches(token, new Set([part])))) && !establishedByFirstParty(phrase));
  const namespacePhrases = [...recurringNamespaces].flatMap(namespace => {
    const match = description.match(new RegExp(`\\b${namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:relationship\\s+)?graphs?(?:\\s+(?:nodes?|edges?|transitions?))?\\b`, 'i'));
    return match && !establishedByFirstParty(match[0]) ? [match[0].toLowerCase()] : [];
  });
  const evidenceStructuralTerms = [...new Set([...groundedStructuralPhrases.map(phrase => phrase.toLowerCase()), ...namespacePhrases])];
  if (evidenceStructuralTerms.length >= 2 || namespacePhrases.length > 0) {
    return { reason: 'implementation-graph-inventory', forbiddenTerms: evidenceStructuralTerms };
  }
  const graphInventoryTerms = description.match(/\b(?:entry points?|exit points?|method calls?|call chains?|methods?|nodes?|edges?)\b/gi) || [];
  const uniqueGraphTerms = [...new Set(graphInventoryTerms.map(term => term.toLowerCase()))];
  return uniqueGraphTerms.length >= 2 ? { reason: 'implementation-graph-inventory', forbiddenTerms: uniqueGraphTerms } : undefined;
}

export function hasFirstPartyCorroboratedCatalogOperations(
  capability: SystemCapability,
  candidates: SystemCapability[],
  signal?: CapabilityCatalogProjectSignal,
): boolean {
  const citedCandidateIds = new Set((capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:'))
    .map(factor => factor.slice('catalog-candidate:'.length)));
  const citedCandidates = candidates.filter(candidate => citedCandidateIds.has(candidate.id));
  if (!capabilityOutcomeHasSpecificFirstPartySupport(capability.name, citedCandidates, signal)) return false;
  return citedCandidates.some(candidate => {
    if ((candidate.operations || []).length === 0) return false;
    if (candidate.evidence_role === 'verification-harness') return false;
    if (candidate.evidence_kind !== 'behavior-surface') return true;
    return capabilityOutcomeUsesDeliverySubject(capability.name, [candidate], capability.description || '') &&
      !capabilityOutcomeMisusesCoordination(capability.name, [candidate]);
  });
}

function hasLifecycleEvidence(entity: CASDataEntity): boolean {
  return Object.values(entity.lifecycle || {}).some(nodeIds => nodeIds.length > 0);
}

function domainEntityLooksLikeImplementationArtifact(entity: CASDataEntity): boolean {
  const tokens = String(entity.name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const suffix = tokens[tokens.length - 1] || '';
  return new Set(['artifact', 'capture', 'config', 'digest', 'manifest', 'report', 'scenario']).has(suffix) ||
    /(?:node)?indexentry$/.test(tokens.join(''));
}

function domainEntitySupportsCandidate(
  entity: CASDataEntity,
  candidate: SystemCapability,
  signal?: CapabilityCatalogProjectSignal,
): boolean {
  if (entity.kind !== 'domain-shape') return false;
  if (candidate.category === 'internal' || candidate.category === 'admin') return false;
  if ((candidate.operations || []).length === 0) return false;
  if (domainEntityLooksLikeImplementationArtifact(entity) && !productTextCorroboratesCapability(candidate, signal)) return false;
  const entityTokens = normalizedSubjectTokens(entity.name);
  const candidateTokens = normalizedSubjectTokens([
    candidate.name,
    candidate.structural_label,
    ...(candidate.related_domains || []),
    ...(candidate.operations || []).flatMap(operation => [operation.action, operation.path_or_command]),
    ...(candidate.evidence_examples || []),
  ].filter(Boolean).join(' '));
  return [...entityTokens].some(token => candidateTokens.has(token)) &&
    hasLifecycleEvidence(entity);
}

function candidateHasProductEntity(
  candidate: SystemCapability,
  entityById: Map<string, CASDataEntity>,
  signal?: CapabilityCatalogProjectSignal,
): boolean {
  return (candidate.related_entities || []).some(entityId => {
    const entity = entityById.get(entityId);
    if (!entity) return false;
    if (!entity.kind || entity.kind === 'persisted-entity' || entity.kind === 'api-response') return true;
    return domainEntitySupportsCandidate(entity, candidate, signal);
  });
}

function capabilityIsVerificationHarness(
  capability: SystemCapability,
  entryPointById: Map<string, CASEntryPoint>,
  nodeById: Map<string, CASNode>,
): boolean {
  if ((capability.operations || []).length === 0) return false;
  for (const operation of capability.operations || []) {
    const anchors: boolean[] = [];
    const entryPoint = entryPointById.get(operation.entry_point_id);
    if (entryPoint?.handler?.file) anchors.push(isScaffoldOrTestPath(entryPoint.handler.file));
    const nodeIds = new Set<string>();
    if (entryPoint?.source_node) nodeIds.add(entryPoint.source_node);
    if (entryPoint?.handler?.node_id) nodeIds.add(entryPoint.handler.node_id);
    if (operation.entry_point_id.startsWith('node:')) nodeIds.add(operation.entry_point_id.slice('node:'.length));
    for (const nodeId of nodeIds) {
      const node = nodeById.get(nodeId);
      if (node) anchors.push(node.metadata?.is_test === true || isScaffoldOrTestPath(node.source?.file || ''));
    }
    if (anchors.length === 0 && operation.path_or_command) anchors.push(isScaffoldOrTestPath(operation.path_or_command));
    if (anchors.length === 0 || anchors.some(anchor => !anchor)) return false;
  }
  return true;
}

function capabilityUsesUncorroboratedTestSurface(
  capability: SystemCapability,
  entryPointById: Map<string, CASEntryPoint>,
  signal?: CapabilityCatalogProjectSignal,
): boolean {
  if ((capability.operations || []).length === 0 || productTextCorroboratesCapability(capability, signal)) return false;
  const testSurfaceSegment = /(?:^|[\/_.:-])tests?(?:[\/_.:-]|$)/i;
  return (capability.operations || []).every(operation => {
    const entryPoint = entryPointById.get(operation.entry_point_id);
    const metadata = entryPoint?.metadata as Record<string, unknown> | undefined;
    const anchors = [
      operation.path_or_command,
      operation.trigger?.path,
      entryPoint?.name,
      entryPoint?.trigger?.path,
      entryPoint?.handler?.file,
      typeof metadata?.controller === 'string' ? metadata.controller : undefined,
    ];
    return anchors.some(value => testSurfaceSegment.test(String(value || '')));
  });
}

function capabilityHasExternalReach(
  capability: SystemCapability,
  entryPointById: Map<string, CASEntryPoint>,
): boolean {
  return (capability.operations || []).some(operation => {
    const entryPoint = entryPointById.get(operation.entry_point_id);
    if (isStructuralExecutableCliEntry(entryPoint)) return false;
    if (entryPoint?.interaction_reach === 'external') return true;
    if (entryPoint?.interaction_reach === 'internal') return false;
    return operation.entry_point_type === 'external' ||
      USER_FACING_ENTRY_TYPES.has(operation.entry_point_type as never);
  });
}

function capabilityHasPotentialUserSurface(capability: SystemCapability, entryPointById: Map<string, CASEntryPoint>): boolean {
  return (capability.operations || []).some(operation =>
    !isStructuralExecutableCliEntry(entryPointById.get(operation.entry_point_id)) &&
    !/^(?:internal|message|event|schedule|queue|ipc|external)$/i.test(operation.entry_point_type || '')
  );
}

function capabilityHasUserOutcomeJourney(
  capability: SystemCapability,
  journeys: CASUserJourney[],
): boolean {
  const operationIds = new Set((capability.operations || []).map(operation => operation.entry_point_id));
  return journeys.some(journey => operationIds.has(journey.entry_point_id) &&
    journey.journey_kind === 'user-facing' &&
    ((journey.terminal_entities || []).some(entity => entity.terminal_kind === 'entity') ||
      (journey.terminal_effects.entities_written || []).length > 0 ||
      (journey.terminal_effects.entities_read || []).length > 0 ||
      (journey.terminal_effects.messages_emitted || []).length > 0));
}

function capabilityHasUserFacingLifecycleBreadth(
  capability: SystemCapability,
  entryPointById: Map<string, CASEntryPoint>,
): boolean {
  if (capability.evidence_kind === 'behavior-surface') return false;
  const stages = new Set<string>();
  let externallyReachableOperations = 0;
  for (const operation of capability.operations || []) {
    const entryPoint = entryPointById.get(operation.entry_point_id);
    const external = entryPoint?.interaction_reach === 'external' ||
      (entryPoint?.interaction_reach !== 'internal' &&
        (USER_FACING_ENTRY_TYPES.has((entryPoint?.type || operation.entry_point_type) as never)));
    if (!external) continue;
    externallyReachableOperations++;
    const method = String(entryPoint?.trigger?.method || operation.trigger?.method || '').toUpperCase();
    const action = [
      operation.action,
      operation.path_or_command,
      operation.trigger?.path,
      entryPoint?.name,
      entryPoint?.trigger?.path,
    ].filter(Boolean).join(' ').toLowerCase();
    if (method === 'POST' || /\b(?:add|create|favorite|follow|publish|register|submit)\b/.test(action)) stages.add('create');
    if (method === 'GET' || /\b(?:browse|fetch|get|list|read|search|view)\b/.test(action)) stages.add('read');
    if (method === 'PUT' || method === 'PATCH' || /\b(?:change|edit|patch|update)\b/.test(action)) stages.add('update');
    if (method === 'DELETE' || /\b(?:delete|remove|unfavorite|unfollow)\b/.test(action)) stages.add('delete');
  }
  return externallyReachableOperations >= 2 && stages.size >= 2;
}

export function classifyCapabilityEvidence(
  candidates: SystemCapability[],
  dataEntities: CASDataEntity[] = [],
  projectTextSignal?: CapabilityCatalogProjectSignal,
  context: CapabilityEvidenceContext = {},
): SystemCapability[] {
  const entityById = new Map(dataEntities.map(entity => [entity.id, entity]));
  const entryPointById = new Map((context.entryPoints || []).map(entryPoint => [entryPoint.id, entryPoint]));
  const terminalityById = catalogCandidateTerminality(candidates);
  const nodeById = new Map((context.nodes || []).map(node => [node.id, node]));
  return candidates.map(candidate => {
    let evidenceRole: CapabilityEvidenceRole;
    const reasons: string[] = [];
    const operations = candidate.operations || [];
    const allStructuralExecutableCli = operations.length > 0 && operations.every(operation =>
      isStructuralExecutableCliEntry(entryPointById.get(operation.entry_point_id)));
    const firstParty = productTextCorroboratesCapability(candidate, projectTextSignal);
    const upstreamPrerequisite = (terminalityById.get(candidate.id)?.distance_to_terminal || 0) > 0;
    const bareDeliveryAggregate = isBareNounCapabilityLabel(candidate.name) &&
      operations.length > 0 && operations.every(operation =>
        /^(?:event|route)$/i.test(operation.entry_point_type || ''));
    if (capabilityIsVerificationHarness(candidate, entryPointById, nodeById)) {
      evidenceRole = 'verification-harness';
      reasons.push('all-resolved-operation-anchors-are-test-or-scaffold');
    } else if (capabilityUsesUncorroboratedTestSurface(candidate, entryPointById, projectTextSignal)) {
      evidenceRole = 'verification-harness';
      reasons.push('test-named-entry-points-without-product-corroboration');
    } else if (allStructuralExecutableCli) {
      evidenceRole = 'supporting-mechanism';
      reasons.push('filesystem-executable-without-product-command-registration');
    } else if (upstreamPrerequisite && !firstParty) {
      evidenceRole = 'supporting-mechanism';
      reasons.push('upstream-prerequisite-outside-product-purpose');
    } else if (bareDeliveryAggregate) {
      evidenceRole = 'supporting-mechanism';
      reasons.push('bare-page-and-event-aggregate-supports-outcomes');
    } else if (candidate.evidence_kind === 'behavior-surface' && candidate.category !== 'core' &&
        capabilityHasExternalReach(candidate, entryPointById) &&
        (candidateHasProductEntity(candidate, entityById, projectTextSignal) ||
          capabilityHasUserOutcomeJourney(candidate, context.userJourneys || []))) {
      evidenceRole = 'unresolved';
      reasons.push('potential-user-outcome-requires-catalog-resolution');
    } else if ((candidate.evidence_kind === 'behavior-surface' && candidate.category !== 'core') || candidate.category === 'internal') {
      const firstParty = productTextCorroboratesCapability(candidate, projectTextSignal);
      evidenceRole = 'supporting-mechanism';
      reasons.push(firstParty
        ? 'first-party-product-delivery-surface-supports-outcome'
        : 'delivery-surface-is-evidence-not-product-outcome');
    } else {
      const externalReach = capabilityHasExternalReach(candidate, entryPointById);
      const productEntity = candidateHasProductEntity(candidate, entityById, projectTextSignal);
      const userOutcomeJourney = capabilityHasUserOutcomeJourney(candidate, context.userJourneys || []);
      const deliverySurfaceShapedCandidate =
        /^(?:get|post|put|patch|delete)\s+\//i.test(candidate.name) ||
        /\b(?:click|change|close|submit|mouse\s*leave)\s*$/i.test(candidate.name) ||
        /\b(?:controller|handler|route|endpoint|modal)\b/i.test(candidate.name);
      const firstPartyCoreOutcome = !deliverySurfaceShapedCandidate && firstParty && candidate.category === 'core' &&
        productTextCorroboratesActionAndSubject(candidate, projectTextSignal);
      const userFacingLifecycle = capabilityHasUserFacingLifecycleBreadth(candidate, entryPointById);
      const mechanismShapedCandidate = deliverySurfaceShapedCandidate ||
        /\b(?:workflow|service|repository|layer|settings|configuration)\b/i.test(candidate.name);
      const candidateNameTokens = outcomeIdentityTokens(candidate.name);
      const relatedEntityNames = (candidate.related_entities || [])
        .map(entityId => entityById.get(entityId)?.name || '')
        .filter(Boolean);
      const relatedEntityTokens = new Set(relatedEntityNames.flatMap(outcomeIdentityTokens));
      const candidateSubject = candidateNameTokens.slice(1).join('');
      const entityOnlySubject = candidateNameTokens.slice(1).every(token => outcomeTokenMatches(token, relatedEntityTokens)) ||
        relatedEntityNames.some(name => outcomeIdentityTokens(name).join('') === candidateSubject);
      const genericCrudSubject = candidateNameTokens.length === 2 || entityOnlySubject;
      const structurallyInferredEntityCrud = /^(?:access|add|archive|browse|change|create|delete|edit|find|get|list|read|record|register|remove|retrieve|review|search|show|update|view)\b/i.test(candidate.name) &&
        candidateNameTokens.length >= 2 &&
        genericCrudSubject &&
        !firstPartyCoreOutcome;
      const outcomeShapedCandidate = candidateNameTokens.length >= 2 &&
        !mechanismShapedCandidate &&
        !structurallyInferredEntityCrud &&
        !isCrudInventoryCapabilityLabel(candidate.name) &&
        !isGenericManagementCapabilityLabel(candidate.name);
      const reversibleUserActionLifecycle = capabilityHasReversibleUserActionLifecycle(candidate, entryPointById);
      const actionHeadedOutcome = !isBareNounCapabilityLabel(candidate.name);
      const interpretableOutcomeEvidence = outcomeShapedCandidate || firstPartyCoreOutcome;
      const terminalOutcomeEvidence = !deliverySurfaceShapedCandidate && interpretableOutcomeEvidence && userOutcomeJourney &&
        (candidate.evidence_kind !== 'behavior-surface' || operations.length > 1 || firstParty);
      const externallyReachableOutcomeEvidence = !deliverySurfaceShapedCandidate && interpretableOutcomeEvidence && actionHeadedOutcome && externalReach && productEntity && operations.length > 1;
      const lifecycleOutcomeEvidence = !deliverySurfaceShapedCandidate && interpretableOutcomeEvidence && userFacingLifecycle;
      const reversibleActionOutcomeEvidence = !deliverySurfaceShapedCandidate && externalReach && reversibleUserActionLifecycle;
      if (firstPartyCoreOutcome || terminalOutcomeEvidence || externallyReachableOutcomeEvidence || lifecycleOutcomeEvidence || reversibleActionOutcomeEvidence) {
        evidenceRole = 'product-outcome';
        if (firstPartyCoreOutcome) reasons.push('first-party-product-text');
        if (terminalOutcomeEvidence) reasons.push('user-facing-terminal-journey');
        if (externallyReachableOutcomeEvidence) reasons.push('external-reach-with-product-entity');
        if (lifecycleOutcomeEvidence) reasons.push('user-facing-lifecycle-breadth');
        if (reversibleActionOutcomeEvidence) reasons.push('reversible-user-action-lifecycle');
      } else if ((candidate.operations || []).length > 0 || (candidate.related_entities || []).length > 0) {
        const potentiallyProductSignificant = productEntity || (externalReach && capabilityHasPotentialUserSurface(candidate, entryPointById));
        evidenceRole = potentiallyProductSignificant ? 'unresolved' : 'supporting-mechanism';
        reasons.push(potentiallyProductSignificant
          ? 'potential-user-outcome-requires-catalog-resolution'
          : 'structural-evidence-without-product-outcome');
      } else {
        evidenceRole = 'unresolved';
        reasons.push('missing-structural-anchor');
      }
    }
    return { ...candidate, evidence_role: evidenceRole, evidence_role_reasons: reasons };
  });
}

export function demoteCoveredImplementationAggregates(
  candidates: readonly SystemCapability[],
): SystemCapability[] {
  return demoteCoveredImplementationAggregatesImpl(candidates, capabilityEvidenceSubjectTokens);
}
export function catalogRequiredEvidenceCandidates(candidates: SystemCapability[]): SystemCapability[] {
  return candidates.filter(capabilityRequiresCatalogCoverage);
}

export function capabilityRequiresCatalogCoverage(candidate: SystemCapability): boolean {
  return candidate.evidence_role === 'product-outcome';
}

export function capabilityCanRepairRejectedOutcomeProposal(candidate: SystemCapability): boolean {
  return candidate.evidence_role === 'product-outcome' || candidate.evidence_role === 'unresolved';
}

export function capabilityCitesRequiredEvidence(
  capability: SystemCapability,
  candidates: SystemCapability[],
): boolean {
  return capabilityEvidencePublicationFailure(capability, candidates) === undefined;
}

export function capabilityEvidencePublicationFailure(
  capability: SystemCapability,
  candidates: SystemCapability[],
  signal?: CapabilityCatalogProjectSignal,
): 'uncited-candidate-evidence' | 'supporting-or-verification-evidence-only' | undefined {
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const citedIds = (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:'))
    .map(factor => factor.slice('catalog-candidate:'.length));
  if (citedIds.length === 0) return 'uncited-candidate-evidence';
  const citedCandidates = citedIds
    .map(id => candidateById.get(id))
    .filter((candidate): candidate is SystemCapability => Boolean(candidate));
  const executableOutcomeEvidence = citedCandidates.some(candidate =>
    (candidate.evidence_role === 'product-outcome' || candidate.evidence_role === 'unresolved') &&
    (candidate.operations || []).length > 0);
  if (executableOutcomeEvidence) return undefined;
  return hasFirstPartyCorroboratedCatalogOperations(capability, candidates, signal)
    ? undefined : 'supporting-or-verification-evidence-only';
}

export function summarizeCapabilityEvidenceRoles(candidates: SystemCapability[]): CapabilityEvidenceRoleSummary {
  return candidates.reduce<CapabilityEvidenceRoleSummary>((summary, candidate) => {
    if (candidate.evidence_role === 'product-outcome') summary.product++;
    else if (candidate.evidence_role === 'supporting-mechanism') summary.supporting++;
    else if (candidate.evidence_role === 'verification-harness') summary.verification++;
    else summary.unresolved++;
    return summary;
  }, { product: 0, supporting: 0, verification: 0, unresolved: 0 });
}

export function catalogCandidateTerminality(candidates: SystemCapability[]) {
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  return new Map(analyzeTerminality(
    candidateIds,
    candidates.flatMap(candidate => (candidate.depends_on || [])
      .filter(dependency => candidateIds.has(dependency.to_capability))
      .map(dependency => ({ source: dependency.to_capability, target: dependency.from_capability }))),
  ).map(member => [member.id, member]));
}

export function behaviorSurfaceEntryCount(surface: SystemCapability): number {
  const factorMatch = /^\s*(\d+)\b/.exec((surface.criticality_factors || [])[0] || '');
  if (factorMatch) return Number(factorMatch[1]);
  const descriptionMatch = /Behavior surface:\s*(\d+)\b/i.exec(surface.description || '');
  return descriptionMatch ? Number(descriptionMatch[1]) : (surface.operations || []).length;
}

export function catalogBehaviorSurfaceCandidates(surfaces: SystemCapability[]): SystemCapability[] {
  return surfaces.filter(surface => {
    const entryCount = behaviorSurfaceEntryCount(surface);
    const cohesiveFamily = (surface.criticality_factors || []).some(factor => /cohesive behavior family\s*\('/i.test(factor));
    const eligible = entryCount >= 15 || (surface.evidence_kind === 'behavior-surface' && cohesiveFamily && entryCount >= 2);
    const operations = surface.operations || [];
    if (!eligible || operations.every(operation => operation.entry_point_type === 'external')) return false;
    const presentationOnly = operations.length > 0 && operations.every(operation =>
      operation.entry_point_type === 'page' || operation.entry_point_type === 'route');
    return !presentationOnly || cohesiveFamily;
  });
}

export function catalogEntityCandidateGroups(candidates: SystemCapability[]): string[][] {
  const eligible = candidates.filter(candidate =>
    candidate.id &&
    candidate.evidence_kind !== 'behavior-surface' &&
    (candidate.related_entities || []).length > 0 &&
    (candidate.operations || []).some(operation => operation.entry_point_type !== 'external')
  );
  const coveringCandidates = candidates.filter(candidate =>
    candidate.id &&
    candidate.evidence_kind !== 'behavior-surface' &&
    (candidate.operations || []).length > 0 &&
    (candidate.operations || []).some(operation => operation.entry_point_type !== 'external')
  );
  const candidatesByEntity = new Map<string, Set<string>>();
  for (const candidate of eligible) {
    const relatedEntities = candidate.related_entities || [];
    const candidateSubjects = new Set(capabilityEvidenceSubjectTokens(candidate));
    const subjectMatchedEntities = relatedEntities.filter(entityId =>
      [...normalizedSubjectTokens(String(entityId).replace(/^entity[_:-]?/i, ' '))]
        .some(subject => candidateSubjects.has(subject)));
    const ownedEntities = subjectMatchedEntities.length > 0 ? subjectMatchedEntities : relatedEntities;
    for (const entityId of ownedEntities) {
      const group = candidatesByEntity.get(entityId);
      if (group) group.add(candidate.id);
      else candidatesByEntity.set(entityId, new Set([candidate.id]));
    }
  }
  for (const [entityId, group] of candidatesByEntity) {
    const parentSubjects = [...normalizedSubjectTokens(String(entityId).replace(/^entity[_:-]?/i, ' '))];
    if (parentSubjects.length !== 1 || parentSubjects[0].length < 4) continue;
    const parentSubject = parentSubjects[0];
    const groupedOperationKeys = new Set(eligible
      .filter(candidate => group.has(candidate.id))
      .flatMap(candidate => (candidate.operations || []).map(operation => [
        operation.entry_point_id,
        operation.entry_point_type,
        operation.action,
        operation.path_or_command || '',
        operation.trigger?.method || '',
        operation.trigger?.path || '',
      ].join('|'))));
    for (const candidate of coveringCandidates) {
      if (group.has(candidate.id)) continue;
      const candidateSubjects = new Set(capabilityEvidenceSubjectTokens(candidate));
      if (!candidateSubjects.has(parentSubject)) continue;
      const ownsCompoundEntity = (candidate.related_entities || []).some(relatedEntityId => {
        const normalized = String(relatedEntityId)
          .replace(/^entity[_:-]?/i, '')
          .replace(/[^a-z0-9]/gi, '')
          .toLowerCase();
        const suffix = normalized.startsWith(parentSubject) ? normalized.slice(parentSubject.length) : '';
        return /[a-z]{2,}/.test(suffix);
      });
      const sharesGroupedOperation = (candidate.operations || []).some(operation => groupedOperationKeys.has([
        operation.entry_point_id,
        operation.entry_point_type,
        operation.action,
        operation.path_or_command || '',
        operation.trigger?.method || '',
        operation.trigger?.path || '',
      ].join('|')));
      if (ownsCompoundEntity || sharesGroupedOperation) group.add(candidate.id);
    }
  }
  const uniqueGroups = new Map<string, string[]>();
  for (const group of candidatesByEntity.values()) {
    const sorted = [...group].sort();
    uniqueGroups.set(sorted.join('|'), sorted);
  }
  return [...uniqueGroups.values()]
    .sort((left, right) => left[0].localeCompare(right[0]));
}


export function catalogEvidenceCoverageFailure(
  reconciled: readonly SystemCapability[],
  requiredBehaviorCandidateIds: readonly string[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
  fullyCoveredAggregateCandidateIds: ReadonlySet<string> = new Set(),
): string | undefined {
  const citedCandidateIds = new Set(reconciled.flatMap(capability => (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:'))
    .map(factor => factor.slice('catalog-candidate:'.length))));
  const omittedBehaviorCandidateIds = requiredBehaviorCandidateIds.filter(candidateId => !citedCandidateIds.has(candidateId));
  if (omittedBehaviorCandidateIds.length > 0) {
    return `catalog omitted ${omittedBehaviorCandidateIds.length} behavior evidence famil${omittedBehaviorCandidateIds.length === 1 ? 'y' : 'ies'}: ${omittedBehaviorCandidateIds.slice(0, 8).join(', ')}`;
  }
  const omittedEntityGroups = requiredEntityCandidateGroups.filter(group => !group.some(candidateId =>
    citedCandidateIds.has(candidateId) || fullyCoveredAggregateCandidateIds.has(candidateId)));
  if (omittedEntityGroups.length > 0) {
    const displayedGroups = omittedEntityGroups.slice(0, 8).map(group => group.join('|')).join(', ');
    const omittedSuffix = omittedEntityGroups.length > 8 ? ' (+' + (omittedEntityGroups.length - 8) + ' more)' : '';
    return 'catalog omitted ' + omittedEntityGroups.length + ' product-entity evidence ' + (omittedEntityGroups.length === 1 ? 'family' : 'families') + ': ' + displayedGroups + omittedSuffix;
  }
  return undefined;
}

export function catalogEvidenceCandidates(
  candidates: SystemCapability[],
  behaviorSurfaces: SystemCapability[],
  dataEntities?: CASDataEntity[],
  artifactType = 'app',
  projectTextSignal?: CapabilityCatalogProjectSignal,
  context: CapabilityEvidenceContext = {},
): SystemCapability[] {
  void artifactType;
  const scopeCandidates = candidates;
  const result = [...scopeCandidates];
  const ids = new Set(scopeCandidates.map(candidate => candidate.id).filter(Boolean));
  const eligibleSurfaces = catalogBehaviorSurfaceCandidates(behaviorSurfaces);
  const operationIds = (surface: SystemCapability) => new Set((surface.operations || []).map(operation => operation.entry_point_id).filter(Boolean));
  const semanticSurfaces = eligibleSurfaces.filter((surface, index) => {
    const surfaceTokens = new Set(String(surface.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const transportTokens = new Set(['mcp', 'tool', 'tools', 'message', 'event', 'command', 'surface']);
    if (surfaceTokens.size > 0 && [...surfaceTokens].every(token => transportTokens.has(token))) {
      const semanticChildren = eligibleSurfaces.filter((other, otherIndex) => {
        if (otherIndex === index) return false;
        const otherTokens = new Set(String(other.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
        return otherTokens.size > surfaceTokens.size && [...surfaceTokens].every(token => otherTokens.has(token));
      });
      if (semanticChildren.length >= 2) return false;
    }
    const own = operationIds(surface);
    if (own.size === 0) return true;
    const contributors = eligibleSurfaces
      .map((other, otherIndex) => otherIndex === index ? undefined : operationIds(other))
      .filter((other): other is Set<string> => Boolean(other && [...own].some(id => other.has(id))));
    const covered = new Set(contributors.flatMap(other => [...other].filter(id => own.has(id))));
    const ownExamples = new Set((surface.evidence_examples || []).map(value => String(value).toLowerCase()));
    const exampleContributors = eligibleSurfaces
      .filter((_, otherIndex) => otherIndex !== index)
      .map(other => new Set((other.evidence_examples || []).map(value => String(value).toLowerCase())))
      .filter(other => [...ownExamples].some(example => other.has(example)));
    const coveredExamples = new Set(exampleContributors.flatMap(other => [...other].filter(example => ownExamples.has(example))));
    return !(contributors.length >= 2 && covered.size / own.size >= 0.75) &&
      !(ownExamples.size > 0 && exampleContributors.length >= 2 && coveredExamples.size / ownExamples.size >= 0.75);
  });
  for (const surface of semanticSurfaces) {
    if (surface.id && ids.has(surface.id)) continue;
    result.push(surface);
    if (surface.id) ids.add(surface.id);
  }
  return demoteCoveredImplementationAggregates(
    classifyCapabilityEvidence(result, dataEntities || [], projectTextSignal, context),
  );
}
