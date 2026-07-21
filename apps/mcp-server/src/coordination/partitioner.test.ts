import test from 'node:test';
import assert from 'node:assert/strict';

import { inferFootprintFromIntent, partitionTasks, groupTasksByConcept } from './partitioner';
import type { PartitionCas, PartitionTask, CoChangeIndexLike } from './partitioner';

const cas: PartitionCas = {
  nodes: [
    { id: 'sym:getUser', name: 'getUser' },
    { id: 'sym:renderProfile', name: 'renderProfile' },
    { id: 'sym:billingHandler', name: 'billingHandler' },
    { id: 'sym:formatCurrency', name: 'formatCurrency' },
    { id: 'sym:unrelatedUtil', name: 'unrelatedUtil' },
  ],
  edges: [
    { source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' },
    { source: 'sym:billingHandler', target: 'sym:formatCurrency', type: 'calls' },
  ],
};

test('two tasks on the same symbol conflict and land in different batches', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'retype getUser', target_symbols: ['sym:getUser'] },
    { id: 't2', intent: 'add logging to getUser', target_symbols: ['sym:getUser'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false });
  assert.equal(result.batches.length, 2);
  assert.equal(result.parallelism_factor, 1);
  assert.equal(result.conflict_edges.length, 1);
  assert.equal(result.conflict_edges[0].reason, 'symbol');
});

test('two tasks on disjoint symbols/paths run in one batch (fully parallel)', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'add formatCurrency', target_symbols: ['sym:formatCurrency'] },
    { id: 't2', intent: 'add unrelatedUtil', target_symbols: ['sym:unrelatedUtil'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false });
  assert.equal(result.batches.length, 1);
  assert.equal(result.parallelism_factor, 2);
  assert.equal(result.conflict_edges.length, 0);
});

test('overlapping target_paths conflict even with disjoint symbols', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit file A', target_paths: ['src/app.ts'] },
    { id: 't2', intent: 'edit same file A', target_paths: ['src/app.ts'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false });
  assert.equal(result.batches.length, 2);
  assert.equal(result.conflict_edges[0].reason, 'path');
});

test('blast-radius expansion separates two tasks with disjoint literal targets', () => {
  // t1 edits getUser directly. t2 edits renderProfile, a real CALLER of
  // getUser per the CAS. Their literal (declared) footprints are disjoint —
  // a file/symbol-only partitioner would put them in the same batch — but
  // editing getUser can break renderProfile's assumptions about it, so
  // blast-radius expansion must separate them.
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'retype getUser to non-null', target_symbols: ['sym:getUser'] },
    { id: 't2', intent: 'add avatar to renderProfile', target_symbols: ['sym:renderProfile'] },
  ];

  const withoutBlastRadius = partitionTasks(tasks, cas, { includeBlastRadius: false });
  assert.equal(withoutBlastRadius.batches.length, 1, 'literal footprints are disjoint -> file-only view sees no conflict');

  const withBlastRadius = partitionTasks(tasks, cas, { includeBlastRadius: true });
  assert.equal(withBlastRadius.batches.length, 2, 'blast-radius expansion must separate these');
  const edge = withBlastRadius.conflict_edges.find(
    (e) => (e.a === 't1' && e.b === 't2') || (e.a === 't2' && e.b === 't1')
  );
  assert.ok(edge, 'expected a conflict edge between t1 and t2');
  assert.equal(edge!.reason, 'blast-radius');
});

test('N fully-disjoint tasks (default blast-radius) all land in a single batch', () => {
  const tasks: PartitionTask[] = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`,
    intent: `unrelated change ${i}`,
    target_paths: [`src/module-${i}.ts`],
  }));
  const result = partitionTasks(tasks, cas);
  assert.equal(result.batches.length, 1);
  assert.equal(result.parallelism_factor, 5);
  assert.equal(result.conflict_edges.length, 0);
});

test('tasks with no declared footprint are reported in unpartitionable, not dropped', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'do something vague, no declared footprint' },
    { id: 't2', intent: 'edit formatCurrency', target_symbols: ['sym:formatCurrency'] },
  ];
  const result = partitionTasks(tasks, cas);
  assert.deepEqual(result.unpartitionable, ['t1']);
  const allTaskIds = result.batches.flatMap((b) => b.task_ids);
  assert.ok(allTaskIds.includes('t1'), 'unpartitionable task must still appear in a batch, never dropped');
  assert.ok(allTaskIds.includes('t2'));
});

test('invariant: no two tasks in the same batch have intersecting (expanded) footprints', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'retype getUser', target_symbols: ['sym:getUser'] },
    { id: 't2', intent: 'edit renderProfile (caller of getUser)', target_symbols: ['sym:renderProfile'] },
    { id: 't3', intent: 'edit billingHandler', target_symbols: ['sym:billingHandler'] },
    { id: 't4', intent: 'edit formatCurrency (callee of billingHandler)', target_symbols: ['sym:formatCurrency'] },
    { id: 't5', intent: 'unrelated file edit', target_paths: ['src/other.ts'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: true });

  const conflictSet = new Set(result.conflict_edges.map((e) => [e.a, e.b].sort().join('|')));
  for (const batch of result.batches) {
    for (let i = 0; i < batch.task_ids.length; i++) {
      for (let j = i + 1; j < batch.task_ids.length; j++) {
        const key = [batch.task_ids[i], batch.task_ids[j]].sort().join('|');
        assert.ok(!conflictSet.has(key), `tasks ${batch.task_ids[i]} and ${batch.task_ids[j]} conflict but share a batch`);
      }
    }
  }
});

test('parallelism_factor > 1 on a mixed conflicting+disjoint task set', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'retype getUser', target_symbols: ['sym:getUser'] },
    { id: 't2', intent: 'edit renderProfile', target_symbols: ['sym:renderProfile'] },
    { id: 't3', intent: 'edit unrelatedUtil', target_symbols: ['sym:unrelatedUtil'] },
    { id: 't4', intent: 'edit some other file', target_paths: ['src/misc.ts'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: true });
  assert.ok(result.parallelism_factor > 1, `expected > 1, got ${result.parallelism_factor}`);
});

test('a task with only an intent (no declared symbols) is partitioned by inferred footprint, not unpartitionable', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'refactor getUser to be non-null' },
    { id: 't2', intent: 'add logging to getUser', target_symbols: ['sym:getUser'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false });

  // Not dropped into unpartitionable — the heuristic found the real getUser node.
  assert.equal(result.unpartitionable, undefined);
  assert.equal(result.footprint_source?.t1, 'inferred');
  assert.equal(result.footprint_source?.t2, 'declared');

  // And it actually conflicts with the other task that explicitly targets getUser —
  // proof the inferred footprint was wired into real conflict detection, not just labeled.
  assert.equal(result.batches.length, 2, 't1 (inferred getUser) and t2 (declared getUser) must conflict');
  const edge = result.conflict_edges.find(
    (e) => (e.a === 't1' && e.b === 't2') || (e.a === 't2' && e.b === 't1')
  );
  assert.ok(edge, 'expected a conflict edge between t1 and t2');
  assert.equal(edge!.reason, 'symbol');
});

test('inferFootprintFromIntent matches real CAS symbols mentioned in free text', () => {
  const inferred = inferFootprintFromIntent('refactor getUser to be non-null', cas);
  assert.deepEqual(inferred.symbols, ['sym:getUser']);
  assert.deepEqual(inferred.paths, []);
});

test('inferFootprintFromIntent matches backtick-quoted symbols and file paths', () => {
  const casWithFiles: PartitionCas = { ...cas, files: ['src/app.ts', 'src/other.ts'] };
  const inferred = inferFootprintFromIntent('touch up `renderProfile` and also `src/app.ts`', casWithFiles);
  assert.deepEqual(inferred.symbols, ['sym:renderProfile']);
  assert.deepEqual(inferred.paths, ['src/app.ts']);
});

test('inferFootprintFromIntent finds nothing for vague intent mentioning no real entity', () => {
  const inferred = inferFootprintFromIntent('fix the bug where users get logged out early', cas);
  assert.deepEqual(inferred.symbols, []);
  assert.deepEqual(inferred.paths, []);
});

test('a task whose intent matches nothing real still lands in unpartitionable', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'fix the bug where users get logged out early' },
    { id: 't2', intent: 'edit formatCurrency', target_symbols: ['sym:formatCurrency'] },
  ];
  const result = partitionTasks(tasks, cas);
  assert.deepEqual(result.unpartitionable, ['t1']);
  assert.equal(result.footprint_source?.t1, undefined);
  assert.equal(result.footprint_source?.t2, 'declared');
});

test('resolves target_symbols by bare name as well as node id', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit by name', target_symbols: ['getUser'] },
    { id: 't2', intent: 'edit by id', target_symbols: ['sym:getUser'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false });
  assert.equal(result.batches.length, 2, 'same symbol referenced by name vs id must still conflict');
});

test('groupTasksByConcept groups tasks by flow_id (preferred over capability_id)', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'charge step work', flow_id: 'flow::checkout' },
    { id: 't2', intent: 'persist step work', flow_id: 'flow::checkout' },
    { id: 't3', intent: 'refund flow work', flow_id: 'flow::refund' },
    { id: 't4', intent: 'no concept declared at all' },
  ];
  const groups = groupTasksByConcept(tasks);
  assert.equal(groups.length, 2);
  const checkout = groups.find((g) => g.concept_id === 'flow::checkout');
  const refund = groups.find((g) => g.concept_id === 'flow::refund');
  assert.ok(checkout && refund);
  assert.equal(checkout!.kind, 'flow');
  assert.deepEqual(checkout!.task_ids.sort(), ['t1', 't2']);
  assert.deepEqual(refund!.task_ids, ['t3']);
  // t4 has no flow_id/capability_id — correctly omitted, never guessed.
});

test('groupTasksByConcept falls back to capability_id when flow_id is absent', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'work a', capability_id: 'cap::billing' },
    { id: 't2', intent: 'work b', capability_id: 'cap::billing' },
  ];
  const groups = groupTasksByConcept(tasks);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'capability');
  assert.equal(groups[0].concept_id, 'cap::billing');
  assert.deepEqual(groups[0].task_ids.sort(), ['t1', 't2']);
});

test('partitionTasks surfaces concept_groups alongside file/symbol batches (conceptually-disjoint flows)', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'checkout: charge', target_symbols: ['sym:formatCurrency'], flow_id: 'flow::checkout' },
    { id: 't2', intent: 'checkout: persist', target_symbols: ['sym:unrelatedUtil'], flow_id: 'flow::checkout' },
    { id: 't3', intent: 'refund flow', target_symbols: ['sym:billingHandler'], flow_id: 'flow::refund' },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false });
  // File/symbol-level: all three are disjoint symbols, so they land fully parallel.
  assert.equal(result.batches.length, 1);
  // Conceptual grouping is a SEPARATE, additive signal on top:
  assert.ok(result.concept_groups);
  const checkoutGroup = result.concept_groups!.find((g) => g.concept_id === 'flow::checkout');
  const refundGroup = result.concept_groups!.find((g) => g.concept_id === 'flow::refund');
  assert.deepEqual(checkoutGroup!.task_ids.sort(), ['t1', 't2']);
  assert.deepEqual(refundGroup!.task_ids, ['t3']);
});

test('partitionTasks omits concept_groups entirely when no task declares flow_id/capability_id', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'add formatCurrency', target_symbols: ['sym:formatCurrency'] },
    { id: 't2', intent: 'add unrelatedUtil', target_symbols: ['sym:unrelatedUtil'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false });
  assert.equal(result.concept_groups, undefined);
});

// ---------------------------------------------------------------------------
// Co-change soft-conflict layer (docs/SPEC-MATHEMATICAL-INTELLIGENCE.md §F)
// ---------------------------------------------------------------------------

test('predicted_conflicts is absent entirely when no coChangeIndex is supplied (unchanged behavior)', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit a', target_paths: ['a.ts'] },
    { id: 't2', intent: 'edit b', target_paths: ['b.ts'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false });
  assert.equal(result.predicted_conflicts, undefined);
});

test('co-change: two structurally-disjoint tasks with a high co-change pair prefer separate batches when a third slot exists', () => {
  const coChangeIndex: CoChangeIndexLike = {
    'a.ts': [{ file: 'b.ts', probability: 0.9, support: 20, lift: 5 }],
  };
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit a', target_paths: ['a.ts'] },
    { id: 't2', intent: 'edit b', target_paths: ['b.ts'] },
    { id: 't3', intent: 'edit unrelated c', target_paths: ['c.ts'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false, coChangeIndex, coChangeThreshold: 0.5 });

  // No hard conflict — but the soft layer is allowed to trade some
  // parallelism to separate the coupled pair, as long as it stops short of
  // full serialization (that floor is asserted in the next test).
  assert.equal(result.conflict_edges.length, 0);
  assert.equal(result.batches.length, 2, 't1/t2 (coupled) should split into separate batches; t3 (uncoupled) joins whichever is free');
  assert.ok(result.parallelism_factor > 1, 'still meaningfully parallel, not forced serial');

  assert.ok(result.predicted_conflicts);
  const pc = result.predicted_conflicts!.find((e) => (e.a === 't1' && e.b === 't2') || (e.a === 't2' && e.b === 't1'));
  assert.ok(pc, 'a.ts/b.ts pair above threshold should be reported as a prediction');
  assert.equal(pc!.probability, 0.9);
  assert.equal(pc!.separated, true, 'with 3 available task slots the greedy coloring can and should keep the coupled pair apart');
});

test('co-change: never blocks or forces serialization even when every task is mutually coupled', () => {
  const coChangeIndex: CoChangeIndexLike = {
    'a.ts': [{ file: 'b.ts', probability: 0.95, support: 20, lift: 5 }],
  };
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit a', target_paths: ['a.ts'] },
    { id: 't2', intent: 'edit b', target_paths: ['b.ts'] },
  ];
  // Only 2 tasks exist — there is no third slot to move to, so even though
  // co-change probability is very high, the pair MUST still be allowed to
  // run in the same (only) batch: throughput first, never refuse parallelism.
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false, coChangeIndex, coChangeThreshold: 0.5 });
  assert.equal(result.batches.length, 1);
  assert.equal(result.parallelism_factor, 2);
  assert.equal(result.predicted_conflicts![0].separated, false);
});

test('co-change: below-threshold probability produces no prediction at all', () => {
  const coChangeIndex: CoChangeIndexLike = {
    'a.ts': [{ file: 'b.ts', probability: 0.2, support: 4, lift: 2.5 }],
  };
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit a', target_paths: ['a.ts'] },
    { id: 't2', intent: 'edit b', target_paths: ['b.ts'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false, coChangeIndex, coChangeThreshold: 0.5 });
  assert.equal(result.predicted_conflicts!.length, 0);
});

test('co-change: a pair with a HARD conflict is never also reported as a soft prediction', () => {
  const coChangeIndex: CoChangeIndexLike = {
    'src/app.ts': [{ file: 'src/app.ts', probability: 0.99, support: 20, lift: 5 }],
  };
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit file A', target_paths: ['src/app.ts'] },
    { id: 't2', intent: 'edit same file A', target_paths: ['src/app.ts'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false, coChangeIndex, coChangeThreshold: 0.5 });
  assert.equal(result.conflict_edges.length, 1, 'literal path overlap is still a hard conflict');
  assert.equal(result.predicted_conflicts!.length, 0, 'already-hard-conflicting pairs are excluded from the soft-prediction layer');
});

test('co-change lookup checks both directions of the (asymmetric, top-K) index', () => {
  // Only b.ts's top-K list mentions a.ts (the reverse direction) — a.ts's own
  // list might not include b.ts if b.ts didn't make a.ts's top-K cut.
  const coChangeIndex: CoChangeIndexLike = {
    'b.ts': [{ file: 'a.ts', probability: 0.8, support: 15, lift: 4 }],
  };
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit a', target_paths: ['a.ts'] },
    { id: 't2', intent: 'edit b', target_paths: ['b.ts'] },
    { id: 't3', intent: 'edit c', target_paths: ['c.ts'] },
  ];
  const result = partitionTasks(tasks, cas, { includeBlastRadius: false, coChangeIndex, coChangeThreshold: 0.5 });
  assert.equal(result.predicted_conflicts!.length, 1);
});

// ---------------------------------------------------------------------------
// Transitive blast radius via the reachability index (Workstream C)
// ---------------------------------------------------------------------------

/** Chain fixture: a -> b -> c -> d (plus an unrelated island x -> y). */
const chainCas: PartitionCas = {
  nodes: [
    { id: 'sym:a', name: 'a' },
    { id: 'sym:b', name: 'b' },
    { id: 'sym:c', name: 'c' },
    { id: 'sym:d', name: 'd' },
    { id: 'sym:x', name: 'x' },
    { id: 'sym:y', name: 'y' },
  ],
  edges: [
    { source: 'sym:a', target: 'sym:b', type: 'calls' },
    { source: 'sym:b', target: 'sym:c', type: 'calls' },
    { source: 'sym:c', target: 'sym:d', type: 'calls' },
    { source: 'sym:x', target: 'sym:y', type: 'calls' },
  ],
};

test('TRANSITIVE collision (3 hops apart on one call chain) is flagged — invisible to one-hop', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit a', target_symbols: ['sym:a'] },
    { id: 't2', intent: 'edit d', target_symbols: ['sym:d'] },
  ];
  // Legacy one-hop behavior misses it: a expands to {a,b}, d to {c,d} — disjoint.
  const oneHop = partitionTasks(tasks, chainCas, { blastRadiusDepth: 1 });
  assert.equal(oneHop.batches.length, 1, 'one-hop expansion cannot see the 3-hop chain collision');

  // Default transitive expansion flags it as a blast-radius conflict.
  const transitive = partitionTasks(tasks, chainCas);
  assert.equal(transitive.batches.length, 2, 'transitive expansion must separate the chain endpoints');
  assert.equal(transitive.conflict_edges.length, 1);
  assert.equal(transitive.conflict_edges[0].reason, 'blast-radius');
});

test('transitive expansion never entangles unrelated islands', () => {
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit a', target_symbols: ['sym:a'] },
    { id: 't2', intent: 'edit x', target_symbols: ['sym:x'] },
  ];
  const result = partitionTasks(tasks, chainCas);
  assert.equal(result.batches.length, 1, 'disconnected call-graph islands stay fully parallel');
  assert.equal(result.conflict_edges.length, 0);
});

test('blastRadiusDepth 1 reproduces the legacy one-hop footprint semantics (acyclic fixture parity)', () => {
  // Old oneHopCallGraph(seed {b}) = {b} + direct callers {a} + direct
  // callees {c} = {a,b,c}. BOTH tasks expand, so on the a->b->c->d chain:
  //  - b vs a: conflict (a is in b's one-hop footprint).
  //  - b vs d: conflict too — b expands to {a,b,c}, d expands to {c,d},
  //    they meet at c (this was true of the legacy one-hop scan as well).
  //  - a vs d: NO conflict — a{a,b} vs d{c,d} are disjoint at one hop
  //    (asserted in the transitive-collision test above).
  const onA: PartitionTask[] = [
    { id: 'tb', intent: 'edit b', target_symbols: ['sym:b'] },
    { id: 'ta', intent: 'edit a', target_symbols: ['sym:a'] },
  ];
  const onD: PartitionTask[] = [
    { id: 'tb', intent: 'edit b', target_symbols: ['sym:b'] },
    { id: 'td', intent: 'edit d', target_symbols: ['sym:d'] },
  ];
  const conflictsWithA = partitionTasks(onA, chainCas, { blastRadiusDepth: 1 });
  assert.equal(conflictsWithA.conflict_edges.length, 1, 'depth-1: b\'s footprint includes direct caller a');
  const conflictsWithD = partitionTasks(onD, chainCas, { blastRadiusDepth: 1 });
  assert.equal(conflictsWithD.conflict_edges.length, 1, 'depth-1: b and d footprints meet at c, matching legacy one-hop');
});

test('blastRadiusMaxNodes caps the footprint (advisory, never blocking)', () => {
  // Star: hub calls 30 leaves. A task on the hub with a tiny cap still
  // partitions — it just stops expanding.
  const star: PartitionCas = {
    nodes: [
      { id: 'sym:hub', name: 'hub' },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `sym:leaf${i}`, name: `leaf${i}` })),
    ],
    edges: Array.from({ length: 30 }, (_, i) => ({ source: 'sym:hub', target: `sym:leaf${i}`, type: 'calls' })),
  };
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit hub', target_symbols: ['sym:hub'] },
    { id: 't2', intent: 'edit leaf29', target_symbols: ['sym:leaf29'] },
  ];
  const capped = partitionTasks(tasks, star, { blastRadiusMaxNodes: 5 });
  assert.ok(capped.batches.length >= 1, 'capped expansion still partitions');
  const uncapped = partitionTasks(tasks, star);
  assert.equal(uncapped.batches.length, 2, 'uncapped expansion sees hub -> leaf29');
});

test('mutually-recursive functions (one SCC) count as one footprint unit', () => {
  const cyclic: PartitionCas = {
    nodes: [
      { id: 'sym:f', name: 'f' },
      { id: 'sym:g', name: 'g' },
      { id: 'sym:h', name: 'h' },
    ],
    edges: [
      { source: 'sym:f', target: 'sym:g', type: 'calls' },
      { source: 'sym:g', target: 'sym:f', type: 'calls' },
      { source: 'sym:g', target: 'sym:h', type: 'calls' },
    ],
  };
  const tasks: PartitionTask[] = [
    { id: 't1', intent: 'edit f', target_symbols: ['sym:f'] },
    { id: 't2', intent: 'edit g', target_symbols: ['sym:g'] },
  ];
  const result = partitionTasks(tasks, cyclic, { blastRadiusDepth: 1 });
  assert.equal(result.batches.length, 2, 'f and g are mutually recursive — always one unit, always a conflict');
});
