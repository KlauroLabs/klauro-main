/**
 * buildCallChains multi-path exploration tests.
 *
 * Guards the fix for the keystone flow-starvation bug: the old implementation
 * traced ONE greedy path per entry point (picking a single best-ranked edge at
 * each depth), so any handler whose non-first callee reached a terminal was
 * misclassified as dead-end (10/3,703 entry-to-exit chains on this repo).
 * The implementation performs deterministic, cycle-safe traversal, preserves
 * every reachable terminal, and projects one canonical evidence path per exit.
 * Alternate routes remain losslessly represented by the CAS relationship graph.
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

  test('among same-value exits, picks the DEEPEST path (the fuller narrative)', () => {
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

    // CONTRACT CHANGE (comprehension lane): shortest-path-wins pinned a flow's
    // terminus to the FIRST side effect on the way out, which on real repos
    // meant the entry function's own first outbound call — the measured cause
    // of a flow population that was 70-96% single-step. An exit point is
    // something a chain passes through; the terminus a reader wants is the LAST
    // thing it does. At equal exit VALUE the deeper path is therefore the
    // better answer. (Exit value still dominates: the test above still prefers
    // a distant database exit over a nearer analytics one.)
    expect(chains[0].exit_point?.exit_point_id).toBe('xFar');
    expect(chains[0].call_path.map(s => s.node_id)).toEqual(['handler', 'a', 'b', 'farRepo']);
  });

  test('an exit point is not a wall: the walk continues past an exit-bearing node that still calls in-repo code', () => {
    // REGRESSION (comprehension lane): entry -> mid -> repo, where `mid` is in
    // a DIFFERENT PACKAGE from the entry and itself carries an sdk exit. The
    // old walk stopped dead at `mid` (any exit-bearing node ended the chain,
    // and a rank-0 exit abandoned the BFS outright), so the flow terminated at
    // an in-repo function and reported an SDK boundary that the chain had not
    // actually reached the end of. The chain must keep going and terminate at
    // the real terminal.
    const nodes = [node('pkgA/entry'), node('pkgB/mid'), node('pkgB/repo')];
    const edges = [edge('pkgA/entry', 'pkgB/mid'), edge('pkgB/mid', 'pkgB/repo')];
    const chains = buildChains(
      nodes,
      edges,
      [entry('ep1', 'pkgA/entry')],
      [exit('xMidSdk', 'pkgB/mid', 'sdk'), exit('xRepoDb', 'pkgB/repo', 'database')]
    );

    expect(chains[0].chain_type).toBe('entry-to-exit');
    expect(chains[0].exit_point?.exit_point_id).toBe('xRepoDb');
    expect(chains[0].call_path.map(s => s.node_id)).toEqual(['pkgA/entry', 'pkgB/mid', 'pkgB/repo']);
  });

  test('a genuinely terminal exit-bearing node with nowhere left to go still ends the chain', () => {
    // The other half of the same rule: honest behavior at a real boundary. A
    // node whose only outbound work is the third-party call IS the terminus.
    const nodes = [node('handler'), node('stripeClient')];
    const edges = [edge('handler', 'stripeClient')];
    const chains = buildChains(
      nodes,
      edges,
      [entry('ep1', 'handler')],
      [exit('xStripe', 'stripeClient', 'sdk')]
    );

    expect(chains[0].chain_type).toBe('entry-to-exit');
    expect(chains[0].exit_point?.exit_point_id).toBe('xStripe');
    expect(chains[0].call_path.map(s => s.node_id)).toEqual(['handler', 'stripeClient']);
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


  test('preserves every distinct exit and projects one deterministic path to a shared exit', () => {
    const nodes = [
      node('handler'), node('left'), node('right'), node('shared'),
      node('audit'), node('database'),
    ];
    const edges = [
      edge('handler', 'left'),
      edge('handler', 'right'),
      edge('left', 'shared'),
      edge('right', 'shared'),
      edge('handler', 'audit'),
      edge('handler', 'database'),
    ];
    const chains = buildChains(
      nodes,
      edges,
      [entry('ep1', 'handler')],
      [exit('xShared', 'shared', 'api'), exit('xAudit', 'audit', 'analytics'), exit('xDb', 'database', 'database')]
    );

    expect(chains).toHaveLength(3);
    expect(chains.map(chain => chain.exit_point?.exit_point_id).sort()).toEqual([
      'xAudit', 'xDb', 'xShared',
    ]);
    const sharedPath = chains.find(chain => chain.exit_point?.exit_point_id === 'xShared');
    expect(sharedPath?.call_path.map(step => step.node_id)).toEqual(['handler', 'left', 'shared']);
    expect(edges.map(item => item.id)).toContain('edge:right->shared');
    expect(new Set(chains.map(chain => chain.id)).size).toBe(3);
  });

  test('dense branch-and-merge graphs retain every terminal without materializing path permutations', () => {
    const layers = 28;
    const nodes = [node('handler')];
    const edges: CASEdge[] = [];
    let previous = ['handler'];
    for (let layer = 0; layer < layers; layer++) {
      const current = [`layer_${layer}_a`, `layer_${layer}_b`];
      nodes.push(...current.map(id => node(id)));
      for (const source of previous) for (const target of current) edges.push(edge(source, target));
      previous = current;
    }
    nodes.push(node('terminal'));
    for (const source of previous) edges.push(edge(source, 'terminal'));

    const started = Date.now();
    const chains = buildChains(nodes, edges, [entry('dense-entry', 'handler')], [exit('dense-exit', 'terminal', 'database')]);

    expect(chains).toHaveLength(1);
    expect(chains[0].exit_point?.exit_point_id).toBe('dense-exit');
    expect(chains[0].call_path).toHaveLength(layers + 2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('structural relationships do not masquerade as executed flow steps', () => {
    const nodes = [node('handler'), node('dependency'), node('terminal')];
    const edges = [
      edge('handler', 'dependency', 'depends_on'),
      edge('dependency', 'terminal'),
    ];
    const chains = buildChains(nodes, edges, [entry('ep1', 'handler')], [exit('x1', 'terminal', 'database')]);

    expect(chains).toHaveLength(1);
    expect(chains[0].chain_type).toBe('dead-end');
    expect(chains[0].call_path.map(step => step.node_id)).toEqual(['handler']);
  });

  test('preserves exits and exact edge provenance beyond the former depth cap', () => {
    const depth = 20;
    const nodes = Array.from({ length: depth + 1 }, (_, index) => node(`deep_${index}`));
    const edges = Array.from({ length: depth }, (_, index) => edge(`deep_${index}`, `deep_${index + 1}`));
    const chains = buildChains(
      nodes,
      edges,
      [entry('deep-entry', 'deep_0')],
      [exit('deep-exit', `deep_${depth}`, 'database')]
    );

    expect(chains).toHaveLength(1);
    expect(chains[0].call_path).toHaveLength(depth + 1);
    expect(chains[0].call_path[depth]).toMatchObject({
      call_id: `edge:deep_${depth - 1}->deep_${depth}`,
      node_id: `deep_${depth}`,
      depth,
    });
  });

  test('cycles terminate without hiding an exit and record circular provenance', () => {
    const nodes = [node('handler'), node('a'), node('b'), node('terminal')];
    const edges = [
      edge('handler', 'a'),
      edge('a', 'b'),
      edge('b', 'a'),
      edge('b', 'terminal'),
    ];
    const chains = buildChains(
      nodes,
      edges,
      [entry('cycle-entry', 'handler')],
      [exit('cycle-exit', 'terminal', 'api')]
    );

    expect(chains).toHaveLength(1);
    expect(chains[0].call_path.map(step => step.node_id)).toEqual(['handler', 'a', 'b', 'terminal']);
    expect(chains[0].characteristics.is_circular).toBe(true);
    expect(chains[0].characteristics.is_recursive).toBe(false);
  });

  test('preserves exits beyond the former per-entry visit budget on a wide fan-out graph', () => {
    // Entry fans out to 2,000 leaf nodes; the only exit hangs off the last
    // lexicographic leaf, beyond the former visit budget. Canonical CAS must retain it.
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
    expect(chains[0].chain_type).toBe('entry-to-exit');
    expect(chains[0].exit_point?.exit_point_id).toBe('xFar');
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

describe('buildCallChains capability-operation seeded roots', () => {
  // Bridge-gap shape: entry_points only carries a test suite (no outgoing call
  // edges), while a capabilities operation anchors the REAL handler via
  // a node: reference. The seeded root must produce an entry-to-exit chain.
  function seededFixture() {
    const nodes = [
      node('testSuite', 'test'),
      node('reconcile', 'function'),
      node('save', 'function'),
      node('db'),
      node('orphan', 'function'),
    ];
    const graph = [
      edge('reconcile', 'save'),
      edge('save', 'db'),
    ];
    const entryPoints = [{ id: 'ep_t', source_node: 'testSuite', type: 'test', name: 'suite' } as unknown as CASEntryPoint];
    const exitPoints = [exit('x_db', 'db')];
    const caps = [{
      id: 'cap_r', name: 'Reconciliation', category: 'core', criticality: 'high',
      operations: [
        { action: 'reconcile', entry_point_id: 'node:reconcile', entry_point_type: 'internal' },
        { action: 'orphaned op', entry_point_id: 'node:orphan', entry_point_type: 'internal' },
        { action: 'missing node', entry_point_id: 'node:doesNotExist', entry_point_type: 'internal' },
      ],
    }];
    return { nodes, graph, entryPoints, exitPoints, caps };
  }

  function buildChainsWithCaps(f: ReturnType<typeof seededFixture>): CASCallChain[] {
    const orchestrator = new AnalyzerOrchestrator() as any;
    return orchestrator.buildCallChains(f.nodes, f.graph, f.entryPoints, f.exitPoints, null, f.caps);
  }

  test('a capability node:-anchored operation with no entry_points root seeds an entry-to-exit chain', () => {
    const chains = buildChainsWithCaps(seededFixture());
    const seeded = chains.find(c => c.entry_point.entry_point_id === 'synthflow:reconcile');
    expect(seeded).toBeDefined();
    expect(seeded!.chain_type).toBe('entry-to-exit');
    expect(seeded!.exit_point?.exit_point_id).toBe('x_db');
    expect(seeded!.call_path.map(s => s.node_id)).toEqual(['reconcile', 'save', 'db']);
  });

  test('seeded roots that reach no exit contribute NO chain (synthetic dead-ends dropped); real dead-ends kept', () => {
    const chains = buildChainsWithCaps(seededFixture());
    // orphan seeds but dead-ends -> dropped; missing node never seeds.
    expect(chains.find(c => c.entry_point.entry_point_id === 'synthflow:orphan')).toBeUndefined();
    // the real test entry keeps its honest dead-end chain.
    const real = chains.find(c => c.entry_point.entry_point_id === 'ep_t');
    expect(real).toBeDefined();
    expect(real!.chain_type).toBe('dead-end');
    expect(chains).toHaveLength(2);
  });

  test('a node already rooted by a real entry point is never double-seeded', () => {
    const f = seededFixture();
    f.entryPoints.push(entry('ep_real', 'reconcile'));
    const chains = buildChainsWithCaps(f);
    expect(chains.filter(c => c.entry_point.node_id === 'reconcile')).toHaveLength(1);
    expect(chains.find(c => c.entry_point.entry_point_id === 'synthflow:reconcile')).toBeUndefined();
  });

  test('no capabilities passed — behavior unchanged (back-compat default)', () => {
    const f = seededFixture();
    const orchestrator = new AnalyzerOrchestrator() as any;
    const chains: CASCallChain[] = orchestrator.buildCallChains(f.nodes, f.graph, f.entryPoints, f.exitPoints, null);
    expect(chains).toHaveLength(1);
    expect(chains[0].chain_type).toBe('dead-end');
  });

  test('language runtime helpers do not become behavioral terminals', () => {
    const nodes = [node('handler'), node('formatter'), node('stripe')];
    const edges = [edge('handler', 'formatter'), edge('handler', 'stripe')];
    const chains = buildChains(
      nodes,
      edges,
      [entry('ep1', 'handler')],
      [
        { ...exit('xFmt', 'formatter', 'sdk'), name: 'External call: fmt.Sprintf' },
        { ...exit('xStripe', 'stripe', 'sdk'), name: 'External call: stripe.Charge' },
      ]
    );

    expect(chains.map(chain => chain.exit_point?.exit_point_id)).toEqual(['xStripe']);
  });
});
