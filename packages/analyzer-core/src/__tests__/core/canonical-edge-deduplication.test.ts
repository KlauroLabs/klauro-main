import type { CASEdge } from '../../types/cas.types';
import { dedupeCanonicalEdges } from '../../analyzer/core/canonical-edge-deduplication';

describe('canonical edge deduplication', () => {
  it.each([false, true])('keeps the attributed contributed edge regardless of input order', reverse => {
    const contributed: CASEdge = {
      id: 'framework-route-edge',
      source: 'route',
      target: 'handler',
      type: 'calls',
      perspectives: ['routes'],
      metadata: { attributes: { source_analyzer: 'framework' } },
    };
    const derived: CASEdge = {
      id: 'derived-route-edge',
      source: 'route',
      target: 'handler',
      type: 'calls',
      metadata: { attributes: { relationship: 'route_handler' } },
    };
    const edges = reverse ? [derived, contributed] : [contributed, derived];

    dedupeCanonicalEdges(edges);

    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe('framework-route-edge');
    expect(edges[0].metadata?.attributes).toEqual({ source_analyzer: 'framework' });
  });
});

test('deduplicates graphs larger than the JavaScript argument limit', () => {
  const edges = Array.from({ length: 150_000 }, (_, index) => ({
    id: `edge_${index}`,
    source: `source_${index}`,
    target: `target_${index}`,
    type: 'calls',
  })) as CASEdge[];

  dedupeCanonicalEdges(edges);

  expect(edges).toHaveLength(150_000);
  expect(edges[149_999].id).toBe('edge_149999');
});
