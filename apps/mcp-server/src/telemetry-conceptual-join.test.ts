import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeProject } from './analyzer';
import { saveAnalysis } from './storage';

/**
 * TELEMETRY-JOIN regression (ICELOT facet 6 on the hosted /conceptual read
 * path): before this fix, `GET /api/projects/:id/conceptual` never loaded or
 * passed runtime metrics into getFlowConcepts at all — every flow/step
 * contract read through the web UI / cross-project HTTP surface silently
 * omitted facet 6 even when real telemetry existed for the project (unlike
 * the MCP `get_flow_concepts` tool, which already threaded
 * `runtimeMetricsForContract` through). This drives the REAL account ->
 * project -> analysis -> ingest -> conceptual read path end to end and
 * asserts a flow contract carries a populated `contract.telemetry`
 * (request_count/error_rate/p50/p95/p99) sourced from a real ingested
 * observation, evidence-gated: the fixture's OTHER route, which gets no
 * observations, stays telemetry-free — nothing fabricated.
 *
 * The CAS is seeded directly at the exact `workspace` path
 * (`<dataDir>/workspaces/<analysis_id>`) the /conceptual handler reads from
 * — the same key `analyzeProjectIncremental` writes to for a real customer
 * upload — via `analyzeProject` + `saveAnalysis`, so this exercises the
 * production Express-route entry-point extraction (package.json must declare
 * an `express` dependency for `ExpressAnalyzer.canAnalyze` to fire) rather
 * than a synthetic CAS fixture.
 */

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

test('GET /api/projects/:id/conceptual joins real ingested telemetry onto a flow contract (evidence-gated)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-telemetry-conceptual-join-'));
  const remoteData = path.join(root, 'remote-data');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;

  // Seed a CAS directly at the exact workspace key the /conceptual handler
  // will read from — `<dataDir>/workspaces/<analysis_id>` — the same
  // location a real customer upload lands its files+CAS under.
  const analysisId = 'fixture-analysis-id-001';
  const workspace = path.join(remoteData, 'workspaces', analysisId);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'telemetry-conceptual-fixture', version: '1.0.0', dependencies: { express: '^4.18.2' } }),
  );
  fs.writeFileSync(
    path.join(workspace, 'server.js'),
    [
      "const express = require('express');",
      'const app = express();',
      "app.get('/items/:id', (req, res) => res.json({ id: req.params.id }));",
      "app.get('/widgets', (req, res) => res.json([]));",
      'app.listen(3000);',
    ].join('\n'),
  );
  const cas = await analyzeProject(workspace);
  await saveAnalysis(workspace, cas);

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as { port: number }).port;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'telemetry-join-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Telemetry Join Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const createRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'telemetry-join-fixture',
      analysis_id: analysisId,
    }, token);
    assert.equal(createRes.statusCode, 201);
    const project = JSON.parse(createRes.body).project as { id: string };

    // Sanity: before any telemetry is ingested, no flow carries a telemetry
    // facet — nothing fabricated. (Compact projection — a distinct cache key
    // from the include=full read below, so this doesn't seed a stale hit.)
    const before = await request(port, 'GET', `/api/projects/${project.id}/conceptual`, undefined, token);
    assert.equal(before.statusCode, 200);
    const beforeBody = JSON.parse(before.body);
    assert.equal(beforeBody.status, 'ready');
    const beforeFlows = beforeBody.flows.flows as Array<{ contract?: { telemetry?: unknown } }>;
    assert.equal(beforeFlows.length, 2, 'fixture must produce both /items/:id and /widgets route flows');
    assert.ok(beforeFlows.every(f => f.contract?.telemetry === undefined), 'no telemetry facet before any observation exists');

    // Ingest real runtime telemetry for the SAME workspace key the read path
    // resolves this project's CAS under — the same key
    // `/api/telemetry/runtime-events/:projectId` and the self-telemetry loop
    // both key their store off (see remote-analyzer-service.ts ingest-
    // reconcile route and self-telemetry.ts).
    const recon = await request(port, 'POST', `/api/telemetry/runtime-events/${encodeURIComponent(workspace)}`, {
      events: [
        { type: 'request', method: 'GET', route: '/items/:id', path: '/items/7', status_code: 200, duration_ms: 15, trace_id: 't-ok', service_name: 'customer-svc' },
        { type: 'request', method: 'GET', route: '/items/:id', path: '/items/8', status_code: 200, duration_ms: 25, trace_id: 't-ok2', service_name: 'customer-svc' },
        { type: 'error', method: 'GET', route: '/items/:id', path: '/items/9', status_code: 500, duration_ms: 90, error_message: 'boom', trace_id: 't-err', service_name: 'customer-svc' },
      ],
    }, token);
    assert.equal(recon.statusCode, 200);
    const reconBody = JSON.parse(recon.body);
    assert.equal(reconBody.event_count, 3);
    assert.equal(reconBody.correlation_summary.matched + reconBody.correlation_summary.partial, 3, 'all 3 events must correlate onto the /items/:id entry point');

    // Read via `include=full` — a params-distinct cache key from the `before`
    // read above, so this is a genuine fresh compute that exercises the new
    // telemetry-join wiring, not a stale cache hit.
    const after = await request(port, 'GET', `/api/projects/${project.id}/conceptual?include=full`, undefined, token);
    assert.equal(after.statusCode, 200);
    const afterBody = JSON.parse(after.body);
    const afterFlows = afterBody.flows.flows as Array<{
      entry_point: string;
      contract?: { telemetry?: { request_count?: number; error_rate?: number; p95_ms?: number; status_code_distribution?: Record<string, number> } };
    }>;
    assert.equal(afterFlows.length, 2);

    const itemsFlow = afterFlows.find(f => f.entry_point.includes('server_get_0'));
    assert.ok(itemsFlow, 'the /items/:id flow must be present');
    const telemetry = itemsFlow!.contract?.telemetry;
    assert.ok(telemetry, 'the /items/:id flow must now carry a populated telemetry facet — the join fires end to end');
    assert.equal(telemetry!.request_count, 3, 'facet reflects the 3 real ingested observations');
    assert.ok(telemetry!.error_rate! > 0, 'the ingested 500 shows up as a non-zero error_rate');
    assert.equal(typeof telemetry!.p95_ms, 'number', 'real p95 latency is present');
    assert.deepEqual(telemetry!.status_code_distribution, { '200': 2, '500': 1 });

    // Evidence-gated: the /widgets flow, which received NO observations,
    // stays telemetry-free — nothing fabricated.
    const widgetsFlow = afterFlows.find(f => f !== itemsFlow);
    assert.ok(widgetsFlow, 'the /widgets flow must be present');
    assert.equal(widgetsFlow!.contract?.telemetry, undefined, '/widgets must stay telemetry-free — no observation matched it');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
