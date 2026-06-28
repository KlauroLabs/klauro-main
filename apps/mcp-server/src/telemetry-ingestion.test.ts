import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildOperationalPriorities } from './product';
import { simulateRuntimeTelemetry } from './runtime-simulation';
import {
  ingestTelemetryBatch,
  ingestedTelemetryDir,
  loadIngestedTelemetry,
  loadTelemetryObservations,
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
