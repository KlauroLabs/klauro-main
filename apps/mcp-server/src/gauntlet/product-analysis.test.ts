import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedBenchCasReady, benchAnalysisTimeoutMs } from './product-analysis';

test('bench analysis timeout supports large progressing repositories without accepting unsafe short overrides', () => {
  assert.equal(benchAnalysisTimeoutMs(undefined), 30 * 60_000);
  assert.equal(benchAnalysisTimeoutMs('120000'), 30 * 60_000);
  assert.equal(benchAnalysisTimeoutMs('600000'), 600_000);
});

test('completed empty analyses are ready benchmark inputs', () => {
  assert.equal(acceptedBenchCasReady({ nodes: [], layers_ready: { complete: true } } as any), true);
  assert.equal(acceptedBenchCasReady({ nodes: [], layers_ready: { complete: false } } as any), false);
});
