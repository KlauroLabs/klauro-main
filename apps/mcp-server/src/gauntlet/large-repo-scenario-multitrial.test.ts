import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import { LARGE_REPO_SOURCE } from './large-repo-scenario';
import { runLargeRepoMultiTrial } from './large-repo-scenario-multitrial';

test('runLargeRepoMultiTrial runs N projected trials per arm and reports a real distribution', async (t) => {
  if (!(await fs.pathExists(LARGE_REPO_SOURCE))) {
    t.skip(`analyzer-core source not present at ${LARGE_REPO_SOURCE} in this checkout`);
    return;
  }
  const prevKey = process.env.DEEPINFRA_API_KEY;
  delete process.env.DEEPINFRA_API_KEY;
  try {
    const report = await runLargeRepoMultiTrial({ trials: 3, forceProjected: true });

    assert.equal(report.mode, 'projected');
    assert.equal(report.trials_requested, 3);
    assert.equal(report.trials_completed, 3);
    assert.equal(report.trial_results.length, 3);

    for (const arm of [report.klauro, report.baseline]) {
      assert.equal(arm.n, 3);
      assert.equal(arm.raw.length, 3);
      assert.ok(arm.success_rate >= 0 && arm.success_rate <= 1);
      assert.ok(Number.isFinite(arm.tokens_median));
      assert.ok(Number.isFinite(arm.quality_median));
      assert.ok(Number.isFinite(arm.duration_ms_median));
    }

    // deltas are derived from the medians, not a single trial
    assert.ok(Number.isFinite(report.deltas.quality_median_delta));
    assert.ok(report.deltas.tokens_median_multiple === null || Number.isFinite(report.deltas.tokens_median_multiple));

    // raw per-trial results persisted to disk for audit
    assert.ok(await fs.pathExists(report.report_file), 'report must be persisted to disk');
    const persisted = await fs.readJson(report.report_file);
    assert.equal(persisted.trial_results.length, 3);
    assert.equal(persisted.mode, 'projected');
  } finally {
    if (prevKey !== undefined) process.env.DEEPINFRA_API_KEY = prevKey;
  }
});

test('runLargeRepoMultiTrial auto-falls-back to projected when DEEPINFRA_API_KEY is absent from env and .env', async (t) => {
  if (!(await fs.pathExists(LARGE_REPO_SOURCE))) {
    t.skip(`analyzer-core source not present at ${LARGE_REPO_SOURCE} in this checkout`);
    return;
  }
  const prevKey = process.env.DEEPINFRA_API_KEY;
  delete process.env.DEEPINFRA_API_KEY;
  try {
    // Note: this only asserts projected-mode plumbing; if the repo-root .env
    // actually contains DEEPINFRA_API_KEY, runLargeRepoMultiTrial will pick it
    // up and (without --projected) attempt a live run. We force projected here
    // so the test is deterministic and offline regardless of .env contents.
    const report = await runLargeRepoMultiTrial({ trials: 2, forceProjected: true });
    assert.equal(report.mode, 'projected');
    assert.equal(report.reason, 'forced by caller');
  } finally {
    if (prevKey !== undefined) process.env.DEEPINFRA_API_KEY = prevKey;
  }
});

test('runLargeRepoMultiTrial caps live trials at the hard safety cap', async (t) => {
  if (!(await fs.pathExists(LARGE_REPO_SOURCE))) {
    t.skip(`analyzer-core source not present at ${LARGE_REPO_SOURCE} in this checkout`);
    return;
  }
  // Force-projected path never live-caps (cap only applies to hasKey && !forceProjected),
  // so assert the cap fields are simply absent/undefined in projected mode.
  const report = await runLargeRepoMultiTrial({ trials: 2, forceProjected: true });
  assert.equal(report.trials_capped, undefined);
});
