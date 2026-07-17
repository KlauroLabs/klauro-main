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
 * Instrumentation coverage for `last_attempt` queue visibility (MOTIVATION:
 * a 705-file repo sat 'in-progress' 90+ minutes behind a concurrent whale
 * rebuild with zero attributable signal — `last_attempt` previously carried
 * only {state, trigger, started_at}, with started_at conflating "accepted"
 * and "actually began executing"). This exercises the full lifecycle for a
 * single project reanalyze: queued -> in-progress -> succeeded, and asserts
 * queued_at, queue_position, started_at, finished_at, and duration_ms all
 * land and are internally consistent. Purely additive: every field the
 * existing remote-analyzer-reanalyze-attempt.test.ts already asserts on
 * (state/reason/started_at/finished_at) is untouched by this test.
 */
test('reanalyze last_attempt lifecycle carries queued_at/queue_position/started_at/finished_at/duration_ms', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-queue-visibility-'));
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
      workspace_name: 'Queue Visibility Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const analyzeResult = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'queue-fixture', wait: true });
    assert.equal(analyzeResult.status, 'success');

    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'queue-visibility-fixture',
      analysis_id: analyzeResult.analysis_id,
    }, token);
    assert.equal(linkRes.statusCode, 201);
    const project = JSON.parse(linkRes.body).project as { id: string };

    const acceptedAt = Date.now();
    const reanalyzeRes = await request(port, 'POST', `/api/projects/${project.id}/reanalyze`, {}, token);
    assert.equal(reanalyzeRes.statusCode, 202);

    type LastAttempt = {
      state?: string;
      queued_at?: string;
      queue_position?: number;
      started_at?: string;
      finished_at?: string;
      duration_ms?: number;
    };
    let succeeded: LastAttempt | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      const analysisRes = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token);
      const analysisBody = JSON.parse(analysisRes.body) as { last_attempt?: LastAttempt };
      if (analysisBody.last_attempt?.state === 'succeeded') {
        succeeded = analysisBody.last_attempt;
        break;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }

    assert.ok(succeeded, 'poller must observe last_attempt.state=succeeded after the reanalyze completes');
    // queued_at: stamped at accept time, so it must be no earlier than just
    // before the POST and no later than "now".
    assert.ok(succeeded!.queued_at, 'queued_at must be recorded');
    assert.ok(Date.parse(succeeded!.queued_at!) >= acceptedAt - 1000, 'queued_at must reflect accept time, not some earlier stamp');
    // queue_position: a single, uncontended reanalyze on a fresh process must
    // see zero other attempts already in flight.
    assert.equal(succeeded!.queue_position, 0, 'first reanalyze on a fresh process has nothing ahead of it');
    // started_at: must be present and no earlier than queued_at (execution
    // cannot begin before the request was accepted).
    assert.ok(succeeded!.started_at, 'started_at must be recorded');
    assert.ok(Date.parse(succeeded!.started_at!) >= Date.parse(succeeded!.queued_at!), 'started_at must not precede queued_at');
    // finished_at + duration_ms: terminal state must carry both, and they
    // must agree with each other.
    assert.ok(succeeded!.finished_at, 'finished_at must be recorded on a terminal state');
    assert.equal(typeof succeeded!.duration_ms, 'number');
    assert.ok(succeeded!.duration_ms! >= 0, 'duration_ms must be non-negative');
    const impliedDuration = Date.parse(succeeded!.finished_at!) - Date.parse(succeeded!.started_at!);
    assert.equal(succeeded!.duration_ms, impliedDuration, 'duration_ms must equal finished_at - started_at');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
