import { catalogEvidenceCandidates } from '../../analyzer/core/capability-catalog-evidence';
import type { SystemCapability } from '../../types/cas.types';

function candidate(id: string, name: string, category: SystemCapability['category'], actions: string[]): SystemCapability {
  return {
    id,
    name,
    structural_label: `${name} Management`,
    description: `${name} behavior backed by observed operations.`,
    category,
    criticality: 'medium',
    criticality_factors: [],
    related_entities: [],
    related_domains: [],
    operations: actions.map((action, index) => ({
      entry_point_id: `${id}_${index}`,
      entry_point_type: 'internal' as const,
      action,
    })),
  } as SystemCapability;
}

describe('catalogEvidenceCandidates', () => {
  test('keeps internally executed product behavior corroborated by first-party concepts', () => {
    const selected = catalogEvidenceCandidates([
      candidate('product', 'Product', 'core', ['Coordinate', 'Generate']),
      candidate('cart', 'Cart', 'supporting', ['Read', 'Update']),
      candidate('cart-notification', 'Cart Notification', 'supporting', ['Read', 'Process']),
      candidate('placeholder', 'Placeholder', 'supporting', ['Coordinate', 'Coordinate', 'Coordinate']),
      candidate('widths', 'Widths', 'supporting', ['Read', 'Generate']),
    ], [], [], 'app', { concepts: ['product', 'cart', 'storefront'] });

    expect(selected.map(item => item.id)).toEqual(['product', 'cart']);
  });

  test('does not promote a single internal occurrence or uncorroborated implementation family', () => {
    const selected = catalogEvidenceCandidates([
      candidate('quantity', 'Quantity', 'core', ['Update']),
      candidate('renderer', 'Renderer', 'core', ['Generate', 'Generate']),
    ], [], [], 'app', { concepts: ['quantity', 'commerce'] });

    expect(selected).toEqual([]);
  });
});
