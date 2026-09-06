import { fitCapabilityCatalogContext, resolveAIInputByteBudget, type ContextBudgetResult } from './ai-context-budget';
import { CapabilityCatalogResponseError, parseCapabilityCatalogResponse } from './capability-catalog-response';

export function fitCapabilityCatalogContexts<T extends Record<string, unknown>>(
  base: T,
  facts: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Array<ContextBudgetResult<T & { facts: Record<string, unknown> }>> {
  const maxBytes = resolveAIInputByteBudget(env);
  const batches: Array<ContextBudgetResult<T & { facts: Record<string, unknown> }>> = [];
  const visit = (candidates: Array<Record<string, unknown>>): void => {
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
    const fitted = fitCapabilityCatalogContext(base, scoped, env);
    if (fitted.omittedCandidateIds.length === 0 && fitted.byteLength <= maxBytes) {
      batches.push(fitted);
      return;
    }
    if (candidates.length > 1) {
      const middle = Math.ceil(candidates.length / 2);
      visit(candidates.slice(0, middle));
      visit(candidates.slice(middle));
      return;
    }
    const candidate = candidates[0];
    const contracts = candidate?.declared_contracts;
    if (Array.isArray(contracts) && contracts.length > 1) {
      const middle = Math.ceil(contracts.length / 2);
      visit([{ ...candidate, declared_contracts: contracts.slice(0, middle) }]);
      visit([{ ...candidate, declared_contracts: contracts.slice(middle) }]);
      return;
    }
    throw new CapabilityCatalogResponseError('source-contract-exceeds-context-budget');
  };
  visit(Array.isArray(facts.candidate_route_areas) ? facts.candidate_route_areas as Array<Record<string, unknown>> : []);
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
