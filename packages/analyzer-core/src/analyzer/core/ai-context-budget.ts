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

function compactCandidate(value: unknown): Record<string, unknown> {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    candidate_id: boundedText(candidate.candidate_id, 180),
    family: boundedText(candidate.family, 180),
    operations: boundedTextArray(candidate.operations, 6, 240),
    name: boundedText(candidate.name, 900),
    entry_points: candidate.entry_points,
    entities: candidate.entities,
    entity_names: boundedTextArray(candidate.entity_names, 8, 160),
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
  const candidates = (Array.isArray(facts.candidate_route_areas) ? facts.candidate_route_areas : []).map(compactCandidate);
  const requiredIds = new Set(boundedTextArray(facts.required_behavior_candidate_ids, candidates.length, 180));
  const topDownSignals = compactTopDownSignals(facts.top_down_signals);
  const boundedFacts: Record<string, unknown> = {
    user_journeys: (Array.isArray(facts.user_journeys) ? facts.user_journeys : []).slice(0, 12).map(compactJourney),
    entities: (Array.isArray(facts.entities) ? facts.entities : []).slice(0, 18).map(compactEntity),
    candidate_route_areas: [] as Record<string, unknown>[],
    required_behavior_candidate_ids: [] as string[],
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
    if (requiredIds.has(candidateId)) includedRequiredIds.push(candidateId);
    if (byteLength(buildContext()) <= maxBytes) continue;
    includedCandidates.pop();
    if (requiredIds.has(candidateId)) includedRequiredIds.pop();
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
  while (byteLength(buildContext()) > maxBytes && includedCandidates.length > 0) {
    const removed = includedCandidates.pop()!;
    const candidateId = String(removed.candidate_id || '');
    const requiredIndex = includedRequiredIds.indexOf(candidateId);
    if (requiredIndex >= 0) includedRequiredIds.splice(requiredIndex, 1);
    omittedCandidateIds.unshift(candidateId);
  }
  const context = buildContext();
  return {
    context,
    byteLength: byteLength(context),
    inputTokenBudget: resolveAIInputTokenBudget(env),
    omittedCandidateIds,
  };
}
