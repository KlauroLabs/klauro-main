/**
 * Exhaustive win-condition coverage for validateWin + summarize.
 *
 * The contract under test (from win-validator.ts): Klauro wins a scenario iff it
 * is strictly higher on quality (by > 0.5) than the BEST other arm AND beats the
 * best other arm on time OR tokens (by > 2%). Both must hold.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWin, summarize } from './win-validator';
import type { ArmResult, ScenarioResult } from './report-schema';

const EDGE = 'get_coding_context delivers structure in one call.';

function arm(
  arm_id: string,
  metrics: { quality?: number; time_ms?: number; tokens?: number },
  attempted = true
): ArmResult {
  return { arm_id, mode: 'projected', attempted, metrics };
}

function comp(v: ReturnType<typeof validateWin>, metric: 'quality' | 'time' | 'tokens') {
  const c = v.comparisons.find(x => x.metric === metric);
  assert.ok(c, `expected a ${metric} comparison`);
  return c!;
}

// --- Klauro wins both efficiency dimensions ---------------------------------

test('wins quality + both efficiency metrics', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 1000, tokens: 2000 }),
      arm('no-tools', { quality: 60, time_ms: 5000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.klauro_wins, true);
  assert.equal(v.quality_won, true);
  assert.equal(v.efficiency_won, true);
  assert.equal(v.violation, undefined);
  assert.equal(comp(v, 'time').klauro_wins, true);
  assert.equal(comp(v, 'tokens').klauro_wins, true);
});

test('wins quality + time only (tokens worse, still a win)', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 1000, tokens: 20000 }),
      arm('no-tools', { quality: 60, time_ms: 5000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.klauro_wins, true);
  assert.equal(comp(v, 'time').klauro_wins, true);
  assert.equal(comp(v, 'tokens').klauro_wins, false);
});

test('wins quality + tokens only (time worse, still a win)', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 9000, tokens: 2000 }),
      arm('no-tools', { quality: 60, time_ms: 5000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.klauro_wins, true);
  assert.equal(comp(v, 'time').klauro_wins, false);
  assert.equal(comp(v, 'tokens').klauro_wins, true);
});

// --- Klauro loses ------------------------------------------------------------

test('loses quality to a competitor => not a win, quality in losing_metrics', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 70, time_ms: 1000, tokens: 2000 }),
      arm('ctags', { quality: 80, time_ms: 5000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.klauro_wins, false);
  assert.equal(v.quality_won, false);
  assert.ok(v.violation);
  assert.deepEqual(v.violation!.losing_metrics, ['quality']);
  assert.match(v.violation!.summary, /quality/i);
  assert.equal(v.violation!.suspected_capability, EDGE);
});

test('wins quality but loses BOTH efficiency metrics => not a win', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 9000, tokens: 9000 }),
      arm('no-tools', { quality: 60, time_ms: 1000, tokens: 1000 }),
    ],
    EDGE
  );
  assert.equal(v.klauro_wins, false);
  assert.equal(v.quality_won, true);
  assert.equal(v.efficiency_won, false);
  assert.ok(v.violation);
  // both time and tokens recorded as losing
  assert.deepEqual([...v.violation!.losing_metrics].sort(), ['time', 'tokens']);
  assert.match(v.violation!.summary, /efficiency/i);
});

// --- Quality tie / margin semantics -----------------------------------------

test('quality tie does NOT count as a win', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 80, time_ms: 1000, tokens: 1000 }),
      arm('ctags', { quality: 80, time_ms: 5000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.quality_won, false);
  assert.equal(v.klauro_wins, false);
});

test('quality lead smaller than the 0.5 margin does NOT win', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 80.4, time_ms: 1000, tokens: 1000 }),
      arm('ctags', { quality: 80, time_ms: 5000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.quality_won, false, '0.4 < 0.5 margin');
});

test('quality lead exactly at the margin does NOT win (strict >)', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 80.5, time_ms: 1000, tokens: 1000 }),
      arm('ctags', { quality: 80, time_ms: 5000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.quality_won, false, 'needs > best + 0.5, 80.5 is not > 80.5');
});

test('quality lead just past the margin wins', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 80.6, time_ms: 1000, tokens: 1000 }),
      arm('ctags', { quality: 80, time_ms: 5000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.quality_won, true);
});

// --- Efficiency margin semantics --------------------------------------------

test('efficiency win needs a >2% improvement, 1% does not count', () => {
  // best other time 1000; 1% better => 990, margin is 2% (20ms) so need < 980.
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 990, tokens: 9000 }),
      arm('no-tools', { quality: 60, time_ms: 1000, tokens: 1000 }),
    ],
    EDGE
  );
  assert.equal(comp(v, 'time').klauro_wins, false, '1% under is within noise margin');
  assert.equal(v.efficiency_won, false);
});

test('efficiency win counts when >2% better', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 970, tokens: 9000 }),
      arm('no-tools', { quality: 60, time_ms: 1000, tokens: 9999 }),
    ],
    EDGE
  );
  assert.equal(comp(v, 'time').klauro_wins, true, '3% under beats the 2% margin');
});

// --- Best-of-many competitor comparison -------------------------------------

test('must beat the BEST competitor on quality, not the average', () => {
  // Average other quality is (60+88)/2 = 74 < 85, but the best other is 88 > 85.
  const v = validateWin(
    [
      arm('klauro', { quality: 85, time_ms: 100, tokens: 100 }),
      arm('no-tools', { quality: 60, time_ms: 9000, tokens: 9000 }),
      arm('cursor-proxy', { quality: 88, time_ms: 9000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.quality_won, false);
  assert.equal(comp(v, 'quality').best_other_arm_id, 'cursor-proxy');
  assert.equal(comp(v, 'quality').best_other_value, 88);
});

test('best-other on a lower-better metric is the smallest competitor value', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 5000, tokens: 100 }),
      arm('no-tools', { quality: 60, time_ms: 9000, tokens: 9000 }),
      arm('ctags', { quality: 61, time_ms: 3000, tokens: 8000 }),
    ],
    EDGE
  );
  const t = comp(v, 'time');
  assert.equal(t.best_other_value, 3000, 'smallest competitor time is the toughest to beat');
  assert.equal(t.best_other_arm_id, 'ctags');
  // 5000 is not < 3000, so Klauro loses time but still wins tokens.
  assert.equal(t.klauro_wins, false);
  assert.equal(comp(v, 'tokens').klauro_wins, true);
  assert.equal(v.klauro_wins, true);
});

test('beats the best of many competitors on every axis => clean win', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 95, time_ms: 500, tokens: 500 }),
      arm('no-tools', { quality: 50, time_ms: 9000, tokens: 9000 }),
      arm('ctags', { quality: 70, time_ms: 4000, tokens: 6000 }),
      arm('embeddings-rag', { quality: 75, time_ms: 3000, tokens: 5000 }),
      arm('cursor-proxy', { quality: 78, time_ms: 2000, tokens: 4000 }),
    ],
    EDGE
  );
  assert.equal(v.klauro_wins, true);
  assert.equal(comp(v, 'quality').best_other_arm_id, 'cursor-proxy');
});

// --- Missing metrics handled without throwing -------------------------------

test('undefined Klauro quality => no quality win, no throw', () => {
  const v = validateWin(
    [
      arm('klauro', { time_ms: 100, tokens: 100 }),
      arm('no-tools', { quality: 60, time_ms: 9000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(comp(v, 'quality').klauro_wins, false);
  assert.equal(v.klauro_wins, false);
});

test('competitor missing a metric => that metric judged on remaining competitors', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 100, tokens: 100 }),
      arm('no-tools', { quality: 60, tokens: 9000 }), // no time
      arm('ctags', { quality: 61, time_ms: 4000, tokens: 8000 }),
    ],
    EDGE
  );
  // only ctags has a time value, so it is the best-other for time
  assert.equal(comp(v, 'time').best_other_arm_id, 'ctags');
  assert.equal(comp(v, 'time').klauro_wins, true);
});

test('no competitor has time data => time comparison cannot be won', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 100, tokens: 100 }),
      arm('no-tools', { quality: 60, tokens: 9000 }),
    ],
    EDGE
  );
  const t = comp(v, 'time');
  assert.equal(t.klauro_wins, false);
  assert.equal(t.best_other_value, undefined);
  // but tokens still wins => efficiency satisfied
  assert.equal(v.efficiency_won, true);
  assert.equal(v.klauro_wins, true);
});

test('all metrics undefined everywhere => not a win, no throw', () => {
  const v = validateWin(
    [arm('klauro', {}), arm('no-tools', {})],
    EDGE
  );
  assert.equal(v.klauro_wins, false);
  assert.equal(v.quality_won, false);
  assert.equal(v.efficiency_won, false);
});

// --- Single competitor -------------------------------------------------------

test('single competitor: clean win', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 84, time_ms: 1000, tokens: 1000 }),
      arm('no-tools', { quality: 62, time_ms: 5000, tokens: 9000 }),
    ],
    EDGE
  );
  assert.equal(v.klauro_wins, true);
  assert.equal(comp(v, 'quality').best_other_arm_id, 'no-tools');
});

test('un-attempted competitors are excluded from the comparison', () => {
  // ctags has the best quality but is not attempted => ignored.
  const v = validateWin(
    [
      arm('klauro', { quality: 84, time_ms: 1000, tokens: 1000 }),
      arm('no-tools', { quality: 62, time_ms: 5000, tokens: 9000 }),
      arm('ctags', { quality: 99, time_ms: 1, tokens: 1 }, false),
    ],
    EDGE
  );
  assert.equal(v.klauro_wins, true);
  assert.equal(comp(v, 'quality').best_other_arm_id, 'no-tools');
});

// --- Uncontested single-arm scenario (quality bar 70) ------------------------

test('uncontested arm at/above 70 wins (efficiency uncontested)', () => {
  const v = validateWin([arm('klauro', { quality: 70 })], EDGE);
  assert.equal(v.klauro_wins, true);
  assert.equal(v.efficiency_won, true);
  assert.equal(v.violation, undefined);
});

test('uncontested arm below 70 fails on quality', () => {
  const v = validateWin([arm('klauro', { quality: 69 })], EDGE);
  assert.equal(v.klauro_wins, false);
  assert.ok(v.violation);
  assert.deepEqual(v.violation!.losing_metrics, ['quality']);
});

test('uncontested arm with no quality value fails', () => {
  const v = validateWin([arm('klauro', { time_ms: 1 })], EDGE);
  assert.equal(v.klauro_wins, false);
});

test('only-Klauro-attempted (others present but not attempted) treated as uncontested', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 72 }),
      arm('no-tools', { quality: 99 }, false),
    ],
    EDGE
  );
  assert.equal(v.klauro_wins, true, 'unattempted others drop out, leaving uncontested bar');
});

// --- Missing Klauro arm ------------------------------------------------------

test('missing Klauro arm => not a win, all metrics flagged', () => {
  const v = validateWin([arm('no-tools', { quality: 90, time_ms: 1, tokens: 1 })], EDGE);
  assert.equal(v.klauro_wins, false);
  assert.equal(v.comparisons.length, 0);
  assert.ok(v.violation);
  assert.deepEqual([...v.violation!.losing_metrics].sort(), ['quality', 'time', 'tokens']);
  assert.equal(v.violation!.suspected_capability, EDGE);
});

// --- Advantage fraction math -------------------------------------------------

test('quality advantage fraction is (kl - best)/best', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 1, tokens: 1 }),
      arm('no-tools', { quality: 60, time_ms: 9, tokens: 9 }),
    ],
    EDGE
  );
  assert.equal(comp(v, 'quality').advantage, (90 - 60) / 60); // 0.5
});

test('time advantage fraction is (best - kl)/best for lower-better', () => {
  const v = validateWin(
    [
      arm('klauro', { quality: 90, time_ms: 2000, tokens: 1 }),
      arm('no-tools', { quality: 60, time_ms: 8000, tokens: 9 }),
    ],
    EDGE
  );
  assert.equal(comp(v, 'time').advantage, (8000 - 2000) / 8000); // 0.75
});

// --- summarize() rollup ------------------------------------------------------

function scenario(id: string, armResults: ArmResult[], edge = EDGE, status: ScenarioResult['status'] = 'done'): ScenarioResult {
  return {
    scenario_id: id,
    label: id,
    group: 'single-repo',
    status,
    execution: 'projected',
    arms: armResults,
    verdict: validateWin(armResults, edge),
  };
}

test('summarize: all-win rollup', () => {
  const s = summarize([
    scenario('a', [arm('klauro', { quality: 90, time_ms: 1, tokens: 1 }), arm('no-tools', { quality: 60, time_ms: 9, tokens: 9 })]),
    scenario('b', [arm('klauro', { quality: 95, time_ms: 1, tokens: 1 }), arm('no-tools', { quality: 50, time_ms: 9, tokens: 9 })]),
  ]);
  assert.equal(s.klauro_wins_all, true);
  assert.equal(s.scenarios_won, 2);
  assert.equal(s.scenarios_lost, 0);
  assert.equal(s.losses.length, 0);
  assert.ok(typeof s.avg_quality_advantage === 'number');
});

test('summarize: mixed rollup lists the loss with its losing_metrics', () => {
  const win = scenario('w', [arm('klauro', { quality: 90, time_ms: 1, tokens: 1 }), arm('no-tools', { quality: 60, time_ms: 9, tokens: 9 })]);
  const loss = scenario('l', [arm('klauro', { quality: 50, time_ms: 1, tokens: 1 }), arm('ctags', { quality: 80, time_ms: 9, tokens: 9 })]);
  const s = summarize([win, loss]);
  assert.equal(s.klauro_wins_all, false);
  assert.equal(s.scenarios_won, 1);
  assert.equal(s.scenarios_lost, 1);
  assert.equal(s.losses.length, 1);
  assert.equal(s.losses[0].scenario_id, 'l');
  assert.deepEqual(s.losses[0].losing_metrics, ['quality']);
  assert.match(s.losses[0].summary, /quality/i);
});

test('summarize: all-loss rollup', () => {
  const s = summarize([
    scenario('l1', [arm('klauro', { quality: 50, time_ms: 9, tokens: 9 }), arm('ctags', { quality: 80, time_ms: 1, tokens: 1 })]),
    scenario('l2', [arm('klauro', { quality: 40, time_ms: 9, tokens: 9 }), arm('ctags', { quality: 70, time_ms: 1, tokens: 1 })]),
  ]);
  assert.equal(s.klauro_wins_all, false);
  assert.equal(s.scenarios_won, 0);
  assert.equal(s.scenarios_lost, 2);
  assert.equal(s.avg_quality_advantage, undefined, 'no won scenarios => no averaged advantage');
});

test('summarize: empty input => not a clean sweep', () => {
  const s = summarize([]);
  assert.equal(s.klauro_wins_all, false, 'zero judged scenarios is not "wins all"');
  assert.equal(s.scenarios_won, 0);
  assert.equal(s.scenarios_lost, 0);
});

test('summarize: only non-done scenarios are not judged', () => {
  const pending = scenario('p', [arm('klauro', { quality: 90, time_ms: 1, tokens: 1 }), arm('no-tools', { quality: 60, time_ms: 9, tokens: 9 })], EDGE, 'running');
  const s = summarize([pending]);
  assert.equal(s.scenarios_won, 0);
  assert.equal(s.scenarios_lost, 0);
  assert.equal(s.klauro_wins_all, false);
});

test('summarize: avg advantage averages only winning comparisons across won scenarios', () => {
  // Two wins: quality advantages 0.5 and 0.25 => mean 0.375.
  const a = scenario('a', [arm('klauro', { quality: 90, time_ms: 1, tokens: 1 }), arm('no-tools', { quality: 60, time_ms: 9, tokens: 9 })]);
  const b = scenario('b', [arm('klauro', { quality: 100, time_ms: 1, tokens: 1 }), arm('no-tools', { quality: 80, time_ms: 9, tokens: 9 })]);
  const s = summarize([a, b]);
  const expected = ((90 - 60) / 60 + (100 - 80) / 80) / 2;
  assert.ok(typeof s.avg_quality_advantage === 'number');
  assert.ok(Math.abs(s.avg_quality_advantage! - expected) < 1e-9);
});
