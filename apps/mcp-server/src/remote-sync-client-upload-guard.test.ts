import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeCodebaseRemotely } from './remote-sync-client';
import { writeDefaultKlauroConfig } from './klauro-config';

/**
 * Cold-start data-loss regression coverage (2026-08-08 audit): calling
 * analyze/sync before `klauro init` — or with a stale .klaurorc bound to a
 * project this account cannot see — used to return 'accepted' and then
 * silently drop the upload (a third, unrelated project shows up later on
 * init; nothing ever references the original source). These tests prove the
 * `requireBoundProject` gate (every real CLI/MCP entry point sets it — see
 * remote-sync-client.ts's assertUploadTargetIsReachable) refuses BEFORE any
 * network call when the repo has no hosted project bound, and BEFORE the
 * upload accepts when a well-formed project id 404s for this account —
 * naming the real cause instead of accepting-then-dropping.
 *
 * The low-level `requireBoundProject: false` (default) behavior — used
 * throughout this file's sibling test suites to drive an arbitrary mock
 * server without an init step — must stay completely unaffected; the last
 * two tests below pin that down explicitly.
 */

const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');

function disableConnectorAuth(t: import('node:test').TestContext): void {
  const previous = process.env.KLAURO_CONNECTOR_AUTH_DISABLED;
  process.env.KLAURO_CONNECTOR_AUTH_DISABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.KLAURO_CONNECTOR_AUTH_DISABLED;
    else process.env.KLAURO_CONNECTOR_AUTH_DISABLED = previous;
  });
}

function makeGitFixtureRepo(root: string): string {
  const repo = path.join(root, 'repo');
  fs.cpSync(fixturePath, repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

async function withMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ serverUrl: string; requestCount: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    void handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${(address as { port: number }).port}`;
  return { serverUrl, requestCount: () => count, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function successPayload(analysisId: string) {
  return JSON.stringify({
    status: 'accepted',
    analysis_id: analysisId,
    manifest: { files: [] },
  });
}

test('requireBoundProject refuses an unbound repo (no klauro init) BEFORE any network call — never accepts-then-drops', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-upload-guard-test-'));
  const repo = makeGitFixtureRepo(root);

  const mock = await withMockServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(successPayload('should-never-be-reached'));
  });
  t.after(async () => {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => analyzeCodebaseRemotely({ projectPath: repo, serverUrl: mock.serverUrl, token: 'test-token', requireBoundProject: true }),
    (error: Error) => {
      assert.match(error.message, /not connected to a hosted Klauro project/i);
      assert.match(error.message, /`klauro init/);
      assert.match(error.message, /orphaned/i);
      return true;
    },
  );
  assert.equal(mock.requestCount(), 0, 'no request should ever reach the server for an unbound repo');
});

test('requireBoundProject refuses a stale/wrong-account project id BEFORE the upload accepts, naming both possible causes', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-upload-guard-test-'));
  const repo = makeGitFixtureRepo(root);
  await writeDefaultKlauroConfig(repo, { projectId: 'prj_stale_other_account', kind: 'project' });

  let sawAnalyzePost = false;
  const mock = await withMockServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/projects/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/analyze') {
      sawAnalyzePost = true;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(successPayload('should-never-be-reached'));
  });
  t.after(async () => {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => analyzeCodebaseRemotely({ projectPath: repo, serverUrl: mock.serverUrl, token: 'test-token', requireBoundProject: true }),
    (error: Error) => {
      assert.match(error.message, /prj_stale_other_account/);
      assert.match(error.message, /not a member of|does not exist/i);
      assert.match(error.message, /`klauro whoami`/);
      assert.match(error.message, /`klauro login/);
      assert.match(error.message, /`klauro init --force`/);
      return true;
    },
  );
  assert.equal(sawAnalyzePost, false, 'the upload must never be attempted once the binding probe reports not_found');
});

test('requireBoundProject proceeds normally when the bound project resolves for this account', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-upload-guard-test-'));
  const repo = makeGitFixtureRepo(root);
  await writeDefaultKlauroConfig(repo, { projectId: 'prj_live_and_visible', kind: 'project' });

  const mock = await withMockServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/projects/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'prj_live_and_visible' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(successPayload('prj_live_and_visible'));
  });
  t.after(async () => {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl: mock.serverUrl, token: 'test-token', requireBoundProject: true });
  assert.equal(result.status, 'accepted');
});

test('requireBoundProject omitted (default false) preserves the existing low-level behavior: an unbound repo still uploads', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-upload-guard-test-'));
  const repo = makeGitFixtureRepo(root);

  const mock = await withMockServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(successPayload('default-behavior-test'));
  });
  t.after(async () => {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl: mock.serverUrl, token: 'test-token' });
  assert.equal(result.status, 'accepted');
});

test('an explicit analysisId is trusted as a deliberate placement decision even with requireBoundProject and no .klaurorc', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-upload-guard-test-'));
  const repo = makeGitFixtureRepo(root);

  const mock = await withMockServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(successPayload('explicit-analysis-id'));
  });
  t.after(async () => {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await analyzeCodebaseRemotely({
    projectPath: repo,
    serverUrl: mock.serverUrl,
    token: 'test-token',
    analysisId: 'explicit-analysis-id',
    requireBoundProject: true,
  });
  assert.equal(result.status, 'accepted');
});
