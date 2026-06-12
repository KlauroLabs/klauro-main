export type LiveRepStatus = 'pass' | 'warn' | 'fail';

export interface LiveArmRepMetrics {
  quality_score: number;
  provider_total_tokens: number | null;
  duration_ms: number;
  files_changed: number;
  lines_changed: number;
  changed_file_precision: number;
  passed: boolean;
}

export interface LiveArmRepRecord {
  completed: boolean;
  error?: string;
  metrics?: LiveArmRepMetrics;
}

export interface LivePairRepRecord {
  rep: number;
  completed: boolean;
  error?: string;
  status?: LiveRepStatus;
  trial_directory?: string;
  with_arm?: LiveArmRepRecord;
  without_arm?: LiveArmRepRecord;
}

export interface MetricAggregate {
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

export interface LiveArmAggregate {
  reps_requested: number;
  completed_reps: number;
  failed_reps: number;
  failed: boolean;
  quality: MetricAggregate | null;
  provider_tokens: MetricAggregate | null;
  duration_ms: MetricAggregate | null;
  changed_file_precision: MetricAggregate | null;
  pass_rate: number | null;
}

export interface LiveRepetitionComparison {
  paired_reps: number;
  median_quality_delta: number | null;
  quality_delta_iqr: { p25: number; p75: number } | null;
  median_token_reduction_percentage: number | null;
  median_time_reduction_percentage: number | null;
  median_changed_file_precision_delta: number | null;
  variance_warning: boolean;
}

export interface LiveRepetitionReport {
  reps_requested: number;
  single_rep_fields_rep: number | null;
  single_rep_fields_source: 'median-rep' | 'first-completed-rep' | 'none';
  median_rep: number | null;
  reps: LivePairRepRecord[];
  with_arm: LiveArmAggregate;
  without_arm: LiveArmAggregate;
  comparison: LiveRepetitionComparison;
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

export function metricAggregate(values: number[]): MetricAggregate | null {
  const finite = values.filter(value => Number.isFinite(value));
  if (finite.length === 0) return null;
  return {
    median: roundTo(median(finite)),
    p25: roundTo(quantile(finite, 0.25)),
    p75: roundTo(quantile(finite, 0.75)),
    min: roundTo(Math.min(...finite)),
    max: roundTo(Math.max(...finite)),
  };
}

export function aggregateArm(armRecords: Array<LiveArmRepRecord | undefined>, repsRequested: number): LiveArmAggregate {
  const completed = armRecords
    .map(record => (record && record.completed && record.metrics ? record.metrics : null))
    .filter((metrics): metrics is LiveArmRepMetrics => metrics !== null);
  const completedReps = completed.length;
  return {
    reps_requested: repsRequested,
    completed_reps: completedReps,
    failed_reps: repsRequested - completedReps,
    failed: completedReps === 0,
    quality: metricAggregate(completed.map(metrics => metrics.quality_score)),
    provider_tokens: metricAggregate(completed
      .map(metrics => metrics.provider_total_tokens)
      .filter((tokens): tokens is number => typeof tokens === 'number')),
    duration_ms: metricAggregate(completed.map(metrics => metrics.duration_ms)),
    changed_file_precision: metricAggregate(completed.map(metrics => metrics.changed_file_precision)),
    pass_rate: completedReps === 0 ? null : roundTo((completed.filter(metrics => metrics.passed).length / completedReps) * 100),
  };
}

export function qualityVarianceWarning(withArm: LiveArmAggregate, withoutArm: LiveArmAggregate): boolean {
  if (!withArm.quality || !withoutArm.quality) return true;
  const withOverlapsWithoutMedian = withArm.quality.p25 <= withoutArm.quality.median && withoutArm.quality.median <= withArm.quality.p75;
  const withoutOverlapsWithMedian = withoutArm.quality.p25 <= withArm.quality.median && withArm.quality.median <= withoutArm.quality.p75;
  return withOverlapsWithoutMedian || withoutOverlapsWithMedian;
}

export function buildLiveRepetitionReport(records: LivePairRepRecord[], repsRequested: number): LiveRepetitionReport {
  const withArm = aggregateArm(records.map(record => record.with_arm), repsRequested);
  const withoutArm = aggregateArm(records.map(record => record.without_arm), repsRequested);
  const pairedRecords = records.filter(record =>
    record.with_arm?.completed && record.with_arm.metrics && record.without_arm?.completed && record.without_arm.metrics);
  const qualityDeltas = pairedRecords.map(record => record.with_arm!.metrics!.quality_score - record.without_arm!.metrics!.quality_score);
  const tokenReductions = pairedRecords
    .map(record => {
      const withTokens = record.with_arm!.metrics!.provider_total_tokens;
      const withoutTokens = record.without_arm!.metrics!.provider_total_tokens;
      if (typeof withTokens !== 'number' || typeof withoutTokens !== 'number' || withoutTokens <= 0) return null;
      return ((withoutTokens - withTokens) / withoutTokens) * 100;
    })
    .filter((value): value is number => value !== null);
  const timeReductions = pairedRecords
    .map(record => {
      const withoutMs = record.without_arm!.metrics!.duration_ms;
      if (withoutMs <= 0) return null;
      return ((withoutMs - record.with_arm!.metrics!.duration_ms) / withoutMs) * 100;
    })
    .filter((value): value is number => value !== null);
  const precisionDeltas = pairedRecords.map(record =>
    record.with_arm!.metrics!.changed_file_precision - record.without_arm!.metrics!.changed_file_precision);

  const medianRep = pickMedianRep(records);
  const firstCompletedRep = records.find(record => record.completed)?.rep ?? null;
  const singleRepFieldsRep = medianRep ?? firstCompletedRep;
  return {
    reps_requested: repsRequested,
    single_rep_fields_rep: singleRepFieldsRep,
    single_rep_fields_source: medianRep !== null ? 'median-rep' : firstCompletedRep !== null ? 'first-completed-rep' : 'none',
    median_rep: medianRep,
    reps: records,
    with_arm: withArm,
    without_arm: withoutArm,
    comparison: {
      paired_reps: pairedRecords.length,
      median_quality_delta: qualityDeltas.length ? roundTo(median(qualityDeltas)) : null,
      quality_delta_iqr: qualityDeltas.length
        ? { p25: roundTo(quantile(qualityDeltas, 0.25)), p75: roundTo(quantile(qualityDeltas, 0.75)) }
        : null,
      median_token_reduction_percentage: tokenReductions.length ? roundTo(median(tokenReductions)) : null,
      median_time_reduction_percentage: timeReductions.length ? roundTo(median(timeReductions)) : null,
      median_changed_file_precision_delta: precisionDeltas.length ? roundTo(median(precisionDeltas)) : null,
      variance_warning: qualityVarianceWarning(withArm, withoutArm),
    },
  };
}

export function pickMedianRep(records: LivePairRepRecord[]): number | null {
  const candidates = records.filter(record => record.completed && record.with_arm?.completed && record.with_arm.metrics);
  if (candidates.length === 0) return null;
  const target = median(candidates.map(record => record.with_arm!.metrics!.quality_score));
  let best: LivePairRepRecord | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const record of candidates) {
    const distance = Math.abs(record.with_arm!.metrics!.quality_score - target);
    if (distance < bestDistance) {
      best = record;
      bestDistance = distance;
    }
  }
  return best ? best.rep : null;
}

function roundTo(value: number): number {
  return Math.round(value * 10) / 10;
}
