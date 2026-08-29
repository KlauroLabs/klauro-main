import type { SystemCapability } from '../../types/cas.types';
import { capabilityEvidenceSubjectTokens } from './capability-catalog-evidence';
import { canonicalCapabilityLifecycleAction } from './capability-lifecycle-actions';
import { canonicalCapabilityCatalogOutcomeToken, capabilityCatalogTargetedOutcomeText, type CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';
import type { CapabilityCatalogPriorRejection } from './capability-catalog-scheduling';

export interface CapabilityCatalogRepairPromptFact {
  candidate_id: string;
  stable_capability_name?: string;
  first_party_outcomes: string[];
  observable_actions: string[];
  prior_rejections: Array<{
    forbidden_subject_terms?: string[];
    missing_audience?: string;
    missing_audience_locations?: string[];
    missing_subject_terms?: string[];
    opposite_audience_labels?: string[];
    opposite_audience_locations?: string[];
    reason: string;
    requirement_id?: string;
  }>;
  required_audience_labels: string[];
  required_subject_terms: string[];
  required_visible_actions: string[];
  minimum_subject_matches: number;
}

const bounded = (value: unknown, length: number): string => String(value || '').trim().slice(0, length);
const boundedArray = (value: unknown, limit: number, length: number): string[] => Array.isArray(value)
  ? value.map(item => bounded(item, length)).filter(Boolean).slice(0, limit) : [];

export function compactCapabilityCatalogRepairPromptFact(value: unknown, required: boolean): Record<string, unknown> | undefined {
  const fact = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (!('first_party_outcomes' in fact || 'observable_actions' in fact || 'required_subject_terms' in fact)) return undefined;
  return {
    candidate_id: bounded(fact.candidate_id, 180),
    ...(bounded(fact.stable_capability_name, 180) ? { stable_capability_name: bounded(fact.stable_capability_name, 180) } : {}),
    first_party_outcomes: boundedArray(fact.first_party_outcomes, 4, 800),
    observable_actions: boundedArray(fact.observable_actions, required ? 6 : 8, 160),
    required_audience_labels: boundedArray(fact.required_audience_labels, 4, 80),
    required_subject_terms: boundedArray(fact.required_subject_terms, 16, 80),
    required_visible_actions: boundedArray(fact.required_visible_actions, 8, 80),
    minimum_subject_matches: Math.max(0, Math.min(16, Number(fact.minimum_subject_matches) || 0)),
    prior_rejections: (Array.isArray(fact.prior_rejections) ? fact.prior_rejections : []).slice(-4).map(value => {
      const rejection = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const missingAudienceLocations = boundedArray(rejection.missing_audience_locations, 2, 20);
      const oppositeAudienceLabels = boundedArray(rejection.opposite_audience_labels, 4, 80);
      const oppositeAudienceLocations = boundedArray(rejection.opposite_audience_locations, 2, 20);
      return {
        reason: bounded(rejection.reason, 180), requirement_id: bounded(rejection.requirement_id, 240),
        forbidden_subject_terms: boundedArray(rejection.forbidden_subject_terms, 12, 120),
        missing_audience: bounded(rejection.missing_audience, 80),
        ...(missingAudienceLocations.length ? { missing_audience_locations: missingAudienceLocations } : {}),
        missing_subject_terms: boundedArray(rejection.missing_subject_terms, 16, 80),
        ...(oppositeAudienceLabels.length ? { opposite_audience_labels: oppositeAudienceLabels } : {}),
        ...(oppositeAudienceLocations.length ? { opposite_audience_locations: oppositeAudienceLocations } : {}),
      };
    }),
  };
}

export function shrinkCapabilityCatalogRepairPromptToBudget(
  base: Record<string, unknown>, facts: Record<string, unknown>, maxBytes: number, measure: () => number,
): void {
  const candidates = Array.isArray(facts.candidate_route_areas) ? facts.candidate_route_areas as Record<string, unknown>[] : [];
  const isAudienceCorrection = (rejection: Record<string, unknown>): boolean => Boolean(String(rejection.missing_audience || '').trim()) ||
    [rejection.missing_audience_locations, rejection.opposite_audience_labels, rejection.opposite_audience_locations]
      .some(value => Array.isArray(value) && value.length > 0);
  const removeLargest = (key: 'prior_rejections' | 'observable_actions' | 'first_party_outcomes'): boolean => {
    const removable = candidates.flatMap(candidate => {
      const values = Array.isArray(candidate[key]) ? candidate[key] as unknown[] : [];
      let protectedIndex = -1;
      if (key === 'prior_rejections') values.forEach((value, index) => {
        const rejection = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        if (isAudienceCorrection(rejection)) protectedIndex = index;
      });
      return values.flatMap((value, index) => index === protectedIndex ? [] : [{ candidate, index, size: JSON.stringify(value).length }]);
    }).sort((left, right) => right.size - left.size);
    const target = removable[0];
    if (!target) return false;
    (target.candidate[key] as unknown[]).splice(target.index, 1);
    return true;
  };
  for (const key of ['prior_rejections', 'observable_actions', 'first_party_outcomes'] as const) {
    while (measure() > maxBytes && removeLargest(key)) {
      if (measure() <= maxBytes) break;
    }
  }
  for (const removableField of ['forbidden_subject_terms', 'missing_subject_terms'] as const) {
    for (const candidate of candidates) {
      if (measure() <= maxBytes) break;
      const rejections = Array.isArray(candidate.prior_rejections) ? candidate.prior_rejections as Record<string, unknown>[] : [];
      const protectedRejection = [...rejections].reverse().find(isAudienceCorrection);
      if (protectedRejection) delete protectedRejection[removableField];
    }
  }
  for (const candidate of candidates) {
    if (measure() <= maxBytes) break;
    const rejections = Array.isArray(candidate.prior_rejections) ? candidate.prior_rejections as Record<string, unknown>[] : [];
    const protectedRejection = [...rejections].reverse().find(isAudienceCorrection);
    if (protectedRejection) protectedRejection.reason = bounded(protectedRejection.reason, 48);
  }
  for (const [key, limit] of [['retry_hint', 800], ['style', 800], ['task', 3200]] as const) {
    if (measure() <= maxBytes || !base[key]) continue;
    base[key] = bounded(base[key], limit);
  }
  const requirements = Array.isArray(facts.required_outcomes) ? facts.required_outcomes as Record<string, unknown>[] : [];
  for (const limit of [600, 320, 160]) {
    if (measure() <= maxBytes) break;
    for (const requirement of requirements) {
      if (requirement.first_party_outcome_text) requirement.first_party_outcome_text = bounded(requirement.first_party_outcome_text, limit);
      requirement.outcome = bounded(requirement.outcome, Math.min(limit, 240));
    }
  }
}

function customerVisibleOperationPhrase(value: unknown, groundedTerms: ReadonlySet<string>): string | undefined {
  const source = String(value || '').trim();
  if (!source || !/^[A-Za-z][A-Za-z0-9 ]+$/.test(source) || /(?:[a-z0-9][A-Z]|[A-Z]{2,}[a-z]|\b[A-Z]{2,}\b)/.test(source)) return undefined;
  const words = source.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3 && !/^(?:api|cmd|command|endpoint|handler|mcp|route|rpc|tool)$/.test(word));
  const directlyObservedLifecycleActions = new Set([
    'add', 'archive', 'authenticate', 'create', 'delete', 'edit', 'favorite', 'follow', 'list',
    'publish', 'read', 'remove', 'retrieve', 'unfavorite', 'unfollow', 'update', 'view',
  ]);
  if (words.length === 1 && directlyObservedLifecycleActions.has(words[0])) {
    return words[0];
  }
  return words.length >= 2 && words.every(word => groundedTerms.has(word)) ? words.slice(0, 8).join(' ') : undefined;
}

function customerSafeRepairReason(value: unknown): string {
  return String(value || 'rejected').toLowerCase().split(':', 1)[0].replace(/[^a-z0-9-]+/g, '-').slice(0, 120);
}

function customerSafeForbiddenSubjectTerms(values: readonly string[]): string[] {
  return values.filter(value => {
    const source = String(value || '').trim();
    return source.length > 0 && /^[A-Za-z][A-Za-z ]+$/.test(source) &&
      !/(?:[a-z0-9][A-Z]|[A-Z]{2,}[a-z]|\b[A-Z]{2,}\b)/.test(source);
  }).slice(0, 12);
}

export function capabilityCatalogRepairPromptFacts(
  candidates: readonly SystemCapability[], repairCandidateIds: readonly string[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  rejectionsByCandidate: ReadonlyMap<string, CapabilityCatalogPriorRejection[]> = new Map(),
  entityNamesById: ReadonlyMap<string, string> = new Map(),
  firstPartyTexts: readonly string[] = [],
): CapabilityCatalogRepairPromptFact[] {
  const repairIds = new Set(repairCandidateIds);
  const scopedRequirementIds = new Set(requirements.map(requirement => requirement.id));
  return candidates.filter(candidate => repairIds.has(candidate.id)).map(candidate => {
    const candidateRequirements = requirements.filter(requirement => requirement.candidateIds.includes(candidate.id));
    const groundedTerms = new Set(candidateRequirements.flatMap(requirement => [
      capabilityCatalogTargetedOutcomeText(requirement) || '', ...(requirement.requiredSubjectTerms || requirement.subjectTokens),
    ]).flatMap(value => String(value).toLowerCase().split(/[^a-z0-9]+/)).filter(word => word.length >= 3));
    const internalPhrases = [candidate.name, candidate.structural_label, ...(candidate.evidence_examples || []),
      ...(candidate.related_entities || []).map(entityId => entityNamesById.get(entityId) || entityId)]
      .map(value => String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_:/.-]+/g, ' ').toLowerCase().trim())
      .filter(value => value.split(/\s+/).length >= 2);
    const evidenceTokens = new Set([
      candidate.name,
      candidate.structural_label,
      ...(candidate.evidence_examples || []),
      ...(candidate.related_entities || []).map(entityId => entityNamesById.get(entityId) || ''),
      ...(candidate.operations || []).flatMap(operation => [operation.action, operation.path_or_command]),
    ].flatMap(value => String(value || '').toLowerCase().split(/[^a-z0-9]+/))
      .filter(token => token.length >= 3)
      .map(canonicalCapabilityCatalogOutcomeToken));
    const genericEvidenceTerms = new Set([
      'access', 'action', 'add', 'bar', 'card', 'change', 'click', 'close', 'create', 'delete', 'edit', 'event',
      'get', 'handle', 'head', 'list', 'manage', 'management', 'modal', 'open', 'options', 'patch', 'post',
      'process', 'put', 'read', 'remove', 'retrieve', 'show', 'submit', 'update', 'user', 'view',
    ]);
    const exactCandidateSubject = canonicalCapabilityCatalogOutcomeToken(String(candidate.name || '').trim().toLowerCase());
    const candidateNameIsCustomerVisible = !/(?:[a-z0-9][A-Z]|[A-Z]{2,}[a-z]|[_:/])/.test(candidate.name || '');
    const routeNameHasRecoverableProductTerms = candidate.evidence_kind === 'behavior-surface' &&
      /\/[A-Za-z]/.test(candidate.name || '');
    const evidenceSubjectTerms = candidateNameIsCustomerVisible || routeNameHasRecoverableProductTerms
      ? capabilityEvidenceSubjectTokens(candidate, (candidate.related_entities || []).map(entityId => entityNamesById.get(entityId) || ''))
        .map(canonicalCapabilityCatalogOutcomeToken)
        .filter(token => token.length >= 3 && (!genericEvidenceTerms.has(token) || (token === 'user' && exactCandidateSubject === 'user')))
        .slice(0, 8)
      : [];
    const requiredSubjectTerms = candidateRequirements.length > 0
      ? [...new Set(candidateRequirements.flatMap(requirement => requirement.requiredSubjectTerms || requirement.subjectTokens))].slice(0, 16)
      : [...new Set(evidenceSubjectTerms)];
    if (candidateRequirements.length === 0) requiredSubjectTerms.forEach(term => groundedTerms.add(term));
    const scopedFirstPartyOutcomes = firstPartyTexts
      .flatMap(value => String(value || '').split(/(?<=[.!?])\s+|[\r\n]+/))
      .map(value => value.trim())
      .filter(value => value.length >= 8 && value.toLowerCase().split(/[^a-z0-9]+/)
        .some(token => token.length >= 3 && evidenceTokens.has(canonicalCapabilityCatalogOutcomeToken(token))))
      .map(value => value.slice(0, 500));
    const safeOperation = (value: unknown): string[] => {
      const phrase = customerVisibleOperationPhrase(value, groundedTerms);
      return phrase && !internalPhrases.some(internal => phrase.includes(internal) || internal.includes(phrase)) ? [phrase] : [];
    };
    return {
      candidate_id: candidate.id,
      first_party_outcomes: [...new Set([
        ...candidateRequirements.map(requirement => String(capabilityCatalogTargetedOutcomeText(requirement) || '').trim()),
        ...scopedFirstPartyOutcomes,
      ].filter(Boolean))].slice(0, 4),
      observable_actions: [...new Set((candidate.operations || []).flatMap(operation => [
        ...safeOperation(canonicalCapabilityLifecycleAction(operation)),
      ]))].slice(0, 8),
      required_audience_labels: [...new Set(candidateRequirements.map(requirement =>
        String(requirement.audienceLabel || requirement.audience || '').trim()).filter(Boolean))],
      required_subject_terms: requiredSubjectTerms,
      required_visible_actions: [...new Set(candidateRequirements.flatMap(requirement => requirement.visibleActionTerms || []))].slice(0, 8),
      minimum_subject_matches: candidateRequirements.reduce((minimum, requirement) => Math.max(minimum,
        requirement.minimumSubjectMatches ?? Math.min(2, requirement.subjectTokens.length)), Math.min(2, requiredSubjectTerms.length)),
      prior_rejections: (rejectionsByCandidate.get(candidate.id) || [])
        .filter(rejection => scopedRequirementIds.size > 0
          ? Boolean(rejection.requirement_id && scopedRequirementIds.has(rejection.requirement_id))
          : !rejection.requirement_id)
        .slice(-4)
        .map(rejection => {
          const forbiddenSubjectTerms = customerSafeForbiddenSubjectTerms(rejection.forbidden_subject_terms);
          return {
          reason: customerSafeRepairReason(rejection.reason),
          ...(forbiddenSubjectTerms.length ? { forbidden_subject_terms: forbiddenSubjectTerms } : {}),
          ...(rejection.missing_audience ? { missing_audience: rejection.missing_audience } : {}),
          ...(rejection.missing_audience_locations?.length ? { missing_audience_locations: rejection.missing_audience_locations } : {}),
          ...(rejection.missing_subject_terms?.length ? { missing_subject_terms: rejection.missing_subject_terms.slice(0, 16) } : {}),
          ...(rejection.opposite_audience_labels?.length ? { opposite_audience_labels: rejection.opposite_audience_labels } : {}),
          ...(rejection.opposite_audience_locations?.length ? { opposite_audience_locations: rejection.opposite_audience_locations } : {}),
          ...(rejection.requirement_id ? { requirement_id: rejection.requirement_id } : {}),
        };
        }),
    };
  });
}

export function capabilityCatalogRepairPromptEnvelope(
  candidates: readonly SystemCapability[], repairCandidateIds: readonly string[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  rejectionsByCandidate: ReadonlyMap<string, CapabilityCatalogPriorRejection[]> = new Map(),
  entityNamesById: ReadonlyMap<string, string> = new Map(),
  firstPartyTexts: readonly string[] = [],
  stableCapabilityName?: string,
): { facts: CapabilityCatalogRepairPromptFact[]; candidateMap: Record<string, string> } {
  const aliases = new Map(repairCandidateIds.map((candidateId, index) => [candidateId, `candidate_${index + 1}`]));
  return {
    facts: capabilityCatalogRepairPromptFacts(candidates, repairCandidateIds, requirements, rejectionsByCandidate, entityNamesById, firstPartyTexts)
      .map(fact => ({
        ...fact,
        candidate_id: aliases.get(fact.candidate_id) || '',
        ...(stableCapabilityName ? { stable_capability_name: stableCapabilityName } : {}),
      })),
    candidateMap: Object.fromEntries([...aliases].map(([rawId, opaqueId]) => [opaqueId, rawId])),
  };
}

export function capabilityCatalogFirstPartyFallback(requirement?: CapabilityCatalogOutcomeRequirement): Record<string, unknown> | undefined {
  const description = requirement ? String(capabilityCatalogTargetedOutcomeText(requirement) || '').trim() : '';
  const actions = [...new Set((requirement?.visibleActionTerms || []).filter(Boolean))];
  if (!requirement || !description || actions.length !== 1) return undefined;
  const words = description.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const action = actions[0];
  const actionIndex = words.findIndex(word => canonicalCapabilityCatalogOutcomeToken(word) === canonicalCapabilityCatalogOutcomeToken(action));
  if (actionIndex < 0) return undefined;
  const clause = words.slice(actionIndex).join(' ');
  const audience = requirement.audienceLabel || requirement.audience || '';
  const audiencePattern = requirement.audience === 'human' ? /\b(?:humans?|people|persons?|users?)\b/i : requirement.audience === 'agent' ? /\b(?:agents?|assistants?)\b/i : undefined;
  const baseName = `${action.charAt(0).toUpperCase()}${action.slice(1)}${clause.slice(words[actionIndex].length)}`.trim();
  const name = audience && !audiencePattern?.test(baseName) ? `${baseName} for ${audience}` : baseName;
  return {
    requirement_id: requirement.id, name, description,
    category: 'core', candidate_ids: requirement.candidateIds,
    catalog_source: 'deterministic',
  };
}

export function capabilityCatalogEvidenceFallback(
  fact: CapabilityCatalogRepairPromptFact | undefined,
  candidateId: string | undefined,
  candidate: SystemCapability | undefined,
): Record<string, unknown> | undefined {
  if (!fact || !candidateId || !candidate || fact.minimum_subject_matches <= 0) return undefined;
  const requiredTerms = [...new Set((fact.required_subject_terms || [])
    .map(term => canonicalCapabilityCatalogOutcomeToken(term))
    .filter(term => /^[a-z][a-z0-9-]*$/.test(term)))];
  if (requiredTerms.length < fact.minimum_subject_matches) return undefined;

  const methods = new Set((candidate.operations || [])
    .map(operation => String(operation.trigger?.method || '').toUpperCase())
    .filter(Boolean));
  const actions = new Set((candidate.operations || [])
    .flatMap(operation => [operation.action, operation.path_or_command])
    .flatMap(value => String(value || '').toLowerCase().split(/[^a-z0-9]+/))
    .filter(Boolean));
  const canRead = [...methods].some(method => /^(?:GET|HEAD|OPTIONS)$/.test(method)) ||
    ['access', 'get', 'list', 'read', 'retrieve', 'show', 'view'].some(action => actions.has(action));
  const hasMutation = [...methods].some(method => /^(?:POST|PUT|PATCH|DELETE)$/.test(method)) ||
    ['add', 'create', 'delete', 'edit', 'remove', 'submit', 'update'].some(action => actions.has(action));
  const explicitlyNamedReadSurface = candidate.evidence_kind === 'behavior-surface' &&
    /^(?:get|list|read|retrieve|show|view)\b/i.test(String(candidate.name || '').trim()) &&
    [...methods].some(method => /^(?:GET|HEAD|OPTIONS)$/.test(method));
  if (!canRead || (hasMutation && !explicitlyNamedReadSurface)) return undefined;

  const titleCase = (term: string) => term.split('-')
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : '')
    .join(' ');
  const candidateWords = String(candidate.name || '').toLowerCase().match(/[a-z][a-z0-9-]*/g) || [];
  const userScoped = candidateWords.some(word => canonicalCapabilityCatalogOutcomeToken(word) === 'user');
  if (!userScoped) return undefined;
  const displayTerms = requiredTerms.map(term => {
    const matches = candidateWords.filter(word => canonicalCapabilityCatalogOutcomeToken(word) === term);
    return matches.find(word => /s$/i.test(word) && !/ss$/i.test(word)) || matches[0] || term;
  });
  const subject = displayTerms.map(titleCase).join(' ');
  const finalDisplayTerm = displayTerms[displayTerms.length - 1] || '';
  const plural = /s$/i.test(finalDisplayTerm) && !/ss$/i.test(finalDisplayTerm);
  return {
    name: `View ${subject}`,
    description: `${subject} ${plural ? 'are' : 'is'} available to be viewed for a specific user.`,
    category: 'core',
    candidate_ids: [candidateId],
    catalog_source: 'deterministic',
  };
}
