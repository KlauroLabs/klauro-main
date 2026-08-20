import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDepthContractDriftReport,
  __resetDepthContractDriftCache,
} from './depth-contract-drift-bench';
import { startCodebaseMemoryDaemon, type CodebaseMemoryDaemonLease } from './real-camp-arms';

let daemon: CodebaseMemoryDaemonLease | null = null;

before(() => {
  daemon = startCodebaseMemoryDaemon();
});

after(() => {
  daemon?.close();
});

test('depth-contract-drift: Klauro detects cross-repo field-level drift; cbm out-of-category; no losses', async () => {
  __resetDepthContractDriftCache();
  const report = await getDepthContractDriftReport();

  assert.equal(report.available, true, 'Klauro side must always be available');
  assert.equal(report.results.length, 5, 'five drift cases: type-change, field-rename, field-removed, interface-dto, bare-interface');

  // No losses — name any loss case loudly (same posture as the win-validator).
  assert.equal(
    report.aggregate.losses,
    0,
    `losses must be 0, got loss cases: ${report.aggregate.lossCases.join(', ')}`,
  );

  for (const r of report.results) {
    // Klauro detects exactly the drift it claims to support for each case.
    assert.deepEqual(
      [...r.klauroDrift].sort(),
      [...r.truthDrift].sort(),
      `case ${r.fixture}: Klauro drift set must match truth`,
    );
    assert.equal(r.klauroF1, 1, `case ${r.fixture}: Klauro F1 must be 1.0`);

    // The non-drifting control seam must NOT be flagged as drift.
    assert.equal(
      r.controlClean,
      true,
      `case ${r.fixture}: non-drift control contract must not be flagged`,
    );

    // cbm has no cross-repo field-level contract concept -> empty -> F1 0.
    assert.deepEqual(r.cbmDrift, [], `case ${r.fixture}: cbm produces no cross-repo field drift`);
    assert.equal(r.cbmF1, 0, `case ${r.fixture}: cbm F1 is 0 (out-of-category)`);

    assert.equal(r.verdict, 'win', `case ${r.fixture}: out-of-category win expected`);
  }

  assert.equal(report.aggregate.wins, 5, 'all five cases are wins');
  assert.equal(report.aggregate.winRate, 1, 'winRate must be 1.0');
  assert.equal(report.aggregate.meanKlauroF1, 1, 'mean Klauro F1 must be 1.0');
});

test('depth-contract-drift: cbm binary presence is reported honestly (skip-guard)', async () => {
  const report = await getDepthContractDriftReport();
  // When the binary is absent the bench still runs Klauro and reports cbm as
  // out-of-category; this assertion just documents the guard is observed.
  assert.equal(typeof report.cbmAvailable, 'boolean');
});
