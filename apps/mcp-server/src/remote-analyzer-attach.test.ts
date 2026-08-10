import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';

// The attach flow runs full analysis rebuilds (AccountWorkspaceAnalysisScheduler
// -> enrichWorkspaceAnalysisNarrative), which lazily connects the process-wide
// `aiService` singleton to Redis (packages/analyzer-core/src/ai/ai-cache.ts) the
// first time it's touched. That connection is a deliberate long-lived resource
// for a real server process, so the product only tears it down via the
// explicit aiService.close() API (never automatically) — nothing else in this
// test's HTTP-server-per-test teardown reaches it, so without this the ioredis
// socket keeps the process alive forever after the last subtest finishes.
after(async () => {
  await aiService.close();
});

/**
 * §THE-SEAM — covers the fix in remote-analyzer-service.ts
 * (linkAnalysisToAccountProject): a `klauro analyze` push must attach its
 * landed analysis to the account project record it belongs to, evidence-
 * gated, so the web app stops showing "Analysis: Not run" after a
 * successful push. See also account-workspace-analysis.test.ts for the
 * pre-existing (project-created-with-analysis_id-at-creation) shape this
 * complements — this file covers the NEW auto-attach-on-push path.
 */

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function makeRepo(root: string, name: string, fileContents: string, remoteUrl?: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'app.py'), fileContents);
  if (remoteUrl) git(repo, ['remote', 'add', 'origin', remoteUrl]);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial commit']);
  return repo;
}

function writeKlaurorc(repo: string, projectId: string): void {
  fs.writeFileSync(path.join(repo, '.klaurorc'), JSON.stringify({
    version: 1,
    project: { id: projectId, name: path.basename(repo) },
  }, null, 2));
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

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

async function withServer(fn: (ctx: { port: number; serverUrl: string; remoteData: string }) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-analysis-attach-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as { port: number }).port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    await fn({ port, serverUrl, remoteData });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('klauro analyze auto-attaches to the bound account project (.klaurorc project.id), and re-push updates the same analysis', async () => {
  await withServer(async ({ port, serverUrl, remoteData }) => {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Attach Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // Project created FIRST (web app flow), no analysis_id yet — this is the
    // "Analysis: Not run" state the seam describes.
    const projectRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'bound-repo',
      repo_url: 'https://github.com/example/bound-repo',
    }, token);
    assert.equal(projectRes.statusCode, 201);
    const project = JSON.parse(projectRes.body).project as { id: string; analysis_id?: string };
    assert.equal(project.analysis_id, undefined);

    const root = path.dirname(remoteData);
    const repo = makeRepo(root, 'bound-repo', 'def handler():\n    return 1\n', 'https://github.com/example/bound-repo');
    // Simulate `klauro init` having bound this repo to the project via .klaurorc.
    writeKlaurorc(repo, project.id);

    const first = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true });
    assert.equal(first.status, 'success');
    // Stable analysis_id: since project_id is bound, it IS the account project id.
    assert.equal(first.analysis_id, project.id);

    const projectsAfterFirst = await request(port, 'GET', `/api/workspaces/${workspaceId}/projects`, undefined, token);
    const afterFirst = JSON.parse(projectsAfterFirst.body).projects.find((p: { id: string }) => p.id === project.id);
    assert.equal(afterFirst.analysis_id, first.analysis_id);

    // Re-push (simulating a second `klauro analyze`, e.g. after further commits,
    // possibly from a different checkout path) must reuse the SAME analysis_id
    // rather than orphaning a new one.
    fs.appendFileSync(path.join(repo, 'app.py'), '\ndef handler_two():\n    return 2\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'second commit']);
    const second = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true });
    assert.equal(second.analysis_id, first.analysis_id);

    const projectsAfterSecond = await request(port, 'GET', `/api/workspaces/${workspaceId}/projects`, undefined, token);
    const afterSecond = JSON.parse(projectsAfterSecond.body).projects.find((p: { id: string }) => p.id === project.id);
    assert.equal(afterSecond.analysis_id, first.analysis_id);

    // Coordination with auto-rebuilt workspace-level CAS: attaching should mark the workspace dirty
    // for a rebuild (account-workspace-analysis.ts hooks analysis_id->project
    // resolution — findProjectsByAnalysisId — which only works once attached).
    await waitFor(async () => {
      const res = await request(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
      return JSON.parse(res.body).status === 'ready';
    });
  });
});

test('klauro analyze does not attach an unbound repo push to any project (no .klaurorc binding, no matching remote)', async () => {
  await withServer(async ({ port, serverUrl, remoteData }) => {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Foreign Workspace',
    });
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // A project exists in the account, but this repo is unrelated to it.
    await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'unrelated-project',
      repo_url: 'https://github.com/example/unrelated-project',
    }, token);

    const root = path.dirname(remoteData);
    const repo = makeRepo(root, 'foreign-repo', 'def handler():\n    return 1\n', 'https://github.com/example/completely-different-repo');
    // No .klaurorc project binding — resolveAnalysisId falls back to the
    // sha256-of-path analysisId, which never has a prj_ prefix.
    const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true });
    assert.equal(result.status, 'success');
    assert.doesNotMatch(result.analysis_id, /^prj_/);

    const projectsRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/projects`, undefined, token);
    const projects = JSON.parse(projectsRes.body).projects as Array<{ analysis_id?: string }>;
    assert.ok(projects.every(p => p.analysis_id === undefined));
  });
});

test('klauro analyze auto-attaches by matching git remote when no .klaurorc binding exists, but only when the match is unambiguous', async () => {
  await withServer(async ({ port, serverUrl, remoteData }) => {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Remote Match Workspace',
    });
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const projectRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'remote-matched-repo',
      repo_url: 'https://github.com/example/remote-matched-repo',
    }, token);
    const project = JSON.parse(projectRes.body).project as { id: string };

    const root = path.dirname(remoteData);
    // No .klaurorc written — the repo only carries the git remote as evidence.
    const repo = makeRepo(root, 'remote-matched-repo', 'def handler():\n    return 1\n', 'git@github.com:example/remote-matched-repo.git');

    const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true });
    assert.equal(result.status, 'success');

    const projectsRes = await request(port, 'GET', `/api/workspaces/${workspaceId}/projects`, undefined, token);
    const matched = JSON.parse(projectsRes.body).projects.find((p: { id: string }) => p.id === project.id) as { analysis_id?: string };
    assert.match(matched.analysis_id || '', /^acct_/);
    assert.notEqual(matched.analysis_id, result.analysis_id);

    // Ambiguous case: a second project shares the same normalized remote —
    // a FRESH repo pushed against that same remote must not guess between them.
    await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'remote-matched-repo-duplicate',
      repo_url: 'https://github.com/example/remote-matched-repo',
    }, token);

    const repo2 = makeRepo(root, 'remote-matched-repo-2', 'def handler_other():\n    return 2\n', 'git@github.com:example/remote-matched-repo.git');
    const result2 = await analyzeCodebaseRemotely({ projectPath: repo2, serverUrl, token, wait: true });
    assert.equal(result2.status, 'success');

    const projectsAfterAmbiguous = await request(port, 'GET', `/api/workspaces/${workspaceId}/projects`, undefined, token);
    const allProjects = JSON.parse(projectsAfterAmbiguous.body).projects as Array<{ id: string; analysis_id?: string }>;
    // Neither of the two same-remote projects should have picked up result2's
    // analysis_id — ambiguous matches must never attach.
    assert.ok(allProjects.every(p => p.analysis_id !== result2.analysis_id));
  });
});
