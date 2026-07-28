import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';

test('remote analyzer exposes account workspace and project APIs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-remote-accounts-'));
  const server = createRemoteAnalyzerHttpServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const app = await request(address.port, 'GET', '/app');
    assert.equal(app.statusCode, 200);
    assert.equal(JSON.parse(app.body).service, 'klauro-api');

    const created = await requestJson(address.port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Customer Workspace',
    });
    assert.equal(created.statusCode, 201);
    const token = created.json.token as string;
    assert.ok(token.startsWith('ks_'));

    const workspaces = await requestJson(address.port, 'GET', '/api/workspaces', undefined, token);
    assert.equal(workspaces.statusCode, 200);
    assert.equal(workspaces.json.workspaces[0].name, 'Customer Workspace');

    const workspaceId = workspaces.json.workspaces[0].id as string;
    const project = await requestJson(address.port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'Main API',
      repo_url: 'https://github.com/example/main-api',
    }, token);
    assert.equal(project.statusCode, 201);
    assert.equal(project.json.project.name, 'Main API');

    const projects = await requestJson(address.port, 'GET', `/api/workspaces/${workspaceId}/projects`, undefined, token);
    assert.equal(projects.statusCode, 200);
    assert.equal(projects.json.projects.length, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account routes remain usable when analyzer shared token is enabled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-remote-token-accounts-'));
  const server = createRemoteAnalyzerHttpServer({ dataDir: root, token: 'shared-secret' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const unauthorizedAnalyze = await requestJson(address.port, 'POST', '/v1/analyze', { snapshot: { files: [] } });
    assert.equal(unauthorizedAnalyze.statusCode, 401);

    const created = await requestJson(address.port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Token Workspace',
    });
    assert.equal(created.statusCode, 201);

    const me = await requestJson(address.port, 'GET', '/api/me', undefined, created.json.token);
    assert.equal(me.statusCode, 200);
    assert.equal(me.json.user.email, 'owner@example.com');
    assert.equal(me.json.entitlement.status, 'active');

    const oldClient = await requestJson(address.port, 'POST', '/v1/analyze', {
      snapshot: { files: [{ path: 'index.ts', content: 'export {};', hash: 'ignored' }] },
      async: true,
    }, created.json.token);
    assert.equal(oldClient.statusCode, 426);
    assert.equal(oldClient.json.code, 'client_upgrade_required');
    assert.equal(oldClient.json.required_protocol_version, 2);

    const sharedTokenMe = await requestJson(address.port, 'GET', '/api/me', undefined, 'shared-secret');
    assert.equal(sharedTokenMe.statusCode, 200);
    assert.equal(sharedTokenMe.json.user.id, 'shared-token');
    assert.equal(sharedTokenMe.json.entitlement.status, 'active');
    assert.equal(sharedTokenMe.json.entitlement.source, 'shared-analyzer-token');

    const sharedTokenQuery = await requestJson(
      address.port,
      'POST',
      '/api/projects/prj_not_allowed/query',
      { tool: 'get_product_map', args: {} },
      'shared-secret'
    );
    assert.equal(sharedTokenQuery.statusCode, 403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cross-tenant HTTP isolation: account B cannot read account A workspace/project/analysis data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-remote-isolation-'));
  const server = createRemoteAnalyzerHttpServer({ dataDir: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    // Account A creates a workspace + project.
    const a = await requestJson(address.port, 'POST', '/api/auth/register', {
      email: 'tenant-a@example.com',
      password: 'password-1234',
      workspace_name: 'Tenant A Workspace',
    });
    assert.equal(a.statusCode, 201);
    const tokenA = a.json.token as string;

    const workspacesA = await requestJson(address.port, 'GET', '/api/workspaces', undefined, tokenA);
    const workspaceIdA = workspacesA.json.workspaces[0].id as string;

    const projectA = await requestJson(address.port, 'POST', `/api/workspaces/${workspaceIdA}/projects`, {
      name: 'Tenant A Secret Project',
      repo_url: 'https://github.com/tenant-a/secret-repo',
    }, tokenA);
    assert.equal(projectA.statusCode, 201);
    const projectIdA = projectA.json.project.id as string;

    // Account B is a completely separate, unrelated account.
    const b = await requestJson(address.port, 'POST', '/api/auth/register', {
      email: 'tenant-b@example.com',
      password: 'password-1234',
      workspace_name: 'Tenant B Workspace',
    });
    assert.equal(b.statusCode, 201);
    const tokenB = b.json.token as string;

    // B must never see A's workspace in its own list.
    const workspacesB = await requestJson(address.port, 'GET', '/api/workspaces', undefined, tokenB);
    assert.equal(workspacesB.statusCode, 200);
    assert.ok(!workspacesB.json.workspaces.some((w: any) => w.id === workspaceIdA), 'B workspace list must not contain A workspace');

    // B reading A's workspace projects directly by id: must be denied, not empty-allowed.
    const bReadsAWorkspaceProjects = await requestJson(address.port, 'GET', `/api/workspaces/${workspaceIdA}/projects`, undefined, tokenB);
    assert.equal(bReadsAWorkspaceProjects.statusCode, 404);

    // B reading A's workspace analysis endpoint: must be denied.
    const bReadsAWorkspaceAnalysis = await requestJson(address.port, 'GET', `/api/workspaces/${workspaceIdA}/analysis`, undefined, tokenB);
    assert.equal(bReadsAWorkspaceAnalysis.statusCode, 404);

    // B reading A's project directly by id: must be denied.
    const bReadsAProject = await requestJson(address.port, 'GET', `/api/projects/${projectIdA}`, undefined, tokenB);
    assert.equal(bReadsAProject.statusCode, 404);

    // B reading A's project analysis: must be denied.
    const bReadsAProjectAnalysis = await requestJson(address.port, 'GET', `/api/projects/${projectIdA}/analysis`, undefined, tokenB);
    assert.equal(bReadsAProjectAnalysis.statusCode, 404);

    // B reading A's project conceptual data: must be denied.
    const bReadsAProjectConceptual = await requestJson(address.port, 'GET', `/api/projects/${projectIdA}/conceptual`, undefined, tokenB);
    assert.equal(bReadsAProjectConceptual.statusCode, 404);

    const bQueriesAProject = await requestJson(
      address.port,
      'POST',
      `/api/projects/${projectIdA}/query`,
      { tool: 'get_product_map', args: {} },
      tokenB
    );
    assert.equal(bQueriesAProject.statusCode, 404);

    // B triggering reanalyze on A's project: must be denied.
    const bReanalyzesAProject = await requestJson(address.port, 'POST', `/api/projects/${projectIdA}/reanalyze`, {}, tokenB);
    assert.equal(bReanalyzesAProject.statusCode, 404);

    // B's by-remote lookup for A's repo URL must not surface A's project.
    const bByRemote = await requestJson(
      address.port,
      'GET',
      `/api/projects/by-remote?repo_url=${encodeURIComponent('https://github.com/tenant-a/secret-repo')}`,
      undefined,
      tokenB,
    );
    assert.equal(bByRemote.statusCode, 200);
    assert.equal(bByRemote.json.match, null);

    // Same-account, two-workspace isolation: A creates a second workspace;
    // its projects must not appear when listing the first workspace's projects.
    const workspaceA2 = await requestJson(address.port, 'POST', '/api/workspaces', { name: 'Tenant A Workspace 2' }, tokenA);
    assert.equal(workspaceA2.statusCode, 201);
    const workspaceIdA2 = workspaceA2.json.workspace.id as string;

    const projectA2 = await requestJson(address.port, 'POST', `/api/workspaces/${workspaceIdA2}/projects`, {
      name: 'Tenant A Second Workspace Project',
      repo_url: 'https://github.com/tenant-a/other-repo',
    }, tokenA);
    assert.equal(projectA2.statusCode, 201);

    const workspace1Projects = await requestJson(address.port, 'GET', `/api/workspaces/${workspaceIdA}/projects`, undefined, tokenA);
    assert.equal(workspace1Projects.statusCode, 200);
    assert.equal(workspace1Projects.json.projects.length, 1);
    assert.equal(workspace1Projects.json.projects[0].name, 'Tenant A Secret Project');

    const workspace2Projects = await requestJson(address.port, 'GET', `/api/workspaces/${workspaceIdA2}/projects`, undefined, tokenA);
    assert.equal(workspace2Projects.statusCode, 200);
    assert.equal(workspace2Projects.json.projects.length, 1);
    assert.equal(workspace2Projects.json.projects[0].name, 'Tenant A Second Workspace Project');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
