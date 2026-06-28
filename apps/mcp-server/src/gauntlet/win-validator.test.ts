import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWin } from './win-validator';
import type { ArmResult } from './report-schema';

function arm(arm_id: string, quality: number, time_ms: number, tokens: number): ArmResult {
  return {
    arm_id,
    mode: 'engine',
    attempted: true,
    metrics: { quality, time_ms, tokens },
    source: 'test',
  };
}

const EDGE = 'type-resolved caller set';

test('strict quality win + token win → klauro wins (no ceiling tie)', () => {
  const v = validateWin([arm('klauro', 100, 10, 50), arm('ripgrep', 80, 5, 400)], EDGE);
  assert.equal(v.klauro_wins, true);
  assert.equal(v.quality_won, true);
  assert.equal(v.quality_tied_at_ceiling, undefined);
});

test('tie at the ceiling vs a compiler-accurate tool + token win → klauro still wins', () => {
  // Both perfect quality (e.g. scip-typescript on TS who-calls). Klauro cannot
  // out-correct ground truth, but returns the exact answer far cheaper.
  const v = validateWin([arm('klauro', 100, 8, 40), arm('scip-typescript', 100, 8, 900)], EDGE);
  assert.equal(v.quality_won, false, 'not an outright quality win');
  assert.equal(v.quality_tied_at_ceiling, true, 'matched at the ceiling');
  assert.equal(v.efficiency_won, true, 'tokens carry it');
  assert.equal(v.klauro_wins, true, 'ceiling tie + efficiency = win');
});

test('ceiling tie but NO efficiency edge → NOT a win (must beat on tokens/speed)', () => {
  const v = validateWin([arm('klauro', 100, 10, 500), arm('scip-typescript', 100, 8, 480)], EDGE);
  assert.equal(v.quality_tied_at_ceiling, true);
  assert.equal(v.efficiency_won, false);
  assert.equal(v.klauro_wins, false);
  assert.ok(v.violation, 'a tie without an efficiency edge is a violation to fix');
});

test('a tie BELOW the ceiling is not acceptable — quality must be won outright', () => {
  // Both mediocre (0.80 F1). A tie here is a real quality gap, not a ground-truth
  // ceiling — Klauro must deepen the analyzer, not coast on tokens.
  const v = validateWin([arm('klauro', 80, 10, 50), arm('ast-grep', 80, 5, 400)], EDGE);
  assert.equal(v.quality_tied_at_ceiling, undefined);
  assert.equal(v.quality_won, false);
  assert.equal(v.klauro_wins, false);
});

test('a real quality loss is always a loss', () => {
  const v = validateWin([arm('klauro', 75, 10, 50), arm('scip-typescript', 100, 5, 400)], EDGE);
  assert.equal(v.quality_won, false);
  assert.equal(v.quality_tied_at_ceiling, undefined);
  assert.equal(v.klauro_wins, false);
});
