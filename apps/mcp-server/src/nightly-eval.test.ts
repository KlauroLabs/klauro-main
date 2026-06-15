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

test('buildKlauroVocabulary derives terms from the curated orchestrator maps', () => {
  const vocabulary = buildKlauroVocabulary();
  assert.ok(vocabulary.includes('Klauro'));
  assert.ok(vocabulary.includes('Agent Task Proof'));
  assert.ok(vocabulary.includes('Proposal Preview'));
  assert.ok(vocabulary.some(term => term.startsWith('Codebase Analysis builds a CAS relationship graph')));
  assert.ok(vocabulary.length >= 20);
});

test('findVocabularyLeaks reports zero occurrences on a clean foreign analysis', () => {
  const foreign = vocabFixture({
    system_capabilities: [
      capability('Work Order Management', 'Work Order Management maintains work order records, workflows, and relationships used by dispatch behavior.', ['work_order']),
    ],
    user_journeys: [{ id: 'journey-1', name: 'Dispatch a work order', steps: [] }],
  } as unknown as Partial<CASOutput>);
  assert.deepEqual(findVocabularyLeaks(foreign), []);
});

test('findVocabularyLeaks catches curated capability names, descriptions, and Klauro mentions', () => {
  const contaminated = vocabFixture({
    system_capabilities: [
      capability('Agent Task Proof', 'Codebase Analysis builds a CAS relationship graph from repository structure so agents can understand interaction surfaces, data, tests, risks, and dependencies before editing.'),
    ],
    user_journeys: [{ id: 'journey-1', name: 'Run klauro analyze on the repo', steps: [] }],
  } as unknown as Partial<CASOutput>);
  const leaks = findVocabularyLeaks(contaminated);
  assert.ok(leaks.some(leak => leak.term === 'Agent Task Proof' && leak.section === 'capability_names'));
  assert.ok(leaks.some(leak => leak.term.startsWith('Codebase Analysis builds') && leak.section === 'capability_descriptions'));
  assert.ok(leaks.some(leak => leak.term === 'Klauro' && leak.section === 'journeys'));
});

test('evaluateVocabIsolationChecks passes clean foreign analyses and the Klauro positive control', () => {
  const foreign = vocabFixture({
    system_capabilities: [capability('Vehicle Management', 'Vehicle Management maintains vehicle records, workflows, and relationships used by fleet behavior.')],
  } as unknown as Partial<CASOutput>);
  const klauroSelf = vocabFixture({
    system_capabilities: [capability('Agent Work Packets', 'Agent Work Packets turns CAS graph matches, risks, idioms, and tests into a compact coding brief before an AI agent edits a repository.')],
  } as unknown as Partial<CASOutput>);
  const checks = evaluateVocabIsolationChecks({
    foreign: [{ name: 'fleet-app', cas: foreign }],
    klauroSelf,
  });
  assert.equal(checks.length, 2);
  assert.ok(checks.every(check => check.status === 'pass'));
});

test('evaluateVocabIsolationChecks fails contaminated foreign analyses and a de-branded self analysis', () => {
  const contaminated = vocabFixture({
    system_capabilities: [capability('Agent Task Proof', 'Proves agent tasks.')],
  } as unknown as Partial<CASOutput>);
  const debrandedSelf = vocabFixture({
    system_capabilities: [capability('Task Management', 'Task Management maintains task records, workflows, and relationships used by analysis behavior.')],
  } as unknown as Partial<CASOutput>);
  const checks = evaluateVocabIsolationChecks({
    foreign: [{ name: 'wagtail', cas: contaminated }, { name: 'missing-repo', cas: null }],
    klauroSelf: debrandedSelf,
  });
  assert.equal(checks.length, 3);
  assert.ok(checks.every(check => check.status === 'fail'));
  const wagtail = checks.find(check => check.id === 'vocab-isolation-wagtail');
  assert.ok(wagtail?.observed.includes('"Agent Task Proof" in capability_names'));
  const missing = checks.find(check => check.id === 'vocab-isolation-missing-repo');
  assert.equal(missing?.observed, 'analysis not loaded');
});

test('renderScorecard documents the launchd install and uninstall commands', () => {
  const markdown = renderScorecard(sampleRun(), []);
  assert.ok(markdown.includes('launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.klauro.nightly-eval.plist'));
  assert.ok(markdown.includes('launchctl bootout gui/$(id -u)/com.klauro.nightly-eval'));
  assert.ok(markdown.includes('/tmp/klauro-nightly-eval/cron.log'));
});
