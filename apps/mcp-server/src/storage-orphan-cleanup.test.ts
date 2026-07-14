import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { pruneOrphanedLockOnlyDirs, withProjectAnalysisLock } from './storage';

/**
 * The orphaned analysis.lock-only store entry pattern (live audit 2026-07-14:
 * ~/.klauro/analyses/f7701b18…-1da636e01772 contained nothing but
 * analysis.lock): withProjectAnalysisLock creates the project dir and writes
 * the lock BEFORE any artifact exists, so an aborted/killed run leaves a
 * lock-only directory forever. Covered here: the sweep removes stale
 * lock-only dirs, leaves live/artifact-bearing dirs alone, and the release
 * path removes an empty project dir instead of leaving it behind.
 */

test('pruneOrphanedLockOnlyDirs removes stale lock-only dirs and leaves everything else', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-orphan-sweep-'));
  try {
    // Orphan: only analysis.lock, holder pid dead, old timestamp.
    const orphan = path.join(root, 'project-orphan');
    await fs.ensureDir(orphan);
    await fs.writeFile(path.join(orphan, 'analysis.lock'), JSON.stringify({
      pid: 999999999,
      hostname: os.hostname(),
      acquired_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      purpose: 'Analysis of /tmp/orphan',
    }));

    // Live lock (this process, fresh): must be left alone.
    const live = path.join(root, 'project-live');
    await fs.ensureDir(live);
    await fs.writeFile(path.join(live, 'analysis.lock'), JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      acquired_at: new Date().toISOString(),
      purpose: 'Analysis of /tmp/live',
    }));

    // Real project dir with artifacts next to a (stale) lock: must be left alone.
    const withArtifacts = path.join(root, 'project-artifacts');
    await fs.ensureDir(withArtifacts);
    await fs.writeFile(path.join(withArtifacts, 'analysis.lock'), '{}');
    await fs.writeFile(path.join(withArtifacts, 'incremental-state.json'), '{}');

    const { removed } = await pruneOrphanedLockOnlyDirs({ root });
    assert.deepEqual(removed, [orphan]);
    assert.equal(await fs.pathExists(orphan), false);
    assert.equal(await fs.pathExists(path.join(live, 'analysis.lock')), true);
    assert.equal(await fs.pathExists(path.join(withArtifacts, 'incremental-state.json')), true);
  } finally {
    await fs.remove(root);
  }
});

test('withProjectAnalysisLock removes the project dir when the run left no artifacts', async () => {
  const store = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-orphan-release-'));
  const previous = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = store;
  try {
    const projectPath = '/tmp/klauro-orphan-release-fixture';
    await assert.rejects(withProjectAnalysisLock(projectPath, async () => {
      throw new Error('analysis aborted before any artifact was written');
    }));
    const dirs = (await fs.readdir(store)).filter(name => !name.startsWith('index.json'));
    assert.deepEqual(dirs, [], 'no lock-only project dir left behind');
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(store);
  }
});
