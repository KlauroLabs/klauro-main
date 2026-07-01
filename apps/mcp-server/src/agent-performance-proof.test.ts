import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentPerformanceProof } from './agent-performance-proof';

test('buildAgentPerformanceProof rolls up recent live A/B reports and excludes stale reports by default window', () => {
  const now = new Date();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const reports = [
    liveReport('zerac-api', now, 100, 200, 10_000, 20_000, 3, 6),
    liveReport('kadra', now, 50, 100, 20_000, 40_000, 1, 4),
    liveReport('old-repo', old, 1, 10_000, 1, 10_000, 1, 100),
    deterministicReport(now),
    incrementalReport(now),
  ];

  const proof = buildAgentPerformanceProof(reports, { sinceDays: 7 });
  const liveRollup = proof.rollups.find(summary => summary.benchmark_type === 'live-agent-quality-ab-rollup');

  assert.equal(proof.report_count, 5);
  assert.equal(proof.included_report_count, 4);
  assert.ok(liveRollup);
  assert.equal(liveRollup.metrics.live_trials, 2);
  assert.equal(liveRollup.metrics.token_reduction, '50%');
  assert.equal(liveRollup.metrics.time_reduction, '50%');
  assert.equal(liveRollup.metrics.file_read_reduction, '60%');
  assert.equal(proof.claims.length, 3);
});

test('buildAgentPerformanceProof can intentionally include all persisted history', () => {
  const now = new Date();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const proof = buildAgentPerformanceProof([
    liveReport('current', now, 100, 200, 10_000, 20_000, 1, 2),
    liveReport('old', old, 100, 200, 10_000, 20_000, 1, 2),
  ], { sinceDays: 0 });

  const liveRollup = proof.rollups.find(summary => summary.benchmark_type === 'live-agent-quality-ab-rollup');
  assert.equal(proof.included_report_count, 2);
  assert.equal(liveRollup?.metrics.live_trials, 2);
});

test('buildAgentPerformanceProof rolls real engineering task proof into quality and token claims', () => {
  const now = new Date();
  const proof = buildAgentPerformanceProof([
    existingTaskReport(now, 'producer-consumer-contract-change', 'cross-repo-contract-changes', {
      status: 'pass',
      with_score: 100,
      without_score: 96,
      quality_delta: 4,
      token_reduction_percentage: 56,
      time_reduction_percentage: 28,
    }),
    taskFamilyCoverageReport(now),
    deterministicReport(now),
    incrementalReport(now),
  ], { sinceDays: 7 });

  const engineeringRollup = proof.rollups.find(summary => summary.benchmark_type === 'existing-project-live-task-rollup');
  const familyRollup = proof.rollups.find(summary => summary.benchmark_type === 'agent-task-family-coverage-rollup');
  const qualityClaim = proof.claims.find(claim => claim.claim.includes('patch quality'));
  const familyClaim = proof.claims.find(claim => claim.claim.includes('task-family gauntlet'));

  assert.equal(engineeringRollup?.status, 'pass');
  assert.equal(engineeringRollup?.metrics.average_quality_delta, '+4');
  assert.equal(engineeringRollup?.metrics.average_token_reduction, '56%');
  assert.equal(engineeringRollup?.metrics.token_regressions, 0);
  assert.equal(familyRollup?.status, 'pass');
  assert.equal(familyRollup?.metrics.coverage, '17/17');
  assert.equal(qualityClaim?.report_id, 'existing-project-live-task-rollup');
  assert.ok(familyClaim);
});

test('buildAgentPerformanceProof fails live quality rollups when Klauro uses materially more total tokens', () => {
  const now = new Date();
  const proof = buildAgentPerformanceProof([
    existingTaskReport(now, 'mfa', 'mfa-security-enhancement', {
      status: 'pass',
      with_score: 100,
      without_score: 95,
      quality_delta: 5,
      token_reduction_percentage: -12,
      time_reduction_percentage: 10,
    }),
  ], { sinceDays: 7 });

  const engineeringRollup = proof.rollups.find(summary => summary.benchmark_type === 'existing-project-live-task-rollup');
  assert.equal(engineeringRollup?.status, 'fail');
  assert.equal(engineeringRollup?.metrics.token_regressions, 1);
  assert.equal(engineeringRollup?.metrics.average_token_reduction, '-12%');
});

test('buildAgentPerformanceProof accepts only tiny token overhead for clear quality wins', () => {
  const now = new Date();
  const proof = buildAgentPerformanceProof([
    existingTaskReport(now, 'auth-replacement', 'auth-system-replacement', {
      status: 'pass',
      with_score: 100,
      without_score: 84,
      quality_delta: 16,
      token_reduction_percentage: -3,
      time_reduction_percentage: 2,
    }),
  ], { sinceDays: 7 });

  const engineeringRollup = proof.rollups.find(summary => summary.benchmark_type === 'existing-project-live-task-rollup');
  assert.equal(engineeringRollup?.status, 'pass');
  assert.equal(engineeringRollup?.metrics.accepted_token_tradeoffs, 1);
  assert.equal(engineeringRollup?.metrics.token_regressions, 0);
});

function liveReport(
  repo: string,
  generatedAt: Date,
  withTokens: number,
  withoutTokens: number,
  withDuration: number,
  withoutDuration: number,
  withFilesRead: number,
  withoutFilesRead: number
) {
  return {
    benchmark_type: 'live-agent-quality-ab',
    generated_at: generatedAt.toISOString(),
    status: 'pass',
    score: 100,
    summary: {
      target_count: 1,
      task_count: 1,
      with_klauro_success_rate: 1,
      projected_without_klauro_success_rate: 0.5,
      average_quality_score: 100,
      average_quality_score_delta: 0,
      average_token_reduction_vs_search: 50,
      average_time_reduction_vs_search: 50,
      average_file_reduction_vs_search: 50,
      average_context_completeness: 100,
      live_trials_attempted: 1,
      live_with_klauro_success_rate: 1,
      live_without_klauro_success_rate: 1,
    },
    trials: [{
      repo,
      live_pair: {
        with_klauro: {
          provider_total_tokens: withTokens,
          duration_ms: withDuration,
          files_read: withFilesRead,
        },
        without_klauro: {
          provider_total_tokens: withoutTokens,
          duration_ms: withoutDuration,
          files_read: withoutFilesRead,
        },
        evaluation: {
          with_klauro_success: true,
          without_klauro_success: true,
          with_klauro_quality_score: 100,
          without_klauro_quality_score: 100,
          quality_score_delta: 0,
        },
      },
    }],
  };
}

function existingTaskReport(generatedAt: Date, id: string, family: string, liveSummary: Record<string, unknown>) {
  return {
    benchmark_type: 'seeded-existing-project-task-proof',
    generated_at: generatedAt.toISOString(),
    status: 'pass',
    score: 100,
    summary: {
      scenario_count: 1,
      family_count: 1,
      passing_scenarios: 1,
      average_score_delta: Number(liveSummary.quality_delta || 0),
      average_file_reduction_percentage: 25,
      average_token_reduction_percentage: Number(liveSummary.token_reduction_percentage || 0),
      live_scenarios: 1,
      live_passing_scenarios: liveSummary.status === 'pass' ? 1 : 0,
      average_live_quality_delta: Number(liveSummary.quality_delta || 0),
      average_live_token_reduction_percentage: Number(liveSummary.token_reduction_percentage || 0),
    },
    scenarios: [{
      id,
      family,
      status: 'pass',
      score: liveSummary.with_score,
      live_summary: liveSummary,
    }],
  };
}

function taskFamilyCoverageReport(generatedAt: Date) {
  return {
    benchmark_type: 'agent-task-family-coverage',
    generated_at: generatedAt.toISOString(),
    status: 'pass',
    score: 100,
    summary: {
      strong: 17,
      partial: 0,
      gaps: 0,
      families: 17,
    },
  };
}

function deterministicReport(generatedAt: Date) {
  return {
    benchmark_type: 'agentic-suite-with-klauro-vs-without-klauro',
    generated_at: generatedAt.toISOString(),
    status: 'pass',
    score: 100,
    summary: {
      target_count: 1,
      task_count: 1,
      with_klauro_success_rate: 1,
      projected_without_klauro_success_rate: 0.5,
      average_token_reduction_vs_cold_scan: 95,
      average_token_reduction_vs_search: 86,
      average_file_reduction: 99,
      average_speedup_vs_cold_scan: 100,
      average_speedup_vs_search: 80,
      average_cached_solution_ms_with_klauro: 100,
      average_search_solution_ms_without_klauro: 8000,
    },
  };
}

function incrementalReport(generatedAt: Date) {
  return {
    benchmark_type: 'incremental-analysis-agent-value',
    generated_at: generatedAt.toISOString(),
    status: 'pass',
    score: 100,
    summary: {
      target_count: 1,
      incremental_success_rate: 1,
      average_initial_full_ms: 1000,
      average_no_change_incremental_ms: 100,
      average_edit_incremental_ms: 250,
      average_no_change_speedup_vs_full: 10,
      average_edit_speedup_vs_full: 4,
      average_context_generation_ms_after_edit: 20,
      average_file_read_plan_after_edit: 2,
      average_context_tokens_after_edit: 500,
      average_full_verify_count_similarity: 1,
    },
  };
}
