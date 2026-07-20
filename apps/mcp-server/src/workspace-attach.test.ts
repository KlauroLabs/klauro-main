import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';

/**
 * Task #64: close the workspace-composition gap. AccountProject.workspace_id
 * is a single required foreign key (account-store.ts), not a join table, so
 * "attach an already-analyzed project to another workspace" is necessarily a
 * MOVE — these tests pin that semantics down at the HTTP layer:
 * POST /api/workspaces/{id}/projects with { project_id } instead of { name }.
 */

test('workspace attach: happy path moves a project and schedules a WAS rebuild for both workspaces', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-workspace-attach-'));
  const server = createRemoteAnalyzerHttpServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  try {
    const registered = await requestJson(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Workspace One',
    });
    assert.equal(registered.statusCode, 201);
    const token = registered.json.token as string;
    const workspaceOneId = (await requestJson(port, 'GET', '/api/workspaces', undefined, token)).json.workspaces[0].id as string;

    const workspaceTwo = await requestJson(port, 'POST', '/api/workspaces', { name: 'Workspace Two' }, token);
    assert.equal(workspaceTwo.statusCode, 201);
    const workspaceTwoId = workspaceTwo.json.workspace.id as string;

    const project = await requestJson(port, 'POST', `/api/workspaces/${workspaceOneId}/projects`, {
      name: 'Movable Project',
      repo_url: 'https://github.com/example/movable',
    }, token);
    assert.equal(project.statusCode, 201);
    const projectId = project.json.project.id as string;

    const attach = await requestJson(port, 'POST', `/api/workspaces/${workspaceTwoId}/projects`, { project_id: projectId }, token);
    assert.equal(attach.statusCode, 200);
    assert.equal(attach.json.attached, true);
    assert.equal(attach.json.already_attached, false);
    assert.equal(attach.json.semantics, 'move');
    assert.equal(attach.json.moved_from_workspace_id, workspaceOneId);
    assert.equal(attach.json.was_rebuild, 'scheduled');
    assert.equal(attach.json.project.workspace_id, workspaceTwoId);

    // The project is gone from workspace one and present in workspace two.
    const workspaceOneProjects = await requestJson(port, 'GET', `/api/workspaces/${workspaceOneId}/projects`, undefined, token);
    assert.equal(workspaceOneProjects.json.projects.length, 0);
    const workspaceTwoProjects = await requestJson(port, 'GET', `/api/workspaces/${workspaceTwoId}/projects`, undefined, token);
    assert.equal(workspaceTwoProjects.json.projects.length, 1);
    assert.equal(workspaceTwoProjects.json.projects[0].id, projectId);

    // Rebuild scheduling is asserted via the same last-attempt sidecar
    // mechanism the reanalyze route already uses — poll for the attempt
    // record to appear rather than sleeping a fixed guess.
    await assertAttemptRecorded(port, token, workspaceTwoId);
    await assertAttemptRecorded(port, token, workspaceOneId);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace attach: idempotent re-attach is a no-op with no rebuild scheduled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-workspace-attach-idempotent-'));
  const server = createRemoteAnalyzerHttpServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  try {
    const registered = await requestJson(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Solo Workspace',
    });
    const token = registered.json.token as string;
    const workspaceId = (await requestJson(port, 'GET', '/api/workspaces', undefined, token)).json.workspaces[0].id as string;

    const project = await requestJson(port, 'POST', `/api/workspaces/${workspaceId}/projects`, { name: 'Already Here' }, token);
    const projectId = project.json.project.id as string;

    const attach = await requestJson(port, 'POST', `/api/workspaces/${workspaceId}/projects`, { project_id: projectId }, token);
    assert.equal(attach.statusCode, 200);
    assert.equal(attach.json.attached, true);
    assert.equal(attach.json.already_attached, true);
    assert.equal(attach.json.was_rebuild, 'unchanged');
    assert.equal(attach.json.moved_from_workspace_id, undefined, 'no move happened, so no moved_from_workspace_id');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace attach: cross-account attach is denied 404, not a distinguishing 403', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-workspace-attach-cross-account-'));
  const server = createRemoteAnalyzerHttpServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  try {
    const a = await requestJson(port, 'POST', '/api/auth/register', {
      email: 'tenant-a@example.com',
      password: 'password-1234',
      workspace_name: 'Tenant A Workspace',
    });
    const tokenA = a.json.token as string;
    const workspaceIdA = (await requestJson(port, 'GET', '/api/workspaces', undefined, tokenA)).json.workspaces[0].id as string;
    const projectA = await requestJson(port, 'POST', `/api/workspaces/${workspaceIdA}/projects`, { name: 'Tenant A Project' }, tokenA);
    const projectIdA = projectA.json.project.id as string;

    const b = await requestJson(port, 'POST', '/api/auth/register', {
      email: 'tenant-b@example.com',
      password: 'password-1234',
      workspace_name: 'Tenant B Workspace',
    });
    const tokenB = b.json.token as string;
    const workspaceIdB = (await requestJson(port, 'GET', '/api/workspaces', undefined, tokenB)).json.workspaces[0].id as string;

    // B tries to attach A's project into B's own workspace: B is not a member
    // of A's (the project's current) workspace, so this must 404 — the same
    // requireMembership-throws-404 gate used everywhere else, not a
    // distinguishing 403 that would leak the project's existence to B.
    const bAttachesAProject = await requestJson(port, 'POST', `/api/workspaces/${workspaceIdB}/projects`, { project_id: projectIdA }, tokenB);
    assert.equal(bAttachesAProject.statusCode, 404);

    // A tries to attach A's own project into B's workspace: A is not a member
    // of B's (the target) workspace, so this must also 404.
    const aAttachesIntoBWorkspace = await requestJson(port, 'POST', `/api/workspaces/${workspaceIdB}/projects`, { project_id: projectIdA }, tokenA);
    assert.equal(aAttachesIntoBWorkspace.statusCode, 404);

    // Project must be untouched by either rejected attempt.
    const stillInA = await requestJson(port, 'GET', `/api/workspaces/${workspaceIdA}/projects`, undefined, tokenA);
    assert.equal(stillInA.json.projects.length, 1);
    assert.equal(stillInA.json.projects[0].id, projectIdA);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace attach: attaching a nonexistent project 404s', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-workspace-attach-missing-project-'));
  const server = createRemoteAnalyzerHttpServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  try {
    const registered = await requestJson(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Only Workspace',
    });
    const token = registered.json.token as string;
    const workspaceId = (await requestJson(port, 'GET', '/api/workspaces', undefined, token)).json.workspaces[0].id as string;

    const attach = await requestJson(port, 'POST', `/api/workspaces/${workspaceId}/projects`, { project_id: 'prj_does-not-exist' }, token);
    assert.equal(attach.statusCode, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function assertAttemptRecorded(port: number, token: string, workspaceId: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const analysisRes = await requestJson(port, 'GET', `/api/workspaces/${workspaceId}/analysis`, undefined, token);
    if (analysisRes.json.last_attempt) return;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`no last_attempt ever appeared for workspace ${workspaceId} — the attach did not schedule a WAS rebuild`);
}

async function requestJson(port: number, method: string, route: string, body?: unknown, token?: string): Promise<{ statusCode: number; json: any; body: string }> {
  const result = await request(port, method, route, body === undefined ? undefined : JSON.stringify(body), {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  return {
    statusCode: result.statusCode,
    body: result.body,
    json: result.body ? JSON.parse(result.body) : {},
  };
}

async function request(port: number, method: string, route: string, body?: string, headers: Record<string, string> = {}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
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
    request.end(body);
  });
}
