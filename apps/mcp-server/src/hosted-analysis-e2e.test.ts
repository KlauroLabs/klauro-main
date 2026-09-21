import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { clearHostedAnalysisCaches, resolveBoundAnalysis, resolveHostedProjectBinding } from './hosted-analysis';
import { loadAnalysis, saveAnalysis } from './storage';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

/**
 * End-to-end proof of hosted segmented CAS access through the REAL
 * analyzer service (the fix for the 2026-07-14 truckspy audit): a repo bound
 * to a hosted prj_ project, whose analysis lives ONLY on the server, must be
 * served to MCP read tools by hydrating only requested sections — never by
 * silently running a local analysis and never by mirroring the full graph.
 */

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function hostedFixture(timestamp = '2026-07-22T00:00:00.000Z'): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_id: 'hosted-e2e-analysis',
    analysis_timestamp: timestamp,
    system: { id: 'system-e2e', name: 'hosted-e2e', type: 'application', technologies: { languages: [], frameworks: [] } },
    nodes: [{ id: 'node-handler', name: 'handler', type: 'function', level: 1, source: { file: 'app.py', line: 1 } }],
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [],
    progressive_levels: [],
    layers_ready: { complete: true, generated_at: timestamp, layers: [] },
  } as unknown as CASOutput;
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

test('bound repo with server-only analysis: MCP hydrates graph sections without replacing local state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-hosted-e2e-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousToken = process.env.KLAURO_ACCOUNT_TOKEN;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    // Account + project (the web-app flow), then a repo bound via .klaurorc.
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'owner@example.com',
      password: 'password-1234',
      workspace_name: 'Hosted E2E Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;
    const projectRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'hosted-e2e-repo',
      repo_url: 'https://github.com/example/hosted-e2e-repo',
      analysis_id: 'hosted-e2e-analysis',
    }, token);
    const project = JSON.parse(projectRes.body).project as { id: string; analysis_id: string };
    assert.match(project.id, /^prj_/);

    const repo = path.join(root, 'hosted-e2e-repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'app.py'), 'def handler():\n    return 1\n');
    fs.writeFileSync(path.join(repo, '.klaurorc'), JSON.stringify({
      version: 1,
      project: { id: project.id, name: 'hosted-e2e-repo' },
      analyzer: { serverUrl },
    }, null, 2));
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial commit']);

    // Persist the hosted source of truth directly; this E2E proves storage and
    // query transport, not the independently-tested analysis scheduler.
    process.env.KLAURO_STORAGE_PATH = path.join(root, 'shared-store');
    const serverWorkspace = path.join(remoteData, 'workspaces', project.analysis_id);
    await saveAnalysis(serverWorkspace, hostedFixture());

    // Recreate the audit's STALE-CACHE condition: overwrite the client-side
    // local entry for this repo with a doctored July-4 copy of the CAS, so the
    // local cache is older than the hosted analysis.
    const localAfterPush = await loadAnalysis(serverWorkspace);
    assert.ok(localAfterPush, 'hosted analysis is persisted on the service');
    const staleTimestamp = '2026-07-04T19:14:18.863Z';
    await saveAnalysis(repo, { ...localAfterPush!, analysis_timestamp: staleTimestamp });
    process.env.KLAURO_ACCOUNT_TOKEN = token;
    clearHostedAnalysisCaches();

    const binding = await resolveHostedProjectBinding(repo);
    assert.ok(binding, 'repo must resolve as project-bound');
    assert.equal(binding!.projectId, project.id);

    // Stale local cache must lose to section hydration without being overwritten.
    const resolution = await resolveBoundAnalysis(binding!, { sections: ['graph'] });
    assert.equal(resolution.source, 'hosted');
    assert.ok(resolution.cas.nodes.length > 0, 'downloaded hosted CAS carries real nodes');
    assert.equal(resolution.cas.analysis_timestamp, resolution.hosted_timestamp);
    assert.notEqual(resolution.cas.analysis_timestamp, staleTimestamp);

    // The local entry remains stale; repeated reads are served by the bounded section cache.
    const mirrored = await loadAnalysis(repo);
    assert.equal(mirrored?.analysis_timestamp, staleTimestamp);
    const second = await resolveBoundAnalysis(binding!, { sections: ['graph'] });
    assert.equal(second.source, 'hosted');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousToken === undefined) delete process.env.KLAURO_ACCOUNT_TOKEN;
    else process.env.KLAURO_ACCOUNT_TOKEN = previousToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A background analysis that CRASHES must be a VISIBLE terminal state, not an
 * infinite "populating".
 *
 * Real incident (2026-07-16): a torn deploy made every hosted analyze/reanalyze
 * die with a ReferenceError. The async catch only console.error'd, so the
 * persisted L0 CAS kept L1..L5 'pending' — and the state endpoint reports
 * 'populating' while ANY layer is pending. Result: status sat "populating"
 * FOREVER with errors:0 while 100% of analyses were broken. This is the twin of
 * the L5 precedent (l5-enrichment-regression.test.ts): a failure must surface.
 */
test('a background analysis that crashed reports status=failed with the reason (never populating forever)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-failed-status-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'shared-store');

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'failed@example.com', password: 'password-1234', workspace_name: 'Failed WS',
    });
    const token = JSON.parse(registerRes.body).token as string;
    const workspaceId = JSON.parse((await request(port, 'GET', '/api/workspaces', undefined, token)).body).workspaces[0].id as string;
    const projectRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'crashed-repo', repo_url: 'https://github.com/example/crashed-repo', analysis_id: 'crashed-e2e-analysis',
    }, token);
    const project = JSON.parse(projectRes.body).project as { id: string; analysis_id: string };

    const repo = path.join(root, 'crashed-repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'app.py'), 'def handler():\n    return 1\n');
    fs.writeFileSync(path.join(repo, '.klaurorc'), JSON.stringify({
      version: 1, project: { id: project.id, name: 'crashed-repo' }, analyzer: { serverUrl },
    }, null, 2));
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'initial commit']);
    const serverWorkspace = path.join(remoteData, 'workspaces', project.analysis_id);
    await saveAnalysis(serverWorkspace, hostedFixture());

    // Reproduce what markBackgroundAnalysisFailed persists when the background
    // analysis throws: the still-pending structural layers flip to 'error'.
    const stored = await loadAnalysis(serverWorkspace);
    assert.ok(stored, 'hosted CAS must exist after push');
    stored!.layers_ready = {
      complete: false,
      generated_at: new Date().toISOString(),
      layers: [
        { layer: 'L0', name: 'Index / inventory', status: 'ready', fields: ['l0_index'] },
        { layer: 'L1', name: 'Nodes, entry points, routes', status: 'error', error: 'ReferenceError: someSymbol is not defined', fields: ['nodes'] },
        { layer: 'L5', name: 'interpretation', status: 'error', error: 'boom', fields: ['enhanced_system_purpose'] },
      ],
    } as never;
    await saveAnalysis(serverWorkspace, stored!);

    const stateRes = await request(port, 'GET', `/api/projects/${encodeURIComponent(project.id)}/analysis`, undefined, token);
    const state = JSON.parse(stateRes.body) as { status?: string; analysis_error?: string; failed_layers?: string[]; product_map?: unknown };
    assert.equal(state.status, 'failed', 'a crashed structural layer must report failed, NOT populating/ready');
    assert.match(String(state.analysis_error), /ReferenceError/, 'the failure reason must be surfaced to the caller');
    assert.deepEqual(state.failed_layers, ['L1'], 'the failed structural layer must be named (L5 is comprehension-only)');
    assert.equal(state.product_map, undefined, 'failed analysis responses must not leak a partial product map to older installed clients');

    const queryRes = await request(port, 'POST', `/api/projects/${encodeURIComponent(project.id)}/query`, {
      tool: 'run_answer_pack', args: {},
    }, token);
    const query = JSON.parse(queryRes.body) as { status?: string; result?: { status?: string }; error?: string };
    assert.equal(query.status, 'failed');
    assert.equal(query.result?.status, 'failed', 'failed queries must remain serializable for published clients that unwrap result');
    assert.match(String(query.error), /boom/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
