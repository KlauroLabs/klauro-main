import { strict as assert } from 'assert';
import { test } from 'node:test';

// The inspector generator is plain CommonJS so the bridge and the stored
// forwarder can run it with a bare `node` invocation; load it the same way.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inspector = require('../scripts/create-analysis-inspector.js');

function pillarCas(): any {
  return {
    cas_version: '1.11.0',
    system: { name: 'orders-app', type: 'service', root_path: '/repo/orders-app', technologies: { languages: ['ruby'], frameworks: ['Rails'] } },
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
    user_journeys: [
      {
        id: 'journey_create_order',
        name: 'Create order -> Order created',
        journey_kind: 'user-facing',
        entry_point_id: 'entry_post_orders',
        entry: { type: 'http', name: 'OrdersController#create', method: 'POST', path_or_trigger: '/orders', handler_node_id: 'method_orders_create' },
        steps: [
          { node_id: 'method_orders_create', name: 'OrdersController#create', layer: 'entry', depth: 0 },
          { node_id: 'method_order_service_place', name: 'OrderService#place', layer: 'business', depth: 1 },
          { node_id: 'method_order_save', name: 'Order#save', layer: 'data', depth: 2 },
        ],
        terminal_effects: { entities_written: ['Order'], entities_read: ['Customer'], external_services: ['stripe'], messages_emitted: [] },
        terminal_entities: [{ entity_id: 'entity_order', name: 'Order', access: 'created', terminal_kind: 'entity' }],
        security_boundaries: [{ node_id: 'method_require_user', name: 'require_user', mechanism: 'before_action' }],
        tests_covering: ['test_orders_create'],
        risk: 'medium',
        criticality: 'critical',
        call_chain_ids: ['chain_1', 'chain_2'],
        exit_point_ids: ['exit_stripe'],
      },
    ],
    user_journey_summary: { total_discovered: 9, included: 1, by_kind: { 'user-facing': 7, system: 1, scheduled: 1 } },
    data_lineage: [
      {
        entity_id: 'entity_customer',
        entity_name: 'Customer',
        sensitive_fields: ['email', 'phone'],
        writers: [{ node_id: 'method_customer_update', file: 'app/services/customer_service.rb', via: 'CustomerService#update' }],
        readers: [
          { node_id: 'method_orders_create', file: 'app/controllers/orders_controller.rb', via: 'OrdersController#create' },
          { node_id: 'method_export', file: 'app/jobs/export_job.rb', via: 'ExportJob#perform' },
        ],
        external_recipients: [{ exit_point_id: 'exit_stripe', service: 'stripe', via_node: 'method_payment_charge' }],
        boundaries_crossed: [
          { boundary: 'require_user', guarded: true },
          { boundary: 'public export endpoint', guarded: false },
        ],
        journeys_carrying: ['journey_create_order'],
        exposure: { unguarded_paths: 1, external_transfer: true, sensitive: true },
      },
    ],
    paradigm_conformance: [
      {
        paradigm: 'controller-service-repository',
        description: 'Controllers delegate writes to services; no direct model writes from controllers.',
        adoption: { following_count: 18, comparable_count: 20, adoption_rate: 0.9, evidence_files: ['app/controllers/orders_controller.rb'] },
        deviations: [
          { file: 'app/controllers/legacy_controller.rb', node_id: 'method_legacy_write', kind: 'direct-data-access', detail: 'Writes Order directly from the controller.', severity: 'warning' },
        ],
      },
    ],
    product_map: {
      identity: {
        name: 'orders-app',
        domain: 'order-management',
        domain_source: 'deterministic',
        description: 'An order management service.',
        description_source: 'deterministic',
        unanalyzed_languages: [{ name: 'CoffeeScript', files: 3, share_of_source: 0.02 }],
      },
      capabilities: [
        { name: 'Order Management', description: 'Order placement and fulfillment.', description_source: 'deterministic', category: 'core', criticality: 'critical', journeys: [{ id: 'journey_create_order', name: 'Create order' }], entities: ['Order'], tests_present: true, risk_level: 'medium' },
      ],
      journeys: { total: 9, user_facing: 7, system: 1, scheduled: 1, top: [{ id: 'journey_create_order', name: 'Create order', kind: 'user-facing', criticality: 'critical', boundaries: ['require_user'], tests: 1 }] },
      data: { entities: 4, sensitive: ['Customer'], exposure_highlights: [{ entity: 'Customer', sensitive_fields: ['email'], unguarded_paths: 1, external_transfer: true, external_recipients: ['stripe'] }] },
      conventions: { paradigms: [{ paradigm: 'controller-service-repository', description: 'Service-mediated writes.', adoption_rate: 0.9, following_count: 18, comparable_count: 20 }], open_deviations: { error: 0, warning: 1, info: 0 } },
      health: { status: 'healthy', score: 88, tests: { total: 40, passing: 40, failing: 0 }, implementation: { complete: 30, partial: 2, stubs: 0, not_implemented: 0, deprecated: 1 }, top_risks: [{ name: 'Legacy controller writes', level: 'medium', type: 'paradigm-deviation', recommendation: 'Route writes through OrderService.' }] },
      coverage_caveats: ['CoffeeScript files were not analyzed.'],
    },
  };
}

function prePillarCas(): any {
  return {
    cas_version: '1.9.0',
    system: { name: 'older-app', type: 'service', root_path: '/repo/older-app', technologies: { languages: ['php'], frameworks: ['Symfony'] } },
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
  };
}

const indexEntry = { name: 'orders-app', file: 'orders-app-abc123.json', analyzed_at: '2026-06-11T00:00:00.000Z', system_type: 'service' };

test('journeyData maps stored journey fields without recomputation', () => {
  const journeys = inspector.journeyData(pillarCas());
  assert.equal(journeys.present, true);
  assert.equal(journeys.notice, '');
  assert.equal(journeys.summary.total_discovered, 9);
  assert.equal(journeys.summary.by_kind['user-facing'], 7);
  const journey = journeys.items[0];
  assert.equal(journey.name, 'Create order -> Order created');
  assert.equal(journey.kind, 'user-facing');
  assert.equal(journey.entry.method, 'POST');
  assert.equal(journey.entry.path_or_trigger, '/orders');
  assert.deepEqual(journey.steps.map((s: any) => s.name), ['OrdersController#create', 'OrderService#place', 'Order#save']);
  assert.deepEqual(journey.steps.map((s: any) => s.layer), ['entry', 'business', 'data']);
  assert.deepEqual(journey.terminal_entities, [{ name: 'Order', access: 'created', kind: 'entity' }]);
  assert.deepEqual(journey.effects.written, ['Order']);
  assert.deepEqual(journey.effects.read, ['Customer']);
  assert.equal(journey.boundaries[0].name, 'require_user');
  assert.equal(journey.boundaries[0].mechanism, 'before_action');
  assert.equal(journey.provenance.entry_point_id, 'entry_post_orders');
  assert.equal(journey.provenance.call_chains, 2);
  assert.equal(journey.provenance.exit_points, 1);
  assert.equal(journey.tests_covering, 1);
});

test('lineageData maps sensitive entities, touchpoints, boundaries, and external receivers', () => {
  const lineage = inspector.lineageData(pillarCas());
  assert.equal(lineage.present, true);
  assert.equal(lineage.total, 1);
  assert.equal(lineage.sensitive_count, 1);
  assert.equal(lineage.external_transfer_count, 1);
  const entity = lineage.items[0];
  assert.equal(entity.entity_name, 'Customer');
  assert.deepEqual(entity.sensitive_fields, ['email', 'phone']);
  assert.equal(entity.writers, 1);
  assert.equal(entity.readers, 2);
  assert.equal(entity.external_recipients[0].service, 'stripe');
  assert.deepEqual(entity.boundaries_crossed, [
    { boundary: 'require_user', guarded: true },
    { boundary: 'public export endpoint', guarded: false },
  ]);
  assert.equal(entity.exposure.unguarded_paths, 1);
  assert.equal(entity.exposure.external_transfer, true);
  assert.equal(entity.exposure.sensitive, true);
});

test('conformanceData maps norms, adoption, and deviations with evidence', () => {
  const conformance = inspector.conformanceData(pillarCas());
  assert.equal(conformance.present, true);
  const paradigm = conformance.items[0];
  assert.equal(paradigm.paradigm, 'controller-service-repository');
  assert.equal(paradigm.adoption.adoption_rate, 0.9);
  assert.equal(paradigm.adoption.following_count, 18);
  assert.equal(paradigm.adoption.comparable_count, 20);
  assert.deepEqual(paradigm.adoption.evidence_files, ['app/controllers/orders_controller.rb']);
  assert.equal(paradigm.deviations[0].kind, 'direct-data-access');
  assert.equal(paradigm.deviations[0].severity, 'warning');
  assert.equal(paradigm.deviations[0].file, 'app/controllers/legacy_controller.rb');
});

test('productMapData maps the stored capability spec view', () => {
  const product = inspector.productMapData(pillarCas());
  assert.equal(product.present, true);
  assert.equal(product.map.identity.domain, 'order-management');
  assert.equal(product.map.identity.description_source, 'deterministic');
  assert.equal(product.map.capabilities[0].name, 'Order Management');
  assert.equal(product.map.capabilities[0].category, 'core');
  assert.equal(product.map.capabilities[0].tests_present, true);
  assert.equal(product.map.journeys.total, 9);
  assert.deepEqual(product.map.data.sensitive, ['Customer']);
  assert.equal(product.map.data.exposure_highlights[0].entity, 'Customer');
  assert.equal(product.map.conventions.open_deviations.warning, 1);
  assert.equal(product.map.health.status, 'healthy');
  assert.deepEqual(product.map.coverage_caveats, ['CoffeeScript files were not analyzed.']);
});

test('pre-pillar analyses get an explicit version notice, never silent emptiness', () => {
  const cas = prePillarCas();
  for (const [data, label] of [
    [inspector.journeyData(cas), 'user journeys'],
    [inspector.lineageData(cas), 'data lineage'],
    [inspector.conformanceData(cas), 'paradigm conformance'],
    [inspector.productMapData(cas), 'the stored product map'],
  ] as const) {
    assert.equal(data.present, false, label);
    assert.ok(data.notice.includes('predates'), label);
    assert.ok(data.notice.includes('1.9.0'), label);
    assert.ok(data.notice.includes(inspector.PILLAR_ATTESTED_CAS_VERSION), label);
    assert.ok(data.notice.includes('Re-run analyze_codebase'), label);
  }
});

test('current-version analyses with genuinely no pillar data carry no version notice', () => {
  const cas = prePillarCas();
  cas.cas_version = '1.11.0';
  assert.equal(inspector.journeyData(cas).present, false);
  assert.equal(inspector.journeyData(cas).notice, '');
  assert.equal(inspector.lineageData(cas).notice, '');
  assert.equal(inspector.conformanceData(cas).notice, '');
  assert.equal(inspector.productMapData(cas).notice, '');
});

test('compareCasVersions orders versions and tolerates unparseable input', () => {
  assert.ok(inspector.compareCasVersions('1.9.0', '1.11.0') < 0);
  assert.ok(inspector.compareCasVersions('1.11.0', '1.11.0') === 0);
  assert.ok(inspector.compareCasVersions('2.0.0', '1.11.0') > 0);
  assert.ok(inspector.compareCasVersions(undefined, '1.11.0') < 0);
});

test('renderHtml embeds pillar sections and payload for a pillar-rich analysis', () => {
  const entry = inspector.buildAnalysisEntry(pillarCas(), indexEntry, '/repo/orders-app');
  const html = inspector.renderHtml({ generated_at: new Date().toISOString(), analysis_count: 1, analyses: [entry] });
  for (const marker of ['journeysView', 'lineageView', 'conformanceView', 'productView', 'Behavior Pillars', 'Paradigm Conformance', 'Product Map', 'Data Lineage', 'User Journeys']) {
    assert.ok(html.includes(marker), marker);
  }
  assert.ok(html.includes('Create order -> Order created'));
  assert.ok(html.includes('controller-service-repository'));
  assert.ok(html.includes('order-management'));
  assert.ok(html.includes('entry_post_orders'));
});

test('renderHtml embeds the version notice for a pre-pillar analysis', () => {
  const entry = inspector.buildAnalysisEntry(prePillarCas(), { ...indexEntry, name: 'older-app', file: 'older-app-def456.json' }, '/repo/older-app');
  const html = inspector.renderHtml({ generated_at: new Date().toISOString(), analysis_count: 1, analyses: [entry] });
  assert.ok(html.includes('predates user journeys'));
  assert.ok(html.includes('Re-run analyze_codebase'));
});

test('buildAnalysisEntry records the stored cas_version and keeps legacy sections', () => {
  const entry = inspector.buildAnalysisEntry(pillarCas(), indexEntry, '/repo/orders-app');
  assert.equal(entry.cas_version, '1.11.0');
  assert.ok(entry.capabilities);
  assert.ok(entry.composition);
  assert.ok(entry.tests);
  assert.equal(entry.journeys.present, true);
  assert.equal(entry.lineage.present, true);
  assert.equal(entry.conformance.present, true);
  assert.equal(entry.product_map.present, true);
});
