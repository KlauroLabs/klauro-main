import { fitCapabilityCatalogContext, resolveAIInputByteBudget } from '../../analyzer/core/ai-context-budget';

test.each([false, true])('retains every canonical operation citation through bounded windows, repair=%s', repair => {
  const observed = Array.from({ length: 90 }, (_, index) => ({
    entry_point_id: 'observed-' + index,
    action: 'Inspect a record without changing it. ' + 'Qualified source behavior. '.repeat(20),
  }));
  const before = JSON.stringify(observed);
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog only supported outcomes.' }, {
    candidate_route_areas: [{
      candidate_id: 'surface', observed_operations: observed,
      ...(repair ? { first_party_outcomes: ['Inspect records without changing them'] } : {}),
    }],
  }, { AI_MAX_CONTEXT_LENGTH: '4096' } as NodeJS.ProcessEnv);
  const delivered = batches.flatMap(batch => batch.context.facts.candidate_route_areas as Array<Record<string, unknown>>);
  expect(delivered.flatMap(value => value.observed_operations)).toEqual(observed);
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.every(batch => batch.byteLength <= resolveAIInputByteBudget({ AI_MAX_CONTEXT_LENGTH: '4096' }))).toBe(true);
  let offset = 0;
  for (const value of delivered) {
    expect((value.evidence_window as any).observed_operations).toEqual({ offset, total: observed.length });
    offset += (value.observed_operations as unknown[]).length;
  }
  expect(JSON.stringify(observed)).toBe(before);
});
import { fitCapabilityCatalogContexts, requestCapabilityCatalogContexts } from '../../analyzer/core/capability-catalog-context-batches';

const env = { AI_MAX_CONTEXT_LENGTH: '4096' } as NodeJS.ProcessEnv;
const contract = (index: number) => ({
  entry_point_id: 'entry-' + index,
  source_node_id: 'node-' + index,
  text: 'Returns the supplied record without verifying it. The caller must decide whether to accept it. ' + 'Contract detail. '.repeat(80),
  example_blocks_omitted: 0,
});
const candidate = (index: number) => ({
  candidate_id: 'candidate-' + index,
  operations: ['Read the supplied record'],
  declared_contracts: [contract(index)],
});

test('only outcomes corroborated by a candidate in the current batch reach the model', async () => {
  const candidates = Array.from({ length: 30 }, (_, index) => candidate(index));
  const required = candidates.map(item => ({
    requirement_id: item.candidate_id, outcome: 'Documented behavior', candidate_ids: [item.candidate_id],
  }));
  const contexts = fitCapabilityCatalogContexts({ task: 'Catalog documented behavior.' }, {
    candidate_route_areas: candidates,
    required_outcomes: [
      ...required,
      { requirement_id: 'unmatched', outcome: 'Predict customer demand', candidate_ids: [] },
      { requirement_id: 'stale', outcome: 'Exceptionally fast', candidate_ids: ['missing'] },
    ],
  }, env);
  expect(contexts.length).toBeGreaterThan(1);
  const delivered = new Set<string>();
  await requestCapabilityCatalogContexts(contexts, async context => {
    const facts = context.facts;
    const ids = new Set((facts.candidate_route_areas as Array<Record<string, unknown>>).map(item => item.candidate_id));
    for (const outcome of facts.required_outcomes as Array<{ requirement_id: string; candidate_ids: string[] }>) {
      expect(outcome.candidate_ids.length).toBeGreaterThan(0);
      expect(outcome.candidate_ids.every(id => ids.has(id))).toBe(true);
      expect(['unmatched', 'stale']).not.toContain(outcome.requirement_id);
      delivered.add(outcome.requirement_id);
    }
    return JSON.stringify({ capabilities: [] });
  });
  expect([...delivered]).toEqual(required.map(outcome => outcome.requirement_id));
});

test('retains all operations and their qualifications through bounded batches', () => {
  const operations = Array.from({ length: 85 }, (_, index) =>
    'Inspect record ' + index + '. ' + 'Context detail. '.repeat(35) + ' Does not change or store the record.');
  const relationships = ['Record inspection depends on authorization and does not provide authorization itself.'];
  const facts = { candidate_route_areas: [{ candidate_id: 'surface', operations, relationships, evidence_role: 'supporting-mechanism' }],
    required_behavior_candidate_ids: ['surface'] };
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog observed behavior.' }, facts, env);
  const delivered = batches.flatMap(batch => batch.context.facts.candidate_route_areas as Array<Record<string, unknown>>);
  expect([...new Set(delivered.flatMap(candidate => candidate.operations as string[]))]).toEqual(operations);
  expect(delivered.every(candidate => candidate.evidence_role === 'supporting-mechanism')).toBe(true);
  expect(delivered.every(candidate => (candidate.relationships as string[]).includes(relationships[0]))).toBe(true);
  expect(batches.every(batch => batch.byteLength <= resolveAIInputByteBudget(env))).toBe(true);
  let offset = 0;
  for (const value of delivered) {
    expect(value.evidence_window).toEqual({ operations: { offset, total: 85 } });
    offset += (value.operations as string[]).length;
  }
  expect(offset).toBe(85);
  expect(facts.candidate_route_areas[0].operations).toEqual(operations);
});

test('keeps partial-contract window metadata during targeted repair compaction', () => {
  const contracts = Array.from({ length: 20 }, (_, index) => contract(index));
  const batches = fitCapabilityCatalogContexts({ task: 'Repair documented outcomes.' }, {
    candidate_route_areas: [{ candidate_id: 'candidate-0', first_party_outcomes: ['Read records'], declared_contracts: contracts }],
  }, env);
  const delivered = batches.flatMap(batch => batch.context.facts.candidate_route_areas as Array<Record<string, unknown>>);
  expect(delivered.flatMap(value => value.declared_contracts)).toEqual(contracts);
  expect(delivered.every(value => (value.evidence_window as any).declared_contracts.total === 20)).toBe(true);
  expect(batches.every(batch => batch.byteLength <= resolveAIInputByteBudget(env))).toBe(true);
});

test('reports an indivisible oversized operation without cutting off its qualifying evidence', () => {
  expect(() => fitCapabilityCatalogContexts({ task: 'Catalog observed behavior.' }, {
    candidate_route_areas: [{ candidate_id: 'surface', operations: ['Read records. ' + 'detail '.repeat(5000) + 'Never writes records.'] }],
  }, env)).toThrow('source-contract-exceeds-context-budget');
});

test('partitions operations and contracts together instead of multiplying requests across both arrays', () => {
  const operations = Array.from({ length: 20 }, (_, index) => 'Read record ' + index + '. ' + 'Operation detail. '.repeat(40));
  const contracts = Array.from({ length: 20 }, (_, index) => contract(index));
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog behavior.' }, {
    candidate_route_areas: [{ ...candidate(0), operations, declared_contracts: contracts }],
  }, env);
  const delivered = batches.flatMap(batch => batch.context.facts.candidate_route_areas as Array<Record<string, unknown>>);
  expect(delivered.flatMap(value => value.operations)).toEqual(operations);
  expect(delivered.flatMap(value => value.declared_contracts)).toEqual(contracts);
  expect(batches.length).toBeLessThanOrEqual(20);
  expect(batches.every(batch => batch.byteLength <= resolveAIInputByteBudget(env))).toBe(true);
});

test('does not remove an oversized relationship to manufacture a fitting context', () => {
  expect(() => fitCapabilityCatalogContexts({ task: 'Catalog behavior.' }, {
    candidate_route_areas: [{ ...candidate(0), relationships: ['Read access requires authorization. ' + 'detail '.repeat(5000)] }],
  }, env)).toThrow('source-contract-exceeds-context-budget');
});

test('keeps an ordinary complete surface in one request', () => {
  const operations = Array.from({ length: 85 }, (_, index) => 'Inspect record ' + index);
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog behavior.' }, {
    candidate_route_areas: [{ candidate_id: 'surface', operations }],
  }, env);
  expect(batches).toHaveLength(1);
  expect((batches[0].context.facts.candidate_route_areas as Array<Record<string, unknown>>)[0].operations).toEqual(operations);
});

test('batches all candidate contracts when the single-prompt fitter omits evidence', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => candidate(index));
  const facts = { candidate_route_areas: candidates };
  const single = fitCapabilityCatalogContext({ task: 'Catalog documented behavior.' }, facts, env);
  expect(single.omittedCandidateIds.length).toBeGreaterThan(0);
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog documented behavior.' }, facts, env);
  expect(batches.length).toBeGreaterThan(1);
  const delivered = batches.flatMap(batch => batch.context.facts.candidate_route_areas as Array<Record<string, unknown>>);
  expect(delivered.map(value => value.candidate_id)).toEqual(candidates.map(value => value.candidate_id));
  expect(delivered.map(value => value.declared_contracts)).toEqual(candidates.map(value => value.declared_contracts));
  expect(batches.every(batch => batch.omittedCandidateIds.length === 0 && batch.byteLength <= resolveAIInputByteBudget(env))).toBe(true);
  expect(fitCapabilityCatalogContexts({ task: 'Catalog documented behavior.' }, facts, env)).toEqual(batches);
});

test('splits a large API group across complete source contracts without splitting qualifications', () => {
  const contracts = Array.from({ length: 20 }, (_, index) => contract(index));
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog documented behavior.' }, {
    candidate_route_areas: [{ ...candidate(0), declared_contracts: contracts }],
    required_behavior_candidate_ids: ['candidate-0'],
    required_outcomes: [{ requirement_id: 'read', outcome: 'Read records', candidate_ids: ['candidate-0'] }],
  }, env);
  expect(batches.length).toBeGreaterThan(1);
  const delivered = batches.flatMap(batch => batch.context.facts.candidate_route_areas as Array<Record<string, unknown>>);
  expect(delivered.flatMap(value => value.declared_contracts)).toEqual(contracts);
  expect(batches.every(batch => batch.byteLength <= resolveAIInputByteBudget(env))).toBe(true);
});

test('reports an indivisible over-budget contract instead of silently removing or truncating it', () => {
  expect(() => fitCapabilityCatalogContexts({ task: 'Catalog behavior.' }, {
    candidate_route_areas: [{ ...candidate(0), declared_contracts: [{ ...contract(0), text: 'x'.repeat(30000) }] }],
  }, env)).toThrow('source-contract-exceeds-context-budget');
});

test('merges every batch proposal but never adopts a partial batch narrative as the whole system', async () => {
  const contexts = fitCapabilityCatalogContexts({ task: 'Catalog behavior.' }, {
    candidate_route_areas: Array.from({ length: 20 }, (_, index) => candidate(index)),
  }, env);
  const request = jest.fn(async (context: { facts: Record<string, unknown> }) => JSON.stringify({
    system_description: 'Only describes this subset.',
    domain: 'partial-subset',
    capabilities: (context.facts.candidate_route_areas as Array<Record<string, unknown>>)
      .map(value => ({ name: value.candidate_id, candidate_ids: [value.candidate_id] })),
  }));
  const response = JSON.parse(await requestCapabilityCatalogContexts(contexts, request));
  expect(response.capabilities).toHaveLength(20);
  expect(response.system_description).toBeUndefined();
  expect(response.domain).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(contexts.length);
});

test('retains successful batch proposals when a later source context cannot be processed', async () => {
  const contexts = fitCapabilityCatalogContexts({ task: 'Catalog behavior.' }, {
    candidate_route_areas: Array.from({ length: 20 }, (_, index) => candidate(index)),
  }, env);
  const supported = { name: 'Read supplied records', candidate_ids: ['candidate-0'] };
  const request = jest.fn().mockResolvedValueOnce(JSON.stringify({ capabilities: [supported] }))
    .mockRejectedValue(new Error('provider unavailable'));
  try {
    await requestCapabilityCatalogContexts(contexts, request);
    throw new Error('expected incomplete evidence');
  } catch (error) {
    expect((error as { partialCapabilities?: unknown[] }).partialCapabilities).toEqual([supported]);
  }
});

test('does not treat a failed batch as an empty accepted subset', async () => {
  const contexts = fitCapabilityCatalogContexts({ task: 'Catalog behavior.' }, {
    candidate_route_areas: Array.from({ length: 20 }, (_, index) => candidate(index)),
  }, env);
  const request = jest.fn().mockResolvedValueOnce('{"capabilities":[]}').mockResolvedValue('{"capabilities":[');
  await expect(requestCapabilityCatalogContexts(contexts, request)).rejects.toThrow('incomplete-json');
});

test('packs contiguous evidence to the byte limit instead of repeatedly halving fitting groups', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => candidate(index + 1000));
  const base = { task: 'Catalog documented behavior.' };
  const fits = (values: typeof candidates) => {
    const context = fitCapabilityCatalogContext(base, { candidate_route_areas: values }, env);
    return context.omittedCandidateIds.length === 0 && context.byteLength <= resolveAIInputByteBudget(env);
  };
  let capacity = 0;
  while (capacity < candidates.length && fits(candidates.slice(0, capacity + 1))) capacity += 1;
  expect(capacity).toBeGreaterThan(1);
  const batches = fitCapabilityCatalogContexts(base, { candidate_route_areas: candidates }, env);
  expect(batches).toHaveLength(Math.ceil(candidates.length / capacity));
  const delivered = batches.flatMap(batch => batch.context.facts.candidate_route_areas as Array<Record<string, unknown>>);
  expect(delivered.map(value => value.candidate_id)).toEqual(candidates.map(value => value.candidate_id));
  expect(delivered.map(value => value.operations)).toEqual(candidates.map(value => value.operations));
  expect(delivered.map(value => value.declared_contracts)).toEqual(candidates.map(value => value.declared_contracts));
});

test('retains every authored requirement that fits even when one evidence family supports more than sixteen', () => {
  const required = Array.from({ length: 20 }, (_, index) => ({
    requirement_id: 'requirement-' + index,
    outcome: 'Inspect record ' + index + ' without changing it',
    candidate_ids: ['candidate-0'],
  }));
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog documented behavior.' }, {
    candidate_route_areas: [candidate(0)], required_outcomes: required,
  }, env);
  expect(batches).toHaveLength(1);
  expect((batches[0].context.facts.required_outcomes as Array<Record<string, unknown>>).map(value => value.requirement_id))
    .toEqual(required.map(value => value.requirement_id));
});

test('packing does not trade shared evidence away to fit another candidate', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => candidate(index + 1000));
  const facts = {
    candidate_route_areas: candidates,
    user_journeys: [{ name: 'Inspect a record without mutation', writes: [], terminal: ['Record:read'] }],
    entities: [{ name: 'Record', fields: ['status', 'origin'] }],
    external_services: ['Audit receiver'],
    top_down_signals: { product_overview: 'Inspection returns records without changing stored data.' },
  };
  const shared = fitCapabilityCatalogContext({ task: 'Catalog documented behavior.' }, {
    ...facts, candidate_route_areas: [],
  }, env).context.facts;
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog documented behavior.' }, facts, env);
  for (const batch of batches) {
    for (const key of ['user_journeys', 'entities', 'external_services', 'top_down_signals']) {
      expect(batch.context.facts[key]).toEqual(shared[key]);
    }
    expect(batch.byteLength).toBeLessThanOrEqual(resolveAIInputByteBudget(env));
    expect(batch.omittedCandidateIds).toEqual([]);
  }
});

test.each([false, true])('keeps sparse reordered contracts with their cited operation, object rows=%s', objectRows => {
  const observed = Array.from({ length: 16 }, (_, index) => objectRows
    ? { entry_point_id: 'entry-' + index, action: 'Inspect record ' + index }
    : ['entry-' + index, 'rpc', 'inspect_' + index, 'read', null]);
  const contracts = [15, 1, 11, 5, 9, 3].map(index => contract(index));
  const original = { candidate_id: 'surface', observed_operations: observed, declared_contracts: contracts };
  const before = JSON.stringify(original);
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog documented behavior.' }, {
    candidate_route_areas: [original],
  }, env);
  expect(batches.length).toBeGreaterThan(1);
  const delivered = batches.flatMap(batch => batch.context.facts.candidate_route_areas as any[]);
  const entryId = (row: any): string => Array.isArray(row) ? row[0] : row.entry_point_id;
  for (const part of delivered) {
    for (const row of part.observed_operations) {
      expect(part.declared_contracts.filter((value: any) => value.entry_point_id === entryId(row)))
        .toEqual(contracts.filter(value => value.entry_point_id === entryId(row)));
    }
    for (const value of part.declared_contracts) {
      expect(part.observed_operations.some((row: any) => entryId(row) === value.entry_point_id)).toBe(true);
    }
    for (const key of ['observed_operations', 'declared_contracts'] as const) {
      const window = part.evidence_window[key];
      const indexes: number[] = window.indices || part[key].map((_: unknown, index: number) => window.offset + index);
      expect(window.total).toBe(original[key].length);
      expect(indexes.map(index => original[key][index])).toEqual(part[key]);
    }
  }
  expect(delivered.flatMap(part => part.observed_operations)).toEqual(observed);
  expect(delivered.flatMap(part => part.declared_contracts).map(value => value.entry_point_id).sort())
    .toEqual(contracts.map(value => value.entry_point_id).sort());
  expect(batches.every(batch => batch.byteLength <= resolveAIInputByteBudget(env))).toBe(true);
  expect(JSON.stringify(original)).toBe(before);
});

test('does not split one operation from any of its qualifications to fit a prompt', () => {
  const observed = Array.from({ length: 8 }, (_, index) => ['entry-' + index, 'rpc', 'read_' + index, 'read', null]);
  const contracts = Array.from({ length: 12 }, (_, index) => ({ ...contract(index), entry_point_id: 'entry-0' }));
  expect(() => fitCapabilityCatalogContexts({ task: 'Catalog documented behavior.' }, {
    candidate_route_areas: [{ candidate_id: 'surface', observed_operations: observed, declared_contracts: contracts }],
  }, env)).toThrow('source-contract-exceeds-context-budget');
});

test.each([false, true])('preserves duplicate operation identities and original indexes through nested windows, repair=%s', repair => {
  const observed = [0, 1, 0, 2, 3, 4, 5, 6].map(index => ['entry-' + index, 'rpc', 'read_' + index, 'read', null]);
  const contracts = [6, 5, 4, 3, 2, 1, 0].map(index => ({ ...contract(index), text: contract(index).text.repeat(3) }));
  const original = { candidate_id: 'surface', observed_operations: observed, declared_contracts: contracts,
    ...(repair ? { first_party_outcomes: ['Inspect records without changing them'] } : {}) };
  const batches = fitCapabilityCatalogContexts({ task: 'Catalog documented behavior.' }, {
    candidate_route_areas: [original],
  }, env);
  expect(batches.length).toBeGreaterThan(2);
  const delivered = batches.flatMap(batch => batch.context.facts.candidate_route_areas as any[]);
  for (const part of delivered) {
    for (const row of part.observed_operations) {
      expect(part.declared_contracts.filter((value: any) => value.entry_point_id === row[0]))
        .toEqual(contracts.filter(value => value.entry_point_id === row[0]));
    }
  }
  for (const key of ['observed_operations', 'declared_contracts'] as const) {
    const restored = new Map<number, unknown>();
    for (const part of delivered) {
      const window = part.evidence_window[key];
      const indexes: number[] = window.indices || part[key].map((_: unknown, index: number) => window.offset + index);
      expect(window.total).toBe(original[key].length);
      expect(indexes.map(index => original[key][index])).toEqual(part[key]);
      indexes.forEach((index, position) => {
        expect(restored.has(index)).toBe(false);
        restored.set(index, part[key][position]);
      });
    }
    expect([...restored].sort(([left], [right]) => left - right).map(([, value]) => value)).toEqual(original[key]);
  }
});
