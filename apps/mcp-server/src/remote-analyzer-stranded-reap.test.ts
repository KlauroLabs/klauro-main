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

/** Mirrors remote-analyzer-service.ts's own (unexported) workspacePath/
 *  projectAttemptRecordPath/safeName — the on-disk sidecar layout is a
 *  stable, documented contract (see ReanalyzeAttemptRecord's doc comment),
 *  so reconstructing it here to inject synthetic fixtures is the same thing
 *  an operator debugging a stuck analysis on the box would do. */
function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
}
function workspaceDir(dataDir: string, analysisId: string): string {
  return path.join(dataDir, 'workspaces', safeName(analysisId));
}
function attemptRecordPath(workspace: string): string {
  return path.join(workspace, '.reanalyze-attempt.json');
}

/**
 * STRANDED-ANALYSIS (defect class #41 continuation): an async analysis
 * (first-analyze OR reanalyze) interrupted by a server-process restart never
 * runs its own catch block, so its attempt record is stuck at 'in-progress'
 * forever and GET .../status/.../analysis reports 'populating'/'no_analysis'
 * forever with no visible error. The fix is a periodic heartbeat while
 * background work is alive (ReanalyzeAttemptRecord.heartbeat_at) plus a
 * reap (on server startup AND lazily on every poll) that treats an
 * unrefreshed heartbeat as proof the owning process died — UNLESS the CAS
 * genuinely landed in the meantime, in which case the record is corrected to
 * 'succeeded' rather than a completed analysis being reported as failed.
 */

test('first-analyze async path writes a succeeded attempt record (regression: it used to write none at all)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-stranded-reap-'));
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
      workspace_name: 'Stranded Reap Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    // analyzeCodebaseRemotely always posts /v1/analyze with async:true (the
    // exact path this fix touches) — wait:true just polls for completion.
    const analyzeResult = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'first-analyze-attempt-fixture', wait: true, readinessRequirement: 'structural' });
    assert.equal(analyzeResult.status, 'success');

    // The client-visible analysis_id (analyzeResult.analysis_id) is NOT the
    // on-disk storage key for an authenticated push — the server salts it
    // per-account (resolveStorageAnalysisId -> acct_<hash>) and only echoes
    // the raw handle back to the client (clientVisibleAnalysisId). With a
    // single fresh data dir there is exactly one workspace directory; read it
    // back directly rather than reimplementing the salting hash here.
    const workspaceEntries = fs.readdirSync(path.join(remoteData, 'workspaces'));
    assert.equal(workspaceEntries.length, 1, 'exactly one workspace directory expected for this fixture');
    const workspace = path.join(remoteData, 'workspaces', workspaceEntries[0]);
    const recordPath = attemptRecordPath(workspace);
    assert.ok(fs.existsSync(recordPath), 'the first-analyze async path must now write a .reanalyze-attempt.json sidecar (it previously wrote none)');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.equal(record.state, 'succeeded');
    assert.equal(record.trigger, 'analyze');
    assert.ok(record.started_at);
    assert.ok(record.finished_at);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale in-progress attempt record with no landed CAS is reaped to failed with a restart-interrupted reason', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-stranded-reap-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Stranded Reap Workspace 2',
    });
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // A project pointed at an analysis_id that has NEVER actually landed a
    // CAS — the exact shape of a first-analyze whose background work died
    // before L0 ever persisted anything. POST .../projects resolves the
    // supplied analysis_id through the same per-account salting as a real
    // push (see resolveStorageAnalysisId) — project.analysis_id in the
    // response is the REAL on-disk storage key, not the raw string sent.
    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'stranded-no-cas-fixture',
      analysis_id: 'stranded-no-cas-fixture',
    }, token);
    assert.equal(linkRes.statusCode, 201);
    const project = JSON.parse(linkRes.body).project as { id: string; analysis_id: string };

    // Synthesize the abandoned record directly: no server process actually
    // died here (this is a single test process), but the on-disk artifact of
    // that scenario is exactly a sidecar whose heartbeat is far older than
    // ATTEMPT_STALE_THRESHOLD_MS (90s) with no CAS ever having landed.
    const workspace = workspaceDir(remoteData, project.analysis_id);
    fs.mkdirSync(workspace, { recursive: true });
    const staleHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(attemptRecordPath(workspace), JSON.stringify({
      state: 'in-progress',
      trigger: 'analyze',
      started_at: staleHeartbeat,
      heartbeat_at: staleHeartbeat,
    }));

    const analysisRes = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token);
    const body = JSON.parse(analysisRes.body) as { status?: string; last_attempt?: { state?: string; reason?: string } };
    assert.equal(body.status, 'no_analysis', 'no CAS ever landed, so status must not silently claim ready/populating');
    assert.equal(body.last_attempt?.state, 'failed', 'the stale in-progress record must be reaped to failed, not left hanging forever');
    assert.match(body.last_attempt?.reason || '', /interrupted by a server restart/i);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh in-progress attempt record (recent heartbeat) is NOT reaped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-stranded-reap-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Stranded Reap Workspace 3',
    });
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'stranded-fresh-heartbeat-fixture',
      analysis_id: 'stranded-fresh-heartbeat-fixture',
    }, token);
    const project = JSON.parse(linkRes.body).project as { id: string; analysis_id: string };

    const workspace = workspaceDir(remoteData, project.analysis_id);
    fs.mkdirSync(workspace, { recursive: true });
    const freshHeartbeat = new Date().toISOString();
    fs.writeFileSync(attemptRecordPath(workspace), JSON.stringify({
      state: 'in-progress',
      trigger: 'analyze',
      started_at: freshHeartbeat,
      heartbeat_at: freshHeartbeat,
    }));

    const analysisRes = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token);
    const body = JSON.parse(analysisRes.body) as { status?: string; last_attempt?: { state?: string } };
    assert.equal(body.last_attempt?.state, 'in-progress', 'a record with a fresh heartbeat could still be genuinely running and must not be reaped');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a landed-and-complete CAS with a stale in-progress record resolves to ready, never failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-stranded-reap-'));
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
      workspace_name: 'Stranded Reap Workspace 4',
    });
    const token = JSON.parse(registerRes.body).token as string;

    // A real, fully-landed analysis (layers_ready.complete === true).
    const analyzeResult = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'landed-cas-fixture', wait: true, readinessRequirement: 'structural' });
    assert.equal(analyzeResult.status, 'success');

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;
    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'landed-cas-fixture',
      analysis_id: analyzeResult.analysis_id,
    }, token);
    const project = JSON.parse(linkRes.body).project as { id: string; analysis_id: string };

    // Overwrite the (already-'succeeded') record with a stale 'in-progress'
    // one, simulating: the CAS landed, but the process died in the narrow
    // gap before the attempt record's own terminal write happened.
    // project.analysis_id (not analyzeResult.analysis_id) is the resolved
    // on-disk storage key — see the earlier test's comment.
    const workspace = workspaceDir(remoteData, project.analysis_id);
    const staleHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(attemptRecordPath(workspace), JSON.stringify({
      state: 'in-progress',
      trigger: 'analyze',
      started_at: staleHeartbeat,
      heartbeat_at: staleHeartbeat,
    }));

    const analysisRes = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token);
    const body = JSON.parse(analysisRes.body) as { status?: string; last_attempt?: { state?: string } };
    assert.equal(body.status, 'ready', 'reaping a stale record must never destroy a genuinely complete analysis');
    assert.equal(body.last_attempt?.state, 'succeeded', 'the record must be corrected to succeeded, not left claiming in-progress or flipped to failed');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the startup reap sweep resolves an abandoned record left by a previous process incarnation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-stranded-reap-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;

  // Simulate a previous process incarnation: a workspace dir with an
  // abandoned 'in-progress' record, written before this server ever started
  // (no server has been created yet at this point in the test).
  const analysisId = 'startup-sweep-fixture';
  const workspace = workspaceDir(remoteData, analysisId);
  fs.mkdirSync(workspace, { recursive: true });
  const staleHeartbeat = new Date(Date.now() - 10 * 60_000).toISOString();
  fs.writeFileSync(attemptRecordPath(workspace), JSON.stringify({
    state: 'in-progress',
    trigger: 'analyze',
    started_at: staleHeartbeat,
    heartbeat_at: staleHeartbeat,
  }));

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    // The startup sweep is fire-and-forget (must never delay server
    // startup/port binding) — poll briefly for it to land instead of
    // asserting immediately after listen().
    let reaped = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const record = JSON.parse(fs.readFileSync(attemptRecordPath(workspace), 'utf8'));
      if (record.state === 'failed') { reaped = true; break; }
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    assert.ok(reaped, 'the startup sweep must reap an abandoned record left by a previous process incarnation');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
