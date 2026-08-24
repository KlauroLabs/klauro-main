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
 * Regression coverage for defect #41 (measured live twice on 2026-07-16): a
 * background reanalyze that throws AFTER a project already has a 'ready'
 * analysis leaves markBackgroundAnalysisFailed with no 'pending' layer to
 * flip to 'error' (the CAS was already complete), so GET
 * /api/projects/:id/analysis kept serving the OLD analysis at status:'ready'
 * with nothing indicating a newer reanalyze attempt failed. The fix persists
 * a sidecar `last_attempt` record (in-progress / succeeded / failed + reason)
 * independent of the CAS, surfaced additively on the analysis response.
 */
test('reanalyze failure surfaces last_attempt.state=failed with a reason; recovery surfaces succeeded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-reanalyze-attempt-'));
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
      workspace_name: 'Reanalyze Attempt Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const analyzeResult = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'attempt-fixture', wait: true, readinessRequirement: 'structural' });
    assert.equal(analyzeResult.status, 'success');

    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'reanalyze-attempt-fixture',
      analysis_id: analyzeResult.analysis_id,
    }, token);
    assert.equal(linkRes.statusCode, 201);
    const project = JSON.parse(linkRes.body).project as { id: string; analysis_id: string };

    // Sanity: before any REANALYZE attempt, last_attempt reflects the
    // first-analyze that already ran (trigger: 'analyze') rather than being
    // absent. STRANDED-ANALYSIS (defect class #41 continuation) closed the
    // asymmetry where only /reanalyze wrote this sidecar — the first-analyze
    // async path now writes one too, so a first-analyze interrupted by a
    // server restart is reapable the same way a reanalyze always was.
    const beforeRes = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token);
    const beforeBody = JSON.parse(beforeRes.body) as { status?: string; last_attempt?: { state?: string; trigger?: string } };
    assert.equal(beforeBody.status, 'degraded');
    assert.equal(beforeBody.last_attempt?.state, 'succeeded', 'the first-analyze itself now leaves a succeeded attempt record');
    assert.equal(beforeBody.last_attempt?.trigger, 'analyze');

    // --- FAILURE CASE: force the background reanalyze to throw for real.
    // analyzeProjectLayered's very first line is
    // `if (!(await fs.pathExists(projectPath))) throw ...` (apps/mcp-server/
    // src/analyzer.ts:1224) — deleting the on-disk workspace snapshot makes
    // the background run fail deterministically and for a genuine reason,
    // no mocking required. The reanalyze handler schedules the background
    // work via setImmediate() and only THEN returns the 202 — setImmediate
    // callbacks run in the event loop's "check" phase, strictly after the
    // current microtask queue drains, so this synchronous rmSync (no await
    // before it) is guaranteed to land before the background task starts,
    // regardless of scheduling — not a timing race.
    const serverWorkspace = path.join(remoteData, 'workspaces', project.analysis_id);
    assert.ok(fs.existsSync(serverWorkspace), 'sanity: the uploaded snapshot workspace must exist on disk before we delete it');

    const reanalyzeRes = await request(port, 'POST', `/api/projects/${project.id}/reanalyze`, {}, token);
    assert.equal(reanalyzeRes.statusCode, 202, 'reanalyze must still accept immediately even though the background run will fail');
    fs.rmSync(serverWorkspace, { recursive: true, force: true });

    let failedAttempt: { status?: string; last_attempt?: { state?: string; reason?: string; started_at?: string; finished_at?: string } } | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      const analysisRes = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token);
      const analysisBody = JSON.parse(analysisRes.body);
      if (analysisBody.last_attempt?.state === 'failed') {
        failedAttempt = analysisBody;
        break;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    assert.ok(failedAttempt, 'poller must observe last_attempt.state=failed after the background reanalyze throws');
    assert.equal(failedAttempt!.status, 'failed', 'the prior structural analysis must not be exposed as current after a failed reanalysis');
    assert.match(failedAttempt!.last_attempt!.reason || '', /Project path does not exist/, 'the failure reason must be surfaced, not just a bare failed flag');
    assert.ok(failedAttempt!.last_attempt!.started_at, 'started_at must be recorded');
    assert.ok(failedAttempt!.last_attempt!.finished_at, 'finished_at must be recorded on a terminal state');

    for (const route of [
      `/api/projects/${project.id}/cas/manifest`,
      `/api/projects/${project.id}/cas/sections?sections=graph`,
      `/api/projects/${project.id}/cas/export`,
    ]) {
      const unavailableRes = await request(port, 'GET', route, undefined, token);
      assert.equal(unavailableRes.statusCode, 200);
      const unavailable = JSON.parse(unavailableRes.body) as { status?: string; error?: string };
      assert.equal(unavailable.status, 'failed', `${route} must fail closed instead of serving the prior generation`);
      assert.match(unavailable.error || '', /Project path does not exist/);
    }
    for (const route of [`/api/workspaces/${workspaceId}/analysis`, `/api/workspaces/${workspaceId}/contracts`]) {
      const unavailableRes = await request(port, 'GET', route, undefined, token);
      assert.equal(unavailableRes.statusCode, 200);
      const unavailable = JSON.parse(unavailableRes.body) as { status?: string; analysis?: unknown; contracts?: unknown };
      assert.ok(['pending', 'failed'].includes(unavailable.status || ''), `${route} must report unavailable while the failed member rebuild settles`);
      assert.equal(unavailable.analysis, undefined);
      assert.equal(unavailable.contracts, undefined);
    }

    // --- RECOVERY CASE: restore the workspace snapshot (same content the
    // original upload wrote) and reanalyze again. We recreate it directly at
    // the known storage path rather than re-uploading through
    // analyzeCodebaseRemotely, because a fresh upload would re-derive a NEW
    // analysis_id from its (raw_id, account_salt) pair — re-hashing the
    // already-resolved id would land at a different path than the one
    // `project.analysis_id` still points at.
    fs.mkdirSync(serverWorkspace, { recursive: true });
    fs.writeFileSync(path.join(serverWorkspace, 'app.py'), 'def handler():\n    return 1\n');

    const recoveryRes = await request(port, 'POST', `/api/projects/${project.id}/reanalyze`, {}, token);
    assert.equal(recoveryRes.statusCode, 202);

    let succeededAttempt: { last_attempt?: { state?: string } } | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      const analysisRes = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token);
      const analysisBody = JSON.parse(analysisRes.body);
      if (analysisBody.last_attempt?.state === 'succeeded') {
        succeededAttempt = analysisBody;
        break;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    assert.ok(succeededAttempt, 'poller must observe last_attempt.state=succeeded after a subsequent successful reanalyze');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
