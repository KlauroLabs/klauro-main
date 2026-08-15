import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  buildKlauroVocabulary,
  buildVersionSkewFixture,
  evaluateVocabIsolationChecks,
  extractTrendRows,
  findVocabularyLeaks,
  formatScorecardRow,
  renderScorecard,
  type NightlyEvalRun,
} from './nightly-eval';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

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

function vocabFixture(overrides: Partial<CASOutput> = {}): CASOutput {
  return { ...buildVersionSkewFixture('1.9.0'), ...overrides } as CASOutput;
}

function capability(name: string, description: string, relatedDomains: string[] = []) {
  return {
    id: `cap-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    description,
    category: 'core',
    operations: [],
    related_entities: [],
    related_domains: relatedDomains,
    criticality: 'medium',
    criticality_factors: [],
  };
}

// #113: buildKlauroVocabulary used to also seed from KLAURO_SELF_CAPABILITY_NAMES
// / KLAURO_SELF_CAPABILITY_DESCRIPTIONS, hand-written maps the orchestrator used
// to manufacture capability names/descriptions for its own repo (a doctrine
// violation: product source must not special-case one repo's vocabulary). Those
// maps are removed, so there is no curated vocabulary left to derive terms from
// — the only legitimate cross-contamination signal that survives is the literal
// brand mention.
test('buildKlauroVocabulary is just the literal brand mention now that the curated maps are gone', () => {
  const vocabulary = buildKlauroVocabulary();
  assert.deepEqual(vocabulary, ['Klauro']);
});

test('findVocabularyLeaks reports zero occurrences on a clean foreign analysis', () => {
  const foreign = vocabFixture({
    capabilities: [
      capability('Work Order Management', 'Work Order Management maintains work order records, workflows, and relationships used by dispatch behavior.', ['work_order']),
    ],
    user_journeys: [{ id: 'journey-1', name: 'Dispatch a work order', steps: [] }],
  } as unknown as Partial<CASOutput>);
  assert.deepEqual(findVocabularyLeaks(foreign), []);
});

test('findVocabularyLeaks catches literal Klauro brand mentions', () => {
  const contaminated = vocabFixture({
    capabilities: [
      capability('Klauro Sync', 'Calls out to Klauro for analysis.'),
    ],
    user_journeys: [{ id: 'journey-1', name: 'Run klauro analyze on the repo', steps: [] }],
  } as unknown as Partial<CASOutput>);
  const leaks = findVocabularyLeaks(contaminated);
  assert.ok(leaks.some(leak => leak.term === 'Klauro' && leak.section === 'capability_names'));
  assert.ok(leaks.some(leak => leak.term === 'Klauro' && leak.section === 'capability_descriptions'));
  assert.ok(leaks.some(leak => leak.term === 'Klauro' && leak.section === 'journeys'));
});

// #113: this used to also assert a "positive control" — that Klauro's own
// self-analysis still received its curated capability names. That test
// validated the doctrine violation itself (manufactured vocabulary appearing
// in the self-analysis was the PASSING case), so it is removed along with
// evaluateVocabIsolationChecks's `klauroSelf` parameter. Only the legitimate
// direction remains: foreign repos must not pick up Klauro's own vocabulary.
test('evaluateVocabIsolationChecks passes a clean foreign analysis', () => {
  const foreign = vocabFixture({
    capabilities: [capability('Vehicle Management', 'Vehicle Management maintains vehicle records, workflows, and relationships used by fleet behavior.')],
  } as unknown as Partial<CASOutput>);
  const checks = evaluateVocabIsolationChecks({
    foreign: [{ name: 'fleet-app', cas: foreign }],
  });
  assert.equal(checks.length, 1);
  assert.ok(checks.every(check => check.status === 'pass'));
});

test('evaluateVocabIsolationChecks fails a contaminated foreign analysis and reports a missing repo', () => {
  const contaminated = vocabFixture({
    capabilities: [capability('Klauro Sync', 'Proves agent tasks via Klauro.')],
  } as unknown as Partial<CASOutput>);
  const checks = evaluateVocabIsolationChecks({
    foreign: [{ name: 'wagtail', cas: contaminated }, { name: 'missing-repo', cas: null }],
  });
  assert.equal(checks.length, 2);
  assert.ok(checks.every(check => check.status === 'fail'));
  const wagtail = checks.find(check => check.id === 'vocab-isolation-wagtail');
  assert.ok(wagtail?.observed.includes('"Klauro" in capability_names'));
  const missing = checks.find(check => check.id === 'vocab-isolation-missing-repo');
  assert.equal(missing?.observed, 'analysis not loaded');
});

test('renderScorecard documents the launchd install and uninstall commands', () => {
  const markdown = renderScorecard(sampleRun(), []);
  assert.ok(markdown.includes('launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.klauro.nightly-eval.plist'));
  assert.ok(markdown.includes('launchctl bootout gui/$(id -u)/com.klauro.nightly-eval'));
  assert.ok(markdown.includes('/tmp/klauro-nightly-eval/cron.log'));
});
