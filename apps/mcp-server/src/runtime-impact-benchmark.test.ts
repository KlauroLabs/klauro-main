import test from 'node:test';
import assert from 'node:assert/strict';
import { runRuntimeImpactBenchmark } from './runtime-impact-benchmark';

test('runtime impact benchmark proves telemetry triage reaches compact agent packets', async () => {
  const report = await runRuntimeImpactBenchmark();
  assert.equal(report.status, 'pass');
  assert.equal(report.score, 100);
  assert.match(report.summary.runtime_top_file, /invoice-export\.service\.ts$/);
  assert.notEqual(report.summary.runtime_top_file, report.summary.baseline_static_top);
  assert.ok(report.summary.token_reduction_percentage >= 70);
});
