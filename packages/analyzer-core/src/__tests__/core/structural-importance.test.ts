/**
 * Structural Importance — deterministic seeded random-walk centrality
 * (analyzer/core/structural-importance.ts).
 *
 * Invariants under test:
 * - known-graph fixture matches a hand-computed closed-form ranking,
 * - byte-stable determinism (input array order must not matter),
 * - mandatory seed filtering (test entry points / test nodes / scaffold paths
 *   never seed the walk),
 * - convergence bookkeeping (converged flag, iteration cap honored),
 * - additive contract (never mutates nodes/edges/entry points).
 */

import {
  computeStructuralImportance,
  resolveSeedNodeIds,
} from '../../analyzer/core/structural-importance';
import { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';

function node(id: string, extra: Partial<CASNode> = {}): CASNode {
  return { id, name: id, type: 'function', ...extra } as CASNode;
}

function edge(source: string, target: string, type = 'calls'): CASEdge {
  return { id: `${source}->${target}:${type}`, source, target, type };
}

function entryPoint(id: string, sourceNode: string, type: CASEntryPoint['type'] = 'http'): CASEntryPoint {
  return {
    id,
    source_node: sourceNode,
    type,
    name: id,
  } as CASEntryPoint;
}

describe('computeStructuralImportance', () => {
  test('known-graph fixture: hand-computed chain ranking', () => {
    // Seeded at a; chain a -> b -> c -> d; x isolated.
    // Closed form with damping 0.85 and dangling mass restarting at the seed:
    //   r(a) = 0.15 + 0.85 * r(d)
    //   r(b) = 0.85 * r(a); r(c) = 0.85 * r(b); r(d) = 0.85 * r(c)
    // => r(a) = 0.15 / (1 - 0.85^4) = 0.31381...; each hop is 0.85x the last;
    //    x receives no mass at all.
    const nodes = [node('a'), node('b'), node('c'), node('d'), node('x')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
    const entryPoints = [entryPoint('ep-a', 'a')];

    const { scores, meta } = computeStructuralImportance(nodes, edges, entryPoints);

    expect(meta.seed_source).toBe('entry-points');
    expect(meta.seed_count).toBe(1);
    expect(meta.converged).toBe(true);

    // Normalized: the seed head of the chain is the maximum.
    expect(scores.get('a')).toBe(1);
    // Each hop carries exactly damping (0.85) of the previous node's mass.
    expect(scores.get('b')!).toBeCloseTo(0.85, 6);
    expect(scores.get('c')!).toBeCloseTo(0.85 * 0.85, 6);
    expect(scores.get('d')!).toBeCloseTo(0.85 * 0.85 * 0.85, 6);
    // Unreachable node gets zero — no keyword, no default floor.
    expect(scores.get('x')).toBe(0);

    // Strict hand-computed ordering.
    const ranked = [...scores.entries()].sort((l, r) => r[1] - l[1]).map(([id]) => id);
    expect(ranked).toEqual(['a', 'b', 'c', 'd', 'x']);
  });

  test('deterministic: input array order never changes the output', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d'), node('e')];
    const edges = [
      edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'),
      edge('d', 'e'), edge('e', 'b', 'uses'),
    ];
    const entryPoints = [entryPoint('ep-a', 'a'), entryPoint('ep-c', 'c')];

    const first = computeStructuralImportance(nodes, edges, entryPoints);
    const second = computeStructuralImportance(
      [...nodes].reverse(),
      [...edges].reverse(),
      [...entryPoints].reverse()
    );

    // Byte-stable: identical maps AND identical meta regardless of input order.
    expect(Object.fromEntries(second.scores)).toEqual(Object.fromEntries(first.scores));
    expect(second.meta).toEqual(first.meta);
    // Scores are pre-rounded for stable serialization.
    for (const value of first.scores.values()) {
      expect(value).toBe(Number(value.toFixed(8)));
    }
  });

  test('seed filtering: test entry points, test nodes, and scaffold paths never seed', () => {
    const nodes = [
      node('real'),
      node('test-node', { metadata: { is_test: true } }),
      node('scaffold-node', { source: { file: 'src/__tests__/helper.ts' } }),
      node('colocated', { source: { file: 'src/thing.test.ts' } }),
    ];
    const nodesById = new Map(nodes.map(n => [n.id, n]));
    const entryPoints = [
      entryPoint('ep-real', 'real'),
      entryPoint('ep-test-kind', 'real', 'test'),         // test-kind entry point: excluded
      entryPoint('ep-test-node', 'test-node'),            // resolves to is_test node: excluded
      entryPoint('ep-scaffold', 'scaffold-node'),         // scaffold dir: excluded
      entryPoint('ep-colocated', 'colocated'),            // co-located test file: excluded
      entryPoint('ep-missing', 'not-in-graph'),           // unresolvable: excluded
    ];

    expect(resolveSeedNodeIds(entryPoints, nodesById)).toEqual(['real']);

    const { scores, meta } = computeStructuralImportance(nodes, [], entryPoints);
    expect(meta.seed_count).toBe(1);
    expect(meta.seed_source).toBe('entry-points');
    expect(scores.get('real')).toBe(1);
    expect(scores.get('test-node')).toBe(0);
  });

  test('uniform fallback when no non-test entry point exists', () => {
    const nodes = [node('a'), node('b')];
    const entryPoints = [entryPoint('ep-t', 'a', 'test')];
    const { meta } = computeStructuralImportance(nodes, [edge('a', 'b')], entryPoints);
    expect(meta.seed_source).toBe('uniform');
    expect(meta.seed_count).toBe(2);
  });

  test('convergence bookkeeping and iteration cap', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    const entryPoints = [entryPoint('ep', 'a')];

    const converging = computeStructuralImportance(nodes, edges, entryPoints);
    expect(converging.meta.converged).toBe(true);
    expect(converging.meta.iterations).toBeGreaterThan(0);
    expect(converging.meta.iterations).toBeLessThanOrEqual(converging.meta.max_iterations);

    // With an unreachable epsilon the cap must hold and be reported honestly.
    const capped = computeStructuralImportance(nodes, edges, entryPoints, { epsilon: 0, maxIterations: 5 });
    expect(capped.meta.converged).toBe(false);
    expect(capped.meta.iterations).toBe(5);
  });

  test('additive contract: inputs are never mutated; only call-ish edges count', () => {
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b'), edge('a', 'b', 'contains'), edge('b', 'a', 'imports')];
    const entryPoints = [entryPoint('ep', 'a')];
    const nodesSnapshot = JSON.stringify(nodes);
    const edgesSnapshot = JSON.stringify(edges);
    const entryPointsSnapshot = JSON.stringify(entryPoints);

    const { meta } = computeStructuralImportance(nodes, edges, entryPoints);

    // contains/imports are structural, not call-ish — only a->b counts.
    expect(meta.edge_count).toBe(1);
    expect(JSON.stringify(nodes)).toBe(nodesSnapshot);
    expect(JSON.stringify(edges)).toBe(edgesSnapshot);
    expect(JSON.stringify(entryPoints)).toBe(entryPointsSnapshot);
  });

  test('empty graph returns an empty, converged result', () => {
    const { scores, meta } = computeStructuralImportance([], [], []);
    expect(scores.size).toBe(0);
    expect(meta.node_count).toBe(0);
    expect(meta.converged).toBe(true);
  });
});
