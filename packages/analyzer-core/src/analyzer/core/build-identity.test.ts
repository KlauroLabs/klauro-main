import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkServerStaleness, resetStalenessCacheForTests, readDevBuildStamp, resolveDevGitSha } from './build-identity';

// Silent-staleness bug this locks: `klauro update` overwrites the installed
// bundle on disk while an already-running MCP server process keeps executing
// the OLD in-memory build until the client restarts. checkServerStaleness must
// surface that drift (running_stale/note) even when latest.json is never
// reachable, and must stay quiet when running == installed and installed ==
// latest.

function withLatestJsonServer(version: string, handler: (url: string) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/dist/latest.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, async () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        await handler(`http://127.0.0.1:${port}`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('running-old / installed-new: running_stale is true and note asks for a restart', async () => {
  resetStalenessCacheForTests();
  const result = await checkServerStaleness({
    forceRefresh: true,
    __test: { runningBaseVersion: '1.0.31', installedVersion: '1.0.38' },
  });
  assert.equal(result.running_stale, true);
  assert.equal(result.installed_version, '1.0.38');
  assert.equal(result.running_version, '1.0.31');
  assert.ok(result.note, 'expected a restart note when running != installed');
  assert.match(result.note!, /RESTART/);
  assert.match(result.note!, /1\.0\.38/);
});

test('up-to-date: running == installed == latest produces no note and update_available is false', async () => {
  resetStalenessCacheForTests();
  await withLatestJsonServer('1.0.38', async (url) => {
    const result = await checkServerStaleness({
      forceRefresh: true,
      serverUrl: url,
      __test: { runningBaseVersion: '1.0.38', installedVersion: '1.0.38' },
    });
    assert.equal(result.running_stale, false);
    assert.equal(result.update_available, false);
    assert.equal(result.note, null);
  });
});

test('installed matches running but hosted latest is newer: update_available true, running_stale false (no restart needed yet — klauro update, not yet run)', async () => {
  resetStalenessCacheForTests();
  await withLatestJsonServer('1.0.40', async (url) => {
    const result = await checkServerStaleness({
      forceRefresh: true,
      serverUrl: url,
      __test: { runningBaseVersion: '1.0.38', installedVersion: '1.0.38' },
    });
    assert.equal(result.running_stale, false);
    assert.equal(result.update_available, true);
    assert.ok(result.note);
    assert.match(result.note!, /klauro update/);
  });
});

test('throttling: a second call within the TTL window returns the cached result even if inputs would otherwise differ', async () => {
  resetStalenessCacheForTests();
  const first = await checkServerStaleness({
    __test: { runningBaseVersion: '1.0.31', installedVersion: '1.0.38' },
  });
  const second = await checkServerStaleness({
    __test: { runningBaseVersion: '1.0.31', installedVersion: null }, // would be "not stale" if it re-ran
  });
  assert.deepEqual(second, first, 'expected the throttled cache to short-circuit the second call');
});

/**
 * PRODUCTION BUG (fresh v1.0.126 self-analysis): the deployed api container
 * runs raw TS via `tsx` (never the esbuild bundle that embeds
 * __KLAURO_GIT_SHA__), and infrastructure/vps/deploy.sh's source sync
 * excludes .git — so `resolveDevGitSha`'s `git rev-parse` fallback always ran
 * with no .git in reach on prod and reported 'unknown', shipping
 * "1.0.126-dev+unknown" on /health. Fix: deploy.sh now writes a
 * `.klauro-build-stamp.json` stamp (real git sha + build time, taken from the
 * clean host tree that IS what got shipped) BEFORE the container build, and
 * getBuildIdentity() prefers it over the git invocation. These tests pin the
 * stamp-reading/preference logic directly (no need to exercise the whole
 * container/deploy path).
 */
test('readDevBuildStamp: parses a real stamp file written by deploy.sh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-build-stamp-'));
  const stampPath = path.join(dir, '.klauro-build-stamp.json');
  fs.writeFileSync(stampPath, JSON.stringify({ git_sha: 'abc1234def56', build_time: '2026-07-21T04:00:00Z' }));
  try {
    const stamp = readDevBuildStamp(stampPath);
    assert.deepEqual(stamp, { git_sha: 'abc1234def56', build_time: '2026-07-21T04:00:00Z' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readDevBuildStamp: a missing file returns null (never throws) — a genuine dev checkout has no stamp', () => {
  const stamp = readDevBuildStamp('/nonexistent/path/.klauro-build-stamp.json');
  assert.equal(stamp, null);
});

test('readDevBuildStamp: a torn/unparsable stamp file returns null rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-build-stamp-torn-'));
  const stampPath = path.join(dir, '.klauro-build-stamp.json');
  fs.writeFileSync(stampPath, '{"git_sha": "abc123'); // truncated JSON
  try {
    assert.equal(readDevBuildStamp(stampPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDevGitSha: a valid stamped git_sha wins over the local git invocation (the deployed-VPS shape)', () => {
  const sha = resolveDevGitSha({ git_sha: 'deadbeefcafe', build_time: '2026-07-21T04:00:00Z' });
  assert.equal(sha, 'deadbeefcafe', 'the whole point of the stamp is to short-circuit a git call that fails with no .git on disk');
});

test('resolveDevGitSha: a malformed stamped git_sha is rejected, falling back to the git invocation', () => {
  const sha = resolveDevGitSha({ git_sha: 'not-a-valid-sha!!', build_time: '2026-07-21T04:00:00Z' });
  // Falls back to running `git rev-parse` in this real (git-backed) checkout —
  // must not blindly trust a malformed stamp value.
  assert.match(sha, /^([0-9a-f]{7,12}|unknown)$/);
});

test('resolveDevGitSha: no stamp (null) falls back to the git invocation exactly as before', () => {
  const sha = resolveDevGitSha(null);
  assert.match(sha, /^([0-9a-f]{7,12}|unknown)$/);
});

test('forceRefresh bypasses the throttle cache', async () => {
  resetStalenessCacheForTests();
  const first = await checkServerStaleness({
    __test: { runningBaseVersion: '1.0.31', installedVersion: '1.0.38' },
  });
  assert.equal(first.running_stale, true);
  const second = await checkServerStaleness({
    forceRefresh: true,
    __test: { runningBaseVersion: '1.0.31', installedVersion: null },
  });
  assert.equal(second.running_stale, false);
});

test('resolveDevGitSha: a DIRTY deploy reports the snapshot commit, not the HEAD it merely sat on', () => {
  // prod once served a tree stamped with an ancestor's sha, so no hosted
  // analysis could be traced to the code that produced it. A dirty deploy now
  // carries a real snapshot commit and that is what identifies the build.
  const sha = resolveDevGitSha({
    git_sha: '2235c82c0000',
    dirty: true,
    snapshot_sha: 'a1b2c3d4e5f6',
    build_time: '2026-07-27T04:00:00Z',
  });
  assert.equal(sha, 'a1b2c3d4e5f6');
});

test('resolveDevGitSha: a dirty stamp with no usable snapshot still falls back to the stamped HEAD sha', () => {
  const sha = resolveDevGitSha({ git_sha: '2235c82c0000', dirty: true, snapshot_sha: 'nope!' });
  assert.equal(sha, '2235c82c0000');
});
