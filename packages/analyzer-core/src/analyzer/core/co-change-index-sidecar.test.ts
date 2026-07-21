import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  writeCoChangeIndexSidecar,
  readCoChangeIndexSidecar,
  getOrComputeCoChangeIndex,
  computeCoChangeIndexForRepo,
} from './co-change-index';

/**
 * Sidecar persistence + cache-invalidation tests, exercised against a real
 * (throwaway) git repository under the OS temp dir — instant to build (a
 * handful of commits touching a handful of files), never against this
 * project's own history or any heavy checkout.
 */

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-cochange-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);

  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    git(['add', '.']);
    git(['commit', '-q', '-m', message]);
  };

  // a.ts and b.ts co-change repeatedly (support 4, above the default floor of 3).
  for (let i = 0; i < 4; i++) {
    commit({ 'a.ts': `a v${i}`, 'b.ts': `b v${i}` }, `couple a+b ${i}`);
  }
  // c.ts changes alone — no partner.
  commit({ 'c.ts': 'c v0' }, 'solo c');

  return dir;
}

test('writeCoChangeIndexSidecar persists a compact JSON sidecar under .klauro/', () => {
  const dir = makeTempRepo();
  const sidecar = writeCoChangeIndexSidecar(dir, { minSupport: 2, minLift: 1 });
  assert.ok(sidecar);
  assert.equal(sidecar!.version, 1);
  assert.ok(sidecar!.commits_considered >= 5);
  assert.ok(sidecar!.index['a.ts']?.some((p) => p.file === 'b.ts'));

  const onDisk = fs.readFileSync(path.join(dir, '.klauro', 'co-change-index.json'), 'utf8');
  const parsed = JSON.parse(onDisk);
  assert.equal(parsed.head_commit, sidecar!.head_commit);
  assert.ok(onDisk.length < 20_000, 'sidecar for a 5-file toy repo should be tiny');
});

test('readCoChangeIndexSidecar round-trips what writeCoChangeIndexSidecar wrote', () => {
  const dir = makeTempRepo();
  const written = writeCoChangeIndexSidecar(dir, { minSupport: 2, minLift: 1 });
  const read = readCoChangeIndexSidecar(dir);
  assert.deepEqual(read, written);
});

test('readCoChangeIndexSidecar returns null when no sidecar exists yet', () => {
  const dir = makeTempRepo();
  assert.equal(readCoChangeIndexSidecar(dir), null);
});

test('getOrComputeCoChangeIndex writes a sidecar on first call and reuses it on the next', () => {
  const dir = makeTempRepo();
  assert.equal(readCoChangeIndexSidecar(dir), null);

  const first = getOrComputeCoChangeIndex(dir, { minSupport: 2, minLift: 1 });
  assert.ok(first);
  assert.ok(readCoChangeIndexSidecar(dir), 'first call should have written the sidecar to disk');

  // Second call must return the same data without needing a fresh git log
  // (we can't easily assert "no git call happened" without mocking, but we
  // can assert the result is byte-identical, which is the contract that
  // matters to callers).
  const second = getOrComputeCoChangeIndex(dir, { minSupport: 2, minLift: 1 });
  assert.deepEqual(second, first);
});

test('getOrComputeCoChangeIndex invalidates on HEAD movement (new commit -> recomputed index)', () => {
  const dir = makeTempRepo();
  const before = getOrComputeCoChangeIndex(dir, { minSupport: 2, minLift: 1 });
  assert.ok(before);

  // A new commit changes HEAD; a brand-new coupled pair should show up after
  // enough repetitions to clear support/lift floors.
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(dir, 'd.ts'), `d v${i}`);
    fs.writeFileSync(path.join(dir, 'e.ts'), `e v${i}`);
    git(['add', '.']);
    git(['commit', '-q', '-m', `couple d+e ${i}`]);
  }

  const after = getOrComputeCoChangeIndex(dir, { minSupport: 2, minLift: 1 });
  assert.ok(after);
  assert.ok(after!['d.ts']?.some((p) => p.file === 'e.ts'), 'new coupling should appear once HEAD moves past the cache key');
});

test('computeCoChangeIndexForRepo returns null for a non-git directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-not-a-repo-'));
  assert.equal(computeCoChangeIndexForRepo(dir), null);
});
