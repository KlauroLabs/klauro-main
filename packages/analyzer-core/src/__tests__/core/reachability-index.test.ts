import {
  buildReachabilityIndex,
  ReachabilityIndex,
  callEdgePairs,
  reachabilityEdgePairs,
  buildReachabilityIndexFromCas,
  type EdgePair,
} from '../../analyzer/core/reachability-index';

// ---------------------------------------------------------------------------
// Brute-force reference implementations (the ground truth the index must
// exactly reproduce).
// ---------------------------------------------------------------------------

function bruteReach(nodes: string[], edges: EdgePair[], from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const [s, t] of edges) {
    if (!adj.has(s)) adj.set(s, []);
    adj.get(s)!.push(t);
  }
  const visited = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const v = queue.shift()!;
    for (const w of adj.get(v) ?? []) {
      if (w === to) return true;
      if (!visited.has(w)) {
        visited.add(w);
        queue.push(w);
      }
    }
  }
  return false;
}

function bruteAffected(
  edges: EdgePair[],
  seeds: string[],
  direction: 'upstream' | 'downstream' | 'both'
): Set<string> {
  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const [s, t] of edges) {
    if (!fwd.has(s)) fwd.set(s, []);
    fwd.get(s)!.push(t);
    if (!rev.has(t)) rev.set(t, []);
    rev.get(t)!.push(s);
  }
  const visited = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const v = queue.shift()!;
    const next = direction === 'downstream'
      ? (fwd.get(v) ?? [])
      : direction === 'upstream'
        ? (rev.get(v) ?? [])
        : [...(fwd.get(v) ?? []), ...(rev.get(v) ?? [])];
    for (const w of next) {
      if (!visited.has(w)) {
        visited.add(w);
        queue.push(w);
      }
    }
  }
  for (const s of seeds) visited.delete(s);
  return visited;
}

/** Deterministic PRNG (mulberry32) — random-graph tests must be replayable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(n: number, m: number, seed: number): { nodes: string[]; edges: EdgePair[] } {
  const rand = rng(seed);
  const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
  const edges: EdgePair[] = [];
  for (let k = 0; k < m; k++) {
    const s = nodes[Math.floor(rand() * n)];
    const t = nodes[Math.floor(rand() * n)];
    if (s !== t) edges.push([s, t]);
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// SCC correctness on cyclic fixtures
// ---------------------------------------------------------------------------

describe('reachability-index: SCC condensation', () => {
  test('collapses a simple cycle into one component', () => {
    const idx = buildReachabilityIndex(
      ['a', 'b', 'c', 'd'],
      [['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd']]
    );
    // a,b,c mutually reachable -> one SCC; d alone.
    expect(idx.stats.comps).toBe(2);
    expect(idx.stats.largest_scc).toBe(3);
    const r = ReachabilityIndex.from(idx);
    expect(r.canReach('a', 'c')).toBe(true);
    expect(r.canReach('c', 'a')).toBe(true);
    expect(r.canReach('b', 'd')).toBe(true);
    expect(r.canReach('d', 'a')).toBe(false);
  });

  test('two disjoint cycles bridged by one edge', () => {
    const edges: EdgePair[] = [
      ['a', 'b'], ['b', 'a'], // cycle 1
      ['x', 'y'], ['y', 'x'], // cycle 2
      ['b', 'x'], // bridge
    ];
    const r = ReachabilityIndex.build(['a', 'b', 'x', 'y'], edges);
    expect(r.toJSON().stats.comps).toBe(2);
    expect(r.canReach('a', 'y')).toBe(true);
    expect(r.canReach('y', 'a')).toBe(false);
    expect(r.canReach('x', 'y')).toBe(true);
  });

  test('nested/overlapping cycles form a single SCC', () => {
    // a->b->c->a and b->d->b: all of a,b,c,d strongly connected via b.
    const r = ReachabilityIndex.build(
      ['a', 'b', 'c', 'd'],
      [['a', 'b'], ['b', 'c'], ['c', 'a'], ['b', 'd'], ['d', 'b']]
    );
    expect(r.toJSON().stats.comps).toBe(1);
    expect(r.toJSON().stats.largest_scc).toBe(4);
    for (const from of ['a', 'b', 'c', 'd']) {
      for (const to of ['a', 'b', 'c', 'd']) {
        expect(r.canReach(from, to)).toBe(true);
      }
    }
  });

  test('self-loops and duplicate edges do not distort the index', () => {
    const r = ReachabilityIndex.build(
      ['a', 'b'],
      [['a', 'a'], ['a', 'b'], ['a', 'b'], ['b', 'b']]
    );
    expect(r.canReach('a', 'b')).toBe(true);
    expect(r.canReach('b', 'a')).toBe(false);
    expect(r.toJSON().stats.edges).toBe(1); // deduped, self-loops dropped
  });
});

// ---------------------------------------------------------------------------
// Reachability equivalence vs brute-force BFS on random graphs
// ---------------------------------------------------------------------------

describe('reachability-index: equivalence vs brute-force BFS', () => {
  const shapes = [
    { n: 50, m: 120, seed: 1 },
    { n: 200, m: 500, seed: 2 },
    { n: 1000, m: 2500, seed: 3 },
    { n: 3000, m: 9000, seed: 4 }, // a few thousand nodes, cyclic by construction
    { n: 500, m: 100, seed: 5 }, // sparse/disconnected
    { n: 100, m: 2000, seed: 6 }, // dense, big SCCs
  ];

  test.each(shapes)('canReach matches BFS on random graph n=$n m=$m', ({ n, m, seed }) => {
    const { nodes, edges } = randomGraph(n, m, seed);
    const r = ReachabilityIndex.build(nodes, edges);
    const rand = rng(seed * 7919);
    for (let q = 0; q < 500; q++) {
      const a = nodes[Math.floor(rand() * n)];
      const b = nodes[Math.floor(rand() * n)];
      const expected = bruteReach(nodes, edges, a, b);
      // Nodes with no incident edge are absent from the index and reach only
      // themselves — same answer BFS gives, so no special-casing here.
      expect(r.canReach(a, b)).toBe(expected);
    }
  });

  test.each(shapes.slice(0, 4))('affectedSet matches BFS closure on random graph n=$n m=$m', ({ n, m, seed }) => {
    const { nodes, edges } = randomGraph(n, m, seed);
    const r = ReachabilityIndex.build(nodes, edges);
    const rand = rng(seed * 104729);
    for (let q = 0; q < 25; q++) {
      const seeds = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => nodes[Math.floor(rand() * n)]);
      for (const direction of ['upstream', 'downstream', 'both'] as const) {
        const expected = bruteAffected(edges, [...new Set(seeds)], direction);
        const got = r.affectedSet(seeds, { direction });
        expect(got.truncated).toBe(false);
        expect(new Set(got.affected)).toEqual(expected);
      }
    }
  });

  test('affectedSet respects maxNodes and reports truncation', () => {
    // Chain 0 -> 1 -> ... -> 99; upstream closure of the tail is 99 nodes.
    const nodes = Array.from({ length: 100 }, (_, i) => `c${String(i).padStart(3, '0')}`);
    const edges: EdgePair[] = [];
    for (let i = 0; i + 1 < 100; i++) edges.push([nodes[i], nodes[i + 1]]);
    const r = ReachabilityIndex.build(nodes, edges);
    const full = r.affectedSet([nodes[99]], { direction: 'upstream' });
    expect(full.affected.length).toBe(99);
    expect(full.truncated).toBe(false);
    const capped = r.affectedSet([nodes[99]], { direction: 'upstream', maxNodes: 10 });
    expect(capped.affected.length).toBeLessThanOrEqual(10);
    expect(capped.truncated).toBe(true);
  });

  test('affectedSet respects maxDepth (condensation hops)', () => {
    const nodes = ['a', 'b', 'c', 'd'];
    const edges: EdgePair[] = [['a', 'b'], ['b', 'c'], ['c', 'd']];
    const r = ReachabilityIndex.build(nodes, edges);
    const oneHop = r.affectedSet(['d'], { direction: 'upstream', maxDepth: 1 });
    expect(oneHop.affected).toEqual(['c']);
    expect(oneHop.truncated).toBe(true); // b and a were cut off
    const twoHop = r.affectedSet(['d'], { direction: 'upstream', maxDepth: 2 });
    expect(twoHop.affected).toEqual(['b', 'c']);
    const all = r.affectedSet(['d'], { direction: 'upstream', maxDepth: 3 });
    expect(all.affected).toEqual(['a', 'b', 'c']);
    expect(all.truncated).toBe(false);
  });

  test('includeSeeds includes seeds and their SCC co-members', () => {
    const r = ReachabilityIndex.build(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['b', 'c']]);
    const without = r.affectedSet(['a'], { direction: 'downstream' });
    expect(without.affected).toEqual(['b', 'c']);
    const withSeeds = r.affectedSet(['a'], { direction: 'downstream', includeSeeds: true });
    expect(withSeeds.affected).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// Determinism / byte-stability
// ---------------------------------------------------------------------------

describe('reachability-index: determinism', () => {
  test('building twice yields byte-identical JSON', () => {
    const { nodes, edges } = randomGraph(800, 2400, 42);
    const a = buildReachabilityIndex(nodes, edges);
    const b = buildReachabilityIndex(nodes, edges);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('input ORDER does not change the output (same graph, shuffled)', () => {
    const { nodes, edges } = randomGraph(300, 900, 7);
    const a = buildReachabilityIndex(nodes, edges);
    const shuffledNodes = [...nodes].reverse();
    const shuffledEdges = [...edges].reverse();
    const b = buildReachabilityIndex(shuffledNodes, shuffledEdges);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('persist -> rehydrate round-trip answers identically', () => {
    const { nodes, edges } = randomGraph(400, 1200, 11);
    const built = ReachabilityIndex.build(nodes, edges);
    const rehydrated = ReachabilityIndex.from(JSON.parse(JSON.stringify(built.toJSON())));
    const rand = rng(1234);
    for (let q = 0; q < 200; q++) {
      const a = nodes[Math.floor(rand() * nodes.length)];
      const b = nodes[Math.floor(rand() * nodes.length)];
      expect(rehydrated.canReach(a, b)).toBe(built.canReach(a, b));
    }
  });
});

// ---------------------------------------------------------------------------
// CAS edge extraction
// ---------------------------------------------------------------------------

describe('reachability-index: callEdgePairs', () => {
  test('takes calls edges plus resolved method_calls, ignores other kinds', () => {
    const pairs = callEdgePairs({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { source: 'a', target: 'b', type: 'calls' },
        { source: 'a', target: 'c', type: 'contains' },
      ],
      method_calls: [
        { caller_node: 'b', target_node: 'c' },
        { caller_node: 'b' }, // unresolved — ignored
      ],
    });
    expect(pairs).toEqual([['a', 'b'], ['b', 'c']]);
  });
});

describe('reachability-index: reachabilityEdgePairs', () => {
  test('is callEdgePairs plus invokes edges', () => {
    const cas = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      edges: [
        { source: 'a', target: 'b', type: 'calls' },
        { source: 'a', target: 'c', type: 'contains' },
        { source: 'b', target: 'd', type: 'invokes' },
      ],
      method_calls: [{ caller_node: 'b', target_node: 'c' }],
    };
    expect(reachabilityEdgePairs(cas)).toEqual([['a', 'b'], ['b', 'c'], ['b', 'd']]);
    // callEdgePairs itself is unchanged (still excludes invokes) — only the
    // reachability-specific superset adds it.
    expect(callEdgePairs(cas)).toEqual([['a', 'b'], ['b', 'c']]);
  });

  test('buildReachabilityIndexFromCas includes invokes-reached nodes (superset over calls-only)', () => {
    // a -calls-> b; b -invokes-> c (dispatch, no literal 'calls' edge to c).
    const cas = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { source: 'a', target: 'b', type: 'calls' },
        { source: 'b', target: 'c', type: 'invokes' },
      ],
      method_calls: [],
    };
    const persisted = buildReachabilityIndexFromCas(cas);
    // The content-coverage marker consumers gate reuse on (see
    // CASReachabilityIndex.includes_invokes_edges) must be set — this is what
    // lets a consumer tell this apart from a pre-task#100 stored index.
    expect(persisted.includes_invokes_edges).toBe(true);
    const idx = ReachabilityIndex.from(persisted);
    // Before this fix, buildReachabilityIndexFromCas excluded 'invokes', so
    // a could not reach c through the index. It must now.
    expect(idx.canReach('a', 'c')).toBe(true);
    expect(idx.canReach('a', 'b')).toBe(true);
  });

  /**
   * Task #100 acceptance criterion 2: "REACHABILITY ANSWERS MUST BE A
   * SUPERSET. Adding edges can only ever make more things reachable. If
   * anything becomes LESS reachable after the change, something is wrong —
   * stop and report rather than adjusting until the numbers look nice.
   * Verify this explicitly on real data, not by argument."
   *
   * Random-graph property test (not argument-only): for every seed and every
   * direction, the affected set computed over the OLD edge definition
   * (`callEdgePairs` — calls + resolved method_calls) must be a SUBSET of the
   * affected set computed over the NEW one (`reachabilityEdgePairs` — the
   * same plus 'invokes'). Never the reverse; never a divergent (non-nested)
   * pair. Runs many random graphs plus many random seed sets per graph so a
   * single lucky topology can't hide a violation.
   */
  test('superset property: old-edge-set reachability ⊆ new-edge-set reachability, every graph/seed/direction', () => {
    for (let g = 0; g < 8; g++) {
      const { nodes, edges: callEdges } = randomGraph(120, 260, 9000 + g);
      // A second, disjoint-ish random edge set standing in for 'invokes' —
      // some overlap with callEdges is fine and realistic (dispatch call
      // sites that also happen to share an endpoint with a literal call).
      const rand = rng(31337 + g);
      const invokesEdges: EdgePair[] = [];
      for (let k = 0; k < 90; k++) {
        const s = nodes[Math.floor(rand() * nodes.length)];
        const t = nodes[Math.floor(rand() * nodes.length)];
        if (s !== t) invokesEdges.push([s, t]);
      }

      const oldIndex = ReachabilityIndex.build(nodes, callEdges);
      const newIndex = ReachabilityIndex.build(nodes, [...callEdges, ...invokesEdges]);

      const seedRand = rng(2026 + g);
      for (let q = 0; q < 25; q++) {
        const seedCount = 1 + Math.floor(seedRand() * 3);
        const seeds = Array.from({ length: seedCount }, () => nodes[Math.floor(seedRand() * nodes.length)]);
        for (const direction of ['upstream', 'downstream', 'both'] as const) {
          const oldResult = oldIndex.affectedSet(seeds, { direction });
          const newResult = newIndex.affectedSet(seeds, { direction });
          const newSet = new Set(newResult.affected);
          for (const id of oldResult.affected) {
            expect(newSet.has(id)).toBe(true);
          }
          // The new (superset-edge) answer is never SMALLER than the old one.
          expect(newResult.affected.length).toBeGreaterThanOrEqual(oldResult.affected.length);
        }
      }
    }
  });
});
