import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';
import { shutdownAnalysisWorker } from './analyzer';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';

// See the matching comment in remote-sync.test.ts / remote-analyzer-attach.test.ts:
// the remote-analyzer HTTP handlers dispatch through analyzer.ts's worker-fork
// isolation and (for account-project pushes) can lazily connect the process-wide
// aiService singleton — both are long-lived resources a test process must tear
// down explicitly or `node --test` never exits.
after(async () => {
  shutdownAnalysisWorker();
  await aiService.close();
});

/**
 * Coverage for GET /api/account/activity and GET /api/workspaces/{id}/activity
 * (the Change Activity feed backing the Home + Workspace Figma frames' "recent
 * changes across your system" panel, previously an empty state because no feed
 * endpoint existed). Every event the feed produces is a projection of data the
 * product ALREADY persists for other reasons: RemoteProjectRevision entries
 * (project-revisions/<analysis_id>.json, appended by every landed analyze),
 * AccountProject.created_at/moved_at, and the reanalyze attempt sidecar — see
 * collectProjectActivityEvents / collectWorkspaceActivityEvents in
 * remote-analyzer-service.ts.
 */

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

test('Change Activity feed: two landed analyses show ordered analysis_completed events with deltas, membership is gated, and an empty account is honest', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-activity-'));
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
      email: 'activity-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Activity Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // First landed analysis — one stored revision, no prior revision to diff
    // against, so its analysis_completed event carries no `deltas`.
    const firstAnalyze = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'activity-fixture', wait: true });
    assert.equal(firstAnalyze.status, 'success');

    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'activity-fixture-project',
      analysis_id: firstAnalyze.analysis_id,
    }, token);
    assert.equal(linkRes.statusCode, 201);
    const project = JSON.parse(linkRes.body).project as { id: string; created_at: string };

    await t.test('before a second analysis, the feed already shows the first analysis_completed + project_created events', async () => {
      const activityRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/activity`, undefined, token);
      assert.equal(activityRes.statusCode, 200);
      const body = JSON.parse(activityRes.body) as { workspace_id: string; events: Array<Record<string, unknown>>; next_cursor: null };
      assert.equal(body.workspace_id, workspaceId);
      assert.equal(body.next_cursor, null);
      const completed = body.events.filter(e => e.type === 'analysis_completed');
      assert.equal(completed.length, 1, 'exactly one landed analysis so far');
      assert.equal(completed[0].deltas, undefined, 'first-ever revision has nothing to diff against');
      const created = body.events.find(e => e.type === 'project_created');
      assert.ok(created, 'project_created event must be present');
      assert.equal(created!.project_id, project.id);
    });

    // Second landed analysis on the SAME analysis_id (a real second push, not
    // a fabricated event) — adds a file so nodes/edges genuinely change,
    // giving the delta computation something real to report.
    fs.writeFileSync(path.join(repo, 'more.py'), 'def another():\n    return 2\n\ndef yet_another():\n    return 3\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'add more code']);
    const secondAnalyze = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'activity-fixture', wait: true });
    assert.equal(secondAnalyze.status, 'success');
    assert.equal(secondAnalyze.analysis_id, firstAnalyze.analysis_id, 'sanity: both pushes must land on the same stored analysis_id for this to be a revision history, not two unrelated projects');

    await t.test('after the second analysis, the feed is reverse-chronological with a real node/edge delta on the newer event', async () => {
      const activityRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/activity`, undefined, token);
      assert.equal(activityRes.statusCode, 200);
      const body = JSON.parse(activityRes.body) as { events: Array<{ type: string; at: string; deltas?: { nodes: number; edges: number } }> };
      const completed = body.events.filter(e => e.type === 'analysis_completed');
      assert.equal(completed.length, 2, 'two landed analyses -> two analysis_completed events');
      // Reverse-chronological: every event's `at` must be >= the next one's.
      for (let i = 0; i + 1 < body.events.length; i++) {
        assert.ok(Date.parse(body.events[i].at) >= Date.parse(body.events[i + 1].at), `events must be sorted newest-first (index ${i})`);
      }
      assert.ok(completed[0].deltas, 'the newer analysis has a prior revision to diff against, so it must carry deltas');
      assert.equal(completed[1].deltas, undefined, 'the original (oldest) revision still has nothing to diff against');
    });

    await t.test('the SAME events are reachable account-wide via GET /api/account/activity', async () => {
      const activityRes = await request(port, 'GET', '/api/account/activity', undefined, token);
      assert.equal(activityRes.statusCode, 200);
      const body = JSON.parse(activityRes.body) as { events: Array<{ type: string; workspace_id?: string }> };
      const completed = body.events.filter(e => e.type === 'analysis_completed' && e.workspace_id === workspaceId);
      assert.equal(completed.length, 2);
    });

    await t.test('limit param bounds the number of events returned', async () => {
      const activityRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/activity?limit=1`, undefined, token);
      const body = JSON.parse(activityRes.body) as { events: unknown[] };
      assert.equal(body.events.length, 1);
    });

    await t.test('a non-member is 404\'d, not shown the workspace\'s activity', async () => {
      const outsiderRes = await request(port, 'POST', '/api/auth/register', {
        email: 'activity-outsider@example.com',
        password: 'password-1234',
        workspace_name: 'Outsider Workspace',
      });
      const outsiderToken = JSON.parse(outsiderRes.body).token as string;
      const forbiddenRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/activity`, undefined, outsiderToken);
      assert.equal(forbiddenRes.statusCode, 404);

      // That same fresh account, on its OWN (empty) workspace, gets an
      // honest empty feed — never a fabricated event.
      const outsiderWorkspacesRes = await request(port, 'GET', '/api/workspaces', undefined, outsiderToken);
      const outsiderWorkspaceId = JSON.parse(outsiderWorkspacesRes.body).workspaces[0].id as string;
      const ownActivityRes = await request(port, 'GET', `/api/workspaces/${outsiderWorkspaceId}/activity`, undefined, outsiderToken);
      assert.equal(ownActivityRes.statusCode, 200);
      const ownBody = JSON.parse(ownActivityRes.body) as { events: unknown[] };
      assert.deepEqual(ownBody.events, [], 'a workspace with no projects and no rebuild history has nothing to report');

      const accountActivityRes = await request(port, 'GET', '/api/account/activity', undefined, outsiderToken);
      assert.equal(accountActivityRes.statusCode, 200);
      const accountBody = JSON.parse(accountActivityRes.body) as { events: unknown[] };
      assert.deepEqual(accountBody.events, [], 'an account with no projects anywhere has nothing to report');
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Change Activity: project_moved event appears after attach-to-a-different-workspace, never before', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-activity-move-'));
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
      email: 'move-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Move Home Workspace',
    });
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const homeWorkspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const secondWorkspaceRes = await request(port, 'POST', '/api/workspaces', { name: 'Move Target Workspace' }, token);
    const targetWorkspaceId = JSON.parse(secondWorkspaceRes.body).workspace.id as string;

    const createRes = await request(port, 'POST', `/api/workspaces/${homeWorkspaceId}/projects`, { name: 'movable-project' }, token);
    assert.equal(createRes.statusCode, 201);
    const project = JSON.parse(createRes.body).project as { id: string };

    const beforeMoveRes = await request(port, 'GET', `/api/workspaces/${homeWorkspaceId}/activity`, undefined, token);
    const beforeMoveBody = JSON.parse(beforeMoveRes.body) as { events: Array<{ type: string }> };
    assert.equal(beforeMoveBody.events.some(e => e.type === 'project_moved'), false, 'a project that has never moved must not produce a fabricated project_moved event');

    const attachRes = await request(port, 'POST', `/api/workspaces/${targetWorkspaceId}/projects`, { project_id: project.id }, token);
    assert.equal(attachRes.statusCode, 200);

    const afterMoveRes = await request(port, 'GET', `/api/workspaces/${targetWorkspaceId}/activity`, undefined, token);
    const afterMoveBody = JSON.parse(afterMoveRes.body) as { events: Array<{ type: string; project_id?: string; detail?: string }> };
    const moved = afterMoveBody.events.find(e => e.type === 'project_moved');
    assert.ok(moved, 'moving a project into this workspace must produce a real project_moved event');
    assert.equal(moved!.project_id, project.id);
    assert.match(moved!.detail || '', new RegExp(homeWorkspaceId));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
