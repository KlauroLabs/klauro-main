import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import {
  materializeLargeRepoTask,
  largeRepoTask,
  runLargeRepoScenario,
  LARGE_REPO_SOURCE,
} from './large-repo-scenario';

test('materializeLargeRepoTask copies only src/ + manifests from analyzer-core (no node_modules/native/etc)', async (t) => {
  if (!(await fs.pathExists(LARGE_REPO_SOURCE))) {
    t.skip(`analyzer-core source not present at ${LARGE_REPO_SOURCE} in this checkout`);
    return;
  }
  const dir = await materializeLargeRepoTask();
  try {
    assert.ok(await fs.pathExists(`${dir}/src`), 'src/ must be copied');
    assert.ok(!(await fs.pathExists(`${dir}/node_modules`)), 'node_modules must NOT be copied');
    assert.ok(!(await fs.pathExists(`${dir}/native`)), 'native/ must NOT be copied');
    assert.ok(!(await fs.pathExists(`${dir}/cas-tests`)), 'cas-tests/ must NOT be copied');
    assert.ok(!(await fs.pathExists(`${dir}/vendored-grammars`)), 'vendored-grammars/ must NOT be copied');
    // The specific file the task targets should be present.
    assert.ok(
      await fs.pathExists(`${dir}/src/analyzer/core/language-registry.ts`),
      'language-registry.ts must be present in the materialized repo'
    );
  } finally {
    await fs.remove(dir);
  }
});

test('largeRepoTask produces a bounded, well-formed task', async (t) => {
  if (!(await fs.pathExists(LARGE_REPO_SOURCE))) {
    t.skip(`analyzer-core source not present at ${LARGE_REPO_SOURCE} in this checkout`);
    return;
  }
  const task = largeRepoTask('/tmp/fake-repo');
  assert.equal(task.repoPath, '/tmp/fake-repo');
  assert.match(task.instructions, /language-registry|extension|manifest/i);
  assert.ok(task.instructions.length < 2000, 'instructions should be bounded, not a novel');
  assert.ok(task.expectedOutcome.length > 0);
});

test('runLargeRepoScenario falls back to PROJECTED mode honestly when DEEPINFRA_API_KEY is absent', async (t) => {
  if (!(await fs.pathExists(LARGE_REPO_SOURCE))) {
    t.skip(`analyzer-core source not present at ${LARGE_REPO_SOURCE} in this checkout`);
    return;
  }
  const prevKey = process.env.DEEPINFRA_API_KEY;
  delete process.env.DEEPINFRA_API_KEY;
  try {
    const report = await runLargeRepoScenario();
    assert.equal(report.mode, 'projected');
    assert.match(report.reason || '', /DEEPINFRA_API_KEY/);
    assert.ok(report.file_count && report.file_count > 50, 'should report a real, large file count');
    assert.ok(report.source_bytes && report.source_bytes > 0);
    assert.equal(report.result, undefined, 'projected mode must not fabricate a result');
    if (report.materialized_repo) await fs.remove(report.materialized_repo).catch(() => undefined);
  } finally {
    if (prevKey !== undefined) process.env.DEEPINFRA_API_KEY = prevKey;
  }
});

test('runLargeRepoScenario can be forced into projected mode even with a key present (no live calls)', async (t) => {
  if (!(await fs.pathExists(LARGE_REPO_SOURCE))) {
    t.skip(`analyzer-core source not present at ${LARGE_REPO_SOURCE} in this checkout`);
    return;
  }
  const prevKey = process.env.DEEPINFRA_API_KEY;
  process.env.DEEPINFRA_API_KEY = 'fake-for-test';
  try {
    const report = await runLargeRepoScenario({ forceProjected: true });
    assert.equal(report.mode, 'projected');
    assert.equal(report.reason, 'forced by caller');
    if (report.materialized_repo) await fs.remove(report.materialized_repo).catch(() => undefined);
  } finally {
    if (prevKey === undefined) delete process.env.DEEPINFRA_API_KEY;
    else process.env.DEEPINFRA_API_KEY = prevKey;
  }
});
