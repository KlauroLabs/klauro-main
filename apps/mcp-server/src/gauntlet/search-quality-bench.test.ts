import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { runSearchQualityBench } from './search-quality-bench';

test('search_nodes surfaces exact symbol-name matches in the top-3 (ideally #1)', { timeout: 120_000 }, async () => {
  const sourceDir = path.resolve(__dirname, '..');
  const report = await runSearchQualityBench(sourceDir);

  for (const c of report.cases) {
    assert.ok(
      c.pass,
      `query "${c.query}" expected "${c.expectedName}" in top-3, got rank=${c.rank} top3=${JSON.stringify(c.top3)}`,
    );
  }

  assert.equal(report.passCount, report.total, `expected all ${report.total} cases to pass, got ${report.passCount}`);
});
