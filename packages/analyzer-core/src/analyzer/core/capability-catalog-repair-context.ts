import type { SystemCapability } from '../../types/cas.types';
import { canonicalCapabilityCatalogOutcomeToken, type CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';
import type { CapabilityCatalogPriorRejection } from './capability-catalog-scheduling';

export interface CapabilityCatalogRepairPromptFact {
  candidate_id: string;
  first_party_outcomes: string[];
  observable_actions: string[];
  prior_rejections: Array<{
    forbidden_subject_terms?: string[];
    missing_audience?: string;
    missing_subject_terms?: string[];
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
    first_party_outcomes: boundedArray(fact.first_party_outcomes, 4, 800),
    observable_actions: boundedArray(fact.observable_actions, required ? 6 : 8, 160),
    required_audience_labels: boundedArray(fact.required_audience_labels, 4, 80),
    required_subject_terms: boundedArray(fact.required_subject_terms, 16, 80),
    required_visible_actions: boundedArray(fact.required_visible_actions, 8, 80),
    minimum_subject_matches: Math.max(0, Math.min(16, Number(fact.minimum_subject_matches) || 0)),
    prior_rejections: (Array.isArray(fact.prior_rejections) ? fact.prior_rejections : []).slice(-4).map(value => {
      const rejection = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return {
        reason: bounded(rejection.reason, 180), requirement_id: bounded(rejection.requirement_id, 240),
        forbidden_subject_terms: boundedArray(rejection.forbidden_subject_terms, 12, 120),
        missing_audience: bounded(rejection.missing_audience, 80),
        missing_subject_terms: boundedArray(rejection.missing_subject_terms, 16, 80),
      };
    }),
  };
}

export function shrinkCapabilityCatalogRepairPromptToBudget(
  base: Record<string, unknown>, facts: Record<string, unknown>, maxBytes: number, measure: () => number,
): void {
  const candidates = Array.isArray(facts.candidate_route_areas) ? facts.candidate_route_areas as Record<string, unknown>[] : [];
  const removeLargest = (key: 'prior_rejections' | 'observable_actions' | 'first_party_outcomes'): boolean => {
    const target = candidates.filter(candidate => Array.isArray(candidate[key]) && (candidate[key] as unknown[]).length > 0)
      .sort((left, right) => JSON.stringify(right[key]).length - JSON.stringify(left[key]).length)[0];
    if (!target) return false;
    (target[key] as unknown[]).pop();
    return true;
  };
  for (const key of ['prior_rejections', 'observable_actions', 'first_party_outcomes'] as const) {
    while (measure() > maxBytes && removeLargest(key)) {
      if (measure() <= maxBytes) break;
    }
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
): CapabilityCatalogRepairPromptFact[] {
  const repairIds = new Set(repairCandidateIds);
  const scopedRequirementIds = new Set(requirements.map(requirement => requirement.id));
  return candidates.filter(candidate => repairIds.has(candidate.id)).map(candidate => {
    const candidateRequirements = requirements.filter(requirement => requirement.candidateIds.includes(candidate.id));
    const groundedTerms = new Set(candidateRequirements.flatMap(requirement => [
      requirement.firstPartyOutcomeText || '', ...(requirement.requiredSubjectTerms || requirement.subjectTokens),
    ]).flatMap(value => String(value).toLowerCase().split(/[^a-z0-9]+/)).filter(word => word.length >= 3));
    const internalPhrases = [candidate.name, candidate.structural_label, ...(candidate.evidence_examples || []),
      ...(candidate.related_entities || []).map(entityId => entityNamesById.get(entityId) || entityId)]
      .map(value => String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_:/.-]+/g, ' ').toLowerCase().trim())
      .filter(value => value.split(/\s+/).length >= 2);
    const safeOperation = (value: unknown): string[] => {
      const phrase = customerVisibleOperationPhrase(value, groundedTerms);
      return phrase && !internalPhrases.some(internal => phrase.includes(internal) || internal.includes(phrase)) ? [phrase] : [];
    };
    return {
      candidate_id: candidate.id,
      first_party_outcomes: [...new Set(candidateRequirements.map(requirement =>
        String(requirement.firstPartyOutcomeText || '').trim()).filter(Boolean))].slice(0, 4),
      observable_actions: [...new Set((candidate.operations || []).flatMap(operation => [
        ...safeOperation(operation.action),
      ]))].slice(0, 8),
      required_audience_labels: [...new Set(candidateRequirements.map(requirement =>
        String(requirement.audienceLabel || requirement.audience || '').trim()).filter(Boolean))],
      required_subject_terms: [...new Set(candidateRequirements.flatMap(requirement =>
        requirement.requiredSubjectTerms || requirement.subjectTokens))].slice(0, 16),
      required_visible_actions: [...new Set(candidateRequirements.flatMap(requirement => requirement.visibleActionTerms || []))].slice(0, 8),
      minimum_subject_matches: candidateRequirements.reduce((minimum, requirement) => Math.max(minimum,
        requirement.minimumSubjectMatches ?? Math.min(2, requirement.subjectTokens.length)), 0),
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
          ...(rejection.missing_subject_terms?.length ? { missing_subject_terms: rejection.missing_subject_terms.slice(0, 16) } : {}),
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
): { facts: CapabilityCatalogRepairPromptFact[]; candidateMap: Record<string, string> } {
  const aliases = new Map(repairCandidateIds.map((candidateId, index) => [candidateId, `candidate_${index + 1}`]));
  return {
    facts: capabilityCatalogRepairPromptFacts(candidates, repairCandidateIds, requirements, rejectionsByCandidate, entityNamesById)
      .map(fact => ({ ...fact, candidate_id: aliases.get(fact.candidate_id) || '' })),
    candidateMap: Object.fromEntries([...aliases].map(([rawId, opaqueId]) => [opaqueId, rawId])),
  };
}

export function capabilityCatalogFirstPartyFallback(requirement?: CapabilityCatalogOutcomeRequirement): Record<string, unknown> | undefined {
  const description = String(requirement?.firstPartyOutcomeText || '').trim();
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
  };
}
