import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRepoRevision, revisionCacheKey, compareRevision } from './revision';

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-rev-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return dir;
}

test('getRepoRevision reports SHA + branch on a clean tree', () => {
  const dir = tmpRepo();
  const rev = getRepoRevision(dir)!;
  assert.ok(rev, 'should detect a git repo');
  assert.match(rev.head_sha!, /^[0-9a-f]{40}$/);
  assert.equal(rev.dirty, false);
  assert.equal(rev.dirty_hash, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dirty tree yields a stable, content-sensitive dirty_hash', () => {
  const dir = tmpRepo();
  fs.appendFileSync(path.join(dir, 'a.ts'), 'export const b = 2;\n');
  const r1 = getRepoRevision(dir)!;
  assert.equal(r1.dirty, true);
  assert.match(r1.dirty_hash!, /^[0-9a-f]{16}$/);
  // same content → same hash (stable)
  assert.equal(getRepoRevision(dir)!.dirty_hash, r1.dirty_hash);
  // different content → different hash (never-stale guarantee)
  fs.appendFileSync(path.join(dir, 'a.ts'), 'export const c = 3;\n');
  assert.notEqual(getRepoRevision(dir)!.dirty_hash, r1.dirty_hash);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('revisionCacheKey: committed key is SHA-stable; in-flight adds the working hash', () => {
  const committed = { branch: 'main', head_sha: 'abc', dirty: false, dirty_hash: null };
  const inflight = { branch: 'main', head_sha: 'abc', dirty: true, dirty_hash: 'deadbeef00000000' };
  assert.equal(revisionCacheKey('proj1', committed), 'proj1@main@abc');
  assert.equal(revisionCacheKey('proj1', inflight), 'proj1@main@abc+wip-deadbeef00000000');
});

test('compareRevision classifies committed-current / in-flight / behind / unknown', () => {
  const clean = { branch: 'main', head_sha: 'abc', dirty: false, dirty_hash: null };
  const dirty = { branch: 'main', head_sha: 'abc', dirty: true, dirty_hash: 'x' };
  assert.equal(compareRevision('abc', clean), 'committed-current');
  assert.equal(compareRevision('abc', dirty), 'in-flight');
  assert.equal(compareRevision('old', clean), 'behind');
  assert.equal(compareRevision('abc', null), 'unknown');
  assert.equal(compareRevision(undefined, clean), 'unknown');
});
