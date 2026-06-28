/**
 * Camp-C ROUTE head-to-head vs the REAL codebase-memory binary.
 *
 * Skip-guard: when codebase-memory-mcp is not installed, the head-to-head cannot
 * run, so the suite no-ops (it is a competitor-present test, not a Klauro test).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCampCRoutesVsCbmReport, __resetCampCRoutesVsCbmCache } from './camp-c-routes-cbm';
import { codebaseMemoryPath } from './real-camp-arms';

const CBM = codebaseMemoryPath() != null;

test('Camp-C routes vs codebase-memory: Klauro never loses, ties-or-wins every framework', { skip: !CBM, timeout: 600_000 }, async () => {
  __resetCampCRoutesVsCbmCache();
  const report = await buildCampCRoutesVsCbmReport();
  assert.equal(report.available, true, 'cbm binary should be available in this run');
  assert.ok(report.results.length >= 30, `expected >=30 framework fixtures, got ${report.results.length}`);

  // No losses: a strict cbm route win would be a real loss to surface + deepen.
  assert.equal(
    report.aggregate.losses,
    0,
    `Klauro lost route F1 to codebase-memory on: ${report.aggregate.lossFrameworks.join(', ') || '(none)'}`,
  );

  // Per-framework: Klauro F1 >= cbm F1 everywhere (honest ties allowed at ceiling).
  for (const r of report.results) {
    assert.ok(
      r.klauroF1 >= r.cbmF1 - 1e-9,
      `framework ${r.framework}: Klauro F1 ${r.klauroF1.toFixed(3)} < cbm F1 ${r.cbmF1.toFixed(3)} (cbm via ${r.cbmSource})`,
    );
  }

  // Klauro mean route F1 is high (the analyzers nail the route table).
  assert.ok(
    report.aggregate.meanKlauroF1 >= 0.95,
    `mean Klauro route F1 ${report.aggregate.meanKlauroF1.toFixed(3)} below 0.95`,
  );

  // winRate (ties-or-wins) is total.
  assert.equal(report.aggregate.winRate, 1, `winRate ${report.aggregate.winRate} != 1`);
});
