import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { buildLivePairRepRecord, parseArgs, runLiveRepetitions, runSeededExistingTaskBenchmark } from './agent-existing-task-benchmark';
import type { LiveAgentPairResult } from './agent-live-trial';

test('seeded existing-task benchmark covers non-greenfield engineering families', async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-existing-task-proof-'));
  const report = await runSeededExistingTaskBenchmark({
    outputRoot,
    reportPath: null,
    markdownPath: null,
    live: false,
    liveReps: 1,
    liveConfig: {},
    withoutArmRetrieval: false,
    realRepoPath: null,
    realTaskId: null,
  });

  assert.equal(report.status, 'pass');
  assert.equal(report.summary.scenario_count, 14);
  assert.equal(report.summary.family_count, 13);
  assert.equal(report.summary.passing_scenarios, 14);
  assert.equal(report.summary.proof_strength, 'deterministic-proxy');
  assert.match(report.summary.claim_limit, /not final live-agent quality/);
  assert.ok(report.summary.average_score_delta > 0);
  assert.ok(report.summary.average_file_reduction_percentage > 0);
  assert.ok(report.summary.average_token_reduction_percentage > 0);
  assert.ok(report.summary.klauro_vs_index_retrieval_token_reduction_percentage > 0);
  assert.equal(report.summary.live_scenarios, 0);
  const producerConsumer = report.scenarios.find(scenario => scenario.id === 'producer-consumer-contract-change');
  assert.equal(producerConsumer?.with_klauro.file_hit_rate, 100);
  assert.ok((producerConsumer?.score || 0) >= 90);
  const performanceFix = report.scenarios.find(scenario => scenario.id === 'n-plus-one-task-summary');
  assert.equal(performanceFix?.status, 'pass');
  assert.equal(performanceFix?.with_klauro.file_hit_rate, 100);
  assert.ok(performanceFix?.with_klauro.first_files.includes('src/services/taskSummaryService.ts'));
  assert.ok(performanceFix?.with_klauro.first_files.includes('src/repositories/projectRepository.ts'));
  assert.deepEqual(
    new Set(report.scenarios.map(scenario => scenario.family)),
    new Set([
      'bug-diagnosis-root-cause',
      'bug-fix-live-edits',
      'real-product-enhancements',
      'architectural-change-refactor',
      'monolith-decomposition',
      'schema-migration-changes',
      'auth-tenant-boundary-changes',
      'auth-system-replacement',
      'mfa-security-enhancement',
      'test-addition-coverage',
      'performance-fixes',
      'cross-repo-contract-changes',
      'large-feature-integration',
    ])
  );
});

test('parseArgs supports --live-reps within 1..5 and rejects everything else', () => {
  assert.equal(parseArgs([]).liveReps, 1);
  assert.equal(parseArgs(['--live-reps', '3']).liveReps, 3);
  assert.equal(parseArgs(['--live-reps', '5']).liveReps, 5);
  assert.throws(() => parseArgs(['--live-reps', '0']), /--live-reps must be an integer between 1 and 5/);
  assert.throws(() => parseArgs(['--live-reps', '6']), /--live-reps must be an integer between 1 and 5/);
  assert.throws(() => parseArgs(['--live-reps', '2.5']), /--live-reps must be an integer between 1 and 5/);
  assert.throws(() => parseArgs(['--live-reps', 'three']), /--live-reps must be an integer between 1 and 5/);
  assert.throws(() => parseArgs(['--unknown-flag']), /Unknown option --unknown-flag/);
});

test('runLiveRepetitions survives a crashed rep and aggregates over completed reps', async () => {
  const expectedChanged = ['src/a.ts', 'tests/a.test.ts'];
  const { repetition, pairs } = await runLiveRepetitions(3, expectedChanged, async rep => {
    if (rep === 2) throw new Error('codex timed out');
    return fakePair(rep === 1 ? 90 : 70, rep === 1 ? 60 : 80, rep === 1 ? 1000 : 3000, rep === 1 ? 9000 : 11000);
  });

  assert.equal(repetition.reps_requested, 3);
  assert.equal(repetition.reps.length, 3);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[1], null);
  assert.equal(repetition.reps[1].completed, false);
  assert.match(repetition.reps[1].error || '', /codex timed out/);
  assert.equal(repetition.with_arm.completed_reps, 2);
  assert.equal(repetition.with_arm.failed_reps, 1);
  assert.equal(repetition.with_arm.failed, false);
  assert.equal(repetition.with_arm.quality?.median, 80);
  assert.equal(repetition.without_arm.quality?.median, 70);
  assert.equal(repetition.comparison.paired_reps, 2);
  assert.equal(repetition.comparison.median_quality_delta, 10);
  assert.ok(repetition.single_rep_fields_rep === 1 || repetition.single_rep_fields_rep === 3);
  assert.equal(repetition.single_rep_fields_source, 'median-rep');
});

test('runLiveRepetitions reports an arm as failed when every rep fails', async () => {
  const { repetition, pairs } = await runLiveRepetitions(2, ['src/a.ts'], async () => {
    throw new Error('agent crashed');
  });

  assert.equal(pairs.every(pair => pair === null), true);
  assert.equal(repetition.with_arm.failed, true);
  assert.equal(repetition.without_arm.failed, true);
  assert.equal(repetition.with_arm.completed_reps, 0);
  assert.equal(repetition.comparison.median_quality_delta, null);
  assert.equal(repetition.comparison.variance_warning, true);
  assert.equal(repetition.single_rep_fields_rep, null);
  assert.equal(repetition.single_rep_fields_source, 'none');
});

test('buildLivePairRepRecord computes changed-file precision and marks crashed arms failed', () => {
  const pair = fakePair(88, 70, 1200, 9000);
  pair.with_klauro.changed_files = ['src/a.ts', 'src/unrelated.ts'];
  pair.without_klauro.error = 'spawn failed';
  const record = buildLivePairRepRecord(1, pair, ['src/a.ts', 'tests/a.test.ts']);

  assert.equal(record.completed, true);
  assert.equal(record.with_arm?.completed, true);
  assert.equal(record.with_arm?.metrics?.changed_file_precision, 50);
  assert.equal(record.with_arm?.metrics?.lines_changed, 12);
  assert.equal(record.without_arm?.completed, false);
  assert.match(record.without_arm?.error || '', /spawn failed/);
});

function fakePair(withQuality: number, withoutQuality: number, withMs: number, withoutMs: number): LiveAgentPairResult {
  return {
    trial_id: 'fake-trial',
    status: 'pass',
    work_root: '/tmp/fake',
    with_klauro: fakeArm('with-klauro', withMs, 1000),
    without_klauro: fakeArm('without-klauro', withoutMs, 4000),
    evaluation: {
      mode: 'deterministic-orchestrator',
      status: 'pass',
      with_klauro_quality_score: withQuality,
      without_klauro_quality_score: withoutQuality,
      quality_score_delta: withQuality - withoutQuality,
      with_klauro_success: true,
      without_klauro_success: true,
      token_reduction_percentage: 25,
      time_reduction_percentage: 10,
      file_change_delta: 0,
      changed_file_precision_delta: 0,
      with_klauro_completion_score: 100,
      without_klauro_completion_score: 100,
      completion_score_delta: 0,
      with_klauro_command_success: true,
      without_klauro_command_success: true,
      confidence: 0.9,
      reasons: [],
    },
    artifacts: {
      trial_directory: '/tmp/fake/trial',
      evaluation_input_file: '/tmp/fake/trial/evaluation-input.json',
      evaluation_file: '/tmp/fake/trial/evaluation.json',
      with_diff_file: '/tmp/fake/trial/with.diff',
      without_diff_file: '/tmp/fake/trial/without.diff',
    },
  };
}

function fakeArm(arm: 'with-klauro' | 'without-klauro', durationMs: number, tokens: number): LiveAgentPairResult['with_klauro'] {
  return {
    attempted: true,
    arm,
    status: 'pass',
    workspace: `/tmp/fake/${arm}`,
    prompt_file: `/tmp/fake/${arm}/prompt.md`,
    metrics_file: `/tmp/fake/${arm}/metrics.json`,
    result_file: `/tmp/fake/${arm}/result.json`,
    diff_file: `/tmp/fake/${arm}.diff`,
    duration_ms: durationMs,
    files_changed: 2,
    changed_files: ['src/a.ts', 'tests/a.test.ts'],
    lines_added: 10,
    lines_deleted: 2,
    tests_passed: true,
    provider_total_tokens: tokens,
    estimated_input_tokens: tokens,
    estimated_output_tokens: 100,
    estimated_total_tokens: tokens + 100,
  };
}
