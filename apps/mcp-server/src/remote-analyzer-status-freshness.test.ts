/**
 * REGRESSION GATE — task #129: `klauro status` (and the hosted `get_summary`
 * fast path) reported a stale, foreign-looking analysis as "fresh" while a
 * NEW analysis for the same project was actively in flight.
 *
 * Root cause: GET /api/projects/:id/analysis-status and GET
 * /api/projects/:id/analysis both key their read off `project.analysis_id`
 * (a workspace directory on disk) and compute `status`/freshness purely from
 * whatever CAS entry is already landed there — with no check for whether a
 * NEWER attempt is actively overwriting that same workspace right now. A
 * push accepted via POST /v1/analyze writes `last_attempt.state:
 * 'in-progress'` to the workspace's sidecar the moment it is accepted, well
 * before the CAS itself lands (see startAttemptHeartbeat / the reanalyze
 * accept path) — so `last_attempt.state === 'in-progress'` is exactly the
 * signal these two routes were ignoring in favor of the last LANDED entry.
 *
 * This test drives the real HTTP surface (no engine imports): accept an
 * analysis for a project, let it land, then simulate a second push that has
 * been ACCEPTED (attempt record written 'in-progress') but has not yet
 * overwritten the CAS — and asserts that a poll during that window reports
 * 'populating', never the previous run's 'ready'/fresh summary.
 */

import { compactSubCasNodes } from './hosted-summary-compaction';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';
import { loadAnalysisSectionManifest } from './storage';
import { withHostedBackgroundPermit } from './hosted-background-queue';

function soleWorkspace(remoteData: string): string {
  const dir = path.join(remoteData, 'workspaces');
  const entries = fs.readdirSync(dir).filter(name => !name.startsWith('.'));
  assert.equal(entries.length, 1, `expected exactly one workspace, got ${entries.join(', ')}`);
  return path.join(dir, entries[0]);
}

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

test('status never reports a stale analysis as fresh while a new attempt is in flight', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-status-freshness-'));
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
      workspace_name: 'Status Freshness Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const analyzed = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'status-freshness-fixture', wait: true, readinessRequirement: 'structural' });
    assert.equal(analyzed.status, 'success');

    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'status-freshness-fixture',
      analysis_id: analyzed.analysis_id,
    }, token);
    const project = JSON.parse(linkRes.body).project as { id: string };

    const workspace = soleWorkspace(remoteData);
    const degradedStatus = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis-status`, undefined, token)).body);
    assert.equal(degradedStatus.status, 'degraded');
    const degradedAnalysis = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token)).body);
    assert.equal(degradedAnalysis.status, 'degraded', JSON.stringify(degradedAnalysis));
    assert.equal(degradedAnalysis.summary.nodes, degradedStatus.summary.node_count);
    assert.equal(degradedAnalysis.summary.edges, degradedStatus.summary.edge_count);
    const manifest = await loadAnalysisSectionManifest(workspace);
    if (manifest?.tree_projection?.format === 'recursive-cas-section-references') {
      assert.deepEqual(degradedAnalysis.summary.sub_cas_nodes, compactSubCasNodes(manifest.tree_projection.sub_cas_nodes!));
    }

    const queryStarted = path.join(root, 'query-started');
    const queryRelease = path.join(root, 'query-release');
    const queryWorker = path.join(root, 'query-worker.cjs');
    fs.writeFileSync(queryWorker, `
const fs = require('node:fs');
process.on('message', request => {
  fs.writeFileSync(${JSON.stringify(queryStarted)}, 'started');
  const wait = () => {
    if (!fs.existsSync(${JSON.stringify(queryRelease)})) return setTimeout(wait, 5);
    process.send({ type: 'result', id: request.id, analysisTimestamp: 'stale', result: { stale: true } });
  };
  wait();
});
`);
    const previousSearchWorker = process.env.KLAURO_HOSTED_SEARCH_WORKER_ENTRY;
    process.env.KLAURO_HOSTED_SEARCH_WORKER_ENTRY = queryWorker;
    const attemptRecordPath = path.join(workspace, '.reanalyze-attempt.json');
    const originalAttempt = fs.readFileSync(attemptRecordPath, 'utf8');
    try {
      const queryPromise = request(port, 'POST', `/api/projects/${project.id}/query`, {
        tool: 'search_nodes',
        args: { query: 'handler' },
      }, token);
      for (let attempt = 0; attempt < 200 && !fs.existsSync(queryStarted); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(fs.existsSync(queryStarted), true, 'the query must reach the worker before the attempt transition');
      fs.writeFileSync(attemptRecordPath, JSON.stringify({
        state: 'in-progress',
        trigger: 'analyze',
        analysis_revision: 20,
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      }));
      fs.writeFileSync(queryRelease, 'release');
      const fencedQuery = JSON.parse((await queryPromise).body);
      assert.equal(fencedQuery.status, 'populating', 'a query cannot publish a stale result after a newer attempt starts');
      assert.equal(fencedQuery.last_attempt?.analysis_revision, 20);
    } finally {
      fs.writeFileSync(attemptRecordPath, originalAttempt);
      await withHostedBackgroundPermit(async () => undefined, { releaseForegroundMemory: true });
      if (previousSearchWorker === undefined) delete process.env.KLAURO_HOSTED_SEARCH_WORKER_ENTRY;
      else process.env.KLAURO_HOSTED_SEARCH_WORKER_ENTRY = previousSearchWorker;
    }

    // Simulate a SECOND push that has been accepted (its attempt record is
    // 'in-progress') but has not yet overwritten the CAS on disk — the exact
    // window observed live where `klauro status` reported the FIRST run as
    // fresh. Write the sidecar directly rather than reaching into the
    // running server's in-memory state (this repo's own gate: tests only
    // drive the real HTTP surface, not engine internals).
    fs.writeFileSync(attemptRecordPath, JSON.stringify({
      state: 'in-progress',
      trigger: 'analyze',
      analysis_revision: 21,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    }));

    const midWriteStatus = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis-status`, undefined, token)).body);
    assert.equal(midWriteStatus.status, 'populating', 'an in-progress attempt must win over a landed-but-stale entry');
    assert.equal(midWriteStatus.last_attempt?.state, 'in-progress');
    assert.equal(midWriteStatus.last_attempt?.analysis_revision, 21);
    assert.equal(midWriteStatus.summary, undefined, 'must not carry a stale summary that reads as fresh');

    const midWriteAnalysis = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token)).body);
    assert.equal(midWriteAnalysis.status, 'populating', 'the /analysis route must agree — a client polling either surface gets the same verdict');
    assert.equal(midWriteAnalysis.last_attempt?.state, 'in-progress');
    const midWriteQuery = JSON.parse((await request(port, 'POST', `/api/projects/${project.id}/query`, {
      tool: 'search_nodes',
      args: { query: 'handler' },
    }, token)).body);
    assert.equal(midWriteQuery.status, 'populating', 'a query cannot serve a prior CAS while the accepted attempt is in progress');

    fs.writeFileSync(attemptRecordPath, JSON.stringify({
      state: 'failed',
      trigger: 'analyze',
      analysis_revision: 22,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      reason: 'analysis worker failed',
    }));
    const failedUploadStatus = JSON.parse((await request(port, 'GET', `/v1/analyses/${analyzed.analysis_id}/status`, undefined, token)).body);
    assert.equal(failedUploadStatus.status, 'failed');
    assert.equal(failedUploadStatus.analysis_revision, 22);
    assert.equal(failedUploadStatus.last_attempt?.reason, 'analysis worker failed');
    const failedProjectStatus = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis-status`, undefined, token)).body);
    assert.equal(failedProjectStatus.status, 'failed');
    assert.equal(failedProjectStatus.summary, undefined, 'a stale prior generation must not masquerade as the failed commit');
    const failedProjectAnalysis = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token)).body);
    assert.equal(failedProjectAnalysis.status, 'failed');
    assert.equal(failedProjectAnalysis.summary, undefined);
    const failedProjectQuery = JSON.parse((await request(port, 'POST', `/api/projects/${project.id}/query`, {
      tool: 'get_product_map',
      args: {},
    }, token)).body);
    assert.equal(failedProjectQuery.status, 'failed');
    assert.equal(failedProjectQuery.result?.status, 'failed', 'older installed clients still receive a compact serializable failure result');

    // Once the attempt resolves (succeeded), both routes go back to reading
    // the (now current) landed entry normally.
    fs.writeFileSync(attemptRecordPath, JSON.stringify({
      state: 'succeeded',
      trigger: 'analyze',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 1200,
    }));
    const afterStatus = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis-status`, undefined, token)).body);
    assert.equal(afterStatus.status, 'degraded');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
