/**
 * DEPTH-1 cross-function source->sink (taint) head-to-head vs the REAL
 * codebase-memory binary.
 *
 * Skip-guard: when codebase-memory-mcp is not installed, the head-to-head cannot
 * run, so the suite no-ops (it is a competitor-present test, not a Klauro test).
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDepthTaintReport, __resetDepthTaintCache } from './depth-taint-bench';
import { codebaseMemoryPath, startCodebaseMemoryDaemon, type CodebaseMemoryDaemonLease } from './real-camp-arms';

const CBM = codebaseMemoryPath() != null;
let daemon: CodebaseMemoryDaemonLease | null = null;

before(() => {
  if (CBM) daemon = startCodebaseMemoryDaemon();
});

after(() => {
  daemon?.close();
});

test('Depth-taint vs codebase-memory: Klauro proves cross-function source->sink, cbm cannot', { skip: !CBM, timeout: 600_000 }, async () => {
  __resetDepthTaintCache();
  const report = await buildDepthTaintReport();
  assert.equal(report.available, true, 'cbm binary should be available in this run');
  assert.ok(report.results.length >= 3, `expected >=3 depth-taint fixtures, got ${report.results.length}`);

  // No losses: a strict cbm source->sink win would be a real loss to surface.
  assert.equal(
    report.aggregate.losses,
    0,
    `Klauro lost source->sink F1 to codebase-memory on: ${report.aggregate.lossFixtures.join(', ') || '(none)'}`,
  );

  for (const r of report.results) {
    // Klauro produces a high-F1 source->sink flow on every case it claims.
    assert.ok(
      r.klauroF1 >= 0.99,
      `${r.fixture}: Klauro source->sink F1 ${r.klauroF1.toFixed(3)} < 0.99 (flows: ${r.klauroFlows.join(' ; ')})`,
    );
    // cbm CANNOT produce the cross-function source->sink fact: zero flow tuples,
    // zero F1. Its trace_path is call-adjacency only.
    assert.equal(
      r.cbmFlows.length,
      0,
      `${r.fixture}: cbm unexpectedly produced source->sink flows: ${r.cbmFlows.join(' ; ')}`,
    );
    assert.equal(
      r.cbmF1,
      0,
      `${r.fixture}: cbm source->sink F1 ${r.cbmF1} != 0 (should be out-of-category)`,
    );
    // Klauro strictly beats cbm everywhere (out-of-category win).
    assert.ok(
      r.klauroF1 > r.cbmF1 + 1e-9,
      `${r.fixture}: Klauro F1 ${r.klauroF1.toFixed(3)} not strictly above cbm ${r.cbmF1.toFixed(3)}`,
    );
    assert.equal(r.verdict, 'win', `${r.fixture}: expected win, got ${r.verdict}`);
  }

  // The decoy fixture: Klauro must NOT claim a source->sink flow for the decoy
  // handler (the same-named var that never reaches a sink).
  const decoy = report.results.find(r => r.fixture === 'decoy-noflow');
  assert.ok(decoy, 'decoy-noflow fixture missing');
  assert.equal(
    decoy!.decoyHandledByKlauro,
    true,
    'Klauro wrongly claimed a source->sink flow for the decoy (non-reaching) handler',
  );

  // Aggregate: Klauro ties-or-wins every case; mean F1 high; cbm mean F1 zero.
  assert.equal(report.aggregate.nonLossRate, 1, `nonLossRate ${report.aggregate.nonLossRate} != 1`);
  assert.equal(report.aggregate.strictWinRate, report.aggregate.klauroWins / report.aggregate.cases);
  assert.ok(
    report.aggregate.meanKlauroF1 >= 0.99,
    `mean Klauro F1 ${report.aggregate.meanKlauroF1.toFixed(3)} below 0.99`,
  );
  assert.equal(report.aggregate.meanCbmF1, 0, `mean cbm F1 ${report.aggregate.meanCbmF1} != 0`);
  assert.equal(report.aggregate.klauroWins, report.results.length, 'every case should be a Klauro win');
});
