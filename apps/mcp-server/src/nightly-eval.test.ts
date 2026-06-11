import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  extractTrendRows,
  formatScorecardRow,
  renderScorecard,
  type NightlyEvalRun,
} from './nightly-eval';

function sampleRun(overrides: Partial<NightlyEvalRun> = {}): NightlyEvalRun {
  return {
    generatedAt: '2026-06-10T02:00:12.345Z',
    status: 'pass',
    durationMs: 612000,
    suites: [
      {
        suite: 'analysis-gauntlet',
        status: 'pass',
        durationMs: 240000,
        detail: '10 truth fixtures, score 100/100',
        metrics: { score: 100, targets: 10, failing_targets: [] },
      },
      {
        suite: 'run-stability',
        status: 'pass',
        durationMs: 90000,
        detail: 'Deterministic re-analysis verdict: stable',
        metrics: {},
      },
      {
        suite: 'answer-pack',
        status: 'pass',
        durationMs: 9000,
        detail: '5/5 invariant questions held',
        metrics: { failing: [] },
      },
      {
        suite: 'bundle-smoke',
        status: 'pass',
        durationMs: 60000,
        detail: 'Bundle initialized (core 142ms, full 188ms)',
        metrics: { init_ms: { core: 142, full: 188 } },
      },
    ],
    answerPackChecks: [
      { id: 'a', question: 'q', invariant: 'i', observed: 'o', status: 'pass' },
      { id: 'b', question: 'q', invariant: 'i', observed: 'o', status: 'pass' },
      { id: 'c', question: 'q', invariant: 'i', observed: 'o', status: 'pass' },
      { id: 'd', question: 'q', invariant: 'i', observed: 'o', status: 'pass' },
      { id: 'e', question: 'q', invariant: 'i', observed: 'o', status: 'pass' },
    ],
    ...overrides,
  };
}

test('formatScorecardRow renders one pipe-delimited trend row with suite cells', () => {
  const row = formatScorecardRow(sampleRun());
  assert.equal(row, '| 2026-06-10 02:00 | pass | pass 100/100 | pass | pass 5/5 | pass 142ms | 612s |');
});

test('formatScorecardRow marks missing suites and failures', () => {
  const run = sampleRun({
    status: 'fail',
    suites: [
      {
        suite: 'analysis-gauntlet',
        status: 'fail',
        durationMs: 1000,
        detail: 'score 70/100',
        metrics: { score: 70 },
      },
    ],
    answerPackChecks: [],
  });
  const row = formatScorecardRow(run);
  assert.equal(row, '| 2026-06-10 02:00 | fail | fail 70/100 | missing | missing | missing | 612s |');
});

test('renderScorecard appends the new row and keeps the last 30 trend rows', () => {
  const previousRows = Array.from({ length: 35 }, (_, index) =>
    `| 2026-05-${String(index + 1).padStart(2, '0')} 02:00 | pass | pass 100/100 | pass | pass 5/5 | pass 100ms | 600s |`);
  const markdown = renderScorecard(sampleRun(), previousRows);
  const rows = extractTrendRows(markdown);
  assert.equal(rows.length, 30);
  assert.equal(rows[rows.length - 1], formatScorecardRow(sampleRun()));
  assert.equal(rows[0], previousRows[6]);
});

test('extractTrendRows survives a missing or malformed trend section', () => {
  assert.deepEqual(extractTrendRows(''), []);
  assert.deepEqual(extractTrendRows('# Scorecard\nno markers here'), []);
});

test('renderScorecard documents the launchd install and uninstall commands', () => {
  const markdown = renderScorecard(sampleRun(), []);
  assert.ok(markdown.includes('launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.klauro.nightly-eval.plist'));
  assert.ok(markdown.includes('launchctl bootout gui/$(id -u)/com.klauro.nightly-eval'));
  assert.ok(markdown.includes('/tmp/klauro-nightly-eval/cron.log'));
});
