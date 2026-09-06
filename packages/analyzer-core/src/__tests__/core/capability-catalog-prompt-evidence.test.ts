import { projectCapabilityCatalogPromptEvidence, capabilityCatalogStructuralApiLabels } from '../../analyzer/core/capability-catalog-prompt-evidence';
import type { SystemCapability } from '../../types/cas.types';

function capability(overrides: Partial<SystemCapability>): SystemCapability {
  return {
    id: 'candidate',
    name: 'Scheduled Task Surface',
    description: '',
    category: 'supporting',
    operations: [],
    related_entities: [],
    related_domains: [],
    criticality: 'medium',
    criticality_factors: [],
    ...overrides,
  };
}

describe('capability catalog prompt evidence', () => {
  it('keeps public API groups as structure and proposes from their behavior', () => {
    const candidate = capability({
      name: 'Courier Request API', structural_label: 'Courier Request API Management',
      operations: [{ entry_point_id: 'request', entry_point_type: 'api', action: 'read' }],
      evidence_examples: ['request.accepts: Negotiate the response content type'],
    });
    expect(capabilityCatalogStructuralApiLabels([candidate])).toEqual(['Courier Request API', 'Courier Request API Management']);
    const result = projectCapabilityCatalogPromptEvidence(candidate);
    expect(result.name).not.toBe(candidate.name);
    expect(result.operations.join(' ')).toContain('Negotiate the response content type');
    expect(candidate.name).toBe('Courier Request API');
    expect(candidate.operations).toHaveLength(1);
  });

  it('does not classify authored library outcomes or ordinary API mentions as raw groups', () => {
    const authored = capability({
      name: 'Negotiate response formats through an API', name_source: 'manual',
      operations: [{ entry_point_id: 'request', entry_point_type: 'api', action: 'read' }],
    });
    expect(capabilityCatalogStructuralApiLabels([authored])).toEqual([]);
    expect(projectCapabilityCatalogPromptEvidence(authored).name).toBe(authored.name);
  });

  it('removes structural surface vocabulary from implementation-shaped evidence', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      name: 'Celery Task Surface',
      structural_label: 'Celery Task Surface',
      evidence_kind: 'behavior-surface',
      evidence_examples: ['celery.task.create_payment_invoice', 'celery:task:sync_orders'],
    }));

    expect(result).toEqual({
      name: 'Create payment invoice, Sync orders',
      operations: ['Create payment invoice', 'Sync orders'],
      relationships: [],
    });
  });

  it('uses observed actions when a surface has no named examples', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      evidence_kind: 'behavior-surface',
      operations: [{ entry_point_id: 'orders', entry_point_type: 'http', action: 'View' }],
    }));

    expect(result).toEqual({ name: 'View', operations: ['View'], relationships: [] });
  });

  it('keeps authored candidate names while humanizing their operation evidence', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      name: 'Order Fulfillment',
      evidence_kind: undefined,
      evidence_examples: ['submit_order'],
    }));

    expect(result).toEqual({ name: 'Order Fulfillment', operations: ['Submit order'], relationships: [] });
  });

  it('projects verified graph relationships separately from operations', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      name: 'Rules',
      depends_on: [{
        from_capability: 'bulk-update', to_capability: 'rule-update', dependency_type: 'shares-data', strength: 'common',
        evidence: { shared_services: [], shared_nodes: [], shared_entities: ['Rule', 'Transaction', 'Category'] },
        description: 'Bulk transaction updates share rule and category data',
      }],
    }));
    expect(result.relationships).toEqual([
      'Bulk transaction updates share rule and category data. Shared subjects: Rule, Transaction, Category',
    ]);
    expect(result.operations).toEqual([]);
  });
});
