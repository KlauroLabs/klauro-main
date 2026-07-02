import test from 'node:test';
import assert from 'node:assert/strict';

import { buildComprehensionProofReport, DIMENSIONS } from './comprehension-proof';

test('comprehension-proof: builds a report over all real scenarios', async () => {
  const report = await buildComprehensionProofReport();
  assert.ok(report.scenarios.length >= 3, 'must score at least 3 real entities');
  for (const s of report.scenarios) {
    assert.ok(s.klauro.covered.length <= DIMENSIONS.length);
    assert.ok(s.baseline.covered.length <= DIMENSIONS.length);
    assert.ok(s.klauroTokens > 0, `${s.scenario}: klauro must consume >0 tokens (it did call primitives)`);
    assert.ok(s.baselineTokens > 0, `${s.scenario}: baseline must consume >0 tokens (it did read source)`);
  }
});

test('comprehension-proof: klauro covers "contract" for every scenario (the I/L/S/O join is real)', async () => {
  const report = await buildComprehensionProofReport();
  for (const s of report.scenarios) {
    assert.ok(
      s.klauro.covered.includes('contract'),
      `${s.scenario}: get_interface_signature should surface input+logic/side_effects in one call`,
    );
  }
});

test('comprehension-proof: klauro covers "what" for every resolved scenario', async () => {
  const report = await buildComprehensionProofReport();
  for (const s of report.scenarios) {
    assert.ok(s.klauro.covered.includes('what'), `${s.scenario}: identity (name/type/file) must be covered`);
  }
});

test('comprehension-proof: mean klauro coverage is >= mean baseline coverage', async () => {
  const report = await buildComprehensionProofReport();
  assert.ok(
    report.aggregate.meanKlauroCoverage >= report.aggregate.meanBaselineCoverage,
    `klauro coverage ${report.aggregate.meanKlauroCoverage} should be >= baseline ${report.aggregate.meanBaselineCoverage}`,
  );
});

test('comprehension-proof: aggregate numbers are internally consistent', async () => {
  const report = await buildComprehensionProofReport();
  const n = report.scenarios.length;
  const recomputedMeanKlauroTokens =
    report.scenarios.reduce((a, s) => a + s.klauroTokens, 0) / n;
  assert.equal(Math.round(recomputedMeanKlauroTokens), Math.round(report.aggregate.meanKlauroTokens));
  assert.equal(report.aggregate.scenariosTotal, n);
  assert.ok(report.aggregate.scenariosWon <= n);
});
