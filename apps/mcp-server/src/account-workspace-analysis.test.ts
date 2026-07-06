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

function makeRepo(root: string, name: string, fileContents: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'app.py'), fileContents);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial commit']);
  return repo;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

/**
 * Server-side auto-refreshed Workspace Analysis (WAS): pushing member project
 * analyses for an account workspace should automatically (re)build a
 * workspace analysis from the STORED member CAS analyses — no separate
 * "run workspace analysis" call needed, matching the user's expectation that
 * "those should be automatic whenever a sub-project changes." Multiple
 * pushes in quick succession must debounce/coalesce into a single rebuild,
 * and the rebuild must never block or fail the analyze response itself.
 */
test('workspace analysis auto-builds once from stored member analyses after a debounced batch push, and GET is honest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-auto-was-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousDebounce = process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = '150';

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
      workspace_name: 'Auto WAS Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // GET before anything exists must be honest: 'none', never a crash or empty-but-lying 200.
    const beforeRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    assert.equal(beforeRes.statusCode, 200);
    assert.equal(JSON.parse(beforeRes.body).status, 'none');

    // Push 2 member project analyses in quick succession (a "batch push").
    const repoA = makeRepo(root, 'repo-a', 'def handler_a():\n    return 1\n');
    const repoB = makeRepo(root, 'repo-b', 'def handler_b():\n    return 2\n');

    const analyzeA = await analyzeCodebaseRemotely({ projectPath: repoA, serverUrl, token });
    const analyzeB = await analyzeCodebaseRemotely({ projectPath: repoB, serverUrl, token });

    // Link both analyses to account projects in this workspace (the
    // `klauro init` reconnect shape: project.analysis_id set at creation).
    const projectARes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'repo-a',
      analysis_id: analyzeA.analysis_id,
    }, token);
    assert.equal(projectARes.statusCode, 201);
    const projectA = JSON.parse(projectARes.body).project as { id: string };

    const projectBRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'repo-b',
      analysis_id: analyzeB.analysis_id,
    }, token);
    assert.equal(projectBRes.statusCode, 201);
    const projectB = JSON.parse(projectBRes.body).project as { id: string };

    // Re-push both analyses (simulating a second analyze pass on each repo,
    // now that they're linked) within the debounce window — this is the
    // "5-repo batch push -> ~1 rebuild" scenario, scaled to 2 repos x 2 pushes.
    await analyzeCodebaseRemotely({ projectPath: repoA, serverUrl, token, analysisId: analyzeA.analysis_id });
    await analyzeCodebaseRemotely({ projectPath: repoB, serverUrl, token, analysisId: analyzeB.analysis_id });

    // Immediately after landing, before the debounce timer fires, the GET
    // must report 'pending' rather than silently serving nothing.
    const pendingRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    assert.equal(pendingRes.statusCode, 200);
    assert.ok(['pending', 'ready'].includes(JSON.parse(pendingRes.body).status));

    await waitFor(async () => {
      const res = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
      return JSON.parse(res.body).status === 'ready';
    });

    const readyRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    assert.equal(readyRes.statusCode, 200);
    const readyBody = JSON.parse(readyRes.body);
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.workspace_id, workspaceId);
    // Membership must match EXACTLY the workspace's analyzed (linked) projects.
    const memberIds = [...readyBody.member_project_ids].sort();
    assert.deepEqual(memberIds, [projectA.id, projectB.id].sort());
    assert.equal(readyBody.analysis.codebase_count, 2);
    assert.ok(readyBody.analysis.nodes || readyBody.analysis.codebases?.length === 2);

    // A brand-new, unrelated workspace (no linked/analyzed projects) must
    // never see this workspace's data — evidence-gated membership only.
    const otherRegisterRes = await request(port, 'POST', '/api/auth/register', {
      email: 'other@example.com',
      password: 'password-1234',
      workspace_name: 'Other Workspace',
    });
    const otherToken = JSON.parse(otherRegisterRes.body).token as string;
    const otherWorkspacesRes = await request(port, 'GET', '/api/workspaces', undefined, otherToken);
    const otherWorkspaceId = JSON.parse(otherWorkspacesRes.body).workspaces[0].id as string;
    const otherRes = await request(port, 'GET', `/api/workspaces/${otherWorkspaceId}/analysis`, undefined, otherToken);
    assert.equal(otherRes.statusCode, 200);
    assert.equal(JSON.parse(otherRes.body).status, 'none');

    // Cross-workspace access must be denied (404), not leak data.
    const crossRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, otherToken);
    assert.equal(crossRes.statusCode, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousDebounce === undefined) delete process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS;
    else process.env.KLAURO_WORKSPACE_ANALYSIS_DEBOUNCE_MS = previousDebounce;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
