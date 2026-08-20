/**
 * REGRESSION GATE — task #129: `klauro status` (and the hosted `get_summary`
 * fast path) reported a stale, foreign-looking analysis as "fresh" while a
 * NEW analysis for the same project was actively in flight.
 *
 * Root cause: GET /api/projects/:id/analysis-status and GET
 * /api/projects/:id/analysis both key their read off `project.analysis_id`
 * (a workspace directory on disk) and compute `status`/freshness purely from
 * whatever CAS entry is already landed there — with no check for whether a
 * NEWER attempt is actively overwriting that same workspace right now. A
 * push accepted via POST /v1/analyze writes `last_attempt.state:
 * 'in-progress'` to the workspace's sidecar the moment it is accepted, well
 * before the CAS itself lands (see startAttemptHeartbeat / the reanalyze
 * accept path) — so `last_attempt.state === 'in-progress'` is exactly the
 * signal these two routes were ignoring in favor of the last LANDED entry.
 *
 * This test drives the real HTTP surface (no engine imports): accept an
 * analysis for a project, let it land, then simulate a second push that has
 * been ACCEPTED (attempt record written 'in-progress') but has not yet
 * overwritten the CAS — and asserts that a poll during that window reports
 * 'populating', never the previous run's 'ready'/fresh summary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';

function soleWorkspace(remoteData: string): string {
  const dir = path.join(remoteData, 'workspaces');
  const entries = fs.readdirSync(dir).filter(name => !name.startsWith('.'));
  assert.equal(entries.length, 1, `expected exactly one workspace, got ${entries.join(', ')}`);
  return path.join(dir, entries[0]);
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function request(port: number, method: string, route: string, body?: unknown, token?: string): Promise<{ statusCode: number; body: string }> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: responseBody }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.end(payload);
    else req.end();
  });
}

test('status never reports a stale analysis as fresh while a new attempt is in flight', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-status-freshness-'));
  const repo = path.join(root, 'repo');
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  fs.mkdirSync(repo, { recursive: true });

  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'app.py'), 'def handler():\n    return 1\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial commit']);

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Status Freshness Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // First analysis: accepted and fully completed.
    const analyzed = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'status-freshness-fixture', wait: true, readinessRequirement: 'structural' });
    assert.equal(analyzed.status, 'success');

    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'status-freshness-fixture',
      analysis_id: analyzed.analysis_id,
    }, token);
    const project = JSON.parse(linkRes.body).project as { id: string };

    // Sanity: right after landing, both status routes agree it is ready.
    const readyStatus = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis-status`, undefined, token)).body);
    assert.equal(readyStatus.status, 'ready');
    const readyAnalysis = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token)).body);
    assert.equal(readyAnalysis.status, 'ready');

    // Simulate a SECOND push that has been accepted (its attempt record is
    // 'in-progress') but has not yet overwritten the CAS on disk — the exact
    // window observed live where `klauro status` reported the FIRST run as
    // fresh. Write the sidecar directly rather than reaching into the
    // running server's in-memory state (this repo's own gate: tests only
    // drive the real HTTP surface, not engine internals).
    const workspace = soleWorkspace(remoteData);
    const attemptRecordPath = path.join(workspace, '.reanalyze-attempt.json');
    fs.writeFileSync(attemptRecordPath, JSON.stringify({
      state: 'in-progress',
      trigger: 'analyze',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    }));

    const midWriteStatus = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis-status`, undefined, token)).body);
    assert.equal(midWriteStatus.status, 'populating', 'an in-progress attempt must win over a landed-but-stale entry');
    assert.equal(midWriteStatus.last_attempt?.state, 'in-progress');
    assert.equal(midWriteStatus.summary, undefined, 'must not carry a stale summary that reads as fresh');

    const midWriteAnalysis = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token)).body);
    assert.equal(midWriteAnalysis.status, 'populating', 'the /analysis route must agree — a client polling either surface gets the same verdict');
    assert.equal(midWriteAnalysis.last_attempt?.state, 'in-progress');

    fs.writeFileSync(attemptRecordPath, JSON.stringify({
      state: 'failed',
      trigger: 'analyze',
      analysis_revision: 22,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      reason: 'analysis worker failed',
    }));
    const failedUploadStatus = JSON.parse((await request(port, 'GET', `/v1/analyses/${analyzed.analysis_id}/status`, undefined, token)).body);
    assert.equal(failedUploadStatus.status, 'failed');
    assert.equal(failedUploadStatus.analysis_revision, 22);
    assert.equal(failedUploadStatus.last_attempt?.reason, 'analysis worker failed');

    // Once the attempt resolves (succeeded), both routes go back to reading
    // the (now current) landed entry normally.
    fs.writeFileSync(attemptRecordPath, JSON.stringify({
      state: 'succeeded',
      trigger: 'analyze',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 1200,
    }));
    const afterStatus = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis-status`, undefined, token)).body);
    assert.equal(afterStatus.status, 'ready');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
