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

    const sharedTokenMe = await requestJson(address.port, 'GET', '/api/me', undefined, 'shared-secret');
    assert.equal(sharedTokenMe.statusCode, 200);
    assert.equal(sharedTokenMe.json.user.id, 'shared-token');
    assert.equal(sharedTokenMe.json.entitlement.status, 'active');
    assert.equal(sharedTokenMe.json.entitlement.source, 'shared-analyzer-token');
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
