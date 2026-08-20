/**
 * OSS study test — Klauro vs real competitors on untuned real OSS repos.
 *
 * Honesty contract asserted here mirrors camp-b-structural.test.ts: losses === 0
 * (honest ties at a competitor's ceiling are fine — the point is no fixture
 * tuning, not artificial superiority). Robust to sandbox conditions: if no repo
 * could be cloned (offline) and no fallback corpus exists, or no competitor arm is
 * installed at all, the test SKIPS with a clear reason instead of failing — a
 * sandbox with no network or no cbm/ctags binary is not a Klauro regression.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';

import { buildOssStudyReport } from './oss-study';
import { codebaseMemoryPath, ctagsAvailable, startCodebaseMemoryDaemon, type CodebaseMemoryDaemonLease } from './real-camp-arms';

let daemon: CodebaseMemoryDaemonLease | null = null;

before(() => {
  daemon = startCodebaseMemoryDaemon();
});

after(() => {
  daemon?.close();
});

function networkAvailable(): boolean {
  try {
    execFileSync('git', ['ls-remote', 'https://github.com/sindresorhus/is-plain-obj.git', 'HEAD'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

test('OSS study: Klauro vs real competitors on untuned real OSS repos', { timeout: 280_000 }, async t => {
  const hasNetwork = networkAvailable();
  const hasCompetitorArm = codebaseMemoryPath() !== null || ctagsAvailable();

  if (!hasNetwork) {
    t.skip('no network reachable (git ls-remote failed) and this harness has no fixture fallback for a cold sandbox — honest skip');
    return;
  }
  if (!hasCompetitorArm) {
    t.skip('neither codebase-memory-mcp nor ctags is installed — no competitor arm available — honest skip');
    return;
  }

  const report = await buildOssStudyReport();

  assert.ok(report.repos.length > 0, 'expected at least one repo row in the report');

  const measured = report.repos.filter(r => r.cloned && r.verdict !== 'unmeasured');
  if (measured.length === 0) {
    t.skip(`no repo could be cloned or resolved from the fallback corpus: ${report.summary.reason}`);
    return;
  }

  // HONESTY: no repo where a competitor arm out-extracted Klauro on symbol names.
  const losses = report.repos.filter(r => r.verdict === 'loss');
  if (losses.length > 0) {
    const detail = losses.map(r => `${r.repo}: ${r.note}`).join('\n  ');
    assert.fail(`competitor arm beat Klauro on ${losses.length} real OSS repo(s) — DEEPEN the analyzer:\n  ${detail}`);
  }
  assert.equal(report.summary.losses, 0, 'losses must be zero (honest ties allowed)');

  // Every measured repo is win or tie — never a loss.
  for (const r of measured) {
    assert.notEqual(r.verdict, 'loss', `${r.repo} must not be a loss`);
  }

  console.log(`[oss-study] compared=${report.summary.compared} unmeasured=${report.summary.unmeasured} wins=${report.summary.wins} ties=${report.summary.ties} losses=${report.summary.losses} strictWinRate=${report.summary.strictWinRate?.toFixed(2) ?? 'N/A'} nonLossRate=${report.summary.nonLossRate?.toFixed(2) ?? 'N/A'} avgKlauroToCompetitorTokenRatio=${report.summary.avgKlauroToCompetitorTokenRatio?.toFixed(2) ?? 'N/A'}`);
});
