import { describe, it, expect } from 'vitest';
import { computeGraphNodeLayout, filterEdgesToKnownNodes, type GraphNode } from '@/shared/components/diagram/graphLayout';

function node(id: string, label: string, cluster?: string, weight = 0): GraphNode {
  return { id, label, cluster, weight };
}

describe('computeGraphNodeLayout', () => {
  it('is a pure function: identical inputs produce identical positions', () => {
    const nodes = [node('a', 'A'), node('b', 'B')];
    const first = computeGraphNodeLayout(nodes);
    const second = computeGraphNodeLayout(nodes);
    expect(first).toEqual(second);
  });

  it('places every node, one column, when at or under the cluster threshold', () => {
    const nodes = [node('a', 'A', 'x'), node('b', 'B', 'y')];
    const layout = computeGraphNodeLayout(nodes);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0].name).toBe('all');
  });

  it('groups into one column per cluster once past the threshold', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => node(`n${i}`, `N${i}`, i < 6 ? 'a' : 'b'));
    const layout = computeGraphNodeLayout(nodes, { clusterThreshold: 10 });
    expect(layout.clusters.map(c => c.name)).toEqual(['a', 'b']);
    expect(layout.nodes).toHaveLength(12);
  });

  it('buckets a missing cluster as "other" rather than guessing', () => {
    const nodes = Array.from({ length: 11 }, (_, i) => node(`n${i}`, `N${i}`, i < 5 ? 'known' : undefined));
    const layout = computeGraphNodeLayout(nodes, { clusterThreshold: 10 });
    expect(layout.clusters.map(c => c.name)).toEqual(['known', 'other']);
  });

  it('grows node height with weight, capped at maxHeight', () => {
    const layout = computeGraphNodeLayout([node('a', 'A', undefined, 0), node('b', 'B', undefined, 50)], {
      minHeight: 44,
      maxHeight: 96,
      headerHeight: 32,
      weightRowHeight: 4,
    });
    const [low, high] = layout.nodes;
    expect(low.height).toBe(44); // 32 + 0*4 = 32, floored to min
    expect(high.height).toBe(96); // 32 + 50*4 = 232, capped at max
  });

  it('positions columns left to right with no overlap', () => {
    const nodes = Array.from({ length: 11 }, (_, i) => node(`n${i}`, `N${i}`, i < 5 ? 'a' : 'b'));
    const layout = computeGraphNodeLayout(nodes, { clusterThreshold: 10 });
    const [colA, colB] = layout.clusters;
    expect(colB.x).toBeGreaterThan(colA.x + colA.width);
  });
});

describe('filterEdgesToKnownNodes', () => {
  it('keeps only edges whose source and target are both known', () => {
    const known = new Set(['a', 'b']);
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'outside' },
      { source: 'outside', target: 'b' },
    ];
    expect(filterEdgesToKnownNodes(edges, known)).toEqual([{ source: 'a', target: 'b' }]);
  });

  it('returns an empty array when given no edges', () => {
    expect(filterEdgesToKnownNodes([], new Set())).toEqual([]);
  });
});
