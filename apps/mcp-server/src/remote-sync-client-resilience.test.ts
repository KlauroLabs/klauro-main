import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { analyzeCodebaseRemotely, waitForRemoteAnalysis } from './remote-sync-client';

/**
 * Reproduces the live mcp.klauro.com bug: the CLI's remote upload path
 * (`postRemote` in remote-sync-client.ts) intermittently received a
 * Cloudflare HTML error/challenge page instead of JSON and crashed with a
 * raw `Unexpected token '<'` SyntaxError. These tests drive a real
 * in-process HTTP server that plays back the same failure shapes (HTML
 * instead of JSON, 5xx, and a hang) and assert the client retries with
 * short backoff and only ever surfaces honest, edge-aware error messages —
 * never a raw JSON.parse SyntaxError.
 */

const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');

// These tests exercise postRemote's retry/timeout/response-handling behavior
// in isolation, not the connector entitlement flow (a separate concern with
// its own tests) — bypass it so the mock server only needs to answer
// /v1/analyze.
function disableConnectorAuth(t: import('node:test').TestContext): void {
  const previous = process.env.KLAURO_CONNECTOR_AUTH_DISABLED;
  process.env.KLAURO_CONNECTOR_AUTH_DISABLED = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.KLAURO_CONNECTOR_AUTH_DISABLED;
    else process.env.KLAURO_CONNECTOR_AUTH_DISABLED = previous;
  });
}

function makeGitFixtureRepo(root: string): string {
  const repo = path.join(root, 'repo');
  fs.cpSync(fixturePath, repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function successPayload(analysisId: string) {
  return JSON.stringify({
    status: 'success',
    analysis_id: analysisId,
    analysis_revision: 1,
    analysis_type: 'full',
    base_commit: 'deadbeef',
    manifest: { files: [] },
    cas: { system: { name: 'x' }, nodes: [], edges: [] },
  });
}

const CLOUDFLARE_CHALLENGE_HTML = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';

test('postRemote retries past a transient HTML edge response and succeeds', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-resilience-test-'));
  const repo = makeGitFixtureRepo(root);
  let requestCount = 0;
  const requestBodies: Buffer[] = [];

  const server = http.createServer(async (req, res) => {
    const raw = await readRequestBody(req);
    requestBodies.push(req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw);
    requestCount++;
    if (requestCount === 1) {
      // First attempt: Cloudflare intercepted the request and returned an
      // HTML challenge page instead of forwarding to the origin.
      res.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare' });
      res.end(CLOUDFLARE_CHALLENGE_HTML);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(successPayload('resilience-test-analysis'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${(address as { port: number }).port}`;

  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token: 'test-token' });
  assert.equal(result.status, 'success');
  assert.equal(requestCount, 2, 'exactly one retry was needed to succeed');
  assert.deepEqual(requestBodies[1], requestBodies[0], 'retry must replay the exact immutable source package bytes');
});

test('postRemote gives an honest edge-aware error after persistent HTML responses, never a raw JSON.parse SyntaxError', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-resilience-test-'));
  const repo = makeGitFixtureRepo(root);
  let requestCount = 0;

  const server = http.createServer(async (req, res) => {
    await readRequestBody(req);
    requestCount++;
    res.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare' });
    res.end(CLOUDFLARE_CHALLENGE_HTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${(address as { port: number }).port}`;

  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token: 'test-token' }),
    (error: Error) => {
      assert.ok(!/Unexpected token/.test(error.message), `must not leak a raw JSON.parse error: ${error.message}`);
      assert.match(error.message, /Cloudflare/i, 'error names the edge');
      assert.match(error.message, /retried 4 times/i, 'error states the retry count');
      return true;
    }
  );
  // 1 initial attempt + 3 retries per the documented backoff schedule.
  assert.equal(requestCount, 4);
});

test('postRemote treats a hung response as a timeout, retries, and eventually gives an honest timeout error', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-resilience-test-'));
  const repo = makeGitFixtureRepo(root);
  let requestCount = 0;
  const pendingResponses: http.ServerResponse[] = [];

  const server = http.createServer(async (req, res) => {
    await readRequestBody(req);
    requestCount++;
    // Never respond — simulate the measured HTTP/2+gzip hang (0 bytes back).
    pendingResponses.push(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${(address as { port: number }).port}`;

  t.after(async () => {
    for (const res of pendingResponses) {
      try { res.end(); } catch { /* already closed */ }
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Use a short timeout so the test does not need to wait 120s per attempt.
  const previousTimeout = process.env.KLAURO_REMOTE_REQUEST_TIMEOUT_MS;
  process.env.KLAURO_REMOTE_REQUEST_TIMEOUT_MS = '200';
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.KLAURO_REMOTE_REQUEST_TIMEOUT_MS;
    else process.env.KLAURO_REMOTE_REQUEST_TIMEOUT_MS = previousTimeout;
  });

  await assert.rejects(
    () => analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token: 'test-token' }),
    (error: Error) => {
      assert.ok(!/Unexpected token/.test(error.message));
      assert.match(error.message, /did not respond within/i);
      return true;
    }
  );
});

test('parseRemoteResponse-equivalent: gzip content-encoding path still round-trips through a real server', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-resilience-test-'));
  const repo = makeGitFixtureRepo(root);
  let sawGzip = false;

  const server = http.createServer(async (req, res) => {
    const raw = await readRequestBody(req);
    if (req.headers['content-encoding'] === 'gzip') {
      sawGzip = true;
      JSON.parse(gunzipSync(raw).toString('utf8'));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(successPayload('gzip-test-analysis'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${(address as { port: number }).port}`;

  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token: 'test-token' });
  assert.equal(result.status, 'success');
  assert.ok(sawGzip, 'the large fixture snapshot should have been sent gzip-encoded');
});

test('analysis completion polling survives a transient server failure', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-resilience-test-'));
  const repo = makeGitFixtureRepo(root);
  const analysisId = 'polling-resilience-analysis';
  let statusRequests = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/analyze') {
      await readRequestBody(req);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', analysis_id: analysisId, manifest: { files: [] } }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/status`) {
      statusRequests++;
      if (statusRequests === 1) {
        req.socket.destroy();
        return;
      }
      if (statusRequests === 2) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'temporary read contention' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', analysis_id: analysisId }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/cas/export`) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-klauro-cas-codec': 'none' });
      res.end(JSON.stringify({ system: { name: 'resilient' }, nodes: [], edges: [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: 'not found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token: 'test-token', wait: true, analysisId });
  assert.equal(result.status, 'success');
  assert.ok(result.cas);
  assert.equal(statusRequests, 3);
});

test('segmented CAS retrieval retries a dropped section response', async (t) => {
  const analysisId = 'segmented-read-resilience';
  let sectionRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === `/v1/analyses/${analysisId}/status`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', analysis_id: analysisId }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/cas/manifest`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        manifest_version: 1,
        cas_version: '3.0.0',
        analysis_id: analysisId,
        analysis_timestamp: new Date().toISOString(),
        sections: [{ name: 'identity', fields: ['system'] }],
        logical_fields: ['system'],
      }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/cas/sections/identity`) {
      sectionRequests += 1;
      if (sectionRequests === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-klauro-cas-codec': 'none' });
      res.end(JSON.stringify({ system: { name: 'resilient-segmented-read' } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => new Promise<void>(resolve => server.close(() => resolve())));

  const cas = await waitForRemoteAnalysis(
    `http://127.0.0.1:${address.port}`,
    analysisId,
    undefined,
    undefined,
    30_000,
    ['identity'],
  );

  assert.equal(cas.system.name, 'resilient-segmented-read');
  assert.equal(sectionRequests, 2);
});

test('segmented CAS retrieval retries a section that is still being published', async (t) => {
  const analysisId = 'segmented-publication-race';
  let sectionRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === `/v1/analyses/${analysisId}/status`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', analysis_id: analysisId }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/cas/manifest`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        manifest_version: 1,
        cas_version: '3.0.0',
        analysis_id: analysisId,
        analysis_timestamp: new Date().toISOString(),
        sections: [{ name: 'identity', fields: ['system'] }],
        logical_fields: ['system'],
      }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/cas/sections/identity`) {
      sectionRequests += 1;
      if (sectionRequests === 1) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'CAS section is not ready' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-klauro-cas-codec': 'none' });
      res.end(JSON.stringify({ system: { name: 'published-segmented-read' } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => new Promise<void>(resolve => server.close(() => resolve())));

  const cas = await waitForRemoteAnalysis(
    `http://127.0.0.1:${address.port}`,
    analysisId,
    undefined,
    undefined,
    30_000,
    ['identity'],
  );

  assert.equal(cas.system.name, 'published-segmented-read');
  assert.equal(sectionRequests, 2);
});

test('segmented CAS retrieval uses bounded parallel section reads', async (t) => {
  const analysisId = 'segmented-parallel-read';
  const sections = ['identity', 'tree', 'graph', 'calls', 'facts'] as const;
  let activeRequests = 0;
  let peakRequests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === `/v1/analyses/${analysisId}/status`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', analysis_id: analysisId }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/cas/manifest`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        manifest_version: 1,
        cas_version: '3.0.0',
        analysis_id: analysisId,
        analysis_timestamp: new Date().toISOString(),
        sections: sections.map(name => ({ name, fields: name === 'identity' ? ['system'] : [] })),
        logical_fields: ['system'],
      }));
      return;
    }
    const section = sections.find(name => req.url === `/v1/analyses/${analysisId}/cas/sections/${name}`);
    if (section) {
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 40));
      activeRequests -= 1;
      res.writeHead(200, { 'content-type': 'application/json', 'x-klauro-cas-codec': 'none' });
      res.end(JSON.stringify(section === 'identity' ? { system: { name: 'parallel-segmented-read' } } : {}));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => new Promise<void>(resolve => server.close(() => resolve())));

  const cas = await waitForRemoteAnalysis(
    `http://127.0.0.1:${address.port}`,
    analysisId,
    undefined,
    undefined,
    30_000,
    sections,
  );

  assert.equal(cas.system.name, 'parallel-segmented-read');
  assert.equal(peakRequests, 4);
});

test('wait mode follows a structural response until pending comprehension completes', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-resilience-test-'));
  const repo = makeGitFixtureRepo(root);
  const analysisId = 'pending-comprehension-analysis';
  let statusRequests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/analyze') {
      await readRequestBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        analysis_id: analysisId,
        manifest: { files: [] },
        cas: {
          system: { name: 'structural' },
          nodes: [],
          edges: [],
          ai_enrichment: 'pending',
          layers_ready: { complete: false, layers: [{ layer: 'L5', status: 'pending' }] },
        },
      }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/status`) {
      statusRequests++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', analysis_id: analysisId }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/cas/export`) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-klauro-cas-codec': 'none' });
      res.end(JSON.stringify({
        system: { name: 'complete' },
        nodes: [],
        edges: [],
        ai_enrichment: 'ready',
        layers_ready: { complete: true, layers: [{ layer: 'L5', status: 'ready' }] },
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: 'not found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token: 'test-token', wait: true, analysisId });
  assert.equal(result.status, 'success');
  assert.equal(result.cas?.ai_enrichment, 'ready');
  assert.equal(result.cas?.layers_ready?.complete, true);
  assert.equal(statusRequests, 1);
});

test('wait mode ignores a ready CAS from an older analysis revision', async (t) => {
  disableConnectorAuth(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-resilience-test-'));
  const repo = makeGitFixtureRepo(root);
  const analysisId = 'revision-aware-analysis';
  let statusRequests = 0;
  let exportRequests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/analyze') {
      await readRequestBody(req);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', analysis_id: analysisId, analysis_revision: 2, manifest: { files: [] } }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/status`) {
      statusRequests++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', analysis_id: analysisId, analysis_revision: statusRequests === 1 ? 1 : 2 }));
      return;
    }
    if (req.url === `/v1/analyses/${analysisId}/cas/export`) {
      exportRequests++;
      if (exportRequests === 1) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'Analysis is still populating' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-klauro-cas-codec': 'none',
        'x-klauro-analysis-revision': '2',
      });
      res.end(JSON.stringify({ system: { name: 'current' }, nodes: [], edges: [], ai_enrichment: 'ready' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: 'not found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await analyzeCodebaseRemotely({ projectPath: repo, serverUrl, token: 'test-token', wait: true, analysisId });
  assert.equal(result.status, 'success');
  assert.equal(result.analysis_revision, 2);
  assert.equal(result.cas?.ai_enrichment, 'ready');
  assert.equal(statusRequests, 3);
  assert.equal(exportRequests, 2);
});
