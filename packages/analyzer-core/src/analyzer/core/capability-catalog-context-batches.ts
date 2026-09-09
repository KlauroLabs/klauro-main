import { fitCapabilityCatalogContext, resolveAIInputByteBudget, type ContextBudgetResult } from './ai-context-budget';
import { CapabilityCatalogResponseError, parseCapabilityCatalogResponse } from './capability-catalog-response';

type EvidenceWindow = { offset?: number; indices?: number[]; total: number };

function evidenceEntryId(value: unknown): string | undefined {
  const id = Array.isArray(value) ? value[0]
    : value && typeof value === 'object' ? (value as Record<string, unknown>).entry_point_id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function selectEvidenceWindow(candidate: Record<string, unknown>, selections: Record<string, number[]>): Record<string, unknown> {
  const previous = candidate.evidence_window as Record<string, EvidenceWindow> | undefined;
  const result: Record<string, unknown> & { evidence_window: Record<string, EvidenceWindow> } = { ...candidate, evidence_window: { ...previous } };
  for (const [key, indexes] of Object.entries(selections)) {
    const values = candidate[key] as unknown[];
    const window = previous?.[key];
    const originalIndexes = indexes.map(index => window?.indices?.[index] ?? (window?.offset || 0) + index);
    result[key] = indexes.map(index => values[index]);
    result.evidence_window[key] = {
      ...(originalIndexes.every((value, index) => value === originalIndexes[0] + index)
        ? { offset: originalIndexes[0] ?? window?.offset ?? 0 }
        : { indices: originalIndexes }),
      total: window?.total ?? values.length,
    };
  }
  return result;
}

function splitJoinedEvidence(candidate: Record<string, unknown>): Record<string, unknown>[] | undefined {
  const observed = Array.isArray(candidate.observed_operations) ? candidate.observed_operations : [];
  const contracts = Array.isArray(candidate.declared_contracts) ? candidate.declared_contracts : [];
  const entryIds = new Set(observed.map(evidenceEntryId).filter(Boolean));
  if (!contracts.some(contract => entryIds.has(evidenceEntryId(contract)))) return undefined;
  const groups: Array<{ observed: number[]; contracts: number[] }> = [];
  const byEntry = new Map<string, number>();
  observed.forEach((value, index) => {
    const id = evidenceEntryId(value);
    const existing = id ? byEntry.get(id) : undefined;
    if (existing !== undefined) groups[existing].observed.push(index);
    else {
      if (id) byEntry.set(id, groups.length);
      groups.push({ observed: [index], contracts: [] });
    }
  });
  contracts.forEach((value, index) => {
    const id = evidenceEntryId(value);
    const existing = id ? byEntry.get(id) : undefined;
    if (existing !== undefined) groups[existing].contracts.push(index);
    else groups.push({ observed: [], contracts: [index] });
  });
  const operations = Array.isArray(candidate.operations) ? candidate.operations : [];
  if (groups.length === 1 && operations.length <= 1) return [];
  const middle = Math.ceil(groups.length / 2);
  const portions = groups.length === 1 ? [groups, groups] : [groups.slice(0, middle), groups.slice(middle)];
  return portions.map((portion, index) => {
    const selections: Record<string, number[]> = {
      observed_operations: portion.flatMap(group => group.observed).sort((left, right) => left - right),
      declared_contracts: portion.flatMap(group => group.contracts).sort((left, right) => left - right),
    };
    if (operations.length > 1) {
      const start = index === 0 ? 0 : Math.ceil(operations.length / 2);
      const end = index === 0 ? Math.ceil(operations.length / 2) : operations.length;
      selections.operations = Array.from({ length: end - start }, (_, offset) => start + offset);
    }
    return selectEvidenceWindow(candidate, selections);
  });
}

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
    const joined = splitJoinedEvidence(candidate);
    if (joined) {
      if (joined.length === 0) throw new CapabilityCatalogResponseError('source-contract-exceeds-context-budget');
      joined.forEach(visit);
      return;
    }
    const splitKeys = ['operations', 'observed_operations', 'declared_contracts'].filter(key =>
      Array.isArray(candidate?.[key]) && (candidate[key] as unknown[]).length > 1);
    if (splitKeys.length > 0) {
      const selections: [Record<string, number[]>, Record<string, number[]>] = [{}, {}];
      for (const key of splitKeys) {
        const values = candidate[key] as unknown[];
        const middle = Math.ceil(values.length / 2);
        selections[0][key] = Array.from({ length: middle }, (_, index) => index);
        selections[1][key] = Array.from({ length: values.length - middle }, (_, index) => middle + index);
      }
      const halves = selections.map(selection => selectEvidenceWindow(candidate, selection));
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
