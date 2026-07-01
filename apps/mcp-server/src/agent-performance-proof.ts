import { formatMarkdownReport as formatAgenticMarkdownReport } from './agent-benchmark';
import { formatQualityMarkdownReport } from './agent-quality-benchmark';
import { formatIncrementalValueMarkdownReport } from './incremental-benchmark';
import { formatIdiomBenchmarkMarkdown } from './agent-idiom-benchmark';

type StoredBenchmarkReport = Record<string, any>;

const SMALL_TOKEN_OVERHEAD_PERCENT = 3;
const CLEAR_QUALITY_WIN_DELTA = 15;

interface ProofSummary {
  benchmark_type: string;
  id?: string;
  generated_at?: string;
  saved_at?: string;
  status?: string;
  score?: number;
  metrics: Record<string, unknown>;
}

interface AgentPerformanceProofOptions {
  sinceDays?: number | null;
}

export function formatStoredBenchmarkReport(report: StoredBenchmarkReport): string {
  if (isFromZeroBuildContextReport(report)) return formatFromZeroBuildContextMarkdown(report);
  if (isIdiomReport(report)) return formatIdiomBenchmarkMarkdown(report as any);
  if (isQualityReport(report)) return formatQualityMarkdownReport(report as any);
  if (isIncrementalReport(report)) return formatIncrementalValueMarkdownReport(report as any);
  return formatAgenticMarkdownReport(report as any);
}

export function buildAgentPerformanceProof(reports: StoredBenchmarkReport[], options: AgentPerformanceProofOptions = {}) {
  const includedReports = filterReportsByWindow(reports, options.sinceDays);
  const sortedReports = [...includedReports].sort((left, right) => timestamp(right).localeCompare(timestamp(left)));
  const latestByType = latestReportsByType(sortedReports);
  const summaries = latestByType.map(summarizeReport);
  const rollups = [
    buildLiveRollup(sortedReports),
    buildExistingTaskLiveRollup(sortedReports),
    buildTaskFamilyCoverageRollup(sortedReports),
  ].filter((summary): summary is ProofSummary => Boolean(summary));
  const generatedAt = new Date().toISOString();
  const claims = buildClaims(summaries, rollups);

  return {
    generated_at: generatedAt,
    report_count: reports.length,
    included_report_count: includedReports.length,
    since_days: options.sinceDays ?? null,
    latest_report_count: summaries.length,
    rollups,
    latest_by_type: summaries,
    claims,
    markdown: formatProofMarkdown(generatedAt, summaries, rollups, claims),
  };
}

function filterReportsByWindow(reports: StoredBenchmarkReport[], sinceDays?: number | null): StoredBenchmarkReport[] {
  if (!sinceDays || sinceDays <= 0) return reports;
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  return reports.filter(report => {
    const generatedAt = report.generated_at || report.generatedAt || report.saved_at;
    const parsed = Date.parse(String(generatedAt || ''));
    return Number.isFinite(parsed) && parsed >= cutoff;
  });
}

function isQualityReport(report: StoredBenchmarkReport): boolean {
  return report.benchmark_type === 'deterministic-agent-quality-proxy'
    || report.benchmark_type === 'live-agent-quality-ab'
    || Number.isFinite(report.summary?.average_quality_score);
}

function isIncrementalReport(report: StoredBenchmarkReport): boolean {
  return report.benchmark_type === 'incremental-analysis-agent-value'
    || Number.isFinite(report.summary?.average_edit_incremental_ms);
}

function isIdiomReport(report: StoredBenchmarkReport): boolean {
  return report.benchmark_type === 'live-agent-idiom-quality-ab'
    || report.benchmark_type === 'deterministic-agent-idiom-quality-proxy'
    || Number.isFinite(report.summary?.average_idiom_conformance_delta);
}

function isFromZeroBuildContextReport(report: StoredBenchmarkReport): boolean {
  return report.benchmark_type === 'from-zero-build-context-proof';
}

function isExistingTaskReport(report: StoredBenchmarkReport): boolean {
  return report.benchmark_type === 'seeded-existing-project-task-proof';
}

function isTaskFamilyCoverageReport(report: StoredBenchmarkReport): boolean {
  return report.benchmark_type === 'agent-task-family-coverage';
}

function latestReportsByType(reports: StoredBenchmarkReport[]): StoredBenchmarkReport[] {
  const byType = new Map<string, StoredBenchmarkReport>();
  for (const report of reports) {
    const type = report.benchmark_type || 'unknown';
    if (!byType.has(type)) byType.set(type, report);
  }
  return [...byType.values()];
}

function summarizeReport(report: StoredBenchmarkReport): ProofSummary {
  const summary = report.summary || {};
  const metrics: Record<string, unknown> = {};

  if (isTaskFamilyCoverageReport(report)) {
    Object.assign(metrics, {
      families: summary.families,
      strong_families: summary.strong,
      partial_families: summary.partial,
      gap_families: summary.gaps,
      coverage: coverage(summary.strong, summary.families),
    });
  } else if (isExistingTaskReport(report)) {
    Object.assign(metrics, {
      scenarios: summary.scenario_count,
      families: summary.family_count,
      passing_scenarios: summary.passing_scenarios,
      average_score_delta: signed(summary.average_score_delta),
      average_file_reduction: asPercentNumber(summary.average_file_reduction_percentage),
      average_token_reduction: asPercentNumber(summary.average_token_reduction_percentage),
      live_scenarios: summary.live_scenarios,
      live_passing_scenarios: summary.live_passing_scenarios,
      live_average_quality_delta: signed(summary.average_live_quality_delta),
      live_average_token_reduction: asPercentNumber(summary.average_live_token_reduction_percentage),
    });
  } else if (isFromZeroBuildContextReport(report)) {
    Object.assign(metrics, {
      scenarios: summary.scenario_count,
      scenarios_passed: summary.scenarios_passed,
      tasks: summary.task_count,
      product_focus_scenarios: summary.product_focus_scenario_count,
      quality_delta: signed(summary.quality_delta),
      duplicate_class_delta: signed(summary.duplicate_class_delta),
      with_klauro_duplicate_classes: summary.with_klauro_duplicate_classes,
      without_klauro_duplicate_classes: summary.without_klauro_duplicate_classes,
      focused_context_file_reduction: summary.focused_context_file_reduction,
      context_char_reduction: asPercentNumber(summary.context_char_reduction_percentage),
    });
  } else if (isIncrementalReport(report)) {
    Object.assign(metrics, {
      targets: summary.target_count,
      incremental_success_rate: asPercent(summary.incremental_success_rate),
      average_full_analysis_ms: summary.average_initial_full_ms,
      average_no_change_incremental_ms: summary.average_no_change_incremental_ms,
      average_edit_incremental_ms: summary.average_edit_incremental_ms,
      average_no_change_speedup_vs_full: summary.average_no_change_speedup_vs_full,
      average_edit_speedup_vs_full: summary.average_edit_speedup_vs_full,
      average_context_generation_ms_after_edit: summary.average_context_generation_ms_after_edit,
      average_file_read_plan_after_edit: summary.average_file_read_plan_after_edit,
      average_context_tokens_after_edit: summary.average_context_tokens_after_edit,
      average_total_context_tokens_after_edit: summary.average_total_context_tokens_after_edit,
      average_search_baseline_tokens_after_edit: summary.average_search_baseline_tokens_after_edit,
      average_search_token_reduction_after_edit: asPercentNumber(summary.average_search_token_reduction_after_edit),
      average_cold_scan_token_reduction_after_edit: asPercentNumber(summary.average_cold_scan_token_reduction_after_edit),
      average_full_verify_count_similarity: asPercent(summary.average_full_verify_count_similarity),
    });
  } else if (isIdiomReport(report)) {
    Object.assign(metrics, {
      targets: summary.target_count,
      tasks: summary.task_count,
      average_with_klauro_score: summary.average_with_klauro_score,
      average_without_klauro_score: summary.average_without_klauro_score,
      average_idiom_conformance_delta: signed(summary.average_idiom_conformance_delta),
      average_total_quality_delta: signed(summary.average_total_quality_delta),
      live_trials_attempted: summary.live_trials_attempted,
      live_correctness_regressions: summary.live_correctness_regressions,
      live_average_idiom_conformance_delta: signed(summary.live_average_idiom_conformance_delta),
      live_average_total_quality_delta: signed(summary.live_average_total_quality_delta),
      live_average_token_reduction: asPercentNumber(summary.live_average_token_reduction),
      live_average_time_reduction: asPercentNumber(summary.live_average_time_reduction),
    });
  } else if (isQualityReport(report)) {
    Object.assign(metrics, {
      targets: summary.target_count,
      tasks: summary.task_count,
      with_klauro_success_rate: asPercent(summary.with_klauro_success_rate),
      projected_without_klauro_success_rate: asPercent(summary.projected_without_klauro_success_rate),
      average_quality_score: summary.average_quality_score,
      average_quality_score_delta: signed(summary.average_quality_score_delta),
      average_token_reduction_vs_search: asPercentNumber(summary.average_token_reduction_vs_search),
      average_time_reduction_vs_search: asPercentNumber(summary.average_time_reduction_vs_search),
      average_file_reduction_vs_search: asPercentNumber(summary.average_file_reduction_vs_search),
      live_trials_attempted: summary.live_trials_attempted,
      live_average_token_reduction: asPercentNumber(summary.live_average_token_reduction),
      live_average_time_reduction: asPercentNumber(summary.live_average_time_reduction),
      live_with_klauro_success_rate: asPercent(summary.live_with_klauro_success_rate),
      live_without_klauro_success_rate: asPercent(summary.live_without_klauro_success_rate),
    });
  } else {
    Object.assign(metrics, {
      targets: summary.target_count,
      tasks: summary.task_count,
      with_klauro_success_rate: asPercent(summary.with_klauro_success_rate),
      projected_without_klauro_success_rate: asPercent(summary.projected_without_klauro_success_rate),
      average_token_reduction_vs_cold_scan: asPercentNumber(summary.average_token_reduction_vs_cold_scan),
      average_token_reduction_vs_search: asPercentNumber(summary.average_token_reduction_vs_search),
      average_file_reduction: asPercentNumber(summary.average_file_reduction),
      average_speedup_vs_cold_scan: asMultiplier(summary.average_speedup_vs_cold_scan),
      average_speedup_vs_search: asMultiplier(summary.average_speedup_vs_search),
      average_cached_solution_ms_with_klauro: summary.average_cached_solution_ms_with_klauro,
      average_search_solution_ms_without_klauro: summary.average_search_solution_ms_without_klauro,
    });
  }

  return {
    benchmark_type: report.benchmark_type || 'unknown',
    id: report.id,
    generated_at: report.generated_at || report.generatedAt,
    saved_at: report.saved_at,
    status: report.status,
    score: report.score,
    metrics: removeEmpty(metrics),
  };
}

function formatFromZeroBuildContextMarkdown(report: StoredBenchmarkReport): string {
  const summary = report.summary || {};
  return [
    '# From-Zero Build Context Proof',
    '',
    `Generated: ${report.generated_at || report.generatedAt || ''}`,
    `Status: ${report.status || 'unknown'}`,
    `Score: ${report.score ?? 'unknown'}/100`,
    '',
    '## Summary',
    '',
    `- Quality delta: ${signed(summary.quality_delta)}`,
    `- Duplicate-class delta avoided: ${signed(summary.duplicate_class_delta)}`,
    `- With-Klauro duplicate classes: ${summary.with_klauro_duplicate_classes ?? 'unknown'}`,
    `- Without-Klauro duplicate classes: ${summary.without_klauro_duplicate_classes ?? 'unknown'}`,
    `- Focused context file reduction: ${summary.focused_context_file_reduction ?? 'unknown'}`,
    `- Context char reduction: ${asPercentNumber(summary.context_char_reduction_percentage) || 'unknown'}`,
    '',
  ].join('\n');
}

function buildLiveRollup(reports: StoredBenchmarkReport[]): ProofSummary | null {
  const liveReports = reports.filter(report => report.benchmark_type === 'live-agent-quality-ab');
  const pairs = liveReports.flatMap(report => (report.trials || [])
    .map((trial: StoredBenchmarkReport) => trial.live_pair)
    .filter(Boolean));
  if (pairs.length === 0) return null;

  const withProviderTokens = sum(pairs.map(pair => numberValue(pair.with_klauro?.provider_total_tokens)));
  const withoutProviderTokens = sum(pairs.map(pair => numberValue(pair.without_klauro?.provider_total_tokens)));
  const withEstimatedTokens = sum(pairs.map(pair => numberValue(pair.with_klauro?.estimated_work_tokens) ?? numberValue(pair.with_klauro?.estimated_total_tokens)));
  const withoutEstimatedTokens = sum(pairs.map(pair => numberValue(pair.without_klauro?.estimated_work_tokens) ?? numberValue(pair.without_klauro?.estimated_total_tokens)));
  const withTokens = withProviderTokens || withEstimatedTokens;
  const withoutTokens = withoutProviderTokens || withoutEstimatedTokens;
  const tokenSource = withProviderTokens && withoutProviderTokens ? 'provider' : 'estimated';
  const withDuration = sum(pairs.map(pair => numberValue(pair.with_klauro?.duration_ms)));
  const withoutDuration = sum(pairs.map(pair => numberValue(pair.without_klauro?.duration_ms)));
  const withFilesRead = sum(pairs.map(pair => numberValue(pair.with_klauro?.files_read)));
  const withoutFilesRead = sum(pairs.map(pair => numberValue(pair.without_klauro?.files_read)));
  const repos = new Set(liveReports.flatMap(report => (report.trials || []).map((trial: StoredBenchmarkReport) => trial.repo).filter(Boolean)));
  const tokenReduction = withTokens && withoutTokens ? 1 - (withTokens / withoutTokens) : undefined;
  const qualityDeltas = pairs
    .map(pair => numberValue(pair.evaluation?.quality_score_delta))
    .filter((value): value is number => value !== undefined);
  const averageQualityDelta = average(qualityDeltas);
  const tokenRegressed = typeof tokenReduction === 'number' && tokenReduction < 0;
  const qualityRegressed = qualityDeltas.some(delta => delta < 0);
  const allWithSucceeded = pairs.every(pair => pair.evaluation?.with_klauro_success);
  const tokenTradeoffAccepted = tokenRegressed
    && Math.abs(tokenReduction * 100) <= SMALL_TOKEN_OVERHEAD_PERCENT
    && averageQualityDelta >= CLEAR_QUALITY_WIN_DELTA;

  return {
    benchmark_type: 'live-agent-quality-ab-rollup',
    id: 'live-agent-quality-ab-rollup',
    status: !allWithSucceeded || (tokenRegressed && !tokenTradeoffAccepted) || qualityRegressed ? 'fail' : 'pass',
    score: Math.round(average(pairs.map(pair => numberValue(pair.evaluation?.with_klauro_quality_score)).filter((value): value is number => value !== undefined))),
    metrics: removeEmpty({
      live_trials: pairs.length,
      codebases: repos.size,
      with_klauro_success_rate: asPercent(average(pairs.map(pair => pair.evaluation?.with_klauro_success ? 1 : 0))),
      without_klauro_success_rate: asPercent(average(pairs.map(pair => pair.evaluation?.without_klauro_success ? 1 : 0))),
      average_quality_delta: signed(averageQualityDelta),
      token_reduction: typeof tokenReduction === 'number' ? asPercent(tokenReduction) : undefined,
      token_measurement_source: withTokens && withoutTokens ? tokenSource : undefined,
      token_tradeoff_policy: `Token overhead is only acceptable when <=${SMALL_TOKEN_OVERHEAD_PERCENT}% and quality delta >=+${CLEAR_QUALITY_WIN_DELTA}.`,
      accepted_token_tradeoffs: tokenTradeoffAccepted ? 1 : 0,
      token_regressions: tokenRegressed && !tokenTradeoffAccepted ? 1 : 0,
      time_reduction: withDuration && withoutDuration ? asPercent(1 - (withDuration / withoutDuration)) : undefined,
      file_read_reduction: withFilesRead && withoutFilesRead ? asPercent(1 - (withFilesRead / withoutFilesRead)) : undefined,
      with_klauro_provider_tokens: withProviderTokens || undefined,
      without_klauro_provider_tokens: withoutProviderTokens || undefined,
      with_klauro_estimated_tokens: withEstimatedTokens || undefined,
      without_klauro_estimated_tokens: withoutEstimatedTokens || undefined,
      with_klauro_duration_ms: withDuration,
      without_klauro_duration_ms: withoutDuration,
      with_klauro_files_read: withFilesRead,
      without_klauro_files_read: withoutFilesRead,
    }),
  };
}

function buildExistingTaskLiveRollup(reports: StoredBenchmarkReport[]): ProofSummary | null {
  const latestByScenario = new Map<string, { report: StoredBenchmarkReport; scenario: StoredBenchmarkReport }>();
  for (const report of reports.filter(isExistingTaskReport)) {
    for (const scenario of report.scenarios || []) {
      if (!scenario.live_summary) continue;
      const key = String(scenario.id || scenario.family || latestByScenario.size);
      if (!latestByScenario.has(key)) latestByScenario.set(key, { report, scenario });
    }
  }

  const entries = [...latestByScenario.values()];
  if (entries.length === 0) return null;

  const summaries = entries.map(entry => entry.scenario.live_summary || {});
  const families = new Set(entries.map(entry => entry.scenario.family).filter(Boolean));
  const qualityDeltas = summaries
    .map(summary => numberValue(summary.quality_delta))
    .filter((value): value is number => value !== undefined);
  const tokenReductions = summaries
    .map(summary => numberValue(summary.token_reduction_percentage))
    .filter((value): value is number => value !== undefined);
  const timeReductions = summaries
    .map(summary => numberValue(summary.time_reduction_percentage))
    .filter((value): value is number => value !== undefined);
  const withScores = summaries
    .map(summary => numberValue(summary.with_score))
    .filter((value): value is number => value !== undefined);
  const withoutScores = summaries
    .map(summary => numberValue(summary.without_score))
    .filter((value): value is number => value !== undefined);
  const passCount = summaries.filter(summary => summary.status === 'pass').length;
  const acceptedTokenTradeoffs = summaries.filter(summary => {
    const tokenReduction = numberValue(summary.token_reduction_percentage);
    const qualityDelta = numberValue(summary.quality_delta);
    return tokenReduction !== undefined
      && qualityDelta !== undefined
      && tokenReduction < 0
      && Math.abs(tokenReduction) <= SMALL_TOKEN_OVERHEAD_PERCENT
      && qualityDelta >= CLEAR_QUALITY_WIN_DELTA;
  }).length;
  const tokenRegressions = summaries.filter(summary => {
    const tokenReduction = numberValue(summary.token_reduction_percentage);
    const qualityDelta = numberValue(summary.quality_delta);
    if (tokenReduction === undefined || tokenReduction >= 0) return false;
    return !(qualityDelta !== undefined
      && Math.abs(tokenReduction) <= SMALL_TOKEN_OVERHEAD_PERCENT
      && qualityDelta >= CLEAR_QUALITY_WIN_DELTA);
  }).length;
  const qualityRegressions = qualityDeltas.filter(value => value < 0).length;
  const hasQualityLift = qualityDeltas.some(value => value > 0);

  return {
    benchmark_type: 'existing-project-live-task-rollup',
    id: 'existing-project-live-task-rollup',
    status: passCount === summaries.length && tokenRegressions === 0 && qualityRegressions === 0 && hasQualityLift ? 'pass' : 'fail',
    score: Math.round(average(withScores)),
    metrics: removeEmpty({
      live_tasks: summaries.length,
      families: families.size,
      passing_live_tasks: passCount,
      with_klauro_average_score: Math.round(average(withScores)),
      without_klauro_average_score: Math.round(average(withoutScores)),
      average_quality_delta: signed(average(qualityDeltas)),
      average_token_reduction: asPercentNumber(average(tokenReductions)),
      average_time_reduction: asPercentNumber(average(timeReductions)),
      token_tradeoff_policy: `Token overhead is only acceptable when <=${SMALL_TOKEN_OVERHEAD_PERCENT}% and quality delta >=+${CLEAR_QUALITY_WIN_DELTA}.`,
      accepted_token_tradeoffs: acceptedTokenTradeoffs,
      token_regressions: tokenRegressions,
      quality_regressions: qualityRegressions,
    }),
  };
}

function buildTaskFamilyCoverageRollup(reports: StoredBenchmarkReport[]): ProofSummary | null {
  const report = reports.find(isTaskFamilyCoverageReport);
  if (!report) return null;
  const summary = report.summary || {};
  const families = numberValue(summary.families) || 0;
  const strong = numberValue(summary.strong) || 0;
  const partial = numberValue(summary.partial) || 0;
  const gaps = numberValue(summary.gaps) || 0;

  return {
    benchmark_type: 'agent-task-family-coverage-rollup',
    id: 'agent-task-family-coverage-rollup',
    generated_at: report.generated_at || report.generatedAt,
    status: report.status === 'pass' && families > 0 && strong === families && partial === 0 && gaps === 0 ? 'pass' : 'fail',
    score: report.score,
    metrics: removeEmpty({
      families,
      strong_families: strong,
      partial_families: partial,
      gap_families: gaps,
      coverage: coverage(strong, families),
    }),
  };
}

function buildClaims(summaries: ProofSummary[], rollups: ProofSummary[]) {
  const claims = [];
  const existingLive = rollups.find(summary => summary.benchmark_type === 'existing-project-live-task-rollup');
  const taskFamilyCoverage = rollups.find(summary => summary.benchmark_type === 'agent-task-family-coverage-rollup')
    || summaries.find(summary => summary.benchmark_type === 'agent-task-family-coverage');
  const quality = existingLive
    || rollups.find(summary => summary.benchmark_type === 'live-agent-quality-ab-rollup')
    || summaries.find(summary => summary.benchmark_type === 'live-agent-quality-ab')
    || summaries.find(summary => summary.benchmark_type === 'deterministic-agent-quality-proxy');
  const deterministic = summaries.find(summary => summary.benchmark_type === 'agentic-suite-with-klauro-vs-without-klauro')
    || summaries.find(summary => summary.benchmark_type === 'agentic-with-klauro-vs-without-klauro');
  const incremental = summaries.find(summary => summary.benchmark_type === 'incremental-analysis-agent-value');
  const idiom = summaries.find(summary => summary.benchmark_type === 'live-agent-idiom-quality-ab')
    || summaries.find(summary => summary.benchmark_type === 'deterministic-agent-idiom-quality-proxy');
  const fromZero = summaries.find(summary => summary.benchmark_type === 'from-zero-build-context-proof');

  if (quality) {
    claims.push({
      claim: 'Klauro preserves or improves agent patch quality while reducing total token usage and discovery work.',
      evidence: quality.metrics,
      report_id: quality.id,
    });
  }
  if (taskFamilyCoverage) {
    claims.push({
      claim: 'Klauro covers the full engineering task-family gauntlet with no partial or missing families.',
      evidence: taskFamilyCoverage.metrics,
      report_id: taskFamilyCoverage.id,
    });
  }
  if (deterministic) {
    claims.push({
      claim: 'Klauro agent contexts reduce context, file reads, and estimated solution time versus broad source exploration.',
      evidence: deterministic.metrics,
      report_id: deterministic.id,
    });
  }
  if (incremental) {
    claims.push({
      claim: 'Incremental analysis stays fast after edits and immediately produces focused agent context.',
      evidence: incremental.metrics,
      report_id: incremental.id,
    });
  }
  if (idiom) {
    claims.push({
      claim: 'Klauro improves agent idiom conformance, helping patches match repo-specific practices instead of only passing correctness.',
      evidence: idiom.metrics,
      report_id: idiom.id,
    });
  }
  if (fromZero) {
    claims.push({
      claim: 'Klauro build contexts help greenfield projects grow without duplicate domain concepts, even when an unguided continuation can still pass tests.',
      evidence: fromZero.metrics,
      report_id: fromZero.id,
    });
  }

  return claims;
}

function formatProofMarkdown(
  generatedAt: string,
  summaries: ProofSummary[],
  rollups: ProofSummary[],
  claims: ReturnType<typeof buildClaims>
): string {
  const lines = [
    '# Klauro Agent Performance Proof',
    '',
    `Generated: ${generatedAt}`,
    '',
    '## Claims',
    '',
  ];

  if (claims.length === 0) {
    lines.push('No persisted benchmark reports were available.');
  } else {
    for (const claim of claims) {
      lines.push(`- ${claim.claim}${claim.report_id ? ` (${claim.report_id})` : ''}`);
    }
  }

  if (rollups.length > 0) {
    lines.push('', '## Rollups', '');
    for (const rollup of rollups) renderSummary(lines, rollup);
  }

  lines.push('', '## Latest Reports', '');
  if (summaries.length === 0) {
    lines.push('No reports found.');
  } else {
    for (const summary of summaries) renderSummary(lines, summary);
  }

  return lines.join('\n').trimEnd() + '\n';
}

function renderSummary(lines: string[], summary: ProofSummary): void {
  lines.push(`### ${summary.benchmark_type}`);
  lines.push('');
  lines.push(`Status: ${summary.status || 'unknown'}`);
  lines.push(`Score: ${summary.score ?? 'unknown'}`);
  if (summary.generated_at) lines.push(`Generated: ${summary.generated_at}`);
  if (summary.id) lines.push(`Report id: ${summary.id}`);
  for (const [key, value] of Object.entries(summary.metrics)) {
    lines.push(`${humanize(key)}: ${value}`);
  }
  lines.push('');
}

function timestamp(report: StoredBenchmarkReport): string {
  return String(report.saved_at || report.generated_at || report.generatedAt || '');
}

function asPercent(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `${Math.round(value * 100)}%`;
}

function asPercentNumber(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `${Math.round(value)}%`;
}

function asMultiplier(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `${Number(value.toFixed(2))}x`;
}

function signed(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= 0 ? `+${Math.round(value)}` : String(Math.round(value));
}

function coverage(numerator: unknown, denominator: unknown): string | undefined {
  const left = numberValue(numerator);
  const right = numberValue(denominator);
  if (left === undefined || right === undefined || right <= 0) return undefined;
  return `${left}/${right}`;
}

function removeEmpty(metrics: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metrics).filter(([, value]) => value !== undefined && value !== null)
  );
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sum(values: Array<number | undefined>): number | undefined {
  const numeric = values.filter((value): value is number => value !== undefined);
  if (numeric.length === 0) return undefined;
  return numeric.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function humanize(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}
