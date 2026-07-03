import test from 'node:test';
import assert from 'node:assert/strict';

import { runThroughputBench } from './throughput-bench';

test('throughput bench: mixed set has parallelism_factor > 1', async () => {
  const report = await runThroughputBench();
  assert.ok(
    report.mixed.parallelism_factor > 1,
    `expected parallelism_factor > 1 on the mixed set, got ${report.mixed.parallelism_factor}`
  );
  assert.ok(report.mixed.conflict_edge_count > 0, 'mixed set should have at least one real conflict');
});

test('throughput bench: blast-radius-conflicting tasks are separated, file-only view would miss it', async () => {
  const report = await runThroughputBench();
  assert.equal(
    report.blast_radius_proof.without_blast_radius_batches,
    1,
    'literal (declared) footprints are disjoint -- a file/symbol-only partitioner sees no conflict'
  );
  assert.equal(
    report.blast_radius_proof.with_blast_radius_batches,
    2,
    'blast-radius expansion must separate a symbol edit from a real caller edit'
  );
  assert.equal(report.blast_radius_proof.separated_correctly, true);
});

test('throughput bench: fully-disjoint tasks all land in one batch (parallelism_factor = N)', async () => {
  const report = await runThroughputBench();
  assert.equal(report.disjoint_control.partitioned_batch_count, 1);
  assert.equal(report.disjoint_control.parallelism_factor, report.disjoint_control.task_count);
});

test('throughput bench: serial wall-clock is always N, partitioned is always <= N', async () => {
  const report = await runThroughputBench();
  for (const scenario of [report.mixed, report.disjoint_control]) {
    assert.equal(scenario.serial_wall_clock_units, scenario.task_count);
    assert.ok(scenario.partitioned_wall_clock_units <= scenario.serial_wall_clock_units);
  }
});
