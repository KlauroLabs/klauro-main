import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompetitorBaselineBenchmark } from './competitor-baseline-benchmark';

test('competitor baseline benchmark proves Klauro beats Cursor and Linear shaped context proxies', async () => {
  const report = await runCompetitorBaselineBenchmark();

  assert.equal(report.status, 'pass');
  assert.equal(report.score, 100);
  assert.deepEqual(report.summary.competitor_models, [
    'cursor-style-index-context-proxy-v2',
    'linear-style-workflow-code-context-proxy-v1',
  ]);
  assert.equal(report.summary.competitor_model, 'cursor-style-index-context-proxy-v2');
  assert.ok(report.summary.claim_limit.includes('proxy'));
  assert.ok(report.summary.scenario_count >= 14);
  assert.ok(report.summary.family_count >= 12);
  assert.ok(report.summary.cursor.average_context_readiness_delta >= 25);
  assert.ok(report.summary.cursor.average_token_reduction_percentage >= 15);
  assert.ok(report.summary.cursor.average_file_recall >= 25);
  assert.ok(report.summary.cursor.average_file_precision >= 25);
  assert.ok(report.summary.cursor.average_raw_score > report.summary.cursor.average_context_readiness_score);
  assert.ok(report.summary.linear.average_context_readiness_score > report.summary.cursor.average_context_readiness_score);
  assert.ok(report.summary.linear.average_context_readiness_delta >= 12);
  assert.ok(report.summary.linear.average_token_reduction_percentage >= 20);
  assert.ok(report.scenarios.every(scenario => scenario.linear_workflow_code_context_proxy.included_context.includes('PR/review workflow context')));
  assert.ok(report.scenarios.every(scenario => scenario.linear_workflow_code_context_proxy.missing_guidance.includes('local dirty-tree incremental analysis')));
  assert.ok(report.gates.every(gate => gate.status === 'pass'));
});
