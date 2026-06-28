import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAllFixtures } from './analyzer-quality';

// Regression guard for the measurement-first analyzer-quality program: the
// hand-curated truth fixtures (apps/mcp-server/fixtures/analysis-truth/*) must
// keep scoring well. Floors are set BELOW current measured values (all 1.0) so
// the test catches real degradation without being brittle to a single new hard
// fixture — if a fixture drops under the floor, an analyzer regressed.
test('analyzer truth fixtures hold their measured precision/recall', async () => {
  const reports = await scoreAllFixtures();
  assert.ok(reports.length >= 10, `expected >=10 truth fixtures, got ${reports.length}`);

  const mean = reports.reduce((a, r) => a + r.overall.f1, 0) / reports.length;
  assert.ok(mean >= 0.95, `mean F1 ${mean.toFixed(3)} dropped below 0.95 — an analyzer regressed`);

  // No single fixture may collapse (basic + hard fixtures are all >=0.95 today).
  for (const r of reports) {
    assert.ok(
      r.overall.f1 >= 0.85,
      `${r.fixture} F1 ${r.overall.f1} below 0.85 (P ${r.overall.precision} / R ${r.overall.recall}) — regression`,
    );
  }
});
