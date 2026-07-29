/**
 * REGRESSION GATE — a stored analysis produced by a DIFFERENT analyzer must
 * not be reused.
 *
 * Measured live on the deployed build (2026-07-28): `analyze` on an unchanged
 * repo returned `{ reused: true, analysis_type: 'unchanged' }` because the
 * reuse gate deduped on the SOURCE SNAPSHOT alone. A customer who upgraded the
 * CLI and re-ran analyze silently got their old analysis back; every re-run
 * during the audit needed an explicit `/reanalyze`. Red here means analyzer
 * fixes stop reaching customers again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAnalyzerIdentityReuse } from './analyzer-identity-reuse';

const CURRENT = {
  analyzer_build: '1.0.120+abcdef1',
  parser_fingerprint: 'parser-AAA',
  derived_fingerprint: 'derived-BBB',
};

test('reuses when the analyzer identity is identical', () => {
  const decision = decideAnalyzerIdentityReuse({ ...CURRENT }, CURRENT);
  assert.equal(decision.reusable, true);
  assert.equal(decision.tier, 'match');
});

test('does NOT reuse when the parser layer changed (full re-parse tier)', () => {
  const decision = decideAnalyzerIdentityReuse({ ...CURRENT, parser_fingerprint: 'parser-OLD' }, CURRENT);
  assert.equal(decision.reusable, false);
  assert.equal(decision.tier, 'parser');
  assert.match(decision.reason, /parser-layer fingerprint changed/i);
});

test('does NOT reuse when only the derived layer changed (parse caches still apply)', () => {
  const decision = decideAnalyzerIdentityReuse({ ...CURRENT, derived_fingerprint: 'derived-OLD' }, CURRENT);
  assert.equal(decision.reusable, false);
  assert.equal(decision.tier, 'derived');
});

test('DOES reuse when only the whole-build stamp moved and both stage fingerprints match', () => {
  // The case stage fingerprints exist for: an MCP-tool-only / marketing
  // release must not turn every deploy into a cold rebuild for every project.
  const decision = decideAnalyzerIdentityReuse({ ...CURRENT, analyzer_build: '1.0.119+0000000' }, CURRENT);
  assert.equal(decision.reusable, true);
  assert.equal(decision.tier, 'build');
});

test('does NOT reuse a legacy analysis stamped before stage fingerprints', () => {
  const decision = decideAnalyzerIdentityReuse({ analyzer_build: '1.0.100+old' }, CURRENT);
  assert.equal(decision.reusable, false);
  assert.equal(decision.tier, 'legacy-build');
});

test('does NOT reuse an analysis carrying no analyzer identity at all', () => {
  assert.equal(decideAnalyzerIdentityReuse(null, CURRENT).reusable, false);
  assert.equal(decideAnalyzerIdentityReuse(null, CURRENT).tier, 'unknown');
  assert.equal(decideAnalyzerIdentityReuse({}, CURRENT).reusable, false);
});

test('always states a reason — `reused: true` with no reason is the defect', () => {
  for (const stored of [
    { ...CURRENT },
    { ...CURRENT, parser_fingerprint: 'x' },
    { ...CURRENT, derived_fingerprint: 'x' },
    { analyzer_build: 'old' },
    {},
  ]) {
    assert.ok(decideAnalyzerIdentityReuse(stored, CURRENT).reason.length > 10);
  }
});
