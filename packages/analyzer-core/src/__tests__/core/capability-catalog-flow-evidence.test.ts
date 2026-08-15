import { mergeCapabilityCatalogFlowEvidence } from '../../analyzer/core/capability-catalog-flow-evidence';

describe('mergeCapabilityCatalogFlowEvidence', () => {
  const flowCandidate: any = {
    id: 'capability_customers',
    name: 'Get /Customers/:Id',
    description: 'Covers customer creation and retrieval.',
    entry_points: ['create-customer', 'get-customer'],
    entry_point_summary: { types: ['http'], count: 2, primary_type: 'http' },
    operations: [{
      id: 'create-customer-operation',
      name: 'POST /customers',
      pattern: 'create',
      entry_point_id: 'create-customer',
      call_chain_ids: [],
      implementing_nodes: [],
      trigger: { type: 'http', method: 'POST', path: '/customers' },
    }],
    operation_patterns: ['crud'],
    entities_touched: ['entity_customer'],
    services_used: [],
    exit_points: [],
    call_chain_ids: [],
    complexity_profile: {
      avg_depth: 1,
      max_depth: 1,
      has_external_calls: false,
      has_database_calls: true,
      has_async_calls: false,
      branching_factor: 1,
    },
    classification: 'primary',
    criticality: 'high',
    signals: { domain_concept_score: 80, centrality_score: 70, coverage_score: 60, complexity_score: 40, total_score: 65 },
    depends_on: [],
    depended_by: [],
  };

  it('promotes flow graph candidates into catalog evidence', () => {
    const [candidate] = mergeCapabilityCatalogFlowEvidence([], [flowCandidate]);
    expect(candidate).toMatchObject({
      id: 'capability_customers',
      category: 'core',
      related_entities: ['entity_customer'],
      operations: [{ entry_point_id: 'create-customer', entry_point_type: 'http', action: 'create' }],
    });
  });

  it('merges flow evidence into an existing structural candidate without duplication', () => {
    const existing: any = {
      id: 'capability_customers',
      name: 'Customers',
      description: '',
      category: 'supporting',
      operations: [],
      related_entities: [],
      related_domains: [],
      criticality: 'medium',
      criticality_factors: [],
    };
    const [candidate] = mergeCapabilityCatalogFlowEvidence([existing], [flowCandidate, flowCandidate]);
    expect(candidate.operations).toHaveLength(1);
    expect(candidate.related_entities).toEqual(['entity_customer']);
    expect(candidate.description).toBe('Covers customer creation and retrieval.');
  });
});
