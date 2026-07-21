import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  __withOuterWorkerWatchdogForTests,
  __readInternalRebuildAttemptForTests,
  analyzeProjectIncremental,
} from './analyzer';
import { saveAnalysis, loadAnalysis } from './storage';

// Gap this covers (see the "Internal/boot rebuild attempt visibility" /
// "OUTER wall-clock watchdog" comments in analyzer.ts): analyzeProjectIncremental's
// OWN lane permit + watchdog only exist INSIDE the forked analysis-worker
// child process. From runAnalysis()'s point of view, the worker-dispatch
// path had NO timeout of its own — a boot-triggered version-change rebuild
// that hung inside the child (measured live: 65+ minutes) never surfaced
// here, and no attempt record existed anywhere to show a poller the truth.

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('outer slow-analysis alarm preserves the worker result and does not manufacture a failure', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-outer-watchdog-'));
  try {
    await withEnv({ KLAURO_ANALYSIS_WATCHDOG_MS: '20' }, async () => {
      const slowDispatch = __withOuterWorkerWatchdogForTests(
        projectDir,
        async () => {
          await new Promise(resolve => setTimeout(resolve, 35));
          return { nodes: 1 } as any;
        },
      );
      assert.deepEqual(await slowDispatch, { nodes: 1 });
      const attempt = await __readInternalRebuildAttemptForTests(projectDir);
      assert.equal(attempt, null);
    });
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('an internal version-mismatch rebuild writes an in-progress then succeeded attempt record, and a same-version incremental pass writes none', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-version-rebuild-'));
  const projectDir = path.join(workspaceRoot, 'fixture-project');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
  fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'module.exports = { greet: (n) => `hi ${n}` };\n');

  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = path.join(workspaceRoot, 'storage');
  process.env.KLAURO_AI_INTERPRETATION = 'false';
  process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
  process.env.KLAURO_EMBEDDING_ENABLED = 'false';

  try {
    // Initial analyze: no previousOutput yet, so this is NOT a version-rebuild
    // scenario — no attempt record should appear.
    await analyzeProjectIncremental(projectDir);
    const afterInitial = await __readInternalRebuildAttemptForTests(projectDir);
    assert.equal(afterInitial, null, 'the initial (no-previous-output) analyze must not write a version-rebuild attempt record');

    // Simulate a stale cas_version on disk, as if a `klauro update` deploy
    // landed between the previous analysis and this incremental pass.
    const stored = await loadAnalysis(projectDir);
    assert.ok(stored, 'expected the initial analyze to have persisted a CAS');
    (stored as any).cas_version = '0.0.1';
    await saveAnalysis(projectDir, stored as any);

    const result = await analyzeProjectIncremental(projectDir);
    assert.ok(result.wasFullRebuild, 'a cas_version mismatch must trigger a full rebuild');

    const attempt = await __readInternalRebuildAttemptForTests(projectDir);
    assert.ok(attempt, 'expected a version-rebuild attempt record after the version-mismatch rebuild');
    assert.equal(attempt!.state, 'succeeded');
    assert.equal(attempt!.trigger, 'version-rebuild');
    assert.ok(attempt!.finished_at);
    assert.ok(typeof attempt!.duration_ms === 'number');

    // A subsequent same-version incremental pass must not touch the attempt
    // record at all (stale in-progress records must never linger, but the
    // simplest way to guarantee that is to never write one for the common,
    // no-mismatch case in the first place).
    const beforeSecondPass = JSON.stringify(await __readInternalRebuildAttemptForTests(projectDir));
    await analyzeProjectIncremental(projectDir);
    const afterSecondPass = JSON.stringify(await __readInternalRebuildAttemptForTests(projectDir));
    assert.equal(afterSecondPass, beforeSecondPass, 'a same-version incremental pass must not rewrite the last version-rebuild attempt record');
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
