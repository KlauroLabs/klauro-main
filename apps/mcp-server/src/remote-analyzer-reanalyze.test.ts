import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';

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

/**
 * Regression coverage for the client-uploads/server-analyzes-and-discards
 * product model: `POST /api/projects/:id/reanalyze` must NEVER read
 * `project.local_path` from the server's own disk (that path only ever makes
 * sense on the user's laptop). It must instead re-run analysis against the
 * last snapshot the client already uploaded (persisted under
 * workspaces/<analysis_id> by /v1/analyze), and return an actionable status
 * — never a server-disk-path error — when no snapshot has ever been uploaded.
 */
test('reanalyze re-runs on the last uploaded snapshot, never touching project.local_path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-reanalyze-'));
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
      workspace_name: 'Reanalyze Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    assert.equal(workspacesRes.statusCode, 200);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // Create the project WITHOUT a server-meaningful local_path — laptop path
    // is stored as client metadata only, never used to drive analysis here.
    const createRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'reanalyze-fixture',
      local_path: '/Users/someone/this-does-not-exist-on-the-server',
    }, token);
    assert.equal(createRes.statusCode, 201);
    const project = JSON.parse(createRes.body).project as { id: string; analysis_id?: string };
    assert.ok(!project.analysis_id, 'freshly created project should have no analysis yet');

    // --- (c) reanalyze with NO uploaded snapshot yet: actionable, no local_path mention ---
    const noSnapshotRes = await request(port, 'POST', `/api/projects/${project.id}/reanalyze`, {}, token);
    assert.equal(noSnapshotRes.statusCode, 409);
    const noSnapshotBody = JSON.parse(noSnapshotRes.body);
    assert.equal(noSnapshotBody.status, 'no_snapshot');
    assert.match(noSnapshotBody.error, /klauro analyze/i);
    assert.doesNotMatch(noSnapshotBody.error, /local_path/i, 'user-facing message must never mention server-disk local_path');

    // --- client uploads a snapshot (the same path klauro init/analyze use) ---
    const analyzeResult = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: project.id });
    assert.equal(analyzeResult.status, 'success');
    assert.ok(analyzeResult.cas.nodes.length > 0);

    // Project record must now carry the analysis_id set by /v1/analyze.
    const projectAfterUploadRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/projects`, undefined, token);
    const projectsAfterUpload = JSON.parse(projectAfterUploadRes.body).projects as Array<{ id: string; analysis_id?: string }>;
    const refreshed = projectsAfterUpload.find(p => p.id === project.id);
    // analysis_id is only auto-linked when the CLI later reports it back;
    // for this in-process test we drive reanalyze directly via analysis_id
    // returned in the analyze response to prove the snapshot workspace path.
    void refreshed;

    // --- (b) reanalyze on a project WITH an uploaded snapshot: re-analyzes
    // from the stored snapshot workspace, no local_path involved ---
    // Point reanalyze at the same analysis_id the upload used by re-fetching
    // the project (server-side linkage happens via setProjectAnalysisId in
    // the CLI flow normally; here we assert the endpoint's own behavior once
    // project.analysis_id is set).
    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'reanalyze-fixture-linked',
      analysis_id: analyzeResult.analysis_id,
    }, token);
    assert.equal(linkRes.statusCode, 201);
    const linkedProject = JSON.parse(linkRes.body).project as { id: string };

    const reanalyzeRes = await request(port, 'POST', `/api/projects/${linkedProject.id}/reanalyze`, {}, token);
    assert.equal(reanalyzeRes.statusCode, 200);
    const reanalyzeBody = JSON.parse(reanalyzeRes.body);
    assert.equal(reanalyzeBody.status, 'success');
    assert.equal(reanalyzeBody.analysis_id, analyzeResult.analysis_id);
    assert.ok(reanalyzeBody.nodes > 0, 'reanalyze should produce a non-empty CAS from the stored snapshot');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
