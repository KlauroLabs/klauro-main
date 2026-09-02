import { mergeCapabilityCatalogFlowEvidence } from '../../analyzer/core/capability-catalog-flow-evidence';
import { classifyCapabilityEvidence } from '../../analyzer/core/capability-catalog-evidence';

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
      evidence_kind: 'behavior-surface',
      related_entities: ['entity_customer'],
      operations: [{ entry_point_id: 'create-customer', entry_point_type: 'http', action: 'create' }],
    });
  });

  it('maps page surfaces to observable view or authentication actions instead of generic implementation actions', () => {
    const page = (name: string) => ({
      ...flowCandidate,
      id: `capability_${name.toLowerCase().replace(/\s+/g, '_')}`,
      name: `Page ${name}`,
      operations: [{
        ...flowCandidate.operations[0],
        id: `page-${name}`,
        name: `Page ${name}`,
        pattern: 'action',
        entry_point_id: `page-${name}`,
        trigger: { type: 'page' },
      }],
    });
    expect(mergeCapabilityCatalogFlowEvidence([], [page('Statistics') as any])[0].operations[0].action).toBe('View');
    expect(mergeCapabilityCatalogFlowEvidence([], [page('Sign In') as any])[0].operations[0].action).toBe('Authenticate');
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

  it('keeps supporting flow gestures out of mandatory product evidence while primary flow outcomes remain eligible', () => {
    const primary = mergeCapabilityCatalogFlowEvidence([], [flowCandidate])[0];
    const supporting = mergeCapabilityCatalogFlowEvidence([], [{
      ...flowCandidate,
      id: 'capability_navigation',
      name: 'Navigation Click',
      classification: 'supporting',
      operations: [{
        ...flowCandidate.operations[0],
        id: 'navigation-click',
        name: 'Navigation Click',
        pattern: 'action',
        entry_point_id: 'navigation-click',
        trigger: { type: 'event' },
      }],
      entities_touched: [],
    } as any])[0];
    const classified = classifyCapabilityEvidence(
      [primary, supporting],
      [{ id: 'entity_customer', name: 'Customer', kind: 'persisted-entity', lifecycle: { created_by: ['create-customer'], read_by: ['get-customer'], updated_by: [], deleted_by: [] } } as any],
      { productDocSummary: 'Get customers by id provides customer records.' },
    );

    expect(classified.find(candidate => candidate.id === primary.id)?.evidence_role).toBe('product-outcome');
    expect(classified.find(candidate => candidate.id === supporting.id)?.evidence_role).toBe('supporting-mechanism');
  });

  it('attaches verified cross-entity flow dependencies to structural evidence without borrowing operations or hub fanout', () => {
    const rules: any = {
      id: 'cap_rules_management', name: 'Rules', description: '', category: 'supporting', operations: [],
      evidence_kind: 'behavior-surface', related_entities: ['entity_rule'], related_domains: [], criticality: 'medium', criticality_factors: [],
    };
    const rulesFlow = {
      ...flowCandidate,
      id: 'capability_rule_update',
      entities_touched: ['entity_rule'],
      depends_on: [{
        from_capability: 'capability_rule_update', to_capability: 'capability_bulk_transactions',
        dependency_type: 'shares-data', strength: 'common',
        evidence: { shared_services: [], shared_nodes: [], shared_entities: ['Rule', 'Action'] },
        description: 'A rule owns categorization actions',
      }],
    } as any;
    const connectedFlow = {
      ...flowCandidate,
      id: 'capability_bulk_transactions',
      entities_touched: ['entity_transaction'],
      depends_on: [{
        from_capability: 'capability_bulk_transactions', to_capability: 'capability_rule_update',
        dependency_type: 'shares-data', strength: 'common',
        evidence: { shared_services: [], shared_nodes: [], shared_entities: ['Action', 'Rule'] },
        description: 'An action applies a rule',
      }, {
        from_capability: 'capability_bulk_transactions', to_capability: 'capability_category_update',
        dependency_type: 'requires', strength: 'required',
        evidence: { shared_services: [], shared_nodes: [], shared_entities: ['Transaction', 'Category'] },
        description: 'A transaction is assigned a category',
      }],
    } as any;
    const hubFlow = {
      ...flowCandidate,
      id: 'capability_family_exports_create',
      entities_touched: [],
      depends_on: ['Account', 'Budget', 'Rule', 'User'].map(subject => ({
        from_capability: 'capability_family_exports_create', to_capability: 'capability_' + subject.toLowerCase(),
        dependency_type: 'shares-data', strength: 'common',
        evidence: { shared_services: [], shared_nodes: [], shared_entities: ['Family', subject] },
        description: 'Family relates to ' + subject,
      })),
    } as any;
    const noisyFlow = {
      ...flowCandidate,
      id: 'capability_assistant_job',
      name: 'Assistant Job',
      entities_touched: ['entity_rule'],
      operations: Array.from({ length: 8 }, (_, index) => ({
        ...flowCandidate.operations[0],
        id: 'assistant-operation-' + index,
        entry_point_id: 'entry_job_' + index,
        trigger: { type: 'message', event_name: 'perform' },
        pattern: 'execute',
      })),
      depends_on: [{
        from_capability: 'capability_assistant_job', to_capability: 'capability_rule',
        dependency_type: 'shares-data', strength: 'common',
        evidence: { shared_services: [], shared_nodes: [], shared_entities: ['Rule', 'Action'] },
        description: 'The aggregate happens to touch a rule action',
      }, {
        from_capability: 'capability_assistant_job', to_capability: 'capability_chat',
        dependency_type: 'shares-data', strength: 'common',
        evidence: { shared_services: [], shared_nodes: [], shared_entities: ['User', 'Chat'] },
        description: 'A user has chats',
      }],
    } as any;
    const result = mergeCapabilityCatalogFlowEvidence([rules], [rulesFlow, connectedFlow, hubFlow, noisyFlow]);
    const mergedRules = result.find(candidate => candidate.id === rules.id)!;
    expect(mergedRules.operations).toEqual([]);
    expect(mergedRules.depends_on).toEqual([...rulesFlow.depends_on, ...connectedFlow.depends_on]);
    expect(mergedRules.depends_on).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ from_capability: 'capability_family_exports_create' }),
      expect.objectContaining({ from_capability: 'capability_assistant_job' }),
    ]));
  });
});
