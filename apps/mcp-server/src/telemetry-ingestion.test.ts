import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildNodeRuntimeMetrics, buildOperationalPriorities } from './product';
import { simulateRuntimeTelemetry } from './runtime-simulation';
import {
  appendIngestedTelemetry,
  backfillIngestedTelemetry,
  ingestTelemetryBatch,
  ingestedTelemetryDir,
  loadIngestedTelemetry,
  loadTelemetryObservations,
  migrateIngestedTelemetryProject,
  summarizeRouteMetrics,
  type TelemetryEvent,
} from './telemetry-ingestion';

function buildCas(root: string): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-telemetry-test',
    system: { id: 'system-telemetry', name: 'Telemetry System', type: 'service', root_path: root },
    nodes: [{
      id: 'node-billing-service',
      name: 'BillingService',
      type: 'service',
      source: { file: 'src/billing.service.ts', line: 12, end_line: 80 },
    }, {
      id: 'node-create-invoice',
      name: 'createInvoice',
      type: 'method',
      source: { file: 'src/billing.service.ts', line: 20, end_line: 40 },
    }],
    edges: [],
    entry_points: [{
      id: 'entry-create-invoice',
      name: 'POST /invoices',
      type: 'http',
      source_node: 'node-billing-service',
      trigger: { method: 'POST', path: '/invoices' },
      handler: { node_id: 'node-billing-service', method_name: 'createInvoice', file: 'src/billing.service.ts', line: 20 },
    }],
    runtime_static_links: [{
      id: 'runtime-entry-create-invoice',
      kind: 'entry-point',
      static_id: 'entry-create-invoice',
      runtime_signal: 'http:POST:/invoices',
      telemetry_status: 'instrumentable',
      confidence: 0.92,
      instrumentation_points: ['src/billing.service.ts:20'],
      evidence: [{ kind: 'route', source: '/invoices', confidence: 0.92 }],
    }],
    change_risks: [{
      node_id: 'entry-create-invoice',
      risk_level: 'high',
      risk_factors: [],
      downstream_impact: {
        direct_callers: [],
        transitive_callers: [],
        affected_call_chains: [],
        affected_entry_points: ['entry-create-invoice'],
      },
      test_protection: {
        has_direct_tests: false,
        has_integration_tests: false,
      },
      recommendations: [],
    }],
    change_risk_summary: {
      high_risk_nodes: ['entry-create-invoice'],
      untested_critical_paths: ['entry-create-invoice'],
      recent_hotspots: [],
    },
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
  } as unknown as CASOutput;
}

async function withTempStorage(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-project-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;
  try {
    await run(root);
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fs.remove(root);
    await fs.remove(storage);
  }
}

test('ingestTelemetryBatch correlates events and reports unmatched hints instead of dropping them', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);
    const events: TelemetryEvent[] = [
      { kind: 'request', method: 'POST', route: '/invoices', status: 201, duration_ms: 120, p95_ms: 150, p99_ms: 2400, rate_per_min: 18, trace_id: 'trace-a' },
      { kind: 'request', method: 'POST', route: '/invoices', status: 201, duration_ms: 90, trace_id: 'trace-b' },
      {
        kind: 'error',
        method: 'POST',
        route: '/invoices',
        status: 500,
        duration_ms: 1800,
        trace_id: 'trace-c',
        error: {
          type: 'TypeError',
          message: 'invoice total is undefined',
          stack_top_frames: [{ file: 'src/billing.service.ts', line: 25, function: 'createInvoice' }],
        },
      },
      { kind: 'error', method: 'GET', route: '/ghost-route', status: 500, error: { message: 'missing handler' } },
      { kind: 'request', method: 'GET', route: '/ghost-route', status: 404 },
    ];

    const result = await ingestTelemetryBatch(cas, root, events);

    assert.equal(result.source, 'ingested');
    assert.equal(result.event_count, 5);
    assert.equal(result.correlation_summary.matched + result.correlation_summary.partial, 3);
    assert.equal(result.correlation_summary.unmatched, 2);
    assert.equal(result.unmatched.count, 2);
    assert.ok(result.unmatched.top_hints.some(entry => entry.hint.includes('/ghost-route')));
    assert.ok(result.matched_targets.length > 0);
    assert.equal(result.matched_targets[0].latency.p99_ms, 2400);
    assert.equal(result.matched_targets[0].rates.throughput_per_min, 18);
    assert.ok(result.observations.every(observation => observation.source === 'ingested'));

    const stored = await loadIngestedTelemetry(root);
    assert.equal(stored.length, 5);
    assert.equal(stored.filter(observation => observation.correlation.status === 'unmatched').length, 2);
  });
});

// ---------------------------------------------------------------------------
// Direct static_id/node_id/entry_point_id correlation (Tier 4 join input
// boundary — see self-telemetry.test.ts's mapSdkEvent tests for the SDK-side
// half of this fix). correlateRuntimeEvent (product.ts) has always checked
// event.static_id/node_id/entry_point_id/exit_point_id/call_chain_id BEFORE
// route/function-hint/stack fuzzy matching, but TelemetryEvent — the public
// contract for BOTH the ingest_telemetry MCP tool and the SDK HTTP route —
// had no field to carry them, so a caller that already knew its own static id
// (an installed SDK wrapping an instrumented call site, or any integrator
// reading getRuntimeEventContract's advertised correlation_order) could never
// reach that path. This locks in that a direct id, with NO route/method/path
// at all, resolves the observation on its own.
// ---------------------------------------------------------------------------
test('a TelemetryEvent carrying only static_id (no route/method/path) still resolves via direct correlation', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);
    const events: TelemetryEvent[] = [
      { kind: 'request', static_id: 'node-create-invoice', duration_ms: 15, status: 200 },
    ];

    const result = await ingestTelemetryBatch(cas, root, events);

    assert.equal(result.correlation_summary.matched + result.correlation_summary.partial, 1);
    assert.equal(result.correlation_summary.unmatched, 0);
    assert.equal(result.observations[0].correlation.best_match?.id, 'node-create-invoice');
    // 'partial' here, not 'unmatched': a single direct-id hit with no
    // corroborating runtime_static_link is real correlation (best_match IS
    // set), just correlateRuntimeEvent's own matched-vs-partial distinction
    // (product.ts) — the case this test guards is that it resolves AT ALL.
    assert.equal(result.observations[0].correlation.status, 'partial');
  });
});

test('an explicit node_id on the event wins over hint-resolution (caller-asserted fact beats a guess)', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);
    // function_hint would resolve to nothing (no node named this); node_id
    // must still land the observation on the real node.
    const events: TelemetryEvent[] = [
      { kind: 'request', node_id: 'node-create-invoice', function_hint: 'thisFunctionDoesNotExist' },
    ];

    const result = await ingestTelemetryBatch(cas, root, events);
    assert.equal(result.observations[0].correlation.best_match?.id, 'node-create-invoice');
  });
});

test('ingestTelemetryBatch persists raw observations when there is NO analysis (cas=null)', async () => {
  await withTempStorage(async root => {
    // Simulate the "project not analyzed yet" path: pass cas=null. Raw runtime
    // observations MUST still persist (route/status/duration/error/timestamp),
    // marked unmatched — never dropped just because analysis has not run.
    const events: TelemetryEvent[] = [
      { kind: 'request', method: 'GET', path: '/opt/klauro/health', status: 200, duration_ms: 8 },
      { kind: 'request', method: 'GET', path: '/opt/klauro/health', status: 200, duration_ms: 12 },
      { kind: 'error', method: 'POST', path: '/opt/klauro/analyze', status: 500, duration_ms: 250, error: { message: 'boom' } },
    ];

    const result = await ingestTelemetryBatch(null, root, events);

    assert.equal(result.event_count, 3, 'all raw events ingested, none dropped');
    assert.equal(result.correlation_summary.matched, 0);
    assert.equal(result.correlation_summary.partial, 0);
    assert.equal(result.correlation_summary.unmatched, 3, 'no CAS => all unmatched');

    // Persisted to the SAME store loadTelemetryObservations reads from.
    const stored = await loadIngestedTelemetry(root);
    assert.equal(stored.length, 3, 'raw observations persisted without a CAS');
    const errObs = stored.find(o => o.event.type === 'error');
    assert.ok(errObs, 'error observation persisted');
    assert.equal(errObs!.event.status_code, 500);
    assert.equal(errObs!.event.duration_ms, 250);
    assert.ok(errObs!.event.timestamp, 'timestamp preserved on raw observation');

    const set = await loadTelemetryObservations(root, { source: 'ingested' });
    assert.equal(set.ingested_count, 3);

    // CAS-free per-route aggregation is visible pre-analysis.
    const metrics = summarizeRouteMetrics(set.observations);
    const health = metrics.find(m => m.route === '/opt/klauro/health');
    assert.ok(health, 'per-route metric for /health');
    assert.equal(health!.request_count, 2);
    assert.equal(health!.error_count, 0);
    assert.equal(typeof health!.latency.p50_ms, 'number');
    const analyze = metrics.find(m => m.route === '/opt/klauro/analyze');
    assert.ok(analyze && analyze.error_count === 1 && analyze.error_rate === 1);
  });
});

test('backfillIngestedTelemetry upgrades pre-analysis unmatched observations once a CAS appears', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);

    // 1. Emit telemetry BEFORE any analysis (cas=null) — the route matches an
    //    entry point in `cas`, plus a stack-frame hint onto a node — all land
    //    as `unmatched` because there is no CAS to correlate against yet.
    const events: TelemetryEvent[] = [
      { kind: 'request', method: 'POST', route: '/invoices', status: 201, duration_ms: 120, trace_id: 'bf-1' },
      { kind: 'request', method: 'POST', route: '/invoices', status: 201, duration_ms: 90, trace_id: 'bf-2' },
      {
        kind: 'error', method: 'POST', route: '/invoices', status: 500, duration_ms: 1800, trace_id: 'bf-3',
        error: { type: 'TypeError', message: 'boom', stack_top_frames: [{ file: 'src/billing.service.ts', line: 25, function: 'createInvoice' }] },
      },
      { kind: 'request', method: 'GET', route: '/ghost-route', status: 404, trace_id: 'bf-4' },
    ];
    await ingestTelemetryBatch(null, root, events);

    const beforeSet = await loadTelemetryObservations(root, { source: 'ingested' });
    assert.equal(beforeSet.observations.length, 4);
    assert.equal(beforeSet.observations.every(o => o.correlation.status === 'unmatched'), true, 'all unmatched pre-analysis');
    assert.equal(buildNodeRuntimeMetrics(cas, beforeSet.observations).every(m => m.type === 'unmatched'), true,
      'node metrics have no static target before backfill');

    // 2. An analysis now exists — run the backfill.
    const result = await backfillIngestedTelemetry(cas, root);
    assert.equal(result.upgraded, 3, 'the 3 /invoices observations upgrade; /ghost-route stays unmatched');
    assert.equal(result.scanned, 4);
    assert.equal(result.days_rewritten.length, 1);

    // 3. Previously-unmatched observations now correlate to CAS nodes, and the
    //    raw factual fields are untouched.
    const afterSet = await loadTelemetryObservations(root, { source: 'ingested' });
    const matched = afterSet.observations.filter(o => o.correlation.status !== 'unmatched');
    assert.equal(matched.length, 3);
    assert.equal(matched.every(o => o.correlation.matches.some(m => m.id === 'entry-create-invoice')), true);
    const invoiceReq = afterSet.observations.find(o => o.event.trace_id === 'bf-1');
    assert.equal(invoiceReq!.event.status_code, 201, 'raw status untouched');
    assert.equal(invoiceReq!.event.duration_ms, 120, 'raw duration untouched');
    assert.equal(invoiceReq!.event.route, '/invoices', 'raw route untouched');
    assert.equal(afterSet.observations.find(o => o.event.trace_id === 'bf-4')!.correlation.status, 'unmatched',
      'genuinely unmatchable route stays unmatched');

    // 4. buildNodeRuntimeMetrics now returns non-empty per-node metrics.
    const nodeMetrics = buildNodeRuntimeMetrics(cas, afterSet.observations);
    const invoiceNode = nodeMetrics.find(m => m.type !== 'unmatched');
    assert.ok(invoiceNode, 'a correlated node metric exists after backfill');
    assert.equal(invoiceNode!.request_count >= 2, true);
    assert.equal(invoiceNode!.error_count >= 1, true);

    // 5. Idempotent: a second pass upgrades nothing and rewrites no files.
    const second = await backfillIngestedTelemetry(cas, root);
    assert.equal(second.upgraded, 0);
    assert.equal(second.days_rewritten.length, 0);
  });
});

test('stable event ids make ambiguous delivery retries idempotent', async () => {
  await withTempStorage(async root => {
    const event: TelemetryEvent = {
      event_id: 'sdk-event-stable-1',
      kind: 'request',
      method: 'POST',
      route: '/invoices',
      status: 201,
    };
    const [first, second] = await Promise.all([
      ingestTelemetryBatch(null, root, [event]),
      ingestTelemetryBatch(null, root, [event]),
    ]);
    assert.equal(first.observations[0].id, second.observations[0].id);
    const stored = await loadIngestedTelemetry(root);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].event.attributes?.telemetry_event_id, event.event_id);
  });
});

test('serialized append and backfill preserve concurrent pre-analysis events', async () => {
  await withTempStorage(async root => {
    const first = ingestTelemetryBatch(null, root, [{
      event_id: 'pre-analysis-first', kind: 'request', method: 'POST', route: '/invoices', trace_id: 'serial-first',
    }]);
    const second = ingestTelemetryBatch(null, root, [{
      event_id: 'pre-analysis-second', kind: 'request', method: 'GET', route: '/ghost-route', trace_id: 'serial-second',
    }]);
    await Promise.all([first, second]);
    const backfill = backfillIngestedTelemetry(buildCas(root), root);
    const third = ingestTelemetryBatch(null, root, [{
      event_id: 'pre-analysis-third', kind: 'request', method: 'POST', route: '/invoices', trace_id: 'serial-third',
    }]);
    await Promise.all([backfill, third]);
    const stored = await loadIngestedTelemetry(root);
    assert.equal(stored.length, 3);
    assert.deepEqual(new Set(stored.map(item => item.event.trace_id)), new Set(['serial-first', 'serial-second', 'serial-third']));
    assert.notEqual(stored.find(item => item.event.trace_id === 'serial-first')?.correlation.status, 'unmatched');
  });
});

test('pre-analysis observations migrate idempotently to the canonical analysis bucket', async () => {
  await withTempStorage(async root => {
    await ingestTelemetryBatch(null, 'prj-pre-analysis', [{
      event_id: 'migration-event', kind: 'request', method: 'POST', route: '/invoices',
    }]);
    assert.equal(await migrateIngestedTelemetryProject('prj-pre-analysis', root), 1);
    assert.equal(await migrateIngestedTelemetryProject('prj-pre-analysis', root), 0);
    const canonical = await loadIngestedTelemetry(root);
    assert.equal(canonical.length, 1);
    const backfill = await backfillIngestedTelemetry(buildCas(root), root);
    assert.equal(backfill.upgraded, 1);
    assert.notEqual((await loadIngestedTelemetry(root))[0].correlation.status, 'unmatched');
  });
});

test('rejects oversized batches instead of acknowledging silent truncation', async () => {
  await withTempStorage(async root => {
    const events = Array.from({ length: 1001 }, (_, index): TelemetryEvent => ({
      event_id: `oversized-${index}`,
      kind: 'log',
    }));
    await assert.rejects(ingestTelemetryBatch(null, root, events), /limited to 1000 events/);
    assert.equal((await loadIngestedTelemetry(root)).length, 0);
  });
});

test('stack frame and file hints resolve events onto CAS nodes', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);
    const result = await ingestTelemetryBatch(cas, root, [{
      kind: 'error',
      error: {
        type: 'RuntimeError',
        message: 'boom',
        stack_top_frames: [{ file: 'app/src/billing.service.ts', line: 25, function: 'createInvoice' }],
      },
    }, {
      kind: 'log',
      file_hint: 'src/billing.service.ts',
      function_hint: 'createInvoice',
    }], { persist: false });

    assert.equal(result.correlation_summary.unmatched, 0);
    for (const observation of result.observations) {
      assert.ok(observation.correlation.matches.some(match => match.id === 'node-create-invoice'));
    }
  });
});

test('#32: an observation keyed by a container-absolute source path joins a node keyed by a workspace-absolute path (self-telemetry key-identity fix)', async () => {
  await withTempStorage(async root => {
    // Reproduce the real defect shape observed on the deployed Klauro-self
    // project: the CAS node's file is recorded under the analysis WORKSPACE
    // root (e.g. `/data/workspaces/<analysis-id>/...`, per
    // remote-analyzer-service.ts `workspacePath`), while a self-instrumented
    // runtime process emits telemetry stack/file hints from wherever ITS OWN
    // process happens to be mounted (e.g. `/app/...`, per
    // Dockerfile.analyzer `WORKDIR /app`). Neither is a literal suffix of the
    // other, so the old `pathsCompatible`-only join left every such
    // observation `unmatched` and facet-6 (telemetry) empty for the node.
    const cas = buildCas(root);
    cas.nodes = [{
      id: 'node-create-invoice-workspace',
      name: 'createInvoice',
      type: 'method',
      source: {
        file: '/data/workspaces/prj_test123456789012/apps/mcp-server/src/billing.service.ts',
        line: 20,
        end_line: 40,
      },
    } as any];
    cas.entry_points = [];
    cas.runtime_static_links = [];

    const result = await ingestTelemetryBatch(cas, root, [{
      kind: 'error',
      error: {
        type: 'RuntimeError',
        message: 'boom',
        stack_top_frames: [{
          file: '/app/apps/mcp-server/src/billing.service.ts',
          line: 25,
          function: 'createInvoice',
        }],
      },
    }, {
      kind: 'log',
      file_hint: '/app/apps/mcp-server/src/billing.service.ts',
      function_hint: 'createInvoice',
    }], { persist: true });

    assert.equal(result.correlation_summary.unmatched, 0, 'container-absolute hints now correlate onto the workspace-absolute node');
    for (const observation of result.observations) {
      assert.ok(
        observation.correlation.matches.some(match => match.id === 'node-create-invoice-workspace'),
        'each observation resolves to the CAS node despite the differing mount-root prefix'
      );
    }

    // The telemetry facet (buildNodeRuntimeMetrics) now produces a populated,
    // node-correlated entry instead of an unmatched-route bucket.
    const stored = await loadTelemetryObservations(root, { source: 'ingested' });
    const metrics = buildNodeRuntimeMetrics(cas, stored.observations);
    const nodeMetric = metrics.find(m => m.static_id === 'node-create-invoice-workspace');
    assert.ok(nodeMetric, 'facet-6 node metric exists for the workspace-keyed node');
    assert.notEqual(nodeMetric!.type, 'unmatched');
  });
});

test('pathsCompatible-only join stays a no-op regression guard: unrelated absolute paths do not spuriously match', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);
    cas.nodes = [{
      id: 'node-unrelated',
      name: 'unrelatedHandler',
      type: 'method',
      source: { file: '/data/workspaces/prj_a/packages/utils/src/index.ts', line: 1, end_line: 5 },
    } as any];
    cas.entry_points = [];
    cas.runtime_static_links = [];

    // Shares only the bare filename with the node above (no deep directory
    // chain in common) — must NOT be treated as the same file.
    const result = await ingestTelemetryBatch(cas, root, [{
      kind: 'log',
      file_hint: '/opt/other-service/index.ts',
    }], { persist: false });

    assert.equal(result.correlation_summary.unmatched, 1, 'a bare shared filename alone must not spuriously correlate');
  });
});

test('ingested error volume drives operational priorities with ingested provenance and resolvable static target', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);
    const errors: TelemetryEvent[] = Array.from({ length: 8 }, (_, index) => ({
      kind: 'error' as const,
      method: 'POST',
      route: '/invoices',
      status: 500,
      duration_ms: 1500,
      trace_id: `trace-${index}`,
      volume: 40,
      error: { type: 'TypeError', message: 'invoice total is undefined' },
    }));
    await ingestTelemetryBatch(cas, root, errors);

    const set = await loadTelemetryObservations(root, { source: 'ingested' });
    assert.equal(set.ingested_count, 8);
    assert.equal(set.simulated_count, 0);

    const priorities = buildOperationalPriorities(cas, set.observations, { limit: 5 });
    assert.equal(priorities.sources.ingested, 8);
    assert.equal(priorities.sources.simulated, 0);
    const top = priorities.priorities[0];
    assert.equal(top.source, 'ingested');
    assert.ok(top.runtime.errors >= 8);
    assert.ok(top.priority_score >= 60);
    assert.ok(top.static_target);
    assert.equal(top.static_target?.file, 'src/billing.service.ts');
    assert.equal(top.static_risk.change_risk, 'high');
  });
});

test('simulated observations never masquerade as ingested telemetry', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);
    await simulateRuntimeTelemetry(cas, root, { scenario: 'bug-hunt', eventCount: 10, seed: 'provenance', persist: true });
    await ingestTelemetryBatch(cas, root, [{
      kind: 'request', method: 'POST', route: '/invoices', status: 201, duration_ms: 50,
    }]);

    const ingestedOnly = await loadTelemetryObservations(root, { source: 'ingested' });
    assert.equal(ingestedOnly.observations.length, 1);
    assert.ok(ingestedOnly.observations.every(observation => observation.source === 'ingested'));

    const simulatedOnly = await loadTelemetryObservations(root, { source: 'simulated' });
    assert.equal(simulatedOnly.observations.length, 10);
    assert.ok(simulatedOnly.observations.every(observation => observation.source === 'simulated'));

    const everything = await loadTelemetryObservations(root, { source: 'all' });
    assert.equal(everything.observations.length, 11);
    const mixedPriorities = buildOperationalPriorities(cas, everything.observations);
    assert.equal(mixedPriorities.sources.ingested, 1);
    assert.equal(mixedPriorities.sources.simulated, 10);
    assert.ok(mixedPriorities.priorities.every(priority => ['ingested', 'simulated', 'mixed'].includes(priority.source)));
  });
});

test('ingested telemetry keeps a rolling daily window', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);
    const staleDay = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dryRun = await ingestTelemetryBatch(cas, root, [{
      kind: 'request', method: 'POST', route: '/invoices',
    }], { persist: false });
    const staleObservation = { ...dryRun.observations[0], recorded_at: `${staleDay}T00:00:00.000Z` };
    const staleFile = path.join(ingestedTelemetryDir(root), `${staleDay}.json`);
    await fs.outputJson(staleFile, [staleObservation]);

    let stored = await loadIngestedTelemetry(root);
    assert.equal(stored.length, 1);

    await ingestTelemetryBatch(cas, root, [{ kind: 'request', method: 'POST', route: '/invoices' }]);

    assert.equal(await fs.pathExists(staleFile), false);
    stored = await loadIngestedTelemetry(root);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].source, 'ingested');
  });
});

test('persisting into a fresh (non-existent) ingested-telemetry dir succeeds without ENOENT', async () => {
  await withTempStorage(async root => {
    const cas = buildCas(root);
    // Simulate the first self-telemetry ingest for a brand-new project: build an
    // observation, then remove the ingested-telemetry dir so it does NOT exist
    // when append runs (the prod race: the day-file's parent dir is absent and
    // fs.move's chmod hit ENOENT). append must recreate it and persist cleanly.
    const dryRun = await ingestTelemetryBatch(cas, root, [{
      kind: 'request', method: 'POST', route: '/invoices', status: 201, duration_ms: 42,
    }], { persist: false });
    const dir = ingestedTelemetryDir(root);
    await fs.remove(dir);
    assert.equal(await fs.pathExists(dir), false);

    await appendIngestedTelemetry(root, dryRun.observations);

    assert.equal(await fs.pathExists(dir), true);
    const stored = await loadIngestedTelemetry(root);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].source, 'ingested');
  });
});
