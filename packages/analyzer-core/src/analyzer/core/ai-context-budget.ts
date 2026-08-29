import { compactCapabilityCatalogRepairPromptFact, shrinkCapabilityCatalogRepairPromptToBudget } from './capability-catalog-repair-context';

const DEFAULT_INPUT_TOKEN_BUDGET = 8000;
const DEFAULT_BYTES_PER_TOKEN = 3;
const PROMPT_ENVELOPE_BYTES = 2000;

export interface ContextBudgetResult<T extends Record<string, unknown>> {
  context: T;
  byteLength: number;
  inputTokenBudget: number;
  omittedCandidateIds: string[];
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function resolveAIInputTokenBudget(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(4096, positiveInteger(env.KLAURO_AI_INPUT_TOKEN_BUDGET)
    ?? positiveInteger(env.AI_MAX_CONTEXT_LENGTH)
    ?? DEFAULT_INPUT_TOKEN_BUDGET);
}

export function resolveAIInputByteBudget(env: NodeJS.ProcessEnv = process.env): number {
  const tokenBudget = resolveAIInputTokenBudget(env);
  const bytesPerToken = positiveInteger(env.KLAURO_AI_BYTES_PER_TOKEN) ?? DEFAULT_BYTES_PER_TOKEN;
  return Math.max(4096, tokenBudget * bytesPerToken - PROMPT_ENVELOPE_BYTES);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function boundedText(value: unknown, maxLength: number): string {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  const prefix = text.slice(0, maxLength);
  const boundary = prefix.lastIndexOf(' ');
  return `${prefix.slice(0, boundary >= Math.floor(maxLength * 0.6) ? boundary : maxLength).trim()}…`;
}

function boundedTextArray(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => boundedText(item, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

function compactCandidate(value: unknown, required: boolean): Record<string, unknown> {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const repairFact = compactCapabilityCatalogRepairPromptFact(candidate, required);
  if (repairFact) return repairFact;
  return {
    candidate_id: boundedText(candidate.candidate_id, 180),
    family: boundedText(candidate.family, required ? 120 : 180),
    operations: boundedTextArray(candidate.operations, required ? 3 : 6, required ? 120 : 240),
    name: boundedText(candidate.name, required ? 320 : 900),
    entry_points: candidate.entry_points,
    entities: candidate.entities,
    entity_names: boundedTextArray(candidate.entity_names, required ? 4 : 8, required ? 100 : 160),
    terminality: candidate.terminality,
    distance_to_terminal: candidate.distance_to_terminal,
  };
}

function compactJourney(value: unknown): Record<string, unknown> {
  const journey = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    name: boundedText(journey.name, 240),
    writes: boundedTextArray(journey.writes, 3, 160),
    terminal: boundedTextArray(journey.terminal, 3, 160),
  };
}

function compactEntity(value: unknown): Record<string, unknown> {
  const entity = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    name: boundedText(entity.name, 180),
    fields: boundedTextArray(entity.fields, 6, 120),
  };
}

function compactTopDownSignals(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const signals = value as Record<string, unknown>;
  const compacted: Record<string, unknown> = {};
  if (signals.product_title) compacted.product_title = boundedText(signals.product_title, 240);
  if (signals.product_overview) compacted.product_overview = boundedText(signals.product_overview, 1600);
  if (signals.product_self_description) compacted.product_self_description = boundedText(signals.product_self_description, 800);
  if (signals.inferred_product_description) compacted.inferred_product_description = boundedText(signals.inferred_product_description, 800);
  const scopedProductContext = boundedTextArray(signals.scoped_product_context, 4, 500);
  if (scopedProductContext.length > 0) compacted.scoped_product_context = scopedProductContext;
  const terminology = boundedTextArray(signals.product_terminology, 20, 180);
  if (terminology.length > 0) compacted.product_terminology = terminology;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

export function fitCapabilityCatalogContext<T extends Record<string, unknown>>(
  contextWithoutFacts: T,
  facts: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): ContextBudgetResult<T & { facts: Record<string, unknown> }> {
  const maxBytes = resolveAIInputByteBudget(env);
  const compactBase = {
    ...contextWithoutFacts,
    ...(contextWithoutFacts.retry_hint ? { retry_hint: boundedText(contextWithoutFacts.retry_hint, 3200) } : {}),
    ...(contextWithoutFacts.task ? { task: boundedText(contextWithoutFacts.task, 8000) } : {}),
    ...(contextWithoutFacts.style ? { style: boundedText(contextWithoutFacts.style, 2400) } : {}),
  } as T;
  const candidateValues = Array.isArray(facts.candidate_route_areas) ? facts.candidate_route_areas : [];
  const candidateIds = candidateValues.map(candidate => boundedText(
    candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>).candidate_id : '',
    180,
  ));
  const candidateIdSet = new Set(candidateIds);
  const requiredBehaviorIds = boundedTextArray(facts.required_behavior_candidate_ids, candidateValues.length, 180)
    .filter(candidateId => candidateIdSet.has(candidateId));
  const rawRequiredEntityGroups = Array.isArray(facts.required_entity_candidate_groups)
    ? facts.required_entity_candidate_groups
    : [];
  const requiredEntityGroups = rawRequiredEntityGroups
    .map(group => boundedTextArray(group, candidateValues.length, 180)
      .filter(candidateId => candidateIdSet.has(candidateId))
      .sort((left, right) => candidateIds.indexOf(left) - candidateIds.indexOf(right))
      .slice(0, 1))
    .filter(group => group.length > 0);
  const requiredBehaviorIdSet = new Set(requiredBehaviorIds);
  const targetedRepairIds = candidateValues.flatMap(value => value && typeof value === 'object' &&
    ('first_party_outcomes' in value || 'observable_actions' in value || 'required_subject_terms' in value)
    ? [boundedText((value as Record<string, unknown>).candidate_id, 180)] : []);
  const requiredIds = new Set([...requiredBehaviorIds, ...requiredEntityGroups.flat(), ...targetedRepairIds]);
  const candidates = candidateValues.map(value => {
    const candidateId = boundedText(
      value && typeof value === 'object' ? (value as Record<string, unknown>).candidate_id : '',
      180,
    );
    return compactCandidate(value, requiredIds.has(candidateId));
  });
  const topDownSignals = compactTopDownSignals(facts.top_down_signals);
  const requiredOutcomes = (Array.isArray(facts.required_outcomes) ? facts.required_outcomes : []).slice(0, 16).map(value => {
    const requirement = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return {
      requirement_id: boundedText(requirement.requirement_id, 240),
      audience: boundedText(requirement.audience, 40),
      required_audience_label: boundedText(requirement.required_audience_label, 80),
      required_subject_terms: boundedTextArray(requirement.required_subject_terms, 16, 80),
      required_visible_actions: boundedTextArray(requirement.required_visible_actions, 8, 80),
      minimum_subject_matches: Math.max(0, Math.min(16, Number(requirement.minimum_subject_matches) || 0)),
      outcome: boundedText(requirement.outcome, 400),
      ...(requirement.first_party_outcome_text ? { first_party_outcome_text: boundedText(requirement.first_party_outcome_text, 1200) } : {}),
      candidate_ids: boundedTextArray(requirement.candidate_ids, candidateValues.length, 180).filter(candidateId => candidateIdSet.has(candidateId)),
    };
  });
  const boundedFacts: Record<string, unknown> = {
    user_journeys: (Array.isArray(facts.user_journeys) ? facts.user_journeys : []).slice(0, 12).map(compactJourney),
    entities: (Array.isArray(facts.entities) ? facts.entities : []).slice(0, 18).map(compactEntity),
    candidate_route_areas: [] as Record<string, unknown>[],
    required_behavior_candidate_ids: [] as string[],
    accepted_outcome_names: boundedTextArray(facts.accepted_outcome_names, 12, 180),
    required_outcomes: requiredOutcomes,
    required_entity_candidate_groups: requiredEntityGroups,
    external_services: boundedTextArray(facts.external_services, 12, 180),
    ...(topDownSignals ? { top_down_signals: topDownSignals } : {}),
  };
  const buildContext = (): T & { facts: Record<string, unknown> } => ({
    ...compactBase,
    compactPrompt: true,
    facts: boundedFacts,
  });
  const includedCandidates = boundedFacts.candidate_route_areas as Record<string, unknown>[];
  const includedRequiredIds = boundedFacts.required_behavior_candidate_ids as string[];
  const omittedCandidateIds: string[] = [];
  for (const candidate of candidates) {
    includedCandidates.push(candidate);
    const candidateId = String(candidate.candidate_id || '');
    if (requiredBehaviorIdSet.has(candidateId)) includedRequiredIds.push(candidateId);
    if (byteLength(buildContext()) <= maxBytes) continue;
    if (requiredIds.has(candidateId)) continue;
    includedCandidates.pop();
    omittedCandidateIds.push(candidateId);
  }
  const shrinkableArrays = ['entities', 'user_journeys', 'external_services'] as const;
  while (byteLength(buildContext()) > maxBytes) {
    const key = shrinkableArrays
      .filter(candidateKey => (boundedFacts[candidateKey] as unknown[]).length > 0)
      .sort((left, right) => byteLength(boundedFacts[right]) - byteLength(boundedFacts[left]))[0];
    if (!key) break;
    (boundedFacts[key] as unknown[]).pop();
  }
  while (byteLength(buildContext()) > maxBytes && includedCandidates.some(candidate => !requiredIds.has(String(candidate.candidate_id || '')))) {
    let removableIndex = includedCandidates.length - 1;
    while (removableIndex >= 0 && requiredIds.has(String(includedCandidates[removableIndex].candidate_id || ''))) {
      removableIndex--;
    }
    const [removed] = includedCandidates.splice(removableIndex, 1);
    const candidateId = String(removed.candidate_id || '');
    omittedCandidateIds.unshift(candidateId);
  }
  if (targetedRepairIds.length > 0) shrinkCapabilityCatalogRepairPromptToBudget(compactBase, boundedFacts, maxBytes, () => byteLength(buildContext()));
  const context = buildContext();
  return {
    context,
    byteLength: byteLength(context),
    inputTokenBudget: resolveAIInputTokenBudget(env),
    omittedCandidateIds,
  };
}
