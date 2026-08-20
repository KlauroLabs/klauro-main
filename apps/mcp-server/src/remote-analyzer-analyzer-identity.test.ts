/**
 * REGRESSION GATE — two live P0s from the 2026-07-28 audit of the deployed
 * build, exercised end-to-end through the real HTTP surface:
 *
 *  1. CUSTOMERS NEVER RECEIVE FIXES. `analyze` on an unchanged repo returned
 *     `{ reused: true, analysis_type: 'unchanged' }` because the reuse gate
 *     deduped on the SOURCE SNAPSHOT alone. A new analyzer build invalidated
 *     nothing, so a customer who upgraded the CLI silently got their old
 *     analysis back and none of the analyzer fixes ever reached them.
 *
 *  2. A DEGRADED COMPREHENSION LAYER REPORTED A CLEAN `ready`. When L5 failed,
 *     the project status still read 'ready' — with a capability catalog of
 *     un-enriched structural placeholders behind it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';
import { loadAnalysis, saveAnalysis } from './storage';

/** The server salts the storage analysis id, so resolve the workspace by
 *  listing the data dir rather than guessing the id. */
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

test('reuse is gated on analyzer identity, not source alone — and the decision is reported', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-analyzer-identity-'));
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
      workspace_name: 'Analyzer Identity Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const first = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'identity-fixture', wait: true, readinessRequirement: 'structural' });
    assert.equal(first.status, 'success');

    // --- Re-run on the UNCHANGED repo with an unchanged analyzer: reuse is
    // correct here, but it must now SAY so.
    const reused = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'identity-fixture' });
    assert.equal(reused.reused, true, 'an unchanged snapshot from the same analyzer is still reused');
    assert.ok(reused.reuse_decision, 'reused:true must never ship without a reason (this is the defect)');
    assert.equal(reused.reuse_decision!.reused, true);
    assert.ok(reused.reuse_decision!.reason.length > 10);
    assert.ok(
      ['match', 'build', 'in-flight'].includes(reused.reuse_decision!.analyzer_identity_tier),
      `unexpected tier ${reused.reuse_decision!.analyzer_identity_tier}`,
    );

    // --- Now simulate the customer's real situation: the SERVER shipped a new
    // analyzer whose parser layer changed. The stored analysis carries the old
    // identity; the source is byte-identical. Before the fix this returned the
    // stale analysis with reused:true.
    const workspace = soleWorkspace(remoteData);
    const stored = await loadAnalysis(workspace, { track: 'main' });
    assert.ok(stored, 'stored analysis must exist');
    stored!.parser_fingerprint = 'stale-parser-fingerprint-from-an-older-build';
    stored!.analyzer_build = '0.0.0+stale';
    await saveAnalysis(workspace, stored!);

    const afterUpgrade = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'identity-fixture' });
    assert.notEqual(afterUpgrade.reused, true, 'a stored analysis from a DIFFERENT analyzer identity must not be reused');
    assert.ok(afterUpgrade.reuse_decision, 'the non-reuse decision must be reported too');
    assert.equal(afterUpgrade.reuse_decision!.reused, false);
    assert.equal(afterUpgrade.reuse_decision!.analyzer_identity_tier, 'parser');
    assert.equal(afterUpgrade.analysis_type, 'analyzer_upgrade');
    assert.match(afterUpgrade.reuse_decision!.reason, /parser-layer fingerprint changed/i);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a degraded comprehension layer never reports a clean ready status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-degraded-status-'));
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
      workspace_name: 'Degraded Status Workspace',
    });
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const analyzed = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: 'degraded-fixture', wait: true, readinessRequirement: 'structural' });
    const linkRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'degraded-fixture',
      analysis_id: analyzed.analysis_id,
    }, token);
    const project = JSON.parse(linkRes.body).project as { id: string };

    const healthy = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token)).body);
    assert.ok(['ready', 'degraded'].includes(healthy.status));

    // Reproduce the audited shape: the AI comprehension pass failed, so the
    // capability catalog behind this status is un-enriched.
    const workspace = soleWorkspace(remoteData);
    const stored = await loadAnalysis(workspace, { track: 'main' });
    assert.ok(stored);
    (stored as any).ai_enrichment = 'error';
    (stored as any).ai_enrichment_error = 'provider request failed';
    (stored as any).layers_ready = {
      ...(stored as any).layers_ready,
      complete: false,
      layers: [
        ...(((stored as any).layers_ready?.layers || []).filter((layer: any) => layer.layer !== 'L5')),
        { layer: 'L5', status: 'error', error: 'AI comprehension pass failed' },
      ],
    };
    await saveAnalysis(workspace, stored!);

    const degradedRes = await request(port, 'GET', `/api/projects/${project.id}/analysis`, undefined, token);
    const degraded = JSON.parse(degradedRes.body);
    assert.equal(degraded.status, 'degraded', 'a failed comprehension layer must not read as a clean ready');
    assert.equal(degraded.comprehension?.degraded, true);
    assert.ok(degraded.ai_enrichment_error, 'the underlying reason stays queryable');

    // The lighter index-backed status route must agree — a client polling
    // either surface gets the same verdict.
    const listing = JSON.parse((await request(port, 'GET', `/api/projects/${project.id}/analysis-status`, undefined, token)).body);
    assert.equal(listing.status, 'degraded');
    assert.deepEqual(listing.degraded_layers, ['L5']);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
