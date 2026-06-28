/**
 * Camp B structural head-to-head test — Klauro vs the REAL codebase-memory binary.
 *
 * Asserts the honesty contract:
 *   - losses === 0 (any language where codebase-memory strictly out-extracts
 *     Klauro is NAMED and leaves the suite RED so the analyzer gets deepened),
 *   - >= 60 languages measured,
 *   - every measured language is tie-or-win,
 *   - Klauro mean tokens < codebase-memory mean tokens.
 *
 * Skip-guarded when the codebase-memory binary is absent (honest, no fake data).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCampBStructuralReport,
  _resetCampBStructuralCache,
} from './camp-b-structural';
import { codebaseMemoryPath } from './real-camp-arms';

const CBM_PRESENT = codebaseMemoryPath() !== null;

test('Camp B structural: Klauro matches-or-beats codebase-memory per language', async t => {
  if (!CBM_PRESENT) {
    t.skip('codebase-memory-mcp binary not installed — honest skip');
    return;
  }

  _resetCampBStructuralCache();
  const report = await buildCampBStructuralReport();
  assert.equal(report.available, true, 'binary present so report must be available');

  const { aggregate, perLanguage } = report;

  // 1) HONESTY: no language where codebase-memory strictly out-extracts Klauro.
  const losses = perLanguage.filter(r => r.verdict === 'loss');
  if (losses.length > 0) {
    const names = losses.map(r => `${r.lang}: ${r.note}`).join('\n  ');
    assert.fail(
      `codebase-memory beat Klauro on ${losses.length} language(s) — DEEPEN these analyzers:\n  ${names}`,
    );
  }
  assert.equal(aggregate.losses, 0, 'losses must be zero');

  // 2) Coverage: at least 60 languages measured.
  assert.ok(
    aggregate.languages >= 60,
    `expected >= 60 languages measured, got ${aggregate.languages}`,
  );

  // 3) Every measured language is tie-or-win.
  for (const r of perLanguage) {
    assert.notEqual(r.verdict, 'loss', `${r.lang} must not be a loss`);
  }

  // 4) Token advantage: Klauro mean tokens < codebase-memory mean tokens.
  assert.ok(
    aggregate.meanKlauroTokens < aggregate.meanCbmTokens,
    `Klauro mean tokens (${aggregate.meanKlauroTokens.toFixed(1)}) must be < ` +
      `codebase-memory mean tokens (${aggregate.meanCbmTokens.toFixed(1)})`,
  );
});
