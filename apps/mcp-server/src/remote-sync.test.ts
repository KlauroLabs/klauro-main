import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely, syncWorkingTreeRemotely } from './remote-sync-client';
import { getAnalysis } from './analyzer';

const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');

test('remote analyzer supports full source upload and dirty-tree incremental sync', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-remote-sync-test-'));
  const repo = path.join(root, 'repo');
  const storage = path.join(root, 'storage');
  const remoteData = path.join(root, 'remote-data');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;

  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  fs.cpSync(fixturePath, repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${address.port}`;

  try {
    const account = await postJson(address.port, '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Remote Sync Workspace',
    });
    assert.equal(account.statusCode, 201);
    const token = JSON.parse(account.body).token as string;

    const full = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token });
    assert.equal(full.status, 'success');
    assert.equal(full.analysis_type, 'full');
    assert.ok(full.cas.nodes.length > 0);
    assert.ok((await getAnalysis(repo)).nodes.length > 0);
    const revisions = await getJson(address.port, `/v1/projects/${encodeURIComponent(full.analysis_id)}/revisions`, token);
    assert.equal(revisions.statusCode, 200);
    const revisionPayload = JSON.parse(revisions.body);
    assert.equal(revisionPayload.revisions[0].commit, full.base_commit);
    assert.equal(revisionPayload.revisions[0].source, 'local_commit_submission');

    const appFile = path.join(repo, 'app', 'main.py');
    fs.appendFileSync(appFile, '\n\n@app.get("/healthz")\ndef healthz():\n    return {"ok": True}\n');
    const incremental = await syncWorkingTreeRemotely({ projectPath: repo, serverUrl, analysisId: full.analysis_id, token });

    assert.equal(incremental.status, 'success');
    assert.equal(incremental.analysis_type, 'incremental');
    assert.ok(incremental.change_report);
    assert.ok((incremental.change_report?.summary.filesAdded || 0) + (incremental.change_report?.summary.filesModified || 0) > 0);
    const cached = await getAnalysis(repo);
    assert.ok((cached.entry_points || []).some(entry => JSON.stringify(entry).includes('healthz')));
    const auditLog = path.join(remoteData, 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(auditLog));
    const auditEvents = fs.readFileSync(auditLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(auditEvents.some(event => event.event === 'analyze'));
    assert.ok(auditEvents.some(event => event.event === 'sync'));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousStorage === undefined) {
      delete process.env.KLAURO_STORAGE_PATH;
    } else {
      process.env.KLAURO_STORAGE_PATH = previousStorage;
    }
    if (previousRemoteData === undefined) {
      delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    } else {
      process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dirty tree analyze: shared revision is committed HEAD and the in-flight pass runs automatically', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-dirty-analyze-test-'));
  const repo = path.join(root, 'repo');
  const storage = path.join(root, 'storage');
  const remoteData = path.join(root, 'remote-data');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;

  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  fs.cpSync(fixturePath, repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  // Dirty the tree BEFORE analyze: an uncommitted route on a tracked file plus an
  // untracked file. Neither may reach the shared revision; both are in-flight-only.
  const appFile = path.join(repo, 'app', 'main.py');
  const dirtyWorkingContent = `${fs.readFileSync(appFile, 'utf8')}\n\n@app.get("/dirty-only")\ndef dirty_only():\n    return {"dirty": True}\n`;
  fs.writeFileSync(appFile, dirtyWorkingContent);
  fs.writeFileSync(path.join(repo, 'app', 'untracked_extra.py'), 'EXTRA = True\n');

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${address.port}`;

  try {
    const account = await postJson(address.port, '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Dirty Analyze Workspace',
    });
    assert.equal(account.statusCode, 201);
    const token = JSON.parse(account.body).token as string;

    // No refusal: the dirty tree analyzes fine.
    const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token });
    assert.equal(result.status, 'success');
    assert.equal(result.snapshot_source, 'committed-head');
    assert.equal(result.base_commit, head, 'shared revision is tagged with the HEAD commit');
    assert.ok(result.cas.nodes.length > 0);

    // The shared (main track) analysis must NOT see the dirty route.
    const main = await getAnalysis(repo, { track: 'main' });
    assert.ok(main.nodes.length > 0);
    assert.ok(!JSON.stringify(main.entry_points || []).includes('dirty_only'), 'dirty-only route is absent from the shared revision');

    // The in-flight pass ran automatically, saw the dirty change, and landed on
    // the dedicated in-flight track.
    assert.equal(result.in_flight?.status, 'completed');
    assert.ok((result.in_flight?.changed_files || 0) >= 1, 'in-flight pass reported the dirty file(s)');
    const inFlight = await getAnalysis(repo, { track: 'in-flight' });
    assert.ok(JSON.stringify(inFlight.entry_points || []).includes('dirty_only'), 'in-flight analysis sees the dirty route');

    // Server-side revision log records the HEAD commit as the shared revision.
    const revisions = await getJson(address.port, `/v1/projects/${encodeURIComponent(result.analysis_id)}/revisions`, token);
    assert.equal(revisions.statusCode, 200);
    const revisionPayload = JSON.parse(revisions.body);
    assert.equal(revisionPayload.revisions[0].commit, head);

    // The working tree was never touched by analyze.
    assert.equal(fs.readFileSync(appFile, 'utf8'), dirtyWorkingContent);
    assert.ok(fs.existsSync(path.join(repo, 'app', 'untracked_extra.py')));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousStorage === undefined) {
      delete process.env.KLAURO_STORAGE_PATH;
    } else {
      process.env.KLAURO_STORAGE_PATH = previousStorage;
    }
    if (previousRemoteData === undefined) {
      delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    } else {
      process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remote analyzer honors hosted request body limit from environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-remote-limit-test-'));
  const previousMaxBody = process.env.KLAURO_MAX_BODY_MB;
  process.env.KLAURO_MAX_BODY_MB = '0.001';

  const server = createRemoteAnalyzerHttpServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const result = await postJson(address.port, '/v1/analyze', { payload: 'x'.repeat(2048) });
    assert.equal(result.statusCode, 500);
    assert.match(result.body, /Request body exceeds/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousMaxBody === undefined) {
      delete process.env.KLAURO_MAX_BODY_MB;
    } else {
      process.env.KLAURO_MAX_BODY_MB = previousMaxBody;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function getJson(port: number, route: string, token?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: responseBody }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function postJson(port: number, route: string, body: unknown): Promise<{ statusCode: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: responseBody }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}
