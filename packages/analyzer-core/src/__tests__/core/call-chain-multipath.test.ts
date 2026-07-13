/**
 * buildCallChains multi-path exploration tests.
 *
 * Guards the fix for the keystone flow-starvation bug: the old implementation
 * traced ONE greedy path per entry point (picking a single best-ranked edge at
 * each depth), so any handler whose non-first callee reached a terminal was
 * misclassified as dead-end (10/3,703 entry-to-exit chains on this repo).
 * The new implementation does bounded, deterministic multi-path BFS.
 */
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import type { CASNode, CASEdge, CASEntryPoint, CASExitPoint, CASCallChain } from '../../types/cas.types';

function node(id: string, type = 'function'): CASNode {
  return { id, name: id, type, file_path: `src/${id}.ts` } as unknown as CASNode;
}

function edge(source: string, target: string, type = 'calls'): CASEdge {
  return { id: `edge:${source}->${target}`, source, target, type } as unknown as CASEdge;
}

function entry(id: string, sourceNode: string): CASEntryPoint {
  return { id, source_node: sourceNode, type: 'http', name: id } as unknown as CASEntryPoint;
}

function exit(id: string, sourceNode: string, type = 'database'): CASExitPoint {
  return { id, source_node: sourceNode, type, name: id } as unknown as CASExitPoint;
}

function buildChains(
  nodes: CASNode[],
  edges: CASEdge[],
  entryPoints: CASEntryPoint[],
  exitPoints: CASExitPoint[]
): CASCallChain[] {
  const orchestrator = new AnalyzerOrchestrator() as any;
  return orchestrator.buildCallChains(nodes, edges, entryPoints, exitPoints, null);
}

describe('buildCallChains multi-path exploration', () => {
  test('entry whose SECOND callee reaches an exit is entry-to-exit (the greedy-path bug)', () => {
    // handler -> validate (dead end, but ranked first alphabetically/by edge)
    // handler -> save -> db (reaches a database exit)
    const nodes = [node('handler'), node('aValidate'), node('save'), node('db')];
    const edges = [
      edge('handler', 'aValidate'),
      edge('handler', 'save'),
      edge('save', 'db')
    ];
    const chains = buildChains(nodes, edges, [entry('ep1', 'handler')], [exit('x1', 'db')]);

    expect(chains).toHaveLength(1);
    expect(chains[0].chain_type).toBe('entry-to-exit');
    expect(chains[0].exit_point?.exit_point_id).toBe('x1');
    // The path must be a REAL path: handler -> save -> db.
    expect(chains[0].call_path.map(step => step.node_id)).toEqual(['handler', 'save', 'db']);
  });

  test('no reachable exit within depth/budget is an honest dead-end', () => {
    const nodes = [node('handler'), node('a'), node('b')];
    const edges = [edge('handler', 'a'), edge('a', 'b')];
    const chains = buildChains(nodes, edges, [entry('ep1', 'handler')], []);

    expect(chains).toHaveLength(1);
    expect(chains[0].chain_type).toBe('dead-end');
    expect(chains[0].exit_point).toBeUndefined();
  });

  test('single-node entry with no edges is dead-end (degenerate ternary fixed)', () => {
    const chains = buildChains([node('handler')], [], [entry('ep1', 'handler')], []);
    expect(chains).toHaveLength(1);
    expect(chains[0].chain_type).toBe('dead-end');
    expect(chains[0].call_path).toHaveLength(1);
  });

  test('prefers highest-value exit kind over a nearer low-value one', () => {
    // handler -> logger (analytics exit at depth 1)
    // handler -> service -> repo (database exit at depth 2)
    const nodes = [node('handler'), node('logger'), node('service'), node('repo')];
    const edges = [
      edge('handler', 'logger'),
      edge('handler', 'service'),
      edge('service', 'repo')
    ];
    const chains = buildChains(
      nodes,
      edges,
      [entry('ep1', 'handler')],
      [exit('xLog', 'logger', 'analytics'), exit('xDb', 'repo', 'database')]
    );

    expect(chains[0].chain_type).toBe('entry-to-exit');
    expect(chains[0].exit_point?.exit_point_id).toBe('xDb');
  });

  test('among same-value exits, picks the shortest path', () => {
    // handler -> nearRepo (database exit, depth 1)
    // handler -> a -> b -> farRepo (database exit, depth 3)
    const nodes = [node('handler'), node('nearRepo'), node('a'), node('b'), node('farRepo')];
    const edges = [
      edge('handler', 'a'),
      edge('a', 'b'),
      edge('b', 'farRepo'),
      edge('handler', 'nearRepo')
    ];
    const chains = buildChains(
      nodes,
      edges,
      [entry('ep1', 'handler')],
      [exit('xFar', 'farRepo', 'database'), exit('xNear', 'nearRepo', 'database')]
    );

    expect(chains[0].exit_point?.exit_point_id).toBe('xNear');
    expect(chains[0].call_path.map(s => s.node_id)).toEqual(['handler', 'nearRepo']);
  });

  test('deterministic: identical chains across runs and across input edge order', () => {
    const nodes = [node('handler'), node('a'), node('b'), node('c'), node('repo')];
    const edges = [
      edge('handler', 'a'),
      edge('handler', 'b'),
      edge('handler', 'c'),
      edge('b', 'repo'),
      edge('c', 'repo')
    ];
    const exits = [exit('x1', 'repo', 'database')];
    const entries = [entry('ep1', 'handler')];

    const run1 = buildChains(nodes, edges, entries, exits);
    const run2 = buildChains(nodes, edges, entries, exits);
    const run3 = buildChains(nodes, [...edges].reverse(), entries, exits);

    expect(JSON.stringify(run2)).toBe(JSON.stringify(run1));
    expect(JSON.stringify(run3)).toBe(JSON.stringify(run1));
  });

  test('respects the per-entry visit budget on a wide fan-out graph', () => {
    // Entry fans out to 2,000 leaf nodes; the ONLY exit hangs off the last
    // (lexicographically) leaf, beyond the visit budget. The chain must come
    // back dead-end (budget honored, no unbounded exploration) and fast.
    const width = 2000;
    const nodes: CASNode[] = [node('handler')];
    const edges: CASEdge[] = [];
    for (let i = 0; i < width; i++) {
      const id = `leaf${String(i).padStart(5, '0')}`;
      nodes.push(node(id));
      edges.push(edge('handler', id));
    }
    const exits = [exit('xFar', `leaf${String(width - 1).padStart(5, '0')}`, 'database')];

    const started = Date.now();
    const chains = buildChains(nodes, edges, [entry('ep1', 'handler')], exits);
    const elapsedMs = Date.now() - started;

    expect(chains).toHaveLength(1);
    expect(chains[0].chain_type).toBe('dead-end');
    expect(elapsedMs).toBeLessThan(2000);
  });

  test('budget still finds exits within reach on a wide graph', () => {
    // Same wide fan-out, but the exit is on an early-sorted leaf: reachable
    // within budget, so the chain is entry-to-exit.
    const width = 2000;
    const nodes: CASNode[] = [node('handler')];
    const edges: CASEdge[] = [];
    for (let i = 0; i < width; i++) {
      const id = `leaf${String(i).padStart(5, '0')}`;
      nodes.push(node(id));
      edges.push(edge('handler', id));
    }
    const exits = [exit('xNear', 'leaf00010', 'database')];

    const chains = buildChains(nodes, edges, [entry('ep1', 'handler')], exits);
    expect(chains[0].chain_type).toBe('entry-to-exit');
    expect(chains[0].exit_point?.exit_point_id).toBe('xNear');
  });
});
