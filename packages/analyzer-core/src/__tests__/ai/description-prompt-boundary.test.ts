import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

describe('AI description evidence boundary', () => {
  it('does not expose entry-point buckets as narrative facts', () => {
    const orchestrator = new AnalyzerOrchestrator() as any;
    const facts = orchestrator.buildAIInterpretationBaseFacts(
      'Orders',
      ['express'],
      [{ type: 'http', count: 12 }, { type: 'cli', count: 3 }, { type: 'test', count: 40 }],
      ['EnterpriseOrder'],
      [],
      { capability_candidates: [], dependencies: [], topology: {}, primary_flow: {}, layers: [], system_insights: {} },
      [{ id: 'orders', name: 'Orders', classification: 'core', frequency: 4 }],
      [{ id: 'orders', name: 'Manage Orders', description: 'Owns EnterpriseOrder decisions.' }],
      []
    );

    expect(facts.entryPoints).toBeUndefined();
    expect(facts.databaseEntities).toEqual(['EnterpriseOrder']);
    expect(facts.capabilities).toEqual(['Manage Orders']);
  });

  it('supplies language-neutral product behavior paths to the description model', () => {
    const orchestrator = new AnalyzerOrchestrator() as any;
    const facts = orchestrator.buildAIInterpretationFacts(
      'Orders',
      ['express'],
      [{ type: 'http', count: 1 }],
      ['EnterpriseOrder'],
      [],
      { capability_candidates: [], dependencies: [], topology: {}, primary_flow: {}, layers: [], system_insights: {} },
      [{ id: 'orders', name: 'Orders', classification: 'core', frequency: 4 }],
      [{ id: 'orders', name: 'Manage Orders', description: 'Owns EnterpriseOrder decisions.' }],
      [],
      { concepts: [], evidence: [] },
      [{ id: 'entity-order', name: 'EnterpriseOrder', kind: 'persisted-entity' }],
      '',
      [{
        id: 'journey-order-total',
        name: 'View order -> calculateEnterpriseTotal',
        journey_kind: 'user-facing',
        entry_point_id: 'entry-order',
        entry: { type: 'http', name: 'View order', method: 'GET', path_or_trigger: '/orders/:id' },
        steps: [
          { node_id: 'handler', name: 'enterprise_python_handler', layer: 'business', depth: 1 },
          { node_id: 'calculate-total', name: 'calculateEnterpriseTotal', layer: 'business', depth: 2 },
        ],
        terminal_effects: {
          entities_written: [], entities_read: ['EnterpriseOrder'], external_services: [], messages_emitted: [],
        },
        terminal_entities: [{ name: 'EnterpriseOrder', access: 'read', terminal_kind: 'entity' }],
        security_boundaries: [],
        tests_covering: ['order-total.test.ts'],
        criticality: 'high',
        call_chain_ids: [],
        exit_point_ids: [],
      }]
    );

    expect(facts.productBehaviorPaths).toEqual([expect.objectContaining({
      intent: 'View order',
      businessTransformations: ['calculate Enterprise Total'],
      recordsRead: ['EnterpriseOrder'],
      testsCovering: ['order-total.test.ts'],
    })]);
    expect(JSON.stringify(facts.productBehaviorPaths)).not.toMatch(/\/orders\/:id|enterprise_python_handler/);
    expect(facts.productBehaviorInstruction).toMatch(/language-neutral traces/);
  });

  it('expresses retrieval-only evidence as positive actions without leaking a mode label', () => {
    const orchestrator = new AnalyzerOrchestrator() as any;
    const facts = orchestrator.buildAIInterpretationFacts(
      'Order reference',
      ['express'],
      [{ type: 'http', count: 1 }],
      ['EnterpriseOrder'],
      [],
      { capability_candidates: [], dependencies: [], topology: {}, primary_flow: {}, layers: [], system_insights: {} },
      [{ id: 'orders', name: 'Orders', classification: 'core', frequency: 4 }],
      [{
        id: 'orders', name: 'View Orders', description: 'Returns EnterpriseOrder details.',
        operations: [{ entry_point_id: 'entry-order', entry_point_type: 'http', action: 'View', trigger: { method: 'GET' } }],
      }],
      [],
      { concepts: [], evidence: [] },
      [{
        id: 'entity-order', name: 'EnterpriseOrder', kind: 'api-response',
        lifecycle: { created_by: [], read_by: ['entry-order'], updated_by: [], deleted_by: [] },
      }],
      '',
      []
    );

    expect(facts.observedProductActions).toEqual([
      'retrieve', 'present', 'return', 'view', 'review', 'compare', 'analyze',
    ]);
    expect(facts.observedBehaviorMode).toBeUndefined();
    expect(JSON.stringify(facts)).not.toMatch(/read[- ]only/i);
  });
});
