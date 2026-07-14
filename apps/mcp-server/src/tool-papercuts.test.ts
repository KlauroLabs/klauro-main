import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import { getDataLineage, getInterfaceSignature } from './query';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { saveAnalysis } from './storage';

/**
 * Four tool-surface paper cuts found by live audits on prod. Each block below
 * covers one cut end to end (unit-level for the pure query.ts joins, real
 * HTTP round trip for the two remote-analyzer-service.ts routes).
 */

// ---------------------------------------------------------------------------
// Cut 1: get_data_lineage silently ignored an unknown `entity` alias param
// and returned the identical unfiltered listing instead of an error.
// ---------------------------------------------------------------------------

function buildLineageCas(): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-lineage-test',
    system: { id: 'system-test', name: 'lineage-test', type: 'service', root_path: '/tmp/lineage' },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    data_lineage: [
      {
        entity_id: 'entity_invoice_0',
        entity_name: 'Invoice',
        sensitive_fields: [],
        writers: [{ node_id: 'n1', file: 'src/billing.ts', via: 'write' }],
        readers: [],
        external_recipients: [],
        boundaries_crossed: [],
        journeys_carrying: [],
        exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
      },
      {
        entity_id: 'entity_trip_0',
        entity_name: 'Trip',
        sensitive_fields: [],
        writers: [{ node_id: 'n2', file: 'src/trips.ts', via: 'write' }],
        readers: [],
        external_recipients: [],
        boundaries_crossed: [],
        journeys_carrying: [],
        exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
      },
    ],
  } as unknown as CASOutput;
}

test('getDataLineage: entity_id and entity (name alias) resolve to the SAME entity, and are distinct from each other\'s entity', () => {
  const cas = buildLineageCas();

  const byId = getDataLineage(cas, { entityId: 'entity_invoice_0' }) as any;
  assert.equal(byId.entity?.entity_name, 'Invoice');

  const byNameAlias = getDataLineage(cas, { entityName: 'Invoice' }) as any;
  assert.equal(byNameAlias.entity?.entity_name, 'Invoice');
  assert.equal(byNameAlias.entity?.entity_id, byId.entity?.entity_id);

  // Case-insensitive, since agents pass display names verbatim.
  const byNameLower = getDataLineage(cas, { entityName: 'invoice' }) as any;
  assert.equal(byNameLower.entity?.entity_name, 'Invoice');

  const trip = getDataLineage(cas, { entityName: 'Trip' }) as any;
  assert.equal(trip.entity?.entity_name, 'Trip');
  assert.notEqual(trip.entity?.entity_id, byId.entity?.entity_id, 'Trip and Invoice must resolve to different entities');
});

test('getDataLineage: an entity filter that does not resolve returns an explicit not-found error, never the unfiltered listing', () => {
  const cas = buildLineageCas();

  const result = getDataLineage(cas, { entityName: 'DoesNotExist' }) as any;
  assert.equal(result.entity, null);
  assert.ok(typeof result.error === 'string' && result.error.includes('DoesNotExist'), `expected a not-found error mentioning the requested name, got: ${JSON.stringify(result)}`);
  assert.ok(result.error.includes('Invoice') && result.error.includes('Trip'), 'error should list known entities as a sample');
  // Must NOT be byte-identical to the unfiltered listing shape (no `entities` array).
  assert.equal(result.entities, undefined);
});

// ---------------------------------------------------------------------------
// Cut 2: get_interface_signature could not resolve "Class::method" targets.
// ---------------------------------------------------------------------------

function buildClassMemberCas(): CASOutput {
  const classNode: CASNode = {
    id: 'class_webhook_controller_ts_WebhookController_0',
    name: 'WebhookController',
    type: 'class',
    source: { file: 'src/webhook.controller.ts', line: 1 },
  } as CASNode;
  const methodViaParent: CASNode = {
    id: 'method_class_src_webhook_controller_ts_WebhookController_0_stripeWebHook_1',
    name: 'stripeWebHook',
    type: 'method',
    parent: classNode.id,
    source: { file: 'src/webhook.controller.ts', line: 10 },
  } as CASNode;
  // A same-named method on an UNRELATED class, to prove resolution is
  // scoped to the requested class and doesn't grab the first name match.
  const decoyClassNode: CASNode = {
    id: 'class_other_ts_OtherController_0',
    name: 'OtherController',
    type: 'class',
    source: { file: 'src/other.controller.ts', line: 1 },
  } as CASNode;
  const decoyMethod: CASNode = {
    id: 'method_class_src_other_ts_OtherController_0_stripeWebHook_1',
    name: 'stripeWebHook',
    type: 'method',
    parent: decoyClassNode.id,
    source: { file: 'src/other.controller.ts', line: 5 },
  } as CASNode;
  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-class-member-test',
    system: { id: 'system-test', name: 'class-member-test', type: 'service', root_path: '/tmp/class-member' },
    nodes: [classNode, methodViaParent, decoyClassNode, decoyMethod],
    edges: [],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('getInterfaceSignature resolves Class::method via the node parent link, scoped to the right class', () => {
  const cas = buildClassMemberCas();
  const result = getInterfaceSignature(cas, 'WebhookController::stripeWebHook') as any;
  assert.equal(result.error, undefined, `expected a resolved target, got error: ${result.error}`);
  assert.equal(result.target.id, 'method_class_src_webhook_controller_ts_WebhookController_0_stripeWebHook_1');
  assert.equal(result.target.name, 'stripeWebHook');
});

test('getInterfaceSignature resolves Class#method and Class.method syntax equivalently to Class::method', () => {
  const cas = buildClassMemberCas();
  const viaHash = getInterfaceSignature(cas, 'WebhookController#stripeWebHook') as any;
  const viaDot = getInterfaceSignature(cas, 'WebhookController.stripeWebHook') as any;
  assert.equal(viaHash.target.id, 'method_class_src_webhook_controller_ts_WebhookController_0_stripeWebHook_1');
  assert.equal(viaDot.target.id, 'method_class_src_webhook_controller_ts_WebhookController_0_stripeWebHook_1');
});

test('getInterfaceSignature: an honest miss on Class::method stays a miss, not a guess', () => {
  const cas = buildClassMemberCas();
  const result = getInterfaceSignature(cas, 'NoSuchController::stripeWebHook') as any;
  assert.ok(typeof result.error === 'string' && result.error.includes('NoSuchController::stripeWebHook'));
});

test('getInterfaceSignature: id-embedding fallback resolves Class::method when no parent link is present', () => {
  const idEmbeddedMethod: CASNode = {
    id: 'method_class_apps_api_src_orders_orders_service_ts_OrdersService_0_findAll_1',
    name: 'findAll',
    type: 'method',
    // Deliberately no `parent` field — some analyzers don't populate it.
    source: { file: 'apps/api/src/orders/orders.service.ts', line: 12 },
  } as CASNode;
  const cas: CASOutput = {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-id-fallback-test',
    system: { id: 'system-test', name: 'id-fallback-test', type: 'service', root_path: '/tmp/id-fallback' },
    nodes: [idEmbeddedMethod],
    edges: [],
    analyzer_contributions: [],
  } as unknown as CASOutput;

  const result = getInterfaceSignature(cas, 'OrdersService::findAll') as any;
  assert.equal(result.error, undefined, `expected a resolved target via id-embedding fallback, got: ${result.error}`);
  assert.equal(result.target.id, idEmbeddedMethod.id);
});

// ---------------------------------------------------------------------------
// Cut 3: /conceptual gap text told HTTP callers to "Pass max_flows" (a param
// the route didn't accept) and claimed "default cap 15" while hardcoding 20.
// ---------------------------------------------------------------------------

function httpRequest(port: number, method: string, route: string, body?: unknown, token?: string): Promise<{ statusCode: number; body: string }> {
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

/**
 * A synthetic CAS with `count` distinct http entry points (one controller
 * node + one entry_point each) — one derivable flow per entry point, which
 * is what actually drives getFlowConcepts' browse-cap truncation. Building
 * this directly (rather than running a real analysis over `count` source
 * files) keeps the test fast and avoids depending on the analyzer's
 * entry-point-detection heuristics recognizing bare Python functions as
 * distinct routes.
 */
function buildManyEntryPointsCas(analysisId: string, count: number): CASOutput {
  const nodes = [];
  const entryPoints = [];
  for (let i = 0; i < count; i++) {
    const nodeId = `n_handler_${i}`;
    nodes.push({
      id: nodeId, name: `handler${i}`, type: 'controller', qualified_name: `handler${i}`,
      category: 'entry', source: { file: `src/handler${i}.ts`, line: 1 },
    });
    entryPoints.push({
      id: `ep_handler_${i}`, source_node: nodeId, type: 'http', name: `handler${i}`,
      trigger: { method: 'POST', path: `/handler${i}` },
      handler: { node_id: nodeId, method_name: `handler${i}`, file: `src/handler${i}.ts` },
    });
  }
  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: analysisId,
    system: { id: 'system-test', name: 'many-entry-points-test', type: 'service', root_path: '/tmp/many-entry-points' },
    nodes,
    edges: [],
    analyzer_contributions: [],
    entry_points: entryPoints,
  } as unknown as CASOutput;
}

test('/conceptual honors a max_flows query param (bounded) and its gap text reflects the cap actually applied', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-conceptual-max-flows-'));
  const remoteData = path.join(root, 'remote-data');
  const storagePath = path.join(root, 'storage');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousCompression = process.env.KLAURO_ANALYSIS_COMPRESSION;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  process.env.KLAURO_STORAGE_PATH = storagePath;
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'none';

  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = (address as { port: number }).port;

  try {
    const registerRes = await httpRequest(port, 'POST', '/api/auth/register', {
      email: 'max-flows-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Max Flows Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;
    const workspacesRes = await httpRequest(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    // 25 distinct entry points -> 25 derivable flows, enough that the
    // default HTTP cap (20) truncates. Land the CAS directly at the
    // location the HTTP route reads from (workspacePath(dataDir, analysisId)),
    // then create the project against that same analysis_id — mirrors the
    // approach plan-parallel-work.test.ts / flow-layer-gaps.test.ts use to
    // exercise query.ts joins without a real multi-file analysis run.
    const analysisId = 'max-flows-analysis-id';
    const workspace = path.join(remoteData, 'workspaces', analysisId);
    await saveAnalysis(workspace, buildManyEntryPointsCas(analysisId, 25));

    const createRes = await httpRequest(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'max-flows-fixture',
      analysis_id: analysisId,
    }, token);
    assert.equal(createRes.statusCode, 201);
    const project = JSON.parse(createRes.body).project as { id: string };

    // Default (no max_flows): capped at 20, gap text names the REAL applied cap (20), not the stale "15".
    const defaultRes = await httpRequest(port, 'GET', `/api/projects/${project.id}/conceptual`, undefined, token);
    assert.equal(defaultRes.statusCode, 200);
    const defaultBody = JSON.parse(defaultRes.body);
    const defaultGap: string[] = defaultBody.flows?.gaps || [];
    const defaultTruncationGap = defaultGap.find((g: string) => g.includes('flows'));
    assert.ok(defaultTruncationGap, `expected a truncation gap, got: ${JSON.stringify(defaultGap)}`);
    assert.ok(defaultTruncationGap.includes('cap 20'), `gap text must name the real applied cap (20), got: ${defaultTruncationGap}`);
    assert.ok(!defaultTruncationGap.includes('cap 15'), `gap text must NOT claim the stale default cap of 15, got: ${defaultTruncationGap}`);
    assert.ok(defaultTruncationGap.includes('max_flows query param'), `gap text must tell HTTP callers about the actual max_flows query param mechanism, got: ${defaultTruncationGap}`);

    // Explicit max_flows=25 must actually return more flows than the default 20.
    const explicitRes = await httpRequest(port, 'GET', `/api/projects/${project.id}/conceptual?max_flows=25`, undefined, token);
    assert.equal(explicitRes.statusCode, 200);
    const explicitBody = JSON.parse(explicitRes.body);
    const explicitFlows = explicitBody.flows?.flows;
    const defaultFlows = defaultBody.flows?.flows;
    assert.ok(Array.isArray(explicitFlows) && Array.isArray(defaultFlows), 'expected flows arrays in both responses');
    assert.ok(explicitFlows.length > defaultFlows.length, `max_flows=25 must yield more flows than the default cap of 20 (got ${explicitFlows.length} vs ${defaultFlows.length})`);

    // max_flows is bounded — an oversized ask is clamped, not honored verbatim.
    const hugeRes = await httpRequest(port, 'GET', `/api/projects/${project.id}/conceptual?max_flows=99999`, undefined, token);
    assert.equal(hugeRes.statusCode, 200);
    const hugeBody = JSON.parse(hugeRes.body);
    const hugeFlows = hugeBody.flows?.flows;
    assert.ok(Array.isArray(hugeFlows) && hugeFlows.length <= 50, `max_flows must be bounded to <=50, got ${hugeFlows.length}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousStoragePath === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStoragePath;
    if (previousCompression === undefined) delete process.env.KLAURO_ANALYSIS_COMPRESSION;
    else process.env.KLAURO_ANALYSIS_COMPRESSION = previousCompression;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cut 4: POST /v1/coordination/plan-parallel-work 500s with a raw
// "Cannot read properties of undefined (reading 'match')" when tasks use the
// wrong field names (e.g. `description` instead of `intent`).
// ---------------------------------------------------------------------------

test('POST /v1/coordination/plan-parallel-work returns a helpful 400 (not a 500) when a task uses the wrong field names', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-partition-shape-'));
  process.env.KLAURO_REMOTE_ANALYZER_DATA = path.join(root, 'remote-data');
  const server = createRemoteAnalyzerHttpServer({ dataDir: path.join(root, 'remote-data') });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const port = address.port;

  try {
    const badRes = await httpRequest(port, 'POST', '/v1/coordination/plan-parallel-work', {
      tasks: [{ id: 't1', description: 'wrong field name instead of intent' }],
    });
    assert.equal(badRes.statusCode, 400, `expected 400, got ${badRes.statusCode}: ${badRes.body}`);
    const badBody = JSON.parse(badRes.body);
    assert.equal(badBody.status, 'error');
    // Must name the expected fields, per the task spec.
    assert.ok(badBody.error.includes('id') && badBody.error.includes('intent'), `error must name expected fields, got: ${badBody.error}`);
    assert.ok(Array.isArray(badBody.details) && badBody.details.some((d: string) => d.includes('intent')), `details must call out the missing intent field, got: ${JSON.stringify(badBody.details)}`);

    // A well-shaped request still works (no regression).
    const goodRes = await httpRequest(port, 'POST', '/v1/coordination/plan-parallel-work', {
      tasks: [{ id: 't1', intent: 'edit a file', target_paths: ['src/a.ts'] }],
    });
    assert.equal(goodRes.statusCode, 200, `expected 200, got ${goodRes.statusCode}: ${goodRes.body}`);
    const goodBody = JSON.parse(goodRes.body);
    assert.equal(goodBody.batches.length, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
