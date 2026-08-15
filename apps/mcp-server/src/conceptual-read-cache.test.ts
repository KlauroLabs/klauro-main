import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRemoteAnalyzerHttpServer, getCasReadResponseCacheStats } from './remote-analyzer-service';
import { analyzeCodebaseRemotely } from './remote-sync-client';

/**
 * TASK (server read-paths starve during whale re-analysis): the /conceptual
 * and /semantic-coverage payloads are pure functions of the stored CAS, but
 * were recomputed per request — seconds of synchronous CPU on a whale CAS,
 * 524-ing behind Cloudflare while the in-process analyzer churned. They are
 * now served from a small LRU response cache keyed on (endpoint, project,
 * analysis, stored-analysis fingerprint, target/include params).
 *
 * This test drives the REAL HTTP path end to end and asserts the honesty
 * invariants: a cache hit is byte-identical to the fresh compute that seeded
 * it, distinct params get distinct entries, and landing a NEW analysis for
 * the same analysis_id (fingerprint change — analysis_id itself is stable
 * across reanalyses) invalidates: the next GET reflects the new CAS, never
 * the cached old body.
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

test('conceptual + semantic-coverage responses are cached byte-identical and invalidated by a new analysis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-read-cache-'));
  const repo = path.join(root, 'repo');
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  fs.mkdirSync(repo, { recursive: true });

  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'app.py'), 'def create_order(order):\n    return save_order(order)\n\n\ndef save_order(order):\n    return order\n');
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
      email: 'cache-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Read Cache Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // Upload an analysis (customer path), then link a project to it.
    const analyzeResult = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, wait: true });
    assert.equal(analyzeResult.status, 'success');
    const createRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'read-cache-fixture',
      analysis_id: analyzeResult.analysis_id,
    }, token);
    assert.equal(createRes.statusCode, 201);
    const project = JSON.parse(createRes.body).project as { id: string };

    // --- byte-identity + real hit accounting on /conceptual ---
    const statsBefore = getCasReadResponseCacheStats();
    const first = await request(port, 'GET', `/api/projects/${project.id}/conceptual`, undefined, token);
    assert.equal(first.statusCode, 200);
    assert.equal(JSON.parse(first.body).status, 'ready');
    const second = await request(port, 'GET', `/api/projects/${project.id}/conceptual`, undefined, token);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body, first.body, 'cache hit must be byte-identical to the fresh compute');
    const statsAfterRepeat = getCasReadResponseCacheStats();
    assert.equal(statsAfterRepeat.hits - statsBefore.hits, 1, 'second GET must be served from the cache');

    // --- param keying: include=full is a DIFFERENT projection, not the cached default ---
    const full = await request(port, 'GET', `/api/projects/${project.id}/conceptual?include=full`, undefined, token);
    assert.equal(full.statusCode, 200);
    assert.equal(JSON.parse(full.body).status, 'ready');
    const statsAfterFull = getCasReadResponseCacheStats();
    assert.equal(statsAfterFull.hits, statsAfterRepeat.hits, 'include=full must not hit the default-projection entry');
    const fullRepeat = await request(port, 'GET', `/api/projects/${project.id}/conceptual?include=full`, undefined, token);
    assert.equal(fullRepeat.body, full.body);

    // --- /semantic-coverage: same purity, same invariants ---
    const coverageFirst = await request(port, 'GET', `/api/projects/${project.id}/semantic-coverage`, undefined, token);
    assert.equal(coverageFirst.statusCode, 200);
    assert.equal(JSON.parse(coverageFirst.body).status, 'ready');
    const coverageSecond = await request(port, 'GET', `/api/projects/${project.id}/semantic-coverage`, undefined, token);
    assert.equal(coverageSecond.body, coverageFirst.body, 'semantic-coverage hit must be byte-identical');

    // --- invalidation: land a NEW analysis under the SAME analysis_id ---
    // (This is what a reanalyze does: analysis_id stays stable, the stored
    // analysis file is rewritten, so the version fingerprint changes.)
    fs.writeFileSync(path.join(repo, 'billing.py'), 'def charge_invoice(invoice):\n    return invoice\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'add billing module']);
    const reAnalyzeResult = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token, analysisId: analyzeResult.analysis_id, wait: true });
    assert.equal(reAnalyzeResult.status, 'success');

    const statsBeforeCoverageRefresh = getCasReadResponseCacheStats();
    const afterReanalyze = await request(port, 'GET', `/api/projects/${project.id}/semantic-coverage`, undefined, token);
    assert.equal(afterReanalyze.statusCode, 200);
    const afterBody = JSON.parse(afterReanalyze.body);
    assert.equal(afterBody.status, 'ready');
    const statsAfterCoverageRefresh = getCasReadResponseCacheStats();
    assert.equal(statsAfterCoverageRefresh.misses - statsBeforeCoverageRefresh.misses, 1, 'new analysis fingerprint must miss the pre-reanalyze semantic-coverage cache entry');

    const statsBeforeConceptualRefresh = getCasReadResponseCacheStats();
    const conceptualAfter = await request(port, 'GET', `/api/projects/${project.id}/conceptual`, undefined, token);
    assert.equal(conceptualAfter.statusCode, 200);
    assert.equal(JSON.parse(conceptualAfter.body).status, 'ready');
    const statsAfterConceptualRefresh = getCasReadResponseCacheStats();
    assert.equal(statsAfterConceptualRefresh.misses - statsBeforeConceptualRefresh.misses, 1, 'new analysis fingerprint must miss the pre-reanalyze conceptual cache entry');
    // And the fresh CAS's own repeat GET is again a byte-identical cache hit.
    const conceptualAfterRepeat = await request(port, 'GET', `/api/projects/${project.id}/conceptual`, undefined, token);
    assert.equal(conceptualAfterRepeat.body, conceptualAfter.body);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
