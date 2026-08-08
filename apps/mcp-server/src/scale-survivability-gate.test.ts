import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_SCALE_GATE_BUDGETS,
  evaluateScaleGateObservation,
  type ScaleGateObservation,
} from './scale-survivability-gate';

function observation(overrides: Partial<ScaleGateObservation> = {}): ScaleGateObservation {
  return {
    repoLabel: 'test-repo',
    sourceFiles: 3000,
    exitCode: 0,
    timedOut: false,
    wallMs: 120_000,
    peakRssMb: 2200,
    nodes: 50_000,
    edges: 70_000,
    stderrTail: '',
    ...overrides,
  };
}

test('evaluateScaleGateObservation: passes a healthy run within all budgets', () => {
  const finding = evaluateScaleGateObservation(observation(), DEFAULT_SCALE_GATE_BUDGETS);
  assert.strictEqual(finding.status, 'pass');
  assert.deepStrictEqual(finding.reasons, []);
});

test('evaluateScaleGateObservation: fails on a non-zero exit code even if timing/counts look fine', () => {
  const finding = evaluateScaleGateObservation(observation({ exitCode: 1 }), DEFAULT_SCALE_GATE_BUDGETS);
  assert.strictEqual(finding.status, 'fail');
  assert.ok(finding.reasons.includes('process-failed'));
});

test('evaluateScaleGateObservation: fails on timeout and does NOT also report process-failed for the same run', () => {
  const finding = evaluateScaleGateObservation(
    observation({ timedOut: true, exitCode: null }),
    DEFAULT_SCALE_GATE_BUDGETS,
  );
  assert.strictEqual(finding.status, 'fail');
  assert.deepStrictEqual(finding.reasons, ['timed-out']);
});

test('evaluateScaleGateObservation: fails when wall time exceeds the latency budget', () => {
  const finding = evaluateScaleGateObservation(
    observation({ wallMs: DEFAULT_SCALE_GATE_BUDGETS.maxWallMs + 1 }),
    DEFAULT_SCALE_GATE_BUDGETS,
  );
  assert.strictEqual(finding.status, 'fail');
  assert.ok(finding.reasons.includes('over-latency-budget'));
});

test('evaluateScaleGateObservation: fails when peak RSS exceeds the memory budget — the core new assertion this gate adds', () => {
  const finding = evaluateScaleGateObservation(
    observation({ peakRssMb: DEFAULT_SCALE_GATE_BUDGETS.maxPeakRssMb + 1 }),
    DEFAULT_SCALE_GATE_BUDGETS,
  );
  assert.strictEqual(finding.status, 'fail');
  assert.ok(finding.reasons.includes('over-memory-budget'));
});

test('evaluateScaleGateObservation: does not fail on memory when RSS was not sampled (peakRssMb null) — absence is not a violation', () => {
  const finding = evaluateScaleGateObservation(observation({ peakRssMb: null }), DEFAULT_SCALE_GATE_BUDGETS);
  assert.ok(!finding.reasons.includes('over-memory-budget'));
});

test('evaluateScaleGateObservation: fails a completed-but-truncated analysis (too few nodes for an "ordinary size" repo)', () => {
  const finding = evaluateScaleGateObservation(
    observation({ nodes: 5, edges: 3 }),
    DEFAULT_SCALE_GATE_BUDGETS,
  );
  assert.strictEqual(finding.status, 'fail');
  assert.ok(finding.reasons.includes('node-count-too-low'));
});

test('evaluateScaleGateObservation: fails when no counts were reported at all, distinctly from a too-low count', () => {
  const finding = evaluateScaleGateObservation(
    observation({ nodes: null, edges: null }),
    DEFAULT_SCALE_GATE_BUDGETS,
  );
  assert.strictEqual(finding.status, 'fail');
  assert.ok(finding.reasons.includes('no-count-reported'));
  assert.ok(!finding.reasons.includes('node-count-too-low'));
});

test('evaluateScaleGateObservation: reports every violated budget at once instead of stopping at the first', () => {
  const finding = evaluateScaleGateObservation(
    observation({
      wallMs: DEFAULT_SCALE_GATE_BUDGETS.maxWallMs + 1,
      peakRssMb: DEFAULT_SCALE_GATE_BUDGETS.maxPeakRssMb + 1,
      nodes: 1,
    }),
    DEFAULT_SCALE_GATE_BUDGETS,
  );
  assert.deepStrictEqual(
    finding.reasons.slice().sort(),
    ['node-count-too-low', 'over-latency-budget', 'over-memory-budget'].sort(),
  );
});
