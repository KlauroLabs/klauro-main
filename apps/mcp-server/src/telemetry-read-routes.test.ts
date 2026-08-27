import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { analyzeProject } from './analyzer';
import { AccountStore } from './account-store';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

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
  analyzeAndSave: () => Promise<void>;
  cleanup: () => Promise<void>;
}

async function boot(opts: { preAnalyze?: boolean } = {}): Promise<Ctx> {
  const preAnalyze = opts.preAnalyze !== false;
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

  // Persist so getAnalysis(projectDir) resolves it inside the HTTP handler.
  const { saveAnalysis } = await import('./storage');
  const analyzeAndSave = async () => {
    const cas = await analyzeProject(projectDir);
    await saveAnalysis(projectDir, cas);
  };
  if (preAnalyze) await analyzeAndSave();

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };

  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    workspace: projectDir,
    analyzeAndSave,
    cleanup: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      if (prev.storage === undefined) delete process.env.KLAURO_STORAGE_PATH; else process.env.KLAURO_STORAGE_PATH = prev.storage;
      if (prev.remote === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA; else process.env.KLAURO_REMOTE_ANALYZER_DATA = prev.remote;
      if (prev.token === undefined) delete process.env.KLAURO_ANALYZER_TOKEN; else process.env.KLAURO_ANALYZER_TOKEN = prev.token;
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

async function getJson(base: string, p: string, token?: string) {
  const res = await fetch(`${base}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function postJson(base: string, p: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

test('account telemetry routes reject cross-project access and migrate pre-analysis events to canonical analysis truth', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-telemetry-account-routes-'));
  const storage = path.join(root, 'storage');
  const remoteData = path.join(root, 'remote-data');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;
  const accounts = new AccountStore(remoteData);
  const owner = await accounts.register({ email: 'runtime-owner@example.com', password: 'password-1234', workspaceName: 'Runtime' });
  const outsider = await accounts.register({ email: 'runtime-outsider@example.com', password: 'password-1234', workspaceName: 'Other' });
  const workspace = (await accounts.listWorkspaces(owner.user.id))[0];
  const project = await accounts.createProject(owner.user.id, workspace.id, { name: 'Orders API' });
  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData, token: 'shared-test-token' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const batch = { events: [{
      event_id: 'pre-analysis-order-event',
      type: 'request',
      method: 'POST',
      route: '/orders',
      status_code: 201,
      trace_id: 'account-pre-analysis',
    }] };
    const accepted = await postJson(base, `/api/telemetry/runtime-events/${project.id}`, batch, owner.token);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.event_count, 1);

    const rejectedPost = await postJson(base, `/api/telemetry/runtime-events/${project.id}`, batch, outsider.token);
    assert.equal(rejectedPost.status, 404);
    const rejectedRead = await getJson(base, `/v1/telemetry/observations?workspace=${project.id}`, outsider.token);
    assert.equal(rejectedRead.status, 404);

    const canonicalId = 'acct_runtime_orders';
    const cas = {
      cas_version: '1.11.0',
      analysis_id: canonicalId,
      analysis_timestamp: new Date().toISOString(),
      system: { id: 'orders', name: 'Orders', type: 'service', root_path: '/orders' },
      nodes: [{ id: 'node-orders', name: 'createOrder', type: 'function', source: { file: 'src/orders.ts', line: 1 } }],
      edges: [],
      entry_points: [{
        id: 'entry-orders', name: 'POST /orders', type: 'http', source_node: 'node-orders',
        trigger: { method: 'POST', path: '/orders' },
        handler: { node_id: 'node-orders', method_name: 'createOrder', file: 'src/orders.ts', line: 1 },
      }],
      analyzer_contributions: [],
    } as unknown as CASOutput;
    const { saveAnalysis } = await import('./storage');
    await saveAnalysis(path.join(remoteData, 'workspaces', canonicalId), cas);
    await accounts.setProjectAnalysisId(owner.user.id, project.id, canonicalId);

    const serviceAccepted = await postJson(base, `/api/telemetry/runtime-events/${project.id}`, { events: [{
      event_id: 'post-analysis-service-event', type: 'request', method: 'POST', route: '/orders', trace_id: 'service-post-analysis',
    }] }, 'shared-test-token');
    assert.equal(serviceAccepted.status, 200);

    const observations = await getJson(base, `/v1/telemetry/observations?workspace=${project.id}&trace_id=account-pre-analysis`, owner.token);
    assert.equal(observations.status, 200);
    assert.equal(observations.body.observations.length, 1);
    assert.notEqual(observations.body.observations[0].correlation.status, 'unmatched');
    const metrics = await getJson(base, `/v1/telemetry/node-metrics?workspace=${project.id}`, owner.token);
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.node_metrics.some((metric: any) => metric.request_count === 2));

    const oversized = await postJson(base, `/api/telemetry/runtime-events/${project.id}`, {
      events: Array.from({ length: 1001 }, (_, index) => ({ event_id: `too-many-${index}`, type: 'log' })),
    }, owner.token);
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

test('telemetry routes: node-metrics read self-heals pre-analysis unmatched observations', async () => {
  // VERIFY(1): emit observations BEFORE analysis, analyze, then READ node-metrics
  // over HTTP — the read must lazily backfill so node metrics populate. This is
  // what makes VPS self-telemetry node-metrics fill in on read.
  const ctx = await boot({ preAnalyze: false });
  try {
    const ws = encodeURIComponent(ctx.workspace);

    // 1. Ingest telemetry for /items/:id while NO analysis exists → unmatched.
    const recon = await postJson(ctx.base, `/api/telemetry/runtime-events/${ws}`, {
      events: [
        { type: 'request', method: 'GET', route: '/items/:id', path: '/items/1', status_code: 200, duration_ms: 10, trace_id: 'pre-1' },
        { type: 'request', method: 'GET', route: '/items/:id', path: '/items/2', status_code: 200, duration_ms: 20, trace_id: 'pre-2' },
        { type: 'error', method: 'GET', route: '/items/:id', path: '/items/3', status_code: 500, duration_ms: 55, error_message: 'boom', trace_id: 'pre-3' },
      ],
    });
    assert.equal(recon.status, 200);
    assert.equal(recon.body.event_count, 3);
    assert.equal(recon.body.correlation_summary.unmatched, 3, 'all 3 land unmatched pre-analysis');

    // 2. node-metrics with observations present but no CAS → empty + note.
    const before = await getJson(ctx.base, `/v1/telemetry/node-metrics?workspace=${ws}`);
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.node_metrics, []);
    assert.equal(before.body.note, 'no analysis for workspace');

    // 3. Analysis now exists.
    await ctx.analyzeAndSave();

    // 4. READ node-metrics again — the route now transitions from the empty
    //    `no analysis` note to a populated rollup that aggregates the SAME
    //    observations ingested pre-analysis. That transition (empty→populated on
    //    read, with the analysis appearing only between the two reads) is the
    //    self-heal: the read lazily loaded the CAS, ran the backfill, and
    //    surfaced the previously-inert observations as node metrics.
    const after = await getJson(ctx.base, `/v1/telemetry/node-metrics?workspace=${ws}`);
    assert.equal(after.status, 200);
    assert.notEqual(after.body.note, 'no analysis for workspace', 'CAS now resolves on read');
    assert.ok(
      Array.isArray(after.body.node_metrics) && after.body.node_metrics.length > 0,
      'node_metrics populate on read after self-heal',
    );
    const totalReq = after.body.node_metrics.reduce((s: number, m: any) => s + m.request_count, 0);
    const totalErr = after.body.node_metrics.reduce((s: number, m: any) => s + m.error_count, 0);
    assert.equal(totalReq, 3, 'all three pre-analysis observations now aggregate into node metrics');
    assert.equal(totalErr, 1, 'the pre-analysis error aggregates too');
    assert.equal(after.body.observation_count, 3, 'all pre-analysis observations are read back');
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
