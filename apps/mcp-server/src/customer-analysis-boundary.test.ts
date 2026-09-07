import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { assertLocalAnalysisAllowed, defaultKlauroConfig } from './klauro-config';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';

const sourceRoot = path.resolve(__dirname);

function source(file: string): string {
  return fs.readFileSync(path.join(sourceRoot, file), 'utf8');
}

function callArguments(file: string, functionName: string): readonly ts.Expression[] {
  const parsed = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let match: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === functionName) match = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(match, `${file} must call ${functionName}`);
  return match.arguments;
}

test('customer MCP, CLI, and watcher paths do not launch analyzer internals', () => {
  for (const file of ['server.ts', 'cli.ts', 'watcher.ts', 'agent-project-map.ts']) {
    const text = source(file);
    assert.doesNotMatch(text, /\b(?:analyzeProject|analyzeProjectIncremental|runAnalysis)\s*\(/, `${file} must submit or read, never analyze locally`);
  }
});

test('watch mode submits in-flight changes to hosted incremental analysis', () => {
  const text = source('watcher.ts');
  assert.match(text, /syncWorkingTreeRemotely\(\{ projectPath: session\.projectPath \}\)/);
  assert.match(text, /scheduleAnalysis\(session\)/);
  assert.doesNotMatch(text, /from ['"]\.\/analyzer['"]/);
});

test('repository policy cannot authorize customer-side analyzer execution', () => {
  const config = defaultKlauroConfig('/tmp/customer-project');
  config.policy.requireRemoteAnalyzer = false;
  assert.throws(
    () => assertLocalAnalysisAllowed({ config, ignorePatterns: [] }),
    /not a customer execution mode/,
  );
});

test('telemetry ingestion is CAS-free and cannot bootstrap analysis', () => {
  for (const file of ['self-telemetry.ts', 'telemetry-ingestion.ts']) {
    const text = source(file);
    assert.doesNotMatch(text, /from ['"]\.\/analyzer['"]/, `${file} must not import analyzer entrypoints`);
    assert.doesNotMatch(text, /\b(?:analyzeProject|runAnalysis)\s*\(/, `${file} must not trigger analysis`);
  }
  const args = callArguments('remote-analyzer-service.ts', 'ingestTelemetryBatch');
  assert.equal(args[0]?.kind, ts.SyntaxKind.NullKeyword, 'HTTP telemetry ingest must persist without loading CAS');
});

test('customer uploads default to asynchronous acceptance and local-path reanalysis has no override', () => {
  const client = source('remote-sync-client.ts');
  assert.match(client, /postRemote\(options, '\/v1\/analyze',[\s\S]*?async: true/);
  assert.match(client, /postRemote\(options, '\/v1\/sync',[\s\S]*?async: !options\.wait/);
  const service = source('remote-analyzer-service.ts');
  assert.doesNotMatch(service, /KLAURO_ALLOW_LOCAL_PATH_REANALYZE_FALLBACK/);
  assert.doesNotMatch(service, /project\.local_path\s*&&\s*\(await fs\.pathExists/);
});

test('hosted deployment reserves CPU for the control plane and admits one analysis at a time', () => {
  const compose = fs.readFileSync(path.resolve(sourceRoot, '../../../infrastructure/vps/docker-compose.yml'), 'utf8');
  const apiService = compose.split('\n  analysis-worker:')[0];
  const workerService = compose.split('\n  analysis-worker:')[1]?.split('\n  fabric:')[0] ?? '';
  const apiCpus = Number(apiService.match(/cpus:\s*["']([\d.]+)["']/)?.[1]);
  const workerCpus = Number(workerService.match(/cpus:\s*["']([\d.]+)["']/)?.[1]);
  assert.ok(apiCpus >= 1, 'the control plane keeps its own CPU reservation');
  assert.ok(workerCpus >= apiCpus, 'analysis runs in the isolated worker with at least the control-plane reservation');
  assert.match(workerService, /KLAURO_ANALYSIS_WORKER_SOCKET:|<<: \*analysis-environment/);
  assert.match(compose, /KLAURO_ANALYSIS_CONCURRENCY:\s*["']1["']/);
  assert.match(apiService, /KLAURO_TS_PARSE_WORKERS:\s*["']2["']/);
  assert.match(apiService, /KLAURO_ANALYSIS_WORKER_IDLE_MS:\s*["']0["']/);
  assert.doesNotMatch(apiService, /KLAURO_ANALYSIS_WORKER_IDLE_MS:\s*["']-1["']/);
});

test('hosted element enrichment rejects unauthenticated requests before workspace access', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-hosted-boundary-'));
  const previousCoordDir = process.env.KLAURO_COORD_DIR;
  process.env.KLAURO_COORD_DIR = path.join(dataDir, 'coordination');
  const server = createRemoteAnalyzerHttpServer({ dataDir, token: 'boundary-token' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: '/v1/enrich-element',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, incoming => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', chunk => { body += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode || 0, body }));
      });
      request.on('error', reject);
      request.end(JSON.stringify({ analysis_id: 'prj_missing', target: 'missing' }));
    });
    assert.equal(response.status, 401);
    assert.match(response.body, /unauthorized|bearer token/i);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
