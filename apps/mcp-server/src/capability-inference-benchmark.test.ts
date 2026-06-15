import assert from 'node:assert/strict';
import test from 'node:test';
import { runCapabilityInferenceBenchmark } from './capability-inference-benchmark';

test('capability inference benchmark prefers domain capabilities over framework entry noise', async () => {
  const report = await runCapabilityInferenceBenchmark();

  assert.equal(report.status, 'pass');
  assert.equal(report.score, 100);
  assert.equal(report.summary.primary_domain, 'fleet-management');
  assert.equal(report.summary.generic_capability_count, 0);
  assert.ok(report.capabilities.some(capability => /Fuel/.test(capability.name)));
  assert.ok(report.capabilities.some(capability => /Vehicle|Fleet Operations/.test(capability.name)));
  assert.ok(report.capabilities.some(capability => /Invoice/.test(capability.name)));
});
