import test from 'node:test';
import assert from 'node:assert/strict';

import { inferFootprintFromIntent, partitionTasks } from './partitioner';
import type { PartitionCas, PartitionTask } from './partitioner';

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
