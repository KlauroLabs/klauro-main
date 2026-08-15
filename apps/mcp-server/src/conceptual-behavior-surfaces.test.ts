import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';
import { getAnalysis } from './analyzer';

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

test('conceptual endpoint exposes behavior_surfaces so flow capability_relationships resolve', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-surfaces-conceptual-'));
  const repo = path.join(root, 'repo');
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  fs.mkdirSync(repo, { recursive: true });

  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const toolNames = [
    'get_summary',
    'get_call_chain',
    'search_nodes',
    'semantic_search',
    'analyze_codebase',
    'get_route_table',
    'get_entry_points',
    'get_data_entities',
    'assess_change_risk',
    'plan_parallel_work',
    'get_coding_context',
    'get_erd',
  ];
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'surfaces-fixture',
    version: '1.0.0',
    dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
  }));
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "const server = new McpServer({ name: 'fixture', version: '1.0.0' });",
    'async function handleTool() {',
    "  return { content: [{ type: 'text', text: 'complete' }] };",
    '}',
    ...toolNames.map(name => `server.registerTool('${name}', { description: '${name}', inputSchema: {} }, handleTool);`),
    '',
  ].join('\n'));
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
      email: 'surfaces-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Surfaces Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const analyzeResult = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true });
    assert.equal(analyzeResult.status, 'success');
    const createRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'surfaces-fixture',
      analysis_id: analyzeResult.analysis_id,
    }, token);
    assert.equal(createRes.statusCode, 201);
    const project = JSON.parse(createRes.body).project as { id: string; analysis_id?: string };
    assert.ok(project.analysis_id, 'authenticated project response should expose its attached analysis');

    // Project creation returns the account-scoped storage ID for the authorized attachment.
    const workspace = path.join(remoteData, 'workspaces', project.analysis_id);
    const cas = await getAnalysis(workspace);
    const toolEntryPoint = cas.entry_points?.find(entryPoint => entryPoint.name === 'get_summary');
    assert.ok(toolEntryPoint);
    const storedSurface = cas.behavior_surfaces?.find(surface =>
      surface.operations.some(operation => operation.entry_point_id === toolEntryPoint.id)
    );
    assert.ok(storedSurface);

    // max_flows high enough to include the flow the fabricated surface anchors on.
    const res = await request(port, 'GET', `/api/projects/${project.id}/conceptual?max_flows=50`, undefined, token);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ready');

    assert.ok(Array.isArray(body.behavior_surfaces));
    const mcpSurface = body.behavior_surfaces.find((surface: any) => surface.id === storedSurface.id);
    assert.ok(mcpSurface);
    assert.equal(mcpSurface.evidence_kind, 'behavior-surface');
    const knownIds = new Set<string>([
      ...body.capabilities.map((c: any) => c.id),
      ...body.behavior_surfaces.map((s: any) => s.id),
    ]);
    const flows = body.flows?.flows || [];
    assert.ok(flows.length > 0, 'expected at least one derived flow');
    let sawSurfaceRef = false;
    for (const flow of flows) {
      for (const rel of flow.capability_relationships || []) {
        assert.ok(
          knownIds.has(rel.capability_id),
          `flow ${flow.flow_id} references capability_id ${rel.capability_id}, which resolves against neither capabilities nor behavior_surfaces`
        );
        if (rel.capability_id === mcpSurface.id) sawSurfaceRef = true;
      }
    }
    assert.ok(sawSurfaceRef, 'expected at least one flow to relate to the mcp-tool surface directly');

    assert.ok(mcpSurface.related_flows.length > 0, 'surface must carry the flows that reference it');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
