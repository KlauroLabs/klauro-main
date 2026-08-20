import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { runResponseSizeBench } from './response-size-bench';

// This repo itself — the large (33k+ node) analyzed repo the spec's byte
// measurements were taken against (docs/SPEC-RESPONSE-BUDGET.md §2).
const REPO_ROOT = path.resolve(__dirname, '../../../..');

test('response-size-bench: default (compact) tool responses stay under target byte budgets', async t => {
  const report = await runResponseSizeBench(REPO_ROOT);

  if (report.skipped) {
    // No stored analysis for this repo in this environment — a size
    // regression guard has nothing to measure, not a failure.
    t.skip(report.skip_reason);
    return;
  }

  assert.ok(report.results.length === 4, `expected 4 tool results, got ${report.results.length}`);

  for (const result of report.results) {
    assert.ok(
      result.within_budget,
      `${result.tool} compact response is ${result.bytes} bytes, over budget of ${result.budget_bytes} bytes`,
    );
  }
});
