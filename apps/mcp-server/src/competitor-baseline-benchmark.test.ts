import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompetitorBaselineBenchmark } from './competitor-baseline-benchmark';

test('competitor baseline benchmark proves Klauro beats lexical index retrieval proxy', async () => {
  const report = await runCompetitorBaselineBenchmark();

  assert.equal(report.status, 'pass');
  assert.equal(report.score, 100);
  assert.equal(report.summary.competitor_model, 'cursor-style-lexical-index-proxy-v1');
  assert.ok(report.summary.claim_limit.includes('proxy'));
  assert.ok(report.summary.scenario_count >= 14);
  assert.ok(report.summary.family_count >= 12);
  assert.ok(report.summary.average_context_readiness_delta_vs_index >= 25);
  assert.ok(report.summary.average_token_reduction_vs_index_percentage >= 15);
  assert.ok(report.summary.average_index_retrieval_file_recall >= 25);
  assert.ok(report.summary.average_index_retrieval_file_precision >= 25);
  assert.ok(report.summary.average_index_retrieval_score > report.summary.average_index_context_readiness_score);
  assert.ok(report.gates.every(gate => gate.status === 'pass'));
});
