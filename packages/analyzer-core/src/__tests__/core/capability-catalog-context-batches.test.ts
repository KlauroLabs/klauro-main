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
