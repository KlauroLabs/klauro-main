import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRemoteAnalyzerHttpServer, getCasReadResponseCacheStats } from './remote-analyzer-service';
import { saveAnalysis } from './storage';
import { acceptedComprehensionFixture } from './accepted-comprehension-test-fixture';
import {
  CAS_VERSION,
  type CASOutput,
  type CASNode,
  type CASEdge,
  type CASEntryPoint,
  type CASExitPoint,
  type CASEntityLineage,
  type CASDataEntity,
} from '../../../packages/analyzer-core/src/types/cas.types';

/**
 * FLEET FIX (truckspy-perfect wave): two HTTP exposure gaps closed this
 * session.
 *
 * (1) GET /api/projects/{id}/entities — the compact GET .../analysis summary
 *     exposes database_entities as a bare name array (query.ts buildSummary);
 *     a web-only customer had no way to read the E1 entity_description.v1
 *     AI-authored descriptions (ecf8a604) or field/role/relation data. This
 *     new route reuses query.ts's getDataEntities projection (the same one
 *     the get_data_entities MCP tool serves) over HTTP.
 *
 * (2) GET /api/projects/{id}/conceptual?include=full — this route's own
 *     post-processing strip already skipped itself when include=full, but it
 *     only strips what's still present: getFlowConcepts (query.ts) defaults
 *     to `detail: 'compact'` and the HTTP handler never forwarded `include`
 *     through as `detail`, so facet_provenance was ALWAYS stripped upstream
 *     regardless of include=full — the query param silently had no effect on
 *     the actual provenance bodies. Fixed by forwarding
 *     `detail: include === 'full' ? 'full' : 'compact'` into getFlowConcepts.
 *
 * Both are exercised end-to-end over the real HTTP surface, with a CAS saved
 * directly to the workspace store (bypassing full source analysis — the
 * D2 facet_provenance fixture below is the same shape used by
 * packages/analyzer-core/src/__tests__/core/flow-concepts-icelot-aggregation.test.ts).
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

function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

function buildFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node({
      id: 'n_handleCreateOrder', name: 'handleCreateOrder', type: 'controller', category: 'entry',
      signature: { parameters: [{ name: 'req', type: 'CreateOrderRequest' }], return_type: 'Promise<OrderResponse>' } as any,
    }),
    node({
      id: 'n_validateOrder', name: 'validateOrder', type: 'function', category: 'business',
      signature: { parameters: [{ name: 'order', type: 'Order' }], return_type: 'boolean' } as any,
      source: {
        file: 'src/orders/validate.ts', line: 1, end_line: 10,
        raw: [
          'function validateOrder(order) {',
          '  if (!order.total > 0) {',
          '    throw new Error("total must be positive");',
          '  }',
          '  return true;',
          '}',
        ].join('\n'),
      },
    }),
    node({
      id: 'n_saveOrder', name: 'saveOrder', type: 'function', category: 'data',
      signature: { parameters: [{ name: 'order', type: 'Order' }], return_type: 'SavedOrder' } as any,
    }),
    node({
      id: 'n_notifyWarehouse', name: 'notifyWarehouse', type: 'function', category: 'business',
      signature: { parameters: [{ name: 'saved', type: 'SavedOrder' }], return_type: 'NotifyResult', throws: ['WarehouseError'] } as any,
      source: {
        file: 'src/orders/notify.ts', line: 1, end_line: 12,
        raw: [
          'function notifyWarehouse(saved) {',
          '  if (!warehouseUp) {',
          '    throw new WarehouseError("warehouse offline");',
          '  }',
          '  return post(saved);',
          '}',
        ].join('\n'),
      },
    }),
    // Entity relation nodes: Booking references Company (ManyToOne), so
    // getDataEntities' relationIndex has real evidence for the /entities
    // route's `relations` field.
    node({ id: 'n_entity_booking', name: 'Booking', type: 'entity', category: 'data' }),
    node({ id: 'n_entity_company', name: 'Company', type: 'entity', category: 'data' }),
  ];

  const edges: CASEdge[] = [
    { id: 'e1', source: 'n_handleCreateOrder', target: 'n_validateOrder', type: 'calls' },
    { id: 'e2', source: 'n_validateOrder', target: 'n_saveOrder', type: 'calls' },
    { id: 'e3', source: 'n_saveOrder', target: 'n_notifyWarehouse', type: 'calls' },
    {
      id: 'e4', source: 'n_entity_booking', target: 'n_entity_company', type: 'references',
      metadata: { attributes: { relationType: 'ManyToOne', field: 'company' } },
    } as CASEdge,
  ];

  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_createOrder', source_node: 'n_handleCreateOrder', type: 'http', name: 'createOrder',
      trigger: { method: 'POST', path: '/orders' },
      handler: { node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder' },
      security: { authenticated: true },
      input: { validation: ['total must be a positive number'] },
    },
  ];

  const exit_points: CASExitPoint[] = [
    { id: 'xp_saveOrder', source_node: 'n_saveOrder', type: 'database', name: 'saveOrder', target: { resource: 'orders_table' } } as CASExitPoint,
    { id: 'xp_notifyWarehouse', source_node: 'n_notifyWarehouse', type: 'webhook', name: 'notifyWarehouse', target: { service_id: 'warehouse-service' } } as CASExitPoint,
  ];

  const data_lineage: CASEntityLineage[] = [
    {
      entity_id: 'entity_order', entity_name: 'Order', sensitive_fields: [],
      writers: [{ node_id: 'n_saveOrder' } as any],
      readers: [{ node_id: 'n_validateOrder' } as any],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
  ];

  const entities: CASDataEntity[] = [
    {
      id: 'entity_order', name: 'Order',
      lifecycle: { created_by: ['n_saveOrder'], read_by: ['n_validateOrder'], updated_by: [], deleted_by: [] },
      invariants: [],
      fields: [{ name: 'total', type: 'number', is_sensitive: false }],
      // E1 AI-authored description — verifies the /entities route surfaces
      // description + description_source untouched from the stored CAS.
      description: 'Order tracks a customer purchase from creation through fulfillment.',
      description_source: 'ai',
      description_generation: { status: 'ai_applied', attempted: true, budget_ms: 15000, generated_at: '2026-07-14T23:52:49.151Z' } as any,
    } as any,
    {
      id: 'entity_booking', name: 'Booking',
      lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
      invariants: [],
      fields: [{ name: 'company_id', type: 'string', is_sensitive: false }],
      // No description — the E1 pass has not (yet) run for this entity;
      // description/description_source must stay undefined, never a
      // fabricated placeholder.
    } as any,
  ];

  return {
    cas_version: CAS_VERSION,
    analysis_timestamp: '2026-01-01T00:00:00.000Z',
    analysis_id: 'test-entities-provenance',
    system: { name: 'test-system' } as any,
    nodes, edges, entry_points, exit_points, data_lineage, entities,
    capabilities: [],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('GET /api/projects/{id}/entities surfaces description/description_source/role/relations; GET /conceptual?include=full truly inlines facet_provenance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-entities-provenance-'));
  const remoteData = path.join(root, 'remote-data');
  const storagePath = path.join(root, 'storage');
  const previousRemoteData = process.env.KLAURO_REMOTE_ANALYZER_DATA;
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_REMOTE_ANALYZER_DATA = remoteData;
  process.env.KLAURO_STORAGE_PATH = storagePath;
  fs.mkdirSync(remoteData, { recursive: true });
  fs.mkdirSync(storagePath, { recursive: true });

  const analysisId = 'test-entities-provenance-analysis';
  const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;

  try {
    const registerRes = await request(port, 'POST', '/api/auth/register', {
      email: 'entities-owner@example.com',
      password: 'password-1234',
      workspace_name: 'Entities Workspace',
    });
    assert.equal(registerRes.statusCode, 201);
    const token = JSON.parse(registerRes.body).token as string;

    const workspacesRes = await request(port, 'GET', '/api/workspaces', undefined, token);
    const workspaceId = JSON.parse(workspacesRes.body).workspaces[0].id as string;

    const createRes = await request(port, 'POST', `/api/workspaces/${workspaceId}/projects`, {
      name: 'entities-fixture',
      analysis_id: analysisId,
    }, token);
    assert.equal(createRes.statusCode, 201);
    const project = JSON.parse(createRes.body).project as { id: string; analysis_id: string };
    const workspace = path.join(remoteData, 'workspaces', project.analysis_id);
    fs.mkdirSync(workspace, { recursive: true });
    await saveAnalysis(workspace, acceptedComprehensionFixture(buildFixtureCas()));

    // --- (1) GET /entities: description/description_source/role/relations ---
    const entitiesRes = await request(port, 'GET', `/api/projects/${project.id}/entities`, undefined, token);
    assert.equal(entitiesRes.statusCode, 200);
    const entitiesBody = JSON.parse(entitiesRes.body);
    assert.equal(entitiesBody.status, 'ready');
    assert.equal(entitiesBody.total, 2);
    const order = entitiesBody.entities.find((e: any) => e.name === 'Order');
    assert.ok(order, 'Order entity must be present');
    assert.equal(order.description, 'Order tracks a customer purchase from creation through fulfillment.');
    assert.equal(order.description_source, 'ai');
    const booking = entitiesBody.entities.find((e: any) => e.name === 'Booking');
    assert.ok(booking, 'Booking entity must be present');
    assert.equal(booking.description, undefined, 'entity with no E1 pass must not carry a fabricated description');
    assert.equal(booking.description_source, undefined);
    assert.ok(Array.isArray(booking.relations), 'relations array must be present');
    assert.ok(
      booking.relations.some((r: any) => r.targetName === 'Company' && r.relationType === 'ManyToOne'),
      'Booking -> Company ManyToOne relation evidence must be surfaced'
    );

    // --- pagination/filter params reach getDataEntities ---
    const filteredRes = await request(port, 'GET', `/api/projects/${project.id}/entities?entity_name=order`, undefined, token);
    const filteredBody = JSON.parse(filteredRes.body);
    assert.equal(filteredBody.total, 1);
    assert.equal(filteredBody.entities[0].name, 'Order');

    // --- entities route caching: identical params hit, different params miss ---
    const statsBefore = getCasReadResponseCacheStats();
    const entitiesRepeat = await request(port, 'GET', `/api/projects/${project.id}/entities`, undefined, token);
    assert.equal(entitiesRepeat.body, entitiesRes.body, 'cache hit must be byte-identical');
    const statsAfter = getCasReadResponseCacheStats();
    assert.equal(statsAfter.hits - statsBefore.hits, 1, 'repeat GET must be served from cache');

    // --- (2) GET /conceptual default: facet_provenance stripped ---
    const compactRes = await request(port, 'GET', `/api/projects/${project.id}/conceptual`, undefined, token);
    assert.equal(compactRes.statusCode, 200);
    const compactBody = JSON.parse(compactRes.body);
    assert.equal(compactBody.status, 'ready');
    const compactFlow = compactBody.flows.flows[0];
    assert.ok(compactFlow, 'flow must be present');
    assert.equal(compactFlow.contract.facet_provenance, undefined, 'compact projection must elide facet_provenance');
    assert.equal(compactFlow.contract.facet_provenance_available, true, 'compact projection must mark availability');

    // --- (2) GET /conceptual?include=full: facet_provenance TRULY inlined ---
    const fullRes = await request(port, 'GET', `/api/projects/${project.id}/conceptual?include=full`, undefined, token);
    assert.equal(fullRes.statusCode, 200);
    const fullBody = JSON.parse(fullRes.body);
    const fullFlow = fullBody.flows.flows[0];
    assert.ok(fullFlow, 'flow must be present');
    assert.ok(
      Array.isArray(fullFlow.contract.facet_provenance) && fullFlow.contract.facet_provenance.length > 0,
      'include=full must inline the real facet_provenance array end-to-end (regression: getFlowConcepts was never told detail:"full", so provenance was stripped upstream regardless of this query param)'
    );
    assert.ok(
      fullFlow.contract.facet_provenance.some((p: any) => p.facet === 'state_change'),
      'facet_provenance must carry the state_change entries the D2 fixture produces'
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRemoteData === undefined) delete process.env.KLAURO_REMOTE_ANALYZER_DATA;
    else process.env.KLAURO_REMOTE_ANALYZER_DATA = previousRemoteData;
    if (previousStoragePath === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStoragePath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
