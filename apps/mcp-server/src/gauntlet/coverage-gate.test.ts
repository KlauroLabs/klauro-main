import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { validateSemanticCoverage, SEMANTIC_COVERAGE_FLOORS } from './coverage-gate';
import { analyzeForBench } from './product-analysis';
import { computeFlowConcepts } from '../../../../packages/analyzer-core/src/analyzer/core/flow-concepts';
import { computeSemanticCoverage, type SemanticCoverage } from '../../../../packages/analyzer-core/src/analyzer/core/semantic-coverage';

function coverage(over: Partial<Record<keyof SemanticCoverage['unmapped'], any>> & {
  reach?: [number, number]; steps?: [number, number]; caps?: [number, number];
} = {}): SemanticCoverage {
  const ratio = (m: number, t: number) => ({ ratio: t > 0 ? Math.round((m / t) * 10000) / 10000 : 1, mapped: m, total: t });
  const [rm, rt] = over.reach ?? [10, 10];
  const [sm, st] = over.steps ?? [5, 5];
  const [cm, ct] = over.caps ?? [3, 5];
  return {
    reachable_code_to_steps: ratio(rm, rt),
    steps_to_flows: ratio(sm, st),
    flows_to_capabilities: ratio(cm, ct),
    unmapped: {
      code_units: [], code_units_omitted: rt - rm,
      steps: [], steps_omitted: st - sm,
      flows: [], flows_omitted: ct - cm,
    },
  };
}

test('healthy coverage passes every floor', () => {
  const v = validateSemanticCoverage(coverage({ reach: [8, 10], steps: [5, 5], caps: [2, 5] }));
  assert.equal(v.passed, true);
  assert.equal(v.violation, undefined);
  assert.equal(v.checks.length, 3);
});

test('reachable_code_to_steps below floor is a regression', () => {
  const v = validateSemanticCoverage(coverage({ reach: [1, 10] })); // 0.1 < 0.25
  assert.equal(v.passed, false);
  assert.ok(v.violation);
  assert.deepEqual(v.violation!.failing_metrics, ['reachable_code_to_steps']);
  assert.match(v.violation!.unmapped_hint, /code_units/);
});

test('the historical 0.07% flow-coverage collapse would fail the gate', () => {
  const v = validateSemanticCoverage(coverage({ reach: [7, 10000] })); // 0.0007
  assert.equal(v.passed, false);
  assert.ok(v.violation!.failing_metrics.includes('reachable_code_to_steps'));
});

test('steps_to_flows below 0.99 (detached steps) is a structural regression', () => {
  const v = validateSemanticCoverage(coverage({ steps: [90, 100] })); // 0.9 < 0.99
  assert.equal(v.passed, false);
  assert.ok(v.violation!.failing_metrics.includes('steps_to_flows'));
});

test('flows_to_capabilities collapse toward pre-B1 zero fails', () => {
  const v = validateSemanticCoverage(coverage({ caps: [1, 1000] })); // 0.001 < 0.03
  assert.equal(v.passed, false);
  assert.ok(v.violation!.failing_metrics.includes('flows_to_capabilities'));
});

test('Klauro-shaped low-but-healthy flows_to_capabilities (0.064) passes', () => {
  const v = validateSemanticCoverage(coverage({ reach: [756, 1836], steps: [4548, 4548], caps: [140, 2194] }));
  assert.equal(v.passed, true, v.reasons.join(' | '));
});

test('vacuous metrics (total=0) pass without being held to the floor', () => {
  const v = validateSemanticCoverage(coverage({ reach: [0, 0], steps: [0, 0], caps: [0, 0] }));
  assert.equal(v.passed, true);
  for (const c of v.checks) assert.equal(c.vacuous, true);
});

test('multiple failing metrics are all reported', () => {
  const v = validateSemanticCoverage(coverage({ reach: [1, 100], caps: [0, 100] }));
  assert.equal(v.passed, false);
  assert.deepEqual(new Set(v.violation!.failing_metrics), new Set(['reachable_code_to_steps', 'flows_to_capabilities']));
});

test('REAL: coverage gate reports missing capability comprehension without deterministic labels', async () => {
  process.env.KLAURO_AI_INTERPRETATION = 'false';
  const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'analysis-truth', 'express-mongoose');
  const cas: any = await analyzeForBench(FIXTURE);
  const cov = computeSemanticCoverage(cas, computeFlowConcepts(cas));
  const v = validateSemanticCoverage(cov);
  assert.equal(v.passed, false);
  assert.deepEqual(v.violation?.failing_metrics, ['flows_to_capabilities']);
  assert.equal(cov.flows_to_capabilities.total, 2);
  assert.equal(cov.flows_to_capabilities.mapped, 0);
  assert.deepEqual(cas.capabilities ?? [], []);
  assert.ok(cov.reachable_code_to_steps.total > 0);
  assert.ok(cov.reachable_code_to_steps.ratio >= SEMANTIC_COVERAGE_FLOORS.reachable_code_to_steps);
});
