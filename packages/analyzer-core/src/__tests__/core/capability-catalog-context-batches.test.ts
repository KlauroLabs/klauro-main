import { fitCapabilityCatalogContext, resolveAIInputByteBudget } from '../../analyzer/core/ai-context-budget';
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
