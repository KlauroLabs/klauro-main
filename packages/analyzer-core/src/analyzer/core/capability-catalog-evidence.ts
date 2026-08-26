import { CASDataEntity, CASEntryPoint, CASNode, CASUserJourney, EnhancedSystemPurpose, SystemCapability } from '../../types/cas.types';
import { USER_FACING_ENTRY_TYPES } from './journey-builder';
import { isScaffoldOrTestPath } from './scaffold-paths';
import { analyzeTerminality } from './terminality';

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
  manifestDescription?: string;
  summary?: string;
}

export interface CapabilityCatalogEntityFact {
  fields: string[];
  name: string;
}

export function capabilityCatalogAiPhaseStatus(
  coverage?: { evidence_families: number; status: 'accepted' | 'partial' | 'rejected' | 'unavailable' },
): 'complete' | 'degraded' {
  return coverage && coverage.evidence_families > 0 && coverage.status !== 'accepted' ? 'degraded' : 'complete';
}

export function synchronizeCapabilityCatalogCoverage(
  purpose: EnhancedSystemPurpose,
  publishedCapabilities: number,
  excludedCapabilities: number,
): void {
  const coverage = purpose.capability_catalog_coverage;
  if (!coverage) return;
  const preserveRejectedCandidates = coverage.status === 'rejected' && coverage.published_capabilities === 0;
  coverage.actual_publishable_capabilities = preserveRejectedCandidates ? Math.max(coverage.actual_publishable_capabilities || 0, publishedCapabilities) : publishedCapabilities;
  coverage.published_capabilities = publishedCapabilities;
  if (excludedCapabilities > 0 && coverage.status === 'accepted') {
    coverage.status = 'partial';
    coverage.reason = `${excludedCapabilities} catalog capability ${excludedCapabilities === 1 ? 'was' : 'were'} excluded during final publishability validation`;
  }
  if (publishedCapabilities < coverage.minimum_published_capabilities) {
    coverage.status = 'rejected';
    coverage.reason = `final catalog published ${publishedCapabilities} of at least ${coverage.minimum_published_capabilities} required capabilities`;
  }
  purpose.ai_phase_status = capabilityCatalogAiPhaseStatus(coverage);
}

function normalizedSubjectTokens(value: string): Set<string> {
  const scaffolding = new Set(['management', 'capability', 'workflow', 'handling', 'operation', 'operations', 'mcp', 'tool', 'tools', 'surface']);
  return new Set(String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !scaffolding.has(token))
    .map(token => token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token));
}

function outcomeIdentityTokens(value: string): string[] {
  const ignored = new Set([
    'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'through', 'to', 'using', 'with',
    'ability', 'across', 'area', 'behavior', 'capability', 'management', 'operation', 'operations', 'surface', 'tool', 'tools', 'workflow',
  ]);
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3)
    .map(token => token.length >= 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)
    .filter(token => !ignored.has(token));
}

function outcomeTokenMatches(token: string, evidence: Set<string>): boolean {
  const equivalents: Record<string, string[]> = {
    code: ['codebase', 'software', 'source'],
    codebase: ['code', 'software', 'source'],
    collaborate: ['collaboration', 'coordinate'],
    collaboration: ['collaborate', 'coordinate'],
    coordinate: ['collaborate', 'collaboration'],
    collision: ['conflict', 'overlap'],
    conflict: ['collision', 'overlap'],
    evolution: ['change', 'history'],
    history: ['change', 'evolution'],
    overlap: ['collision', 'conflict'],
    overlapping: ['collision', 'conflict'],
  };
  if ((equivalents[token] || []).some(candidate => evidence.has(candidate))) return true;
  return evidence.has(token) || [...evidence].some(candidate =>
    Math.min(token.length, candidate.length) >= 5 &&
    (token.startsWith(candidate) || candidate.startsWith(token) || token.slice(0, 5) === candidate.slice(0, 5))
  );
}

function capabilityOutcomeCorroboratedByProductText(
  name: string,
  citedCandidates: SystemCapability[],
  signal?: CapabilityCatalogProjectSignal,
): boolean {
  const words = outcomeIdentityTokens(name);
  const productTokens = new Set(outcomeIdentityTokens([
    ...(signal?.concepts || []),
    signal?.productDocTitle,
    signal?.productDocSummary,
    signal?.manifestDescription,
    signal?.summary,
  ].filter(Boolean).join(' ')));
  if (words.length <= 1 || !outcomeTokenMatches(words[0], productTokens)) return false;
  const subjects = words.slice(1);
  if (!subjects.some(token => outcomeTokenMatches(token, productTokens))) return false;
  const evidenceTokens = new Set(citedCandidates.flatMap(candidate => capabilityEvidenceSubjectTokens(candidate)));
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

export function capabilityEvidenceSubjectTokens(
  candidate: SystemCapability,
  entityNames: readonly string[] = [],
): string[] {
  const ignored = new Set([
    'analyze', 'check', 'entry', 'extend', 'fetch', 'get', 'install', 'internal', 'list', 'load', 'mcp', 'model',
    'preview', 'read', 'record', 'release', 'run', 'show', 'start', 'stop', 'supporting', 'sync', 'system', 'validate', 'value',
  ]);
  const tokens = outcomeIdentityTokens([
    candidate.name,
    candidate.structural_label,
    ...(candidate.related_domains || []),
    ...entityNames,
  ].filter(Boolean).join(' ')).filter(token => !ignored.has(token));
  const exampleCounts = new Map<string, number>();
  for (const example of candidate.evidence_examples || []) {
    for (const token of new Set(outcomeIdentityTokens(example).filter(value => !ignored.has(value)))) {
      exampleCounts.set(token, (exampleCounts.get(token) || 0) + 1);
    }
  }
  const recurringExampleTokens = [...exampleCounts.entries()]
    .filter(([, count]) => count >= Math.min(2, candidate.evidence_examples?.length || 1))
    .map(([token]) => token);
  return [...new Set([...tokens, ...recurringExampleTokens])].sort();
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
  const copiesOperationPhrase = citedCandidates.some(candidate => (candidate.evidence_examples || []).some(example => {
    const operationPhrase = outcomeIdentityTokens(example).join(' ');
    return operationPhrase.split(' ').length >= 2 && (` ${namePhrase} `).includes(` ${operationPhrase} `);
  }));
  const corroboratedProductOutcome = capabilityOutcomeCorroboratedByProductText(name, citedCandidates, signal);
  const usesDeliveryScaffolding = /\b(?:mcp|tools?|surfaces?)\b/i.test(name);
  const usesGenericDeliveryAction = /^(?:handle|manage|process)(?:s|es|ing)?\b/i.test(name.trim());
  const repeatsActionAsSubject = words.length === 2 && outcomeTokenMatches(words[0], new Set([words[1]]));
  return words.length === 0 || usesDeliveryScaffolding || usesGenericDeliveryAction || repeatsActionAsSubject ||
    (!acceptedOutcome && !corroboratedProductOutcome && copiesOperationPhrase) || /\b(?:at|by|for|from|in|of|on|to|via|with)$/i.test(name.trim());
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
    ...(candidate.evidence_examples || []),
  ].filter(Boolean).join(' '))));
  return !['claim', 'collision', 'conflict', 'concurrent', 'collaborat', 'overlap', 'participant', 'reserv'].some(signal =>
    [...coordinationEvidence].some(token => token.startsWith(signal))
  );
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
  const subjectTokens = nameTokens.slice(1);
  const firstPartyTokens = new Set(outcomeIdentityTokens([
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
      ...(candidate.evidence_examples || []),
    ].filter(Boolean).join(' '))));
  const unsupportedTokens = subjectTokens.filter(token =>
    !outcomeTokenMatches(token, firstPartyTokens) && !outcomeTokenMatches(token, citedIdentityTokens)
  );
  if (!focusedBehaviorSurface || unsupportedTokens.length < 2 || !/\band\b/i.test(name)) return unsupportedTokens;
  const hasRecurringSubject = subjectTokens.some(token => outcomeTokenMatches(token, citedIdentityTokens));
  const operationTokenSets = (citedCandidates[0].evidence_examples || []).map(example =>
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
): string[] {
  if (capabilityOutcomeRestatesDeliveryOperation(name, citedCandidates, signal, acceptedOutcome)) return ['delivery-operation-restatement'];
  if (capabilityOutcomeMisusesCoordination(name, citedCandidates)) return ['coordination-outcome-unsupported'];
  if (!capabilityOutcomeCorroboratedByProductText(name, citedCandidates, signal) && !capabilityOutcomeUsesDeliverySubject(name, citedCandidates, acceptedOutcome ? description : '')) return ['delivery-subject-missing'];
  if (acceptedOutcome) return [];
  const audienceTokens = new Set(evidenceBackedAudienceTokens.flatMap(outcomeIdentityTokens));
  return capabilityOutcomeNameUnsupportedTokens(name, citedCandidates, signal)
    .filter(token => !outcomeTokenMatches(token, audienceTokens));
}

export function capabilityDescriptionProductLanguageFailure(
  description: string,
  relatedEntities: readonly string[],
  operations: readonly string[] = [],
): string | undefined {
  return capabilityDescriptionProductLanguageViolation(description, relatedEntities, operations)?.reason;
}

export function capabilityDescriptionProductLanguageViolation(
  description: string,
  relatedEntities: readonly string[],
  operations: readonly string[] = [],
): { reason: string; forbiddenTerms: string[] } | undefined {
  const surfaceScaffolding = description.match(/\bmcp\s+(?:tools?|surfaces?|endpoints?)\b|\bcli\s+(?:commands?|interfaces?|surfaces?)\b/i);
  if (surfaceScaffolding) return { reason: 'delivery-surface-scaffolding', forbiddenTerms: [surfaceScaffolding[0]] };
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
    if (phrase.length < 2) return false;
    return normalizedDescription.some((_, index) => phrase.every((token, offset) => normalizedDescription[index + offset] === token));
  });
  if (copiedOperation) return { reason: 'delivery-operation-restatement', forbiddenTerms: outcomeIdentityTokens(copiedOperation) };
  const copiedEntity = relatedEntities.find(entity =>
    (/[a-z0-9][A-Z]|[_:$]/.test(entity) || /(?:Config|DTO|Entity|Entry|Model|Record|Schema)$/i.test(entity)) &&
    new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(description)
  );
  if (copiedEntity) return { reason: 'raw-related-entity-identifier', forbiddenTerms: [copiedEntity] };
  const graphInventoryTerms = description.match(/\b(?:entry points?|exit points?|method calls?|call chains?|methods?|nodes?|edges?)\b/gi) || [];
  const uniqueGraphTerms = [...new Set(graphInventoryTerms.map(term => term.toLowerCase()))];
  return uniqueGraphTerms.length >= 2 ? { reason: 'implementation-graph-inventory', forbiddenTerms: uniqueGraphTerms } : undefined;
}

export function productTextCorroboratesCapability(candidate: SystemCapability, signal?: CapabilityCatalogProjectSignal): boolean {
  if (!signal) return false;
  const productTokens = normalizedSubjectTokens([
    ...(signal.concepts || []),
    signal.productDocTitle,
    signal.productDocSummary,
    signal.manifestDescription,
    signal.summary,
  ].filter(Boolean).join(' '));
  const subjectTokens = normalizedSubjectTokens([candidate.structural_label, candidate.name].filter(Boolean).join(' '));
  const matches = [...subjectTokens].filter(token => productTokens.has(token) ||
    [...productTokens].some(productToken => Math.min(token.length, productToken.length) >= 3 &&
      (token.startsWith(productToken) || productToken.startsWith(token)))).length;
  return subjectTokens.size > 0 && matches >= Math.min(2, subjectTokens.size);
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
    if (operation.path_or_command) anchors.push(isScaffoldOrTestPath(operation.path_or_command));
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
    if (anchors.length === 0 || anchors.some(anchor => !anchor)) return false;
  }
  return true;
}

function capabilityHasExternalReach(
  capability: SystemCapability,
  entryPointById: Map<string, CASEntryPoint>,
): boolean {
  return (capability.operations || []).some(operation => {
    const entryPoint = entryPointById.get(operation.entry_point_id);
    if (entryPoint?.interaction_reach === 'external') return true;
    if (entryPoint?.interaction_reach === 'internal') return false;
    return operation.entry_point_type === 'external' ||
      USER_FACING_ENTRY_TYPES.has(operation.entry_point_type as never);
  });
}

function capabilityHasPotentialUserSurface(capability: SystemCapability): boolean {
  return (capability.operations || []).some(operation =>
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
    (journey.terminal_entities.length > 0 ||
      Object.values(journey.terminal_effects).some(values => values.length > 0)));
}

export function classifyCapabilityEvidence(
  candidates: SystemCapability[],
  dataEntities: CASDataEntity[] = [],
  projectTextSignal?: CapabilityCatalogProjectSignal,
  context: CapabilityEvidenceContext = {},
): SystemCapability[] {
  const entityById = new Map(dataEntities.map(entity => [entity.id, entity]));
  const entryPointById = new Map((context.entryPoints || []).map(entryPoint => [entryPoint.id, entryPoint]));
  const nodeById = new Map((context.nodes || []).map(node => [node.id, node]));
  return candidates.map(candidate => {
    let evidenceRole: CapabilityEvidenceRole;
    const reasons: string[] = [];
    if (capabilityIsVerificationHarness(candidate, entryPointById, nodeById)) {
      evidenceRole = 'verification-harness';
      reasons.push('all-resolved-operation-anchors-are-test-or-scaffold');
    } else if ((candidate.evidence_kind === 'behavior-surface' && candidate.category !== 'core') || candidate.category === 'internal') {
      const firstParty = productTextCorroboratesCapability(candidate, projectTextSignal);
      evidenceRole = 'supporting-mechanism';
      reasons.push(firstParty
        ? 'first-party-product-delivery-surface-supports-outcome'
        : 'delivery-surface-is-evidence-not-product-outcome');
    } else {
      const firstParty = productTextCorroboratesCapability(candidate, projectTextSignal);
      const externalReach = capabilityHasExternalReach(candidate, entryPointById);
      const productEntity = candidateHasProductEntity(candidate, entityById, projectTextSignal);
      const userOutcomeJourney = capabilityHasUserOutcomeJourney(candidate, context.userJourneys || []);
      const firstPartyCoreOutcome = firstParty && candidate.category === 'core';
      if (firstPartyCoreOutcome || userOutcomeJourney || (externalReach && productEntity)) {
        evidenceRole = 'product-outcome';
        if (firstPartyCoreOutcome) reasons.push('first-party-product-text');
        if (userOutcomeJourney) reasons.push('user-facing-terminal-journey');
        if (externalReach && productEntity) reasons.push('external-reach-with-product-entity');
      } else if ((candidate.operations || []).length > 0 || (candidate.related_entities || []).length > 0) {
        const potentiallyProductSignificant = productEntity || (externalReach && capabilityHasPotentialUserSurface(candidate));
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

export function catalogRequiredEvidenceCandidates(candidates: SystemCapability[]): SystemCapability[] {
  return candidates.filter(capabilityRequiresCatalogCoverage);
}

export function capabilityRequiresCatalogCoverage(candidate: SystemCapability): boolean {
  return candidate.evidence_role === 'product-outcome';
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
  const required = citedCandidates.some(candidate => candidate.evidence_role === 'product-outcome');
  if (required) return undefined;
  const firstPartyDeliveryEvidence = citedCandidates.some(candidate =>
    candidate.evidence_kind === 'behavior-surface' && candidate.evidence_role === 'supporting-mechanism'
  );
  return firstPartyDeliveryEvidence && hasFirstPartyCorroboratedCatalogOperations(capability, candidates, signal)
    ? undefined
    : 'supporting-or-verification-evidence-only';
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
  const parent = eligible.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const entityOwners = new Map<string, number>();
  eligible.forEach((candidate, index) => {
    for (const entityId of candidate.related_entities || []) {
      const owner = entityOwners.get(entityId);
      if (owner === undefined) entityOwners.set(entityId, index);
      else union(owner, index);
    }
  });
  const groups = new Map<number, string[]>();
  eligible.forEach((candidate, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(candidate.id);
    else groups.set(root, [candidate.id]);
  });
  return [...groups.values()]
    .map(group => group.sort())
    .sort((left, right) => left[0].localeCompare(right[0]));
}

export function catalogPromptEntities(
  dataEntities: CASDataEntity[],
  candidates: SystemCapability[],
  limit = 18,
): CapabilityCatalogEntityFact[] {
  const candidateEntityIds = new Set(candidates.flatMap(candidate => candidate.related_entities || []));
  return dataEntities
    .filter(entity => entity.kind === 'persisted-entity' || entity.kind === 'api-response' || candidateEntityIds.has(entity.id))
    .sort((left, right) => (right.fields?.length || 0) - (left.fields?.length || 0) || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map(entity => ({ name: entity.name, fields: (entity.fields || []).slice(0, 6).map(field => field.name) }));
}

export function catalogCandidateEntityFacts(
  candidate: SystemCapability,
  entityById: Map<string, CASDataEntity>,
): CapabilityCatalogEntityFact[] {
  return (candidate.related_entities || []).map(id => {
    const entity = entityById.get(id);
    return { name: entity?.name || id, fields: (entity?.fields || []).slice(0, 8).map(field => field.name) };
  });
}

export function catalogEvidenceCoverageFailure(
  reconciled: readonly SystemCapability[],
  requiredBehaviorCandidateIds: readonly string[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
): string | undefined {
  const citedCandidateIds = new Set(reconciled.flatMap(capability => (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:'))
    .map(factor => factor.slice('catalog-candidate:'.length))));
  const omittedBehaviorCandidateIds = requiredBehaviorCandidateIds.filter(candidateId => !citedCandidateIds.has(candidateId));
  if (omittedBehaviorCandidateIds.length > 0) {
    return `catalog omitted ${omittedBehaviorCandidateIds.length} behavior evidence famil${omittedBehaviorCandidateIds.length === 1 ? 'y' : 'ies'}: ${omittedBehaviorCandidateIds.slice(0, 8).join(', ')}`;
  }
  const omittedEntityGroups = requiredEntityCandidateGroups.filter(group => !group.some(candidateId => citedCandidateIds.has(candidateId)));
  if (omittedEntityGroups.length > 0) {
    return `catalog omitted ${omittedEntityGroups.length} product-entity evidence famil${omittedEntityGroups.length === 1 ? 'y' : 'ies'}: ${omittedEntityGroups.slice(0, 8).map(group => group.join('|')).join(', ')}`;
  }
  return undefined;
}

export function catalogCountBounds(
  distinctFamilyCount: number,
  behaviorFamilyCount: number,
  entityFamilyCount: number,
  requiredOutcomeCount = 0,
): { min: number; max: number } {
  const max = Math.max(1, Math.min(20, Math.max(
    distinctFamilyCount,
    behaviorFamilyCount,
    entityFamilyCount,
    requiredOutcomeCount,
  )));
  const min = Math.min(max, catalogMinimumCapabilityCount(
    distinctFamilyCount,
    entityFamilyCount,
    requiredOutcomeCount,
  ));
  return { min, max };
}

export function catalogMinimumCapabilityCount(
  distinctFamilyCount: number,
  entityFamilyCount: number,
  requiredOutcomeCount = 0,
): number {
  return Math.max(
    requiredOutcomeCount,
    Math.ceil(Math.log2(distinctFamilyCount + 1)),
    Math.ceil(Math.log2(entityFamilyCount + 1)),
  );
}

export function catalogRelatedEntityIds(
  authoredEntityIds: string[],
  candidateEntityIds: Iterable<string>,
): string[] {
  return [...new Set(authoredEntityIds.length > 0 ? authoredEntityIds : [...candidateEntityIds])];
}

export function firstPartySupportsIdentityProduct(signal?: CapabilityCatalogProjectSignal): boolean {
  if (!signal) return false;
  const text = [signal.productDocTitle, signal.productDocSummary, signal.manifestDescription, signal.summary]
    .filter(Boolean)
    .join(' ');
  const identity = '(?:identity|authentication|authorization|access[ -]?control)';
  const product = '(?:platform|service|provider|product|system|server|gateway)';
  return new RegExp(`\\b${identity}\\b[^.]{0,60}\\b${product}\\b|\\b${product}\\b[^.]{0,60}\\b${identity}\\b`, 'i').test(text) ||
    new RegExp(`\\b(?:provides?|delivers?|offers?|sells?|issues?|verifies?|authenticates?|authorizes?)\\b[^.]{0,60}\\b${identity}\\b`, 'i').test(text);
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
  return classifyCapabilityEvidence(result, dataEntities || [], projectTextSignal, context);
}
