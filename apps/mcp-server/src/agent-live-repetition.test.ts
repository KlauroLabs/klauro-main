import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateArm,
  buildLiveRepetitionReport,
  median,
  metricAggregate,
  pickMedianRep,
  quantile,
  qualityVarianceWarning,
  type LiveArmRepRecord,
  type LivePairRepRecord,
} from './agent-live-repetition';

test('median and quantile use linear interpolation over unsorted input', () => {
  assert.equal(median([3]), 3);
  assert.equal(median([4, 2]), 3);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(quantile([1, 2, 3, 4], 0.75), 3.25);
  assert.equal(quantile([10, 20, 30, 40, 50], 0.25), 20);
  assert.equal(quantile([10, 20, 30, 40, 50], 0.75), 40);
  assert.ok(Number.isNaN(median([])));
});

test('metricAggregate reports median, IQR, min, and max and ignores non-finite values', () => {
  assert.deepEqual(metricAggregate([90, 70, 80, Number.NaN, Number.POSITIVE_INFINITY]), {
    median: 80,
    p25: 75,
    p75: 85,
    min: 70,
    max: 90,
  });
  assert.equal(metricAggregate([]), null);
  assert.equal(metricAggregate([Number.NaN]), null);
});

test('aggregateArm skips failed reps and computes pass rate over completed reps', () => {
  const records: Array<LiveArmRepRecord | undefined> = [
    armRecord(90, 1000, 1500, 100, true),
    { completed: false, error: 'timed out' },
    armRecord(70, null, 2500, 50, false),
    undefined,
  ];
  const aggregate = aggregateArm(records, 4);

  assert.equal(aggregate.reps_requested, 4);
  assert.equal(aggregate.completed_reps, 2);
  assert.equal(aggregate.failed_reps, 2);
  assert.equal(aggregate.failed, false);
  assert.equal(aggregate.quality?.median, 80);
  assert.equal(aggregate.quality?.min, 70);
  assert.equal(aggregate.quality?.max, 90);
  assert.deepEqual(aggregate.provider_tokens, { median: 1000, p25: 1000, p75: 1000, min: 1000, max: 1000 });
  assert.equal(aggregate.duration_ms?.median, 2000);
  assert.equal(aggregate.changed_file_precision?.median, 75);
  assert.equal(aggregate.pass_rate, 50);
});

test('aggregateArm marks the arm failed when no rep completed', () => {
  const aggregate = aggregateArm([{ completed: false, error: 'crash' }, undefined], 2);
  assert.equal(aggregate.failed, true);
  assert.equal(aggregate.quality, null);
  assert.equal(aggregate.pass_rate, null);
});

test('qualityVarianceWarning fires when either arm IQR overlaps the other arm median', () => {
  assert.equal(
    qualityVarianceWarning(armAggregate(80, 70, 90), armAggregate(75, 60, 78)),
    true,
    'without median 75 falls inside with IQR 70..90'
  );
  assert.equal(
    qualityVarianceWarning(armAggregate(90, 88, 92), armAggregate(70, 60, 91)),
    true,
    'with median 90 falls inside without IQR 60..91'
  );
  assert.equal(
    qualityVarianceWarning(armAggregate(90, 88, 92), armAggregate(70, 65, 75)),
    false,
    'clearly separated arms produce no warning'
  );
  assert.equal(qualityVarianceWarning(armAggregate(90, 88, 92), failedArmAggregate()), true, 'a failed arm always warns');
});

test('buildLiveRepetitionReport pairs deltas, picks the median rep, and flags noisy effects', () => {
  const records: LivePairRepRecord[] = [
    pairRecord(1, 95, 70),
    pairRecord(2, 70, 90),
    pairRecord(3, 81, 75),
  ];
  const report = buildLiveRepetitionReport(records, 3);

  assert.equal(report.reps_requested, 3);
  assert.equal(report.comparison.paired_reps, 3);
  assert.equal(report.comparison.median_quality_delta, 6);
  assert.deepEqual(report.comparison.quality_delta_iqr, { p25: -7, p75: 15.5 });
  assert.equal(report.median_rep, 3);
  assert.equal(report.single_rep_fields_rep, 3);
  assert.equal(report.single_rep_fields_source, 'median-rep');
  assert.equal(
    report.comparison.variance_warning,
    true,
    'with median 81 falls inside the without arm IQR 72.5..82.5'
  );
});

test('buildLiveRepetitionReport separated arms produce no variance warning', () => {
  const records: LivePairRepRecord[] = [
    pairRecord(1, 95, 60),
    pairRecord(2, 92, 62),
    pairRecord(3, 90, 65),
  ];
  const report = buildLiveRepetitionReport(records, 3);
  assert.equal(report.comparison.variance_warning, false);
  assert.equal(report.comparison.median_quality_delta, 30);
  assert.equal(report.with_arm.quality?.median, 92);
  assert.equal(report.without_arm.quality?.median, 62);
});

test('buildLiveRepetitionReport falls back to the first completed rep when the with arm never completed', () => {
  const records: LivePairRepRecord[] = [
    { rep: 1, completed: false, error: 'crashed' },
    {
      rep: 2,
      completed: true,
      status: 'fail',
      with_arm: { completed: false, error: 'timed out' },
      without_arm: armRecord(60, 4000, 9000, 50, false),
    },
  ];
  const report = buildLiveRepetitionReport(records, 2);

  assert.equal(report.median_rep, null);
  assert.equal(report.single_rep_fields_rep, 2);
  assert.equal(report.single_rep_fields_source, 'first-completed-rep');
  assert.equal(report.with_arm.failed, true);
  assert.equal(report.without_arm.failed, false);
  assert.equal(report.comparison.paired_reps, 0);
  assert.equal(report.comparison.median_quality_delta, null);
  assert.equal(report.comparison.variance_warning, true);
});

test('pickMedianRep prefers the earliest rep on quality ties', () => {
  const records: LivePairRepRecord[] = [
    pairRecord(1, 80, 70),
    pairRecord(2, 80, 75),
    pairRecord(3, 80, 65),
  ];
  assert.equal(pickMedianRep(records), 1);
  assert.equal(pickMedianRep([{ rep: 1, completed: false }]), null);
});

function armRecord(quality: number, tokens: number | null, durationMs: number, precision: number, passed: boolean): LiveArmRepRecord {
  return {
    completed: true,
    metrics: {
      quality_score: quality,
      provider_total_tokens: tokens,
      duration_ms: durationMs,
      files_changed: 2,
      lines_changed: 20,
      changed_file_precision: precision,
      passed,
    },
  };
}

function pairRecord(rep: number, withQuality: number, withoutQuality: number): LivePairRepRecord {
  return {
    rep,
    completed: true,
    status: 'pass',
    with_arm: armRecord(withQuality, 1000 + rep, 1000 * rep, 100, true),
    without_arm: armRecord(withoutQuality, 5000 + rep, 2000 * rep, 50, true),
  };
}

function armAggregate(medianValue: number, p25: number, p75: number) {
  return {
    reps_requested: 3,
    completed_reps: 3,
    failed_reps: 0,
    failed: false,
    quality: { median: medianValue, p25, p75, min: p25, max: p75 },
    provider_tokens: null,
    duration_ms: null,
    changed_file_precision: null,
    pass_rate: 100,
  };
}

function failedArmAggregate() {
  return {
    reps_requested: 3,
    completed_reps: 0,
    failed_reps: 3,
    failed: true,
    quality: null,
    provider_tokens: null,
    duration_ms: null,
    changed_file_precision: null,
    pass_rate: null,
  };
}
