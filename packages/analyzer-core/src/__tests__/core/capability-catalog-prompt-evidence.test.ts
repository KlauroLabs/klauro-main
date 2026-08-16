import { projectCapabilityCatalogPromptEvidence } from '../../analyzer/core/capability-catalog-prompt-evidence';
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
    });
  });

  it('uses observed actions when a surface has no named examples', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      evidence_kind: 'behavior-surface',
      operations: [{ entry_point_id: 'orders', entry_point_type: 'http', action: 'View' }],
    }));

    expect(result).toEqual({ name: 'View', operations: ['View'] });
  });

  it('keeps authored candidate names while humanizing their operation evidence', () => {
    const result = projectCapabilityCatalogPromptEvidence(capability({
      name: 'Order Fulfillment',
      evidence_kind: undefined,
      evidence_examples: ['submit_order'],
    }));

    expect(result).toEqual({ name: 'Order Fulfillment', operations: ['Submit order'] });
  });
});
