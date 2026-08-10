/**
 * REGRESSION GATE — task #129: `klauro analyze` (the shipped, customer-facing
 * command) must never render an in-progress ('accepted') result in a way
 * that reads like a finished analysis. Two failure shapes pinned here:
 *
 *  1. formatRemoteResult's text rendering must say plainly that the analysis
 *     is still running (and never dump a raw completion-shaped structure)
 *     when status is 'accepted'.
 *  2. withAnalysisState must add an unambiguous `analysis_state` field so a
 *     --json caller (script, harness, agent) doesn't have to already know
 *     that `status: 'accepted'` means "not done yet."
 *
 * Also asserts, at the source level, that BOTH CLI entry points
 * (installed-cli.ts — the one customers actually run — and cli.ts, the dev
 * CLI) render `analyze`/`remote-sync` output through this shared module
 * rather than each hand-rolling their own (which is exactly how the two
 * drifted before: cli.ts had honest text output, installed-cli.ts dumped the
 * raw object through JSON.stringify even in non-`--json` mode).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { formatRemoteResult, withAnalysisState } from './remote-result-format';
import type { AnalyzeRemotelyResult } from './remote-sync-client';

function acceptedResult(): AnalyzeRemotelyResult {
  return {
    status: 'accepted',
    analysis_id: 'analysis-129-fixture',
    manifest: { file_count: 42, total_bytes: 123456 } as any,
    reuse_decision: { reused: false, reason: 'first analysis', analyzer_identity_tier: 'match' } as any,
  } as unknown as AnalyzeRemotelyResult;
}

function successResult(): AnalyzeRemotelyResult {
  return {
    status: 'success',
    analysis_id: 'analysis-129-fixture',
    analysis_revision: 1,
    analysis_type: 'full',
    manifest: { file_count: 42, total_bytes: 123456 } as any,
    cas: { nodes: [1, 2, 3], edges: [1, 2] } as any,
  } as unknown as AnalyzeRemotelyResult;
}

test('an accepted (still-running) result renders as running, never as a raw completion dump', () => {
  const text = formatRemoteResult(acceptedResult());
  assert.match(text, /running on the Klauro server/i);
  assert.match(text, /did NOT wait/i);
  // The defect this closes: the OLD installed-cli.ts path JSON.stringified
  // the raw result even in text mode, so `reuse_decision`/`{`/`}` leaked
  // into what should be a plain status sentence.
  assert.ok(!text.includes('reuse_decision'), 'must not leak the raw JSON shape into the human-readable rendering');
  assert.ok(!text.trim().startsWith('{'), 'must not read as a JSON dump');
});

test('a completed result still renders the full completion summary', () => {
  const text = formatRemoteResult(successResult());
  assert.match(text, /Klauro remote analysis: SUCCESS/);
  assert.match(text, /Nodes: 3/);
});

test('withAnalysisState makes running vs complete an explicit, unambiguous field', () => {
  assert.equal(withAnalysisState(acceptedResult()).analysis_state, 'running');
  assert.equal(withAnalysisState(successResult()).analysis_state, 'complete');
  // Additive — every existing field (including the ones a caller might
  // already branch on, like `status`) survives untouched.
  assert.equal(withAnalysisState(acceptedResult()).status, 'accepted');
});

test('both CLI entry points render analyze/remote-sync output through the shared formatter', () => {
  const installedCliSource = readFileSync(path.join(__dirname, 'installed-cli.ts'), 'utf8');
  const cliSource = readFileSync(path.join(__dirname, 'cli.ts'), 'utf8');
  assert.match(installedCliSource, /formatRemoteResult/, 'installed-cli.ts (the shipped customer surface) must use the shared formatter, not dump the raw result');
  assert.match(installedCliSource, /withAnalysisState/, 'installed-cli.ts --json output must carry the explicit analysis_state field');
  assert.match(cliSource, /formatRemoteResult/, 'cli.ts must keep using the shared formatter (not a re-inlined copy) so the two entry points cannot diverge again');
});
