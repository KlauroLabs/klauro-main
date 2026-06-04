import { formatMarkdownReport as formatAgenticMarkdownReport } from './agent-benchmark';
import { formatQualityMarkdownReport } from './agent-quality-benchmark';
import { formatIncrementalValueMarkdownReport } from './incremental-benchmark';
import { formatIdiomBenchmarkMarkdown } from './agent-idiom-benchmark';

type StoredBenchmarkReport = Record<string, any>;

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

  if (isIncrementalReport(report)) {
    Object.assign(metrics, {
      targets: summary.target_count,
      incremental_success_rate: asPercent(summary.incremental_success_rate),
      average_full_analysis_ms: summary.average_initial_full_ms,
      average_no_change_incremental_ms: summary.average_no_change_incremental_ms,
      average_edit_incremental_ms: summary.average_edit_incremental_ms,
      average_no_change_speedup_vs_full: summary.average_no_change_speedup_vs_full,
      average_edit_speedup_vs_full: summary.average_edit_speedup_vs_full,
      average_packet_generation_ms_after_edit: summary.average_packet_generation_ms_after_edit,
      average_file_read_plan_after_edit: summary.average_file_read_plan_after_edit,
      average_packet_tokens_after_edit: summary.average_packet_tokens_after_edit,
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

  return {
    benchmark_type: 'live-agent-quality-ab-rollup',
    id: 'live-agent-quality-ab-rollup',
    status: pairs.every(pair => pair.evaluation?.with_klauro_success) ? 'pass' : 'warn',
    score: Math.round(average(pairs.map(pair => numberValue(pair.evaluation?.with_klauro_quality_score)).filter((value): value is number => value !== undefined))),
    metrics: removeEmpty({
      live_trials: pairs.length,
      codebases: repos.size,
      with_klauro_success_rate: asPercent(average(pairs.map(pair => pair.evaluation?.with_klauro_success ? 1 : 0))),
      without_klauro_success_rate: asPercent(average(pairs.map(pair => pair.evaluation?.without_klauro_success ? 1 : 0))),
      average_quality_delta: signed(average(pairs.map(pair => numberValue(pair.evaluation?.quality_score_delta)).filter((value): value is number => value !== undefined))),
      token_reduction: withTokens && withoutTokens ? asPercent(1 - (withTokens / withoutTokens)) : undefined,
      token_measurement_source: withTokens && withoutTokens ? tokenSource : undefined,
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

function buildClaims(summaries: ProofSummary[], rollups: ProofSummary[]) {
  const claims = [];
  const quality = rollups.find(summary => summary.benchmark_type === 'live-agent-quality-ab-rollup')
    || summaries.find(summary => summary.benchmark_type === 'live-agent-quality-ab')
    || summaries.find(summary => summary.benchmark_type === 'deterministic-agent-quality-proxy');
  const deterministic = summaries.find(summary => summary.benchmark_type === 'agentic-suite-with-klauro-vs-without-klauro')
    || summaries.find(summary => summary.benchmark_type === 'agentic-with-klauro-vs-without-klauro');
  const incremental = summaries.find(summary => summary.benchmark_type === 'incremental-analysis-agent-value');
  const idiom = summaries.find(summary => summary.benchmark_type === 'live-agent-idiom-quality-ab')
    || summaries.find(summary => summary.benchmark_type === 'deterministic-agent-idiom-quality-proxy');

  if (quality) {
    claims.push({
      claim: 'Klauro preserves or improves agent patch quality while reducing discovery work.',
      evidence: quality.metrics,
      report_id: quality.id,
    });
  }
  if (deterministic) {
    claims.push({
      claim: 'Klauro work packets reduce context, file reads, and estimated solution time versus broad source exploration.',
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
