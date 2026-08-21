import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { shutdownAnalysisWorker } from './analyzer';
import { __resetHostedAnalysisSchedulerForTests, hostedAnalysisQueueState } from './hosted-analysis-admission';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION } from './remote-analyzer-protocol';

function request(port: number, method: string, route: string, body: unknown | undefined, token: string): Promise<{ statusCode: number; body: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      headers,
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: JSON.parse(responseBody) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function analyzeBody(id: string) {
  const content = 'export function handle(): string { return "ok"; }\n';
  return {
    protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
    project_id: id,
    project_path: `/fixtures/${id}`,
    async: true,
    analysis_focus: 'full',
    snapshot: {
      project_name: id,
      snapshot_source: 'working-tree',
      files: [{ path: 'src/index.ts', content, hash: `hash-${id}` }],
      manifest: {
        generated_at: new Date().toISOString(),
        root: `/fixtures/${id}`,
        file_count: 1,
        total_bytes: Buffer.byteLength(content),
        snapshot_digest: `digest-${id}`,
        excluded_directories: [],
      },
    },
  };
}

test('POST /v1/analyze rejects work beyond the bounded queue and exposes retry metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-analysis-admission-'));
  const dataDir = path.join(root, 'remote-data');
  const previous = {
    storage: process.env.KLAURO_STORAGE_PATH,
    queue: process.env.KLAURO_ANALYSIS_QUEUE_CAPACITY,
    stall: process.env.KLAURO_TEST_ANALYSIS_WORKER_STALL,
    ai: process.env.KLAURO_AI_INTERPRETATION,
  };
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
  process.env.KLAURO_ANALYSIS_QUEUE_CAPACITY = '0';
  process.env.KLAURO_TEST_ANALYSIS_WORKER_STALL = 'before-start';
  process.env.KLAURO_AI_INTERPRETATION = 'false';
  const token = 'analysis-admission-token';
  const server = createRemoteAnalyzerHttpServer({ dataDir, token });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const first = await request(address.port, 'POST', '/v1/analyze', analyzeBody('admission-first'), token);
    assert.equal(first.statusCode, 202);
    assert.equal(first.body.queue.queue_position, 0);
    assert.equal(first.body.queue.active_limit, 1);
    assert.equal(first.body.queue.queue_limit, 0);

    const second = await request(address.port, 'POST', '/v1/analyze', analyzeBody('admission-rejected'), token);
    assert.equal(second.statusCode, 503);
    assert.equal(second.body.status, 'overloaded');
    assert.equal(second.body.code, 'analysis_capacity_exhausted');
    assert.equal(second.body.active_limit, 1);
    assert.equal(second.body.queue_limit, 0);
    assert.ok(second.body.retry_after_ms > 0);
    assert.equal(fs.existsSync(path.join(dataDir, 'workspaces', 'admission-rejected')), false);

    let status = await request(address.port, 'GET', '/v1/analyses/admission-first/status', undefined, token);
    for (let attempt = 0; attempt < 20 && !status.body.last_attempt; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      status = await request(address.port, 'GET', '/v1/analyses/admission-first/status', undefined, token);
    }
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.status, 'populating');
    assert.ok(status.body.last_attempt, JSON.stringify(status.body));
    assert.equal(status.body.last_attempt.queue_position, 0);
    assert.equal(status.body.last_attempt.estimated_wait_ms, 0);
  } finally {
    delete process.env.KLAURO_TEST_ANALYSIS_WORKER_STALL;
    shutdownAnalysisWorker();
    for (let attempt = 0; attempt < 20 && hostedAnalysisQueueState().active > 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    __resetHostedAnalysisSchedulerForTests();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      const envName = key === 'storage' ? 'KLAURO_STORAGE_PATH'
        : key === 'queue' ? 'KLAURO_ANALYSIS_QUEUE_CAPACITY'
          : key === 'stall' ? 'KLAURO_TEST_ANALYSIS_WORKER_STALL'
            : 'KLAURO_AI_INTERPRETATION';
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
