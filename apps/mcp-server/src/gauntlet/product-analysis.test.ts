import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedBenchCasReady, benchAnalysisTimeoutMs, benchAnalyzerToken } from './product-analysis';

test('bench analysis timeout supports large progressing repositories without accepting unsafe short overrides', () => {
  assert.equal(benchAnalysisTimeoutMs(undefined), 30 * 60_000);
  assert.equal(benchAnalysisTimeoutMs('120000'), 30 * 60_000);
  assert.equal(benchAnalysisTimeoutMs('600000'), 600_000);
});

test('bench requests authenticate to a locally spawned protected analyzer by default', () => {
  assert.equal(benchAnalyzerToken({ KLAURO_ANALYZER_TOKEN: 'local-token' } as NodeJS.ProcessEnv), 'local-token');
  assert.equal(benchAnalyzerToken({
    KLAURO_ANALYZER_TOKEN: 'local-token',
    KLAURO_BENCH_ANALYZER_TOKEN: 'explicit-bench-token',
  } as NodeJS.ProcessEnv), 'explicit-bench-token');
});

test('completed empty analyses are ready benchmark inputs', () => {
  assert.equal(acceptedBenchCasReady({ nodes: [], layers_ready: { complete: true } } as any), true);
  assert.equal(acceptedBenchCasReady({ nodes: [], layers_ready: { complete: false } } as any), false);
});
