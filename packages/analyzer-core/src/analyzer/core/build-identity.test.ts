import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { checkServerStaleness, resetStalenessCacheForTests } from './build-identity';

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
