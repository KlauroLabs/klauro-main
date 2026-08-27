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
      accepted_outcome_names: ['Analyze codebases', 'Coordinate overlapping work'],
      required_outcomes: [{ requirement_id: 'agent:behavior-understand', audience: 'agent', required_audience_label: 'agents', required_subject_terms: ['understand', 'behavior'], minimum_subject_matches: 2, outcome: 'understand behavior', candidate_ids: ['candidate-0'] }],
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
    expect(first.context.facts.accepted_outcome_names).toEqual(['Analyze codebases', 'Coordinate overlapping work']);
    expect(first.context.facts.required_outcomes).toEqual([{ requirement_id: 'agent:behavior-understand', audience: 'agent', required_audience_label: 'agents', required_subject_terms: ['understand', 'behavior'], required_visible_actions: [], minimum_subject_matches: 2, outcome: 'understand behavior', candidate_ids: ['candidate-0'] }]);
    expect(first).toEqual(second);
  });

  it('enforces a safe minimum context budget', () => {
    expect(resolveAIInputTokenBudget({ AI_MAX_CONTEXT_LENGTH: '512' } as NodeJS.ProcessEnv)).toBe(4096);
  });

  it('retains a representable candidate for every required entity family in a large catalog', () => {
    const candidates = Array.from({ length: 86 }, (_, index) => ({
      candidate_id: `candidate-${index}`,
      family: `Analyze software concern ${index}`,
      operations: [`Inspect concern ${index}`, `Trace concern ${index}`, `Explain concern ${index}`],
      name: `Inspect, trace, and explain software concern ${index}`,
      entry_points: 3,
      entities: 1,
      entity_names: [`SourceModel${index}`],
      terminality: index < 37 ? 'terminal' : 'upstream',
      distance_to_terminal: index,
    }));
    const requiredGroups = candidates.slice(0, 37).map(candidate => [candidate.candidate_id]);
    const result = fitCapabilityCatalogContext({
      task: 'Return a complete PM-readable capability catalog and cite every required evidence family.',
      style: 'Use product language without source type identifiers.',
    }, {
      user_journeys: [],
      entities: [],
      candidate_route_areas: candidates,
      required_behavior_candidate_ids: [],
      required_entity_candidate_groups: requiredGroups,
      external_services: [],
    }, { AI_MAX_CONTEXT_LENGTH: '8000' } as NodeJS.ProcessEnv);
    const includedIds = new Set((result.context.facts.candidate_route_areas as Array<Record<string, unknown>>)
      .map(candidate => String(candidate.candidate_id)));
    const retainedGroups = result.context.facts.required_entity_candidate_groups as string[][];

    expect(result.byteLength).toBeLessThanOrEqual(resolveAIInputByteBudget({ AI_MAX_CONTEXT_LENGTH: '8000' } as NodeJS.ProcessEnv));
    expect(retainedGroups).toHaveLength(37);
    expect(retainedGroups.every(group => group.some(candidateId => includedIds.has(candidateId)))).toBe(true);
  });

  it('preserves sanitized targeted-repair facts under budget pressure without restoring raw evidence fields', () => {
    const result = fitCapabilityCatalogContext({
      task: 'Repair one required product outcome.',
    }, {
      user_journeys: Array.from({ length: 40 }, (_, index) => ({ name: `Journey ${index} ${'x'.repeat(200)}` })),
      entities: Array.from({ length: 40 }, (_, index) => ({ name: `RawEntity${index}`, fields: ['secret'] })),
      candidate_route_areas: [{
        candidate_id: 'candidate_1',
        first_party_outcomes: ['People inspect software behavior and change risk before modifying connected code.'],
        observable_actions: ['compare proposed changes', 'inspect software behavior'],
        required_audience_labels: ['people'],
        required_subject_terms: ['understand', 'behavior'],
        required_visible_actions: ['inspect'],
        minimum_subject_matches: 2,
        prior_rejections: [{ reason: 'outcome-scope-unsupported', requirement_id: 'human:understand', missing_audience: 'people' }],
        family: 'CrossCodebaseSystemGraph', entity_names: ['CASEdge'], operations: ['read KlauroConfig'],
      }],
      required_behavior_candidate_ids: ['candidate_1'],
      required_outcomes: [{
        requirement_id: 'human:understand', audience: 'human', required_audience_label: 'people',
        required_subject_terms: ['understand', 'behavior'], minimum_subject_matches: 2,
        required_visible_actions: ['inspect'],
        outcome: 'people understand behavior',
        first_party_outcome_text: 'People inspect software behavior and change risk before modifying connected code.',
        candidate_ids: ['candidate_1'],
      }],
      external_services: [],
    }, { AI_MAX_CONTEXT_LENGTH: '4096' } as NodeJS.ProcessEnv);
    const serialized = JSON.stringify(result.context);
    const [candidate] = result.context.facts.candidate_route_areas as Array<Record<string, unknown>>;

    expect(candidate).toEqual(expect.objectContaining({
      candidate_id: 'candidate_1', required_audience_labels: ['people'],
      required_subject_terms: ['understand', 'behavior'], required_visible_actions: ['inspect'], minimum_subject_matches: 2,
    }));
    expect(result.context.facts.required_outcomes).toEqual([expect.objectContaining({
      first_party_outcome_text: 'People inspect software behavior and change risk before modifying connected code.',
    })]);
    expect(serialized).not.toContain('CrossCodebaseSystemGraph');
    expect(serialized).not.toContain('CASEdge');
    expect(serialized).not.toContain('KlauroConfig');
    expect(result.byteLength).toBeLessThanOrEqual(resolveAIInputByteBudget({ AI_MAX_CONTEXT_LENGTH: '4096' } as NodeJS.ProcessEnv));
  });

  it('keeps every opaque repair id and required binding field within the aggregate byte cap', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      candidate_id: `candidate_${index + 1}`,
      first_party_outcomes: [`People inspect software behavior ${'safeword '.repeat(180)}`],
      observable_actions: Array.from({ length: 8 }, () => `inspect software behavior ${'detail '.repeat(20)}`),
      required_audience_labels: ['people'], required_subject_terms: ['inspect', 'software', 'behavior'],
      required_visible_actions: ['inspect'],
      minimum_subject_matches: 2,
      prior_rejections: [
        {
          reason: 'required-outcome-audience-conflict', missing_audience: 'people',
          missing_audience_locations: ['name'], opposite_audience_labels: ['agents'],
          opposite_audience_locations: ['description'],
        },
        ...Array.from({ length: 3 }, () => ({
          reason: `missing-subject-${'detail'.repeat(20)}`,
          missing_subject_terms: ['inspect', 'behavior'],
        })),
      ],
    }));
    const env = { AI_MAX_CONTEXT_LENGTH: '4096' } as NodeJS.ProcessEnv;
    const result = fitCapabilityCatalogContext({ task: `Repair outcomes ${'instruction '.repeat(900)}` }, {
      candidate_route_areas: candidates,
      required_outcomes: [{
        requirement_id: 'human:understand', audience: 'human', required_audience_label: 'people',
        required_subject_terms: ['inspect', 'software', 'behavior'], minimum_subject_matches: 2,
        required_visible_actions: ['inspect'],
        outcome: 'people inspect software behavior', first_party_outcome_text: `People inspect software behavior ${'context '.repeat(300)}`,
        candidate_ids: candidates.map(candidate => candidate.candidate_id),
      }],
    }, env);

    const retained = result.context.facts.candidate_route_areas as Array<Record<string, unknown>>;
    expect(result.byteLength).toBeLessThanOrEqual(resolveAIInputByteBudget(env));
    expect(retained.map(candidate => candidate.candidate_id)).toEqual(candidates.map(candidate => candidate.candidate_id));
    expect(retained.every(candidate => Array.isArray(candidate.required_audience_labels) && candidate.required_audience_labels[0] === 'people')).toBe(true);
    expect(retained.every(candidate => candidate.minimum_subject_matches === 2)).toBe(true);
    expect(retained.every(candidate => (candidate.prior_rejections as Array<Record<string, unknown>>).some(rejection =>
      JSON.stringify(rejection.missing_audience_locations) === '["name"]' &&
      JSON.stringify(rejection.opposite_audience_labels) === '["agents"]' &&
      JSON.stringify(rejection.opposite_audience_locations) === '["description"]'))).toBe(true);
    expect(retained.every(candidate => JSON.stringify(candidate).includes('CrossCodebaseSystemGraph'))).toBe(false);
  });
});
