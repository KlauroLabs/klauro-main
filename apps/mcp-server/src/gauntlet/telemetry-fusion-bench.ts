/**
 * BLACKBOX bench for WS-A telemetry fusion — asserts fuseTelemetry() produces
 * the correct hot/slow/error RuntimeFacts on the right CAS nodes from a batch
 * of OTEL-ish spans, and honestly rejects a decoy span (no matching route) as
 * unmatched rather than force-fitting it.
 *
 * This bench is a pure fixture-CAS test: it does NOT import the analyzer
 * engine (no createOrchestrator/orchestrateAnalysis/analyzeProject) and does
 * NOT set any AI/model env — fuseTelemetry/correlateRuntimeEvent are
 * deterministic structural correlation, no AI involved. The fixture CAS below
 * stands in for "a stored analysis" the way a real workspace's CAS would look
 * after `analyze_codebase`; production wiring loads the real one from storage.
 */

import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';
import { fuseTelemetry, type RuntimeFact, type TelemetrySpan } from '../telemetry-fusion';

export interface TelemetryFusionBenchExpectation {
  service: string;
  endpoint: string;
  expect_node_id: string;
  expect_kind: RuntimeFact['kind'];
}

export interface TelemetryFusionBenchFixture {
  name: string;
  cas: CASOutput;
  spans: TelemetrySpan[];
  /** Spans expected to correlate, keyed by (service, endpoint). */
  expected: TelemetryFusionBenchExpectation[];
  /** Spans expected to be rejected as unmatched (decoys). */
  expected_unmatched: Array<{ service: string; endpoint: string }>;
}

export interface TelemetryFusionBenchResult {
  fixture: string;
  correct: number;
  total: number;
  f1: number;
  decoy_handled_honestly: boolean;
  mismatches: string[];
}

/** The fixture used by the bench: one entry point, one exit point, one decoy span with no static match. */
export function buildFixture(): TelemetryFusionBenchFixture {
  const cas: CASOutput = {
    cas_version: '1.7.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'telemetry-fusion-bench-fixture',
    system: { name: 'fusion-fixture', root_path: '/fixture', type: 'service' } as any,
    nodes: [
      {
        id: 'node:listOrders',
        name: 'listOrders',
        type: 'function',
        source: { file: 'src/routes/orders.ts', line: 8, end_line: 22 },
      } as any,
      {
        id: 'node:chargeCard',
        name: 'chargeCard',
        type: 'function',
        source: { file: 'src/payments/charge.ts', line: 12, end_line: 30 },
      } as any,
    ],
    edges: [],
    entry_points: [
      {
        id: 'entry:listOrders',
        source_node: 'node:listOrders',
        type: 'http',
        name: 'GET /api/orders',
        trigger: { method: 'GET', path: '/api/orders' },
        handler: { node_id: 'node:listOrders', method_name: 'listOrders', file: 'src/routes/orders.ts', line: 8 },
      } as any,
    ],
    exit_points: [
      {
        id: 'exit:chargeCard',
        source_node: 'node:chargeCard',
        type: 'api',
        name: 'stripe-charge',
        target: { endpoint: '/v1/charges' },
        operation: { method: 'POST' },
      } as any,
    ],
    analyzer_contributions: [],
  } as unknown as CASOutput;

  const spans: TelemetrySpan[] = [
    // hot: high call volume, low latency, on the real entry point
    { service: 'orders-api', endpoint: '/api/orders', method: 'GET', duration_ms: 40, count: 800 },
    // slow: latency crosses the slow threshold, on the same entry point
    { service: 'orders-api', endpoint: '/api/orders', method: 'GET', duration_ms: 2200, count: 5 },
    // error: on the exit point (outbound payment call)
    { service: 'payments', endpoint: '/v1/charges', method: 'POST', error: true, count: 2 },
    // DECOY: no such route/service in the CAS — must be rejected, not force-fit.
    { service: 'ghost-service', endpoint: '/v9/nonexistent', method: 'GET', duration_ms: 9999, count: 9999 },
  ];

  return {
    name: 'orders-payments-fixture',
    cas,
    spans,
    expected: [
      { service: 'orders-api', endpoint: '/api/orders', expect_node_id: 'node:listOrders', expect_kind: 'hot' },
      { service: 'orders-api', endpoint: '/api/orders', expect_node_id: 'node:listOrders', expect_kind: 'slow' },
      { service: 'payments', endpoint: '/v1/charges', expect_node_id: 'node:chargeCard', expect_kind: 'error' },
    ],
    expected_unmatched: [{ service: 'ghost-service', endpoint: '/v9/nonexistent' }],
  };
}

export function runTelemetryFusionBench(fixture: TelemetryFusionBenchFixture = buildFixture()): TelemetryFusionBenchResult {
  const { facts, unmatched } = fuseTelemetry(fixture.cas, fixture.spans);
  const mismatches: string[] = [];
  let correct = 0;
  const total = fixture.expected.length + fixture.expected_unmatched.length;

  for (const expectation of fixture.expected) {
    const hit = facts.find(fact =>
      fact.service === expectation.service &&
      fact.endpoint === expectation.endpoint &&
      fact.kind === expectation.expect_kind &&
      fact.node_id === expectation.expect_node_id);
    if (hit) correct++;
    else mismatches.push(`expected ${expectation.service}${expectation.endpoint} -> ${expectation.expect_kind}@${expectation.expect_node_id}, got ${JSON.stringify(facts.filter(f => f.service === expectation.service && f.endpoint === expectation.endpoint))}`);
  }

  for (const decoy of fixture.expected_unmatched) {
    const rejectedHonestly = unmatched.some(entry => entry.service === decoy.service && entry.endpoint === decoy.endpoint);
    const forceFit = facts.some(fact => fact.service === decoy.service && fact.endpoint === decoy.endpoint);
    if (rejectedHonestly && !forceFit) correct++;
    else mismatches.push(`decoy ${decoy.service}${decoy.endpoint} should be unmatched, forceFit=${forceFit}, rejected=${rejectedHonestly}`);
  }

  const decoyHandledHonestly = fixture.expected_unmatched.every(decoy =>
    unmatched.some(entry => entry.service === decoy.service && entry.endpoint === decoy.endpoint) &&
    !facts.some(fact => fact.service === decoy.service && fact.endpoint === decoy.endpoint));

  return {
    fixture: fixture.name,
    correct,
    total,
    f1: total > 0 ? correct / total : 0,
    decoy_handled_honestly: decoyHandledHonestly,
    mismatches,
  };
}
