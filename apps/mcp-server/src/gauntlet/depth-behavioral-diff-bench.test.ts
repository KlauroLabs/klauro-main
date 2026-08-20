/**
 * DEPTH-3 behavioral / semantic DIFF head-to-head vs the REAL codebase-memory
 * binary.
 *
 * Skip-guard: when codebase-memory-mcp is not installed, the head-to-head cannot
 * run, so the suite no-ops (it is a competitor-present test, not a Klauro-only
 * test).
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDepthBehavioralDiffReport,
  __resetDepthBehavioralDiffCache,
} from './depth-behavioral-diff-bench';
import { codebaseMemoryPath, startCodebaseMemoryDaemon, type CodebaseMemoryDaemonLease } from './real-camp-arms';

const CBM = codebaseMemoryPath() != null;
let daemon: CodebaseMemoryDaemonLease | null = null;

before(() => {
  if (CBM) daemon = startCodebaseMemoryDaemon();
});

after(() => {
  daemon?.close();
});

test('Depth-behavioral-diff vs codebase-memory: Klauro produces a behavioral delta, cbm produces only file churn', { skip: !CBM, timeout: 600_000 }, async () => {
  __resetDepthBehavioralDiffCache();
  const report = await buildDepthBehavioralDiffReport();
  assert.equal(report.available, true, 'cbm binary should be available in this run');
  assert.ok(report.results.length >= 4, `expected >=4 behavioral-diff fixtures, got ${report.results.length}`);

  // No losses: a strict cbm behavioral-F1 win would be a real loss to surface.
  assert.equal(
    report.aggregate.losses,
    0,
    `Klauro lost behavioral-diff F1 to codebase-memory on: ${report.aggregate.lossFixtures.join(', ') || '(none)'}`,
  );

  // Per-fixture: cbm can NEVER produce a behavioral kind (out-of-category), and
  // Klauro ties-or-wins every case.
  for (const r of report.results) {
    assert.equal(
      r.cbmKinds.length,
      0,
      `${r.fixture}: cbm unexpectedly produced behavioral kinds: ${r.cbmKinds.join(', ')}`,
    );
    assert.equal(r.verdict, 'win', `${r.fixture}: expected win, got ${r.verdict}`);
    // On the behavioral cases (truth non-empty) cbm's empty output scores F1 0.
    // On the CONTROL (truth empty) cbm's empty output vacuously scores F1 1 — but
    // only because it can never emit a kind, not because it understood the rename.
    if (!r.control) {
      assert.equal(r.cbmF1, 0, `${r.fixture}: cbm behavioral F1 ${r.cbmF1} != 0 (should be out-of-category)`);
    }
  }

  // auth-removed: Klauro detects the auth guard removal.
  const authRemoved = report.results.find(r => r.fixture === 'auth-removed');
  assert.ok(authRemoved, 'auth-removed fixture missing');
  assert.ok(
    authRemoved!.klauroKinds.includes('auth-removed'),
    `auth-removed: Klauro did not flag auth-removed (kinds: ${authRemoved!.klauroKinds.join(', ') || 'none'})`,
  );
  assert.ok(
    authRemoved!.klauroRiskFlags.some(f => /lost its auth boundary|auth boundary/i.test(f)),
    `auth-removed: expected an auth-boundary risk flag, got: ${authRemoved!.klauroRiskFlags.join(' | ') || 'none'}`,
  );
  assert.ok(authRemoved!.klauroF1 >= 0.99, `auth-removed: Klauro F1 ${authRemoved!.klauroF1.toFixed(3)} < 0.99`);

  // journey-broken: Klauro detects the broken (removed) source->sink journey.
  const journeyBroken = report.results.find(r => r.fixture === 'journey-broken');
  assert.ok(journeyBroken, 'journey-broken fixture missing');
  assert.ok(
    journeyBroken!.klauroKinds.includes('journey-broken'),
    `journey-broken: Klauro did not flag journey-broken (kinds: ${journeyBroken!.klauroKinds.join(', ') || 'none'})`,
  );
  assert.ok(journeyBroken!.klauroF1 >= 0.99, `journey-broken: Klauro F1 ${journeyBroken!.klauroF1.toFixed(3)} < 0.99`);

  // capability-added: Klauro detects the new capability/journey.
  const capAdded = report.results.find(r => r.fixture === 'capability-added');
  assert.ok(capAdded, 'capability-added fixture missing');
  assert.ok(
    capAdded!.klauroKinds.includes('capability-added'),
    `capability-added: Klauro did not flag capability-added (kinds: ${capAdded!.klauroKinds.join(', ') || 'none'})`,
  );
  assert.ok(capAdded!.klauroF1 >= 0.99, `capability-added: Klauro F1 ${capAdded!.klauroF1.toFixed(3)} < 0.99`);

  // CONTROL rename: Klauro must NOT flag any behavioral change (precision guard).
  const control = report.results.find(r => r.fixture === 'control-rename');
  assert.ok(control, 'control-rename fixture missing');
  assert.equal(control!.control, true, 'control-rename should be marked control');
  assert.equal(
    control!.klauroKinds.length,
    0,
    `control-rename: Klauro wrongly flagged behavioral change(s): ${control!.klauroKinds.join(', ')}`,
  );
  assert.equal(
    control!.controlCleanByKlauro,
    true,
    'control-rename: Klauro did not treat the pure rename as behaviorally clean',
  );
  assert.equal(
    control!.klauroRiskFlags.length,
    0,
    `control-rename: Klauro emitted risk flags on a pure rename: ${control!.klauroRiskFlags.join(' | ')}`,
  );

  // Aggregate: Klauro ties-or-wins every case with perfect mean F1; cbm scores 0
  // on every behavioral case (its only non-zero F1 is the vacuous control match).
  assert.equal(report.aggregate.nonLossRate, 1, `nonLossRate ${report.aggregate.nonLossRate} != 1`);
  assert.equal(report.aggregate.strictWinRate, report.aggregate.klauroWins / report.aggregate.cases);
  assert.equal(report.aggregate.meanKlauroF1, 1, `mean Klauro F1 ${report.aggregate.meanKlauroF1} != 1`);
  const behavioralCbmF1 = report.results.filter(r => !r.control).map(r => r.cbmF1);
  assert.ok(
    behavioralCbmF1.every(v => v === 0),
    `cbm produced non-zero behavioral F1 on a real change: ${behavioralCbmF1.join(', ')}`,
  );
  assert.equal(report.aggregate.klauroWins, report.results.length, 'every case should be a Klauro win');
  // Token saving: the structured behavioral delta is far cheaper than re-reading
  // the changed source cbm would need to (and still cannot) reconstruct behavior from.
  assert.ok(report.aggregate.tokenSaving > 0.5, `token saving ${report.aggregate.tokenSaving} unexpectedly low`);
});
