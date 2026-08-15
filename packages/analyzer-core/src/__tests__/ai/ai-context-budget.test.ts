import {
  fitCapabilityCatalogContext,
  resolveAIInputByteBudget,
  resolveAIInputTokenBudget,
} from '../../analyzer/core/ai-context-budget';

describe('AI context budgeting', () => {
  it('fits large catalog evidence deterministically while retaining ranked evidence families', () => {
    const candidates = Array.from({ length: 80 }, (_, index) => ({
      candidate_id: `candidate-${index}`,
      family: `Product family ${index}`,
      operations: Array.from({ length: 12 }, (__, operation) => `perform_product_operation_${index}_${operation}_${'x'.repeat(180)}`),
      name: Array.from({ length: 12 }, (__, operation) => `perform_product_operation_${index}_${operation}`).join(', '),
      entry_points: 12,
      entities: 8,
      entity_names: Array.from({ length: 12 }, (__, entity) => `ProductEntity${index}_${entity}`),
      terminality: index < 4 ? 'terminal' : 'upstream',
      distance_to_terminal: index,
    }));
    const facts = {
      user_journeys: Array.from({ length: 30 }, (_, index) => ({ name: `Complete journey ${index}`, writes: [`Entity${index}`], terminal: [`Entity${index}:write`] })),
      entities: Array.from({ length: 40 }, (_, index) => ({ name: `Entity${index}`, fields: Array.from({ length: 12 }, (__, field) => `field_${field}`) })),
      candidate_route_areas: candidates,
      required_behavior_candidate_ids: candidates.slice(0, 20).map(candidate => candidate.candidate_id),
      external_services: Array.from({ length: 30 }, (_, index) => `Service${index}`),
      top_down_signals: {
        product_title: 'Evidence platform',
        product_overview: 'Turns source evidence into trustworthy software understanding. '.repeat(100),
        product_terminology: Array.from({ length: 40 }, (_, index) => `Term${index}`),
      },
    };
    const env = { AI_MAX_CONTEXT_LENGTH: '8000' } as NodeJS.ProcessEnv;
    const first = fitCapabilityCatalogContext({ task: 'Return only valid JSON.', style: 'Product language.' }, facts, env);
    const second = fitCapabilityCatalogContext({ task: 'Return only valid JSON.', style: 'Product language.' }, facts, env);
    const included = first.context.facts.candidate_route_areas as Array<Record<string, unknown>>;
    expect(first.byteLength).toBeLessThanOrEqual(resolveAIInputByteBudget(env));
    expect(first.inputTokenBudget).toBe(8000);
    expect(included.length).toBeGreaterThan(0);
    expect(included[0]?.candidate_id).toBe('candidate-0');
    expect((first.context.facts.top_down_signals as Record<string, unknown>).product_title).toBe('Evidence platform');
    expect(first).toEqual(second);
  });

  it('enforces a safe minimum context budget', () => {
    expect(resolveAIInputTokenBudget({ AI_MAX_CONTEXT_LENGTH: '512' } as NodeJS.ProcessEnv)).toBe(4096);
  });
});
