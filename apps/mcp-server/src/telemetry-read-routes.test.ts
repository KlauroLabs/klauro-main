import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeProject } from './analyzer';

/**
 * Focused HTTP tests for the telemetry read-back + ingest-reconcile routes
 * added to remote-analyzer-service.ts:
 *   - GET  /v1/telemetry/observations
 *   - GET  /v1/telemetry/node-metrics
 *   - POST /api/telemetry/runtime-events/:projectId  (SDK ingest reconcile)
 *
 * A tiny real project is analyzed in-process (KLAURO_STORAGE_PATH pointed at a
 * temp root so getAnalysis/loadTelemetryObservations share one store), then the
 * SDK's `{ events: [...] }` batch is POSTed and read back — proving a
 * customer-installed SDK actually ingests AND the data is reachable over HTTP.
 */

interface Ctx {
  server: ReturnType<typeof createRemoteAnalyzerHttpServer>;
  base: string;
  workspace: string;
  cleanup: () => Promise<void>;
}

async function boot(): Promise<Ctx> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-telemetry-routes-'));
  const storage = path.join(root, 'storage');
  const remoteData = path.join(root, 'remote-data');
  fs.mkdirSync(storage, { recursive: true });

  const prev = {
    storage: process.env.KLAURO_STORAGE_PATH,
    remote: process.env.KLAURO_REMOTE_ANALYZER_DATA,
    token: process.env.KLAURO_ANALYZER_TOKEN,
  };
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  delete process.env.KLAURO_ANALYZER_TOKEN; // open analyzer auth for the test

  // Minimal analyzable project (an Express-ish route) so a CAS exists to
  // correlate against.
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'telemetry-fixture', version: '1.0.0' }));
  fs.writeFileSync(
    path.join(projectDir, 'server.js'),
    [
      "const express = require('express');",
      'const app = express();',
      "app.get('/items/:id', (req, res) => res.json({ id: req.params.id }));",
      'app.listen(3000);',
    ].join('\n'),
  );

  const cas = await analyzeProject(projectDir);
  // Persist so getAnalysis(projectDir) resolves it inside the HTTP handler.
  const { saveAnalysis } = await import('./storage');
  await saveAnalysis(projectDir, cas);

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };

  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    workspace: projectDir,
    cleanup: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      if (prev.storage === undefined) delete process.env.KLAURO_STORAGE_PATH; else process.env.KLAURO_STORAGE_PATH = prev.storage;
      if (prev.remote === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA; else process.env.KLAURO_REMOTE_ANALYZER_DATA = prev.remote;
      if (prev.token === undefined) delete process.env.KLAURO_ANALYZER_TOKEN; else process.env.KLAURO_ANALYZER_TOKEN = prev.token;
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

async function getJson(base: string, p: string) {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function postJson(base: string, p: string, body: unknown) {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

test('telemetry routes: reconcile POST → observations + node-metrics read-back', async () => {
  const ctx = await boot();
  try {
    const ws = encodeURIComponent(ctx.workspace);

    // 1. SDK ingest reconcile: the shape the @klauro/telemetry SDK actually POSTs.
    const batch = {
      events: [
        { type: 'request', method: 'GET', route: '/items/:id', path: '/items/7', status_code: 200, duration_ms: 15, trace_id: 't-ok', service_name: 'customer-svc' },
        { type: 'request', method: 'GET', route: '/items/:id', path: '/items/8', status_code: 200, duration_ms: 25, trace_id: 't-ok2', service_name: 'customer-svc' },
        { type: 'error', method: 'GET', route: '/items/:id', path: '/items/9', status_code: 500, duration_ms: 90, error_message: 'boom', trace_id: 't-err', service_name: 'customer-svc' },
      ],
    };
    const recon = await postJson(ctx.base, `/api/telemetry/runtime-events/${ws}`, batch);
    assert.equal(recon.status, 200, 'reconcile POST should ingest, not 401/404');
    assert.equal(recon.body.event_count, 3);

    // 2. Read the observations back over HTTP.
    const obs = await getJson(ctx.base, `/v1/telemetry/observations?workspace=${ws}&limit=100`);
    assert.equal(obs.status, 200);
    assert.equal(obs.body.ingested_count, 3, 'all 3 reconciled events should be readable');
    const errObs = obs.body.observations.filter((o: any) => o.event.type === 'error');
    assert.equal(errObs.length, 1, 'the error event should be present');

    // 3. trace_id filter passes through.
    const traced = await getJson(ctx.base, `/v1/telemetry/observations?workspace=${ws}&trace_id=t-err`);
    assert.equal(traced.status, 200);
    assert.equal(traced.body.observations.length, 1);
    assert.equal(traced.body.observations[0].event.type, 'error');

    // 4. node-metrics rollup: real per-node traffic/error/latency.
    const nm = await getJson(ctx.base, `/v1/telemetry/node-metrics?workspace=${ws}`);
    assert.equal(nm.status, 200);
    assert.ok(Array.isArray(nm.body.node_metrics) && nm.body.node_metrics.length > 0, 'node_metrics should be non-empty');
    const totalReq = nm.body.node_metrics.reduce((s: number, m: any) => s + m.request_count, 0);
    const totalErr = nm.body.node_metrics.reduce((s: number, m: any) => s + m.error_count, 0);
    assert.equal(totalReq, 3, 'three observations aggregate into request_count');
    assert.equal(totalErr, 1, 'one error aggregates into error_count');
    const errNode = nm.body.node_metrics.find((m: any) => m.error_count > 0);
    assert.ok(errNode && errNode.error_rate > 0, 'error node should carry a non-zero error_rate');
    assert.ok(errNode.latency && typeof errNode.latency.p95_ms !== 'undefined', 'latency percentiles present');
  } finally {
    await ctx.cleanup();
  }
});

test('telemetry routes: graceful degradation without a CAS', async () => {
  const ctx = await boot();
  try {
    const missing = encodeURIComponent('/no/such/workspace/xyz');

    // node-metrics with no analysis → 200 with an empty list + note, never 500.
    const nm = await getJson(ctx.base, `/v1/telemetry/node-metrics?workspace=${missing}`);
    assert.equal(nm.status, 200);
    assert.deepEqual(nm.body.node_metrics, []);
    assert.equal(nm.body.note, 'no analysis for workspace');

    // observations with no analysis → still 200 (raw observations, empty here).
    const obs = await getJson(ctx.base, `/v1/telemetry/observations?workspace=${missing}`);
    assert.equal(obs.status, 200);
    assert.equal(obs.body.ingested_count, 0);

    // reconcile with no analysis → 200 and the raw observation PERSISTS
    // (uncorrelated). Telemetry is never dropped just because the project has
    // not been analyzed yet; correlation happens lazily once an analysis exists.
    const recon = await postJson(ctx.base, `/api/telemetry/runtime-events/${missing}`, {
      events: [
        { type: 'request', method: 'GET', path: '/widgets', status_code: 200, duration_ms: 12 },
        { type: 'error', method: 'GET', path: '/widgets', status_code: 500, duration_ms: 40 },
      ],
    });
    assert.equal(recon.status, 200, 'no-analysis ingest acks 200, not 404');
    assert.equal(recon.body.event_count, 2, 'both raw events ingested');
    assert.equal(recon.body.correlation_summary.unmatched, 2, 'stored as unmatched (no CAS)');

    // ...and the raw records are readable back with real status/duration, plus a
    // CAS-free per-route aggregation, even with no analysis for the workspace.
    const obs2 = await getJson(ctx.base, `/v1/telemetry/observations?workspace=${missing}`);
    assert.equal(obs2.status, 200);
    assert.equal(obs2.body.ingested_count, 2, 'raw observations persisted pre-analysis');
    assert.ok(
      obs2.body.observations.some((o: any) => o.event.status_code === 500 && o.event.duration_ms === 40),
      'raw error observation carries real status + duration',
    );
    assert.ok(Array.isArray(obs2.body.route_metrics), 'route_metrics is present without a CAS');
    const widgetMetric = obs2.body.route_metrics.find((m: any) => m.route === '/widgets');
    assert.ok(widgetMetric, 'per-route aggregation for /widgets');
    assert.equal(widgetMetric.request_count, 2);
    assert.equal(widgetMetric.error_count, 1);
    assert.ok(widgetMetric.error_rate > 0 && typeof widgetMetric.latency.p95_ms === 'number');

    // missing workspace query param → 400.
    const bad = await getJson(ctx.base, `/v1/telemetry/observations`);
    assert.equal(bad.status, 400);
  } finally {
    await ctx.cleanup();
  }
});
