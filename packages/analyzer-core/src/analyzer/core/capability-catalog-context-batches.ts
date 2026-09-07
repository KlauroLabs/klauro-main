import { fitCapabilityCatalogContext, resolveAIInputByteBudget, type ContextBudgetResult } from './ai-context-budget';
import { CapabilityCatalogResponseError, parseCapabilityCatalogResponse } from './capability-catalog-response';

export function fitCapabilityCatalogContexts<T extends Record<string, unknown>>(
  base: T,
  facts: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Array<ContextBudgetResult<T & { facts: Record<string, unknown> }>> {
  const maxBytes = resolveAIInputByteBudget(env);
  const batches: Array<ContextBudgetResult<T & { facts: Record<string, unknown> }>> = [];
  const fit = (candidates: Array<Record<string, unknown>>) => {
    const ids = new Set(candidates.map(candidate => candidate.candidate_id));
    const scoped = {
      ...facts,
      candidate_route_areas: candidates,
      required_behavior_candidate_ids: (Array.isArray(facts.required_behavior_candidate_ids) ? facts.required_behavior_candidate_ids : []).filter(id => ids.has(id)),
      required_entity_candidate_groups: (Array.isArray(facts.required_entity_candidate_groups) ? facts.required_entity_candidate_groups : [])
        .map(group => Array.isArray(group) ? group.filter(id => ids.has(id)) : []).filter(group => group.length > 0),
      required_outcomes: (Array.isArray(facts.required_outcomes) ? facts.required_outcomes : []).flatMap(value => {
        const outcome = value as Record<string, unknown>;
        const candidateIds = (Array.isArray(outcome.candidate_ids) ? outcome.candidate_ids : []).filter(id => ids.has(id));
        return candidateIds.length > 0 ? [{ ...outcome, candidate_ids: candidateIds }] : [];
      }),
    };
    return fitCapabilityCatalogContext(base, scoped, env);
  };
  const sharedEvidence = (value: Record<string, unknown>) => JSON.stringify([
    value.user_journeys, value.entities, value.external_services,
  ]);
  const empty = fit([]);
  const shared = sharedEvidence(empty.context.facts);
  const fits = (value: ContextBudgetResult<T & { facts: Record<string, unknown> }>) =>
    value.omittedCandidateIds.length === 0 && value.byteLength <= maxBytes &&
    sharedEvidence(value.context.facts) === shared;
  let pending: Array<Record<string, unknown>> = [];
  let pendingFit: ContextBudgetResult<T & { facts: Record<string, unknown> }> | undefined;
  const flush = (): void => {
    if (pendingFit) batches.push(pendingFit);
    pending = [];
    pendingFit = undefined;
  };
  const visit = (candidate: Record<string, unknown>): void => {
    const combined = fit([...pending, candidate]);
    if (fits(combined)) {
      pending.push(candidate);
      pendingFit = combined;
      return;
    }
    flush();
    const single = fit([candidate]);
    if (fits(single)) {
      pending = [candidate];
      pendingFit = single;
      return;
    }
    const splitKeys = ['operations', 'declared_contracts'].filter(key =>
      Array.isArray(candidate?.[key]) && (candidate[key] as unknown[]).length > 1);
    if (splitKeys.length > 0) {
      const halves = [{ ...candidate }, { ...candidate }];
      const previousWindow = candidate.evidence_window as Record<string, { offset: number; total: number }> | undefined;
      for (const half of halves) half.evidence_window = { ...previousWindow };
      for (const key of splitKeys) {
        const values = candidate[key] as unknown[];
        const middle = Math.ceil(values.length / 2);
        const offset = previousWindow?.[key]?.offset || 0;
        const total = previousWindow?.[key]?.total || values.length;
        halves[0][key] = values.slice(0, middle);
        halves[1][key] = values.slice(middle);
        (halves[0].evidence_window as Record<string, unknown>)[key] = { offset, total };
        (halves[1].evidence_window as Record<string, unknown>)[key] = { offset: offset + middle, total };
      }
      visit(halves[0]);
      visit(halves[1]);
      return;
    }
    throw new CapabilityCatalogResponseError('source-contract-exceeds-context-budget');
  };
  const candidates = Array.isArray(facts.candidate_route_areas) ? facts.candidate_route_areas as Array<Record<string, unknown>> : [];
  for (const candidate of candidates) visit(candidate);
  flush();
  if (candidates.length === 0) {
    if (!fits(empty)) throw new CapabilityCatalogResponseError('source-contract-exceeds-context-budget');
    batches.push(empty);
  }
  return batches;
}

export async function requestCapabilityCatalogContexts<T extends Record<string, unknown>>(
  contexts: readonly ContextBudgetResult<T>[],
  request: (context: T) => Promise<string>,
): Promise<string> {
  if (contexts.length === 1) return request(contexts[0].context);
  const capabilities: unknown[] = [];
  for (let index = 0; index < contexts.length; index += 1) {
    try {
      const response = parseCapabilityCatalogResponse(await request(contexts[index].context));
      if (!response.ok) throw new CapabilityCatalogResponseError(response.reason);
      capabilities.push(...response.capabilities, ...(response.rejectedMemberIndices || []).map(() => null));
    } catch (error) {
      const unprocessedCandidateIds = [...new Set(contexts.slice(index).flatMap(context => {
        const facts = context.context.facts as Record<string, unknown> | undefined;
        return (Array.isArray(facts?.candidate_route_areas) ? facts.candidate_route_areas : [])
          .map(candidate => String((candidate as Record<string, unknown>).candidate_id || '')).filter(Boolean);
      }))];
      throw new CapabilityCatalogResponseError(
        error instanceof CapabilityCatalogResponseError ? error.reason : 'provider-request-failed',
        capabilities.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))),
        unprocessedCandidateIds,
      );
    }
  }
  return JSON.stringify({ capabilities });
}
