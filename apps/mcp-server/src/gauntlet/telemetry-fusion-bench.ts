













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

  expected: TelemetryFusionBenchExpectation[];

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

    { service: 'orders-api', endpoint: '/api/orders', method: 'GET', duration_ms: 40, count: 800 },

    { service: 'orders-api', endpoint: '/api/orders', method: 'GET', duration_ms: 2200, count: 5 },

    { service: 'payments', endpoint: '/v1/charges', method: 'POST', error: true, count: 2 },

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
