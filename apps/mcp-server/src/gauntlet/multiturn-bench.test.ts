import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MULTITURN_SCENARIOS,
  MULTITURN_ARMS,
  runMultiTurnAllArms,
  runMultiTurn,
  multiTurnVerdict,
  type ArmMultiTurnResult,
} from './multiturn-bench';

// Representative repo facts grounding the projection. Real corpus facts would be
// passed in production; a stable basis keeps the projected test deterministic.
const REPO_FACTS = [{ name: 'basis', nodes: 400, edges: 900 }];

test('every catalog scenario produces per-turn + cumulative metrics for each arm (projected)', async () => {
  for (const scenario of MULTITURN_SCENARIOS) {
    const results = await runMultiTurnAllArms(scenario, { live: false, repoFacts: REPO_FACTS });

    // One result per arm.
    assert.equal(results.length, MULTITURN_ARMS.length, `${scenario.id}: one result per arm`);

    for (const r of results) {
      assert.equal(r.mode, 'projected', `${scenario.id}/${r.arm}: flagged projected`);

      if (!r.available) {
        // Only codebase-memory is expected to be carried-unavailable.
        assert.equal(r.arm, 'codebase-memory', `${scenario.id}: only codebase-memory may be unavailable`);
        assert.ok(r.note && /not installed|unavailable/i.test(r.note), 'unavailable arm explains itself');
        continue;
      }

      // Per-turn metrics: one per scenario turn, well-formed.
      assert.equal(r.turns.length, scenario.turns.length, `${scenario.id}/${r.arm}: a result per turn`);
      for (const t of r.turns) {
        assert.ok(t.quality >= 0 && t.quality <= 100, 'quality in 0..100');
        assert.ok(t.tokens > 0, 'tokens measured');
        assert.ok(t.ms > 0, 'ms measured');
        assert.equal(typeof t.completed, 'boolean');
      }

      // Cumulative metrics present and consistent.
      const c = r.cumulative;
      assert.ok(c.totalTokens > 0, 'cumulative tokens');
      assert.ok(c.totalMs > 0, 'cumulative ms');
      assert.equal(c.finalQuality, r.turns[r.turns.length - 1].quality, 'finalQuality matches last turn');
      assert.ok(c.meanQuality >= 0 && c.meanQuality <= 100, 'meanQuality in range');
      assert.equal(
        c.qualityTrend,
        r.turns[r.turns.length - 1].quality - r.turns[0].quality,
        'qualityTrend = final - first',
      );
    }
  }
});

test('multiTurnVerdict: Klauro wins every projected scenario, quality >= competitors every turn', async () => {
  for (const scenario of MULTITURN_SCENARIOS) {
    const results = await runMultiTurnAllArms(scenario, { live: false, repoFacts: REPO_FACTS });
    const verdict = multiTurnVerdict(results);

    assert.equal(verdict.klauroWins, true, `${scenario.id}: klauroWins (projected) — reasons: ${verdict.reasons.join(' | ')}`);
    assert.equal(verdict.qualityHeldEveryTurn, true, `${scenario.id}: quality held every turn`);
    assert.equal(verdict.efficiencyWon, true, `${scenario.id}: efficiency won`);
    assert.equal(verdict.violation, undefined, `${scenario.id}: no violation`);

    // Explicit per-turn quality >= every available competitor.
    const klauro = results.find(r => r.arm === 'klauro')!;
    const competitors = results.filter(r => r.arm !== 'klauro' && r.available);
    assert.ok(competitors.length > 0, `${scenario.id}: at least one available competitor`);
    for (const comp of competitors) {
      for (let i = 0; i < klauro.turns.length; i++) {
        assert.ok(
          klauro.turns[i].quality >= comp.turns[i].quality,
          `${scenario.id}: turn ${i + 1} klauro >= ${comp.arm}`,
        );
      }
    }
  }
});

test('codebase-memory is carried as a stubbed unavailable arm (no fabricated numbers)', async () => {
  const r: ArmMultiTurnResult = await runMultiTurn(MULTITURN_SCENARIOS[0], 'codebase-memory', {
    live: false,
    repoFacts: REPO_FACTS,
  });
  assert.equal(r.available, false);
  assert.equal(r.turns.length, 0);
  assert.equal(r.cumulative.totalTokens, 0);
  assert.ok(r.note && /install/i.test(r.note));
});

test('structure supports live mode: requesting live without commands refuses (never fabricates)', async () => {
  await assert.rejects(
    () => runMultiTurn(MULTITURN_SCENARIOS[0], 'klauro', { live: true, repoFacts: REPO_FACTS }),
    /Live multi-turn requires|Live multi-turn execution is wired/,
    'live mode must demand real commands, not fabricate',
  );
  // codebase-memory live is skipped (unavailable), not fabricated.
  const cm = await runMultiTurn(MULTITURN_SCENARIOS[0], 'codebase-memory', { live: true });
  assert.equal(cm.available, false);
  assert.equal(cm.mode, 'live');
});
