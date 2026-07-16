import test from 'node:test';
import assert from 'node:assert/strict';
import type { NodeRuntimeMetrics } from './product';
import {
  attachEntryPointTelemetry,
  entryRoutesCompatible,
  matchTelemetryForEntryPoint,
  normalizeEntryRoute,
} from './server';

/**
 * GAP #32: entry-point telemetry keying.
 *
 * Runtime observations are commonly correlated (or only ever recorded) by a
 * resolved static/node id, or — when correlation misses (e.g. a self-telemetry
 * loop whose stack-frame hints live under a different container mount root
 * than the analysis workspace path) — only by the raw route+method the HTTP
 * request carried. `get_entry_points` previously never consulted runtime
 * metrics at all, so an entry point's own request_count/error_rate/p50-p95-p99
 * never appeared even when a metric existed for its exact route. These tests
 * cover the fix in server.ts: `attachEntryPointTelemetry` / the route-fallback
 * join in `matchTelemetryForEntryPoint`.
 */

function buildMetric(overrides: Partial<NodeRuntimeMetrics> = {}): NodeRuntimeMetrics {
  return {
    static_id: 'unmatched-runtime',
    label: 'POST /v1/analyze',
    type: 'unmatched',
    request_count: 42,
    error_count: 2,
    error_rate: 0.0476,
    status_code_distribution: { '200': 40, '500': 2 },
    latency: { p50_ms: 12, p95_ms: 88, p99_ms: 140 },
    slow_events: 1,
    observations: 42,
    traces: 3,
    source: 'ingested',
    ...overrides,
  };
}

test('normalizeEntryRoute treats params, trailing slash, and case as equivalent', () => {
  assert.equal(normalizeEntryRoute('/v1/Analyze/'), '/v1/analyze');
  assert.equal(normalizeEntryRoute('/v1/invoices/:id'), '/v1/invoices/:param');
  assert.equal(normalizeEntryRoute('/v1/invoices/{id}'), '/v1/invoices/:param');
});

test('entryRoutesCompatible matches wildcard segments and literal suffixes, not unrelated routes', () => {
  assert.equal(entryRoutesCompatible('/v1/invoices/:param', '/v1/invoices/123'), true);
  assert.equal(entryRoutesCompatible('/v1/analyze', '/v1/analyze'), true);
  assert.equal(entryRoutesCompatible('/v1/analyze', '/v1/other'), false);
});

test('an entry point with no resolved static id still joins telemetry recorded only by route+method (the GAP #32 case)', () => {
  const entryPoint = {
    id: 'entry-analyze',
    name: 'POST /v1/analyze',
    type: 'http',
    source_node: 'node-analyze-handler',
    trigger: { method: 'POST', path: '/v1/analyze' },
  };
  // Metric carries NO static_id/node_id/entry_point_id match (as if correlation
  // missed, e.g. a container-mount-root mismatch) — only the raw route+method.
  const metric = buildMetric({ static_id: 'unmatched-runtime', route: '/v1/analyze', method: 'POST' });

  const match = matchTelemetryForEntryPoint(entryPoint, [metric]);
  assert.ok(match, 'route+method fallback join must find the metric');
  assert.equal(match!.request_count, 42);

  const [attached] = attachEntryPointTelemetry([entryPoint], [metric]) as any[];
  assert.deepEqual(attached.telemetry, {
    request_count: 42,
    error_rate: 0.0476,
    p50: 12,
    p95: 88,
    p99: 140,
  });
});

test('an entry point with a route parameter still joins telemetry recorded against a concrete request path', () => {
  const entryPoint = {
    id: 'entry-invoice-get',
    trigger: { method: 'GET', path: '/v1/invoices/:id' },
  };
  const metric = buildMetric({ route: '/v1/invoices/482', method: 'GET', request_count: 7, error_rate: 0 });

  const [attached] = attachEntryPointTelemetry([entryPoint], [metric]) as any[];
  assert.ok(attached.telemetry);
  assert.equal(attached.telemetry.request_count, 7);
});

test('a resolved static/node id match is preferred over (and does not require) the route fallback', () => {
  const entryPoint = { id: 'entry-billing', handler: { node_id: 'node-billing' }, trigger: { method: 'POST', path: '/billing' } };
  const metric = buildMetric({ static_id: 'node-billing', route: '/somewhere-else', method: 'GET', request_count: 99 });

  const match = matchTelemetryForEntryPoint(entryPoint, [metric]);
  assert.ok(match);
  assert.equal(match!.request_count, 99);
});

test('an entry point with no matching metric is returned byte-for-byte unchanged (no telemetry key added)', () => {
  const entryPoint = { id: 'entry-unmatched', trigger: { method: 'GET', path: '/nothing/here' } };
  const metric = buildMetric({ route: '/v1/analyze', method: 'POST' });

  const [attached] = attachEntryPointTelemetry([entryPoint], [metric]);
  assert.deepEqual(attached, entryPoint);
  assert.equal('telemetry' in attached, false);
});

test('attachEntryPointTelemetry is a no-op pass-through when there are no runtime metrics at all', () => {
  const entryPoint = { id: 'entry-x', trigger: { method: 'GET', path: '/x' } };
  const result = attachEntryPointTelemetry([entryPoint], []);
  assert.deepEqual(result, [entryPoint]);
});

/**
 * Goal 2 — serialization pass-through of NEW optional per-entry-point fields
 * (input, output, security incl. enforcement, capabilities, interaction_reach,
 * deployable_id, deployable_name). Entries are spread verbatim in
 * attachEntryPointTelemetry (never rebuilt field-by-field), so any of these
 * fields present on the raw CAS entry point object must survive untouched, and
 * an entry point that lacks them must not gain them.
 */
test('optional per-entry-point fields (input/output/security/capabilities/interaction_reach/deployable_id/deployable_name) pass through when present', () => {
  const richEntryPoint = {
    id: 'entry-rich',
    trigger: { method: 'POST', path: '/v1/orders' },
    input: { type: 'json', schema: 'CreateOrderRequest' },
    output: { type: 'json', status_codes: [201, 400] },
    security: { authenticated: true, enforcement: 'middleware:requireAuth' },
    capabilities: [{ capability_id: 'cap_orders', capability_name: 'Order Management', role: 'primary' }],
    interaction_reach: 'external',
    deployable_id: 'deployable_api',
    deployable_name: 'orders-api',
  };
  const metric = buildMetric({ route: '/v1/orders', method: 'POST' });

  const [attached] = attachEntryPointTelemetry([richEntryPoint], [metric]) as any[];
  assert.deepEqual(attached.input, richEntryPoint.input);
  assert.deepEqual(attached.output, richEntryPoint.output);
  assert.deepEqual(attached.security, richEntryPoint.security);
  assert.deepEqual(attached.capabilities, richEntryPoint.capabilities);
  assert.equal(attached.interaction_reach, richEntryPoint.interaction_reach);
  assert.equal(attached.deployable_id, richEntryPoint.deployable_id);
  assert.equal(attached.deployable_name, richEntryPoint.deployable_name);
  assert.ok(attached.telemetry, 'telemetry facet still attaches alongside the pass-through fields');
});

test('an older entry point that lacks the new optional fields does not have them fabricated', () => {
  const plainEntryPoint = { id: 'entry-plain', trigger: { method: 'GET', path: '/v1/health' } };
  const [attached] = attachEntryPointTelemetry([plainEntryPoint], []);
  for (const field of ['input', 'output', 'security', 'capabilities', 'interaction_reach', 'deployable_id', 'deployable_name', 'telemetry']) {
    assert.equal(field in attached, false, `${field} must be omitted, not fabricated`);
  }
});
