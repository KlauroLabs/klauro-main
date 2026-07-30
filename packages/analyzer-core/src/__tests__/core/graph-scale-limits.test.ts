import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { internalizeInRepoCalls } from '../../analyzer/core/in-repo-call-resolution';
import { appendAll, replaceArrayContents } from '../../analyzer/core/bulk-array-ops';
import type { CASEdge, CASExitPoint, CASNode } from '../../types/cas.types';

/**
 * THE DEFECT UNDER TEST: a SCALING CLIFF, not a gradual slowdown.
 * `target.push(...source)` passes one argument per element, and past the
 * engine's argument limit it throws `RangeError: Maximum call stack size
 * exceeded`. An ordinary 3,856-file TypeScript repository crossed that limit in
 * the whole-graph edge dedupe and produced NO analysis at all — while every
 * existing gate stayed green, because every gate analyzes a small project where
 * no collection comes close.
 *
 * These cases exist because correctness at small N proves nothing here: the
 * same code path is fine at 500 edges and impossible at 200,000. They run
 * against the real passes, at a size above the limit, and are fast because they
 * build the graph directly instead of parsing a large repository.
 */

/** Comfortably above the engine argument limit (tens of thousands), and above
 *  the edge count of the repository that failed. */
const EDGE_COUNT = 250_000;

function bareNode(id: string): CASNode {
  return { id, name: id, type: 'function', level: 3, level_name: 'member', analyzers: ['x'] } as CASNode;
}

describe('graph assembly at scale', () => {
  it('collapses duplicate edges on a graph far larger than the argument limit', () => {
    const orchestrator = new AnalyzerOrchestrator() as any;
    const nodes: CASNode[] = [bareNode('sink')];
    const edges: CASEdge[] = [];
    // The spread that failed is over the SURVIVING (deduped) edges, so the
    // survivors are what has to exceed the limit: DISTINCT (source,target,type)
    // triples. A graph of 250,000 identical edges collapses to one and proves
    // nothing — the first version of this test made exactly that mistake and
    // passed against the broken code.
    for (let i = 0; i < EDGE_COUNT; i++) {
      nodes.push(bareNode(`caller${i}`));
      edges.push({ id: `e${i}`, source: `caller${i}`, target: 'sink', type: 'calls' } as CASEdge);
    }
    // Plus a few genuine duplicates, so the pass rewrites the array instead of
    // short-circuiting on "nothing changed".
    for (let i = 0; i < 5; i++) {
      edges.push({ id: `dup${i}`, source: 'caller0', target: 'sink', type: 'calls' } as CASEdge);
    }

    expect(() => orchestrator.resolveNodeTwins(nodes, edges, [], [])).not.toThrow();
    // Survivors still exceed the argument limit, and the duplicates collapsed.
    expect(edges.length).toBe(EDGE_COUNT);
  });

  it('reconciles dropped exit points on a graph far larger than the argument limit', () => {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const exitPoints: CASExitPoint[] = [];
    const COUNT = 120_000;
    for (let i = 0; i < COUNT; i++) {
      nodes.push({
        ...bareNode(`caller${i}`),
        source: { file: `src/callers/c${i}.ts`, line: 1, end_line: 5 } as any,
      });
      nodes.push({
        ...bareNode(`useThing${i}`),
        name: `useThing${i}`,
        source: { file: `src/hooks/thing${i}.ts`, line: 1, end_line: 5 } as any,
      });
      exitPoints.push({
        id: `exit_sdk_${i}`,
        source_node: `caller${i}`,
        type: 'sdk',
        name: `useThing${i}`,
        target: { sdk: `@/hooks/thing${i}` },
        metadata: { module: `@/hooks/thing${i}`, function: `useThing${i}`, call_line: 2 },
      } as CASExitPoint);
      edges.push({ id: `call_${i}`, source: `caller${i}`, target: `exit_sdk_${i}`, type: 'calls' } as CASEdge);
    }

    expect(() => internalizeInRepoCalls({ nodes, edges, exitPoints, libraries: [] })).not.toThrow();

    // And the invariant still holds at this size: nothing dangling.
    const endpointIds = new Set<string>([...nodes.map(n => n.id), ...exitPoints.map(e => e.id)]);
    const dangling = edges.filter(e => !endpointIds.has(e.source) || !endpointIds.has(e.target));
    expect(dangling).toEqual([]);
  });
});

describe('bulk array operations', () => {
  it('appends past the argument limit', () => {
    const target: number[] = [];
    const source = Array.from({ length: EDGE_COUNT }, (_, i) => i);
    expect(() => appendAll(target, source)).not.toThrow();
    expect(target.length).toBe(EDGE_COUNT);
    expect(target[EDGE_COUNT - 1]).toBe(EDGE_COUNT - 1);
  });

  it('replaces past the argument limit, preserving order', () => {
    const target = [1, 2, 3];
    const source = Array.from({ length: EDGE_COUNT }, (_, i) => i);
    expect(() => replaceArrayContents(target, source)).not.toThrow();
    expect(target.length).toBe(EDGE_COUNT);
    expect(target[0]).toBe(0);
    expect(target[EDGE_COUNT - 1]).toBe(EDGE_COUNT - 1);
  });

  it('is a no-op when replacing an array with itself rather than emptying it', () => {
    const target = [1, 2, 3];
    replaceArrayContents(target, target);
    expect(target).toEqual([1, 2, 3]);
  });

  it('demonstrates the construct it replaces actually fails at this size', () => {
    const source = Array.from({ length: EDGE_COUNT }, (_, i) => i);
    // This is the shape that shipped. Kept as an executable statement of WHY the
    // helpers exist, so nobody "simplifies" them back into a spread.
    expect(() => {
      const target: number[] = [];
      target.push(...source);
    }).toThrow(RangeError);
  });
});
