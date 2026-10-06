import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getFlowConcepts, getFlowCoverage } from './query';

/**
 * Flow-layer gap regressions (3-repo audit): role must anchor on
 * terminal/product evidence (deploy.sh -> infrastructure even when a "shell"
 * domain concept was classified core), capability_id must serialize on every
 * flow, get_flow_coverage must speak the same "flow" vocabulary as
 * get_flow_concepts (chains reported as chains), and persisted AI descriptions
 * must overlay with honest provenance.
 */
function buildCas(): CASOutput {
  return {
    analysis_id: 'test-flow-gaps',
    nodes: [
      { id: 'n_deploy', name: 'deploy', type: 'function', qualified_name: 'deploy', source: { file: 'scripts/deploy.sh', line: 1 } },
      { id: 'n_push', name: 'pushArtifact', type: 'function', qualified_name: 'pushArtifact', source: { file: 'scripts/deploy.sh', line: 10 } },
      { id: 'n_orders', name: 'handleCreateOrder', type: 'controller', qualified_name: 'handleCreateOrder', category: 'entry', source: { file: 'src/orders.ts', line: 1 } },
      { id: 'n_saveOrder', name: 'saveOrder', type: 'function', qualified_name: 'saveOrder', category: 'data', source: { file: 'src/orders.ts', line: 20 } },
    ],
    edges: [
      { id: 'e1', source: 'n_deploy', target: 'n_push', type: 'calls' },
      { id: 'e2', source: 'n_orders', target: 'n_saveOrder', type: 'calls' },
    ],
    entry_points: [
      {
        id: 'ep_deploy', source_node: 'n_deploy', type: 'cli', name: 'deploy',
        trigger: { pattern: './deploy.sh' },
        handler: { node_id: 'n_deploy', method_name: 'deploy', file: 'scripts/deploy.sh' },
        security: { authenticated: true }, // significance surface so the union keeps it
      },
      {
        id: 'ep_orders', source_node: 'n_orders', type: 'http', name: 'createOrder',
        trigger: { method: 'POST', path: '/orders' },
        handler: { node_id: 'n_orders', method_name: 'handleCreateOrder', file: 'src/orders.ts' },
      },
    ],
    exit_points: [
      { id: 'xp_db', source_node: 'n_saveOrder', type: 'database', name: 'saveOrder', target: { resource: 'orders_table' } },
    ],
    data_lineage: [
      {
        entity_id: 'entity_order', entity_name: 'Order', sensitive_fields: [],
        writers: [{ node_id: 'n_saveOrder' }], readers: [],
        external_recipients: [], boundaries_crossed: [], entry_point_flows_carrying: [],
        exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
      },
    ],
    call_chains: [
      {
        id: 'chain_orders',
        chain_type: 'entry-to-exit',
        entry_point: { node_id: 'n_orders', method_name: 'handleCreateOrder', entry_point_id: 'ep_orders' },
        exit_point: { node_id: 'n_saveOrder', method_name: 'saveOrder', exit_point_id: 'xp_db' },
        call_path: [
          { call_id: 'c1', node_id: 'n_orders', method_name: 'handleCreateOrder', depth: 0 },
          { call_id: 'c2', node_id: 'n_saveOrder', method_name: 'saveOrder', depth: 1 },
        ],
        characteristics: {
          total_calls: 2, max_depth: 2, has_external_calls: false,
          has_database_calls: true, has_async_calls: false,
          is_circular: false, is_recursive: false, complexity_score: 1,
        },
        risk_analysis: { risk_level: 'low', risk_factors: [] },
      },
    ],
    flow_coverage: [
      {
        call_chain_id: 'chain_orders',
        call_chain_name: 'handleCreateOrder',
        coverage_status: 'partially-covered',
        coverage_percentage: 0.5,
        tested_segments: [{ node_id: 'n_orders', test_ids: [], assertion_count: 0 }],
        untested_segments: [{ node_id: 'n_saveOrder', importance: 'medium', reason: 'no tests' }],
        test_quality: { has_unit_tests: true, has_integration_tests: false, has_e2e_tests: false, uses_mocks: false },
      },
    ],
    capabilities: [
      {
        id: 'cap_orders', name: 'Order Management', category: 'core', criticality: 'high',
        operations: [{ action: 'create order', entry_point_id: 'ep_orders', entry_point_type: 'http' }],
      },
    ],
    // A "shell" domain concept mistakenly classified core, anchored on the
    // deploy entry point — the pre-fix source of deploy.sh flows ranked core.
    domain_concepts: [
      {
        id: 'dc_shell', name: 'shell', classification: 'core',
        appears_in: { entry_points: ['ep_deploy'], entities: [], nodes: [] },
      },
    ],
  } as unknown as CASOutput;
}

test('role anchors on terminal/product evidence: deploy-script flow is infrastructure despite a core "shell" domain concept', () => {
  const result = getFlowConcepts(buildCas(), {});
  const deployFlow: any = result.flows.find((f: any) => f.entry_point === 'ep_deploy');
  assert.ok(deployFlow, 'deploy.sh entry should still produce a (union) flow');
  assert.equal(deployFlow.role, 'infrastructure');
  assert.ok(deployFlow.role_evidence.some((e: string) => /script file/i.test(e)));
});

test('capability-linked flow with a persisted terminus is core, and capability_id is serialized on the projection', () => {
  const result = getFlowConcepts(buildCas(), {});
  const orderFlow: any = result.flows.find((f: any) => f.entry_point === 'ep_orders');
  assert.ok(orderFlow, 'order flow missing');
  assert.equal(orderFlow.capability_id, 'cap_orders');
  assert.equal(orderFlow.role, 'core');
  assert.ok(orderFlow.role_evidence.some((e: string) => /capability operation/i.test(e)));
  // Serialization holds on the structural projection too (default path).
  assert.ok('capability_id' in orderFlow);
});

test('AI description overlay: flow_id/step_id keys flip description_source to ai; unmatched units stay deterministic', () => {
  const cas = buildCas();
  const base = getFlowConcepts(cas, {});
  const orderFlow: any = base.flows.find((f: any) => f.entry_point === 'ep_orders');
  const stepId = orderFlow.steps[0].step_id;

  const aiDescriptions = new Map<string, { description: string }>([
    [orderFlow.flow_id, { description: 'Creates an order and persists it.' }],
    [stepId, { description: 'Receives and validates the incoming order request.' }],
  ]);
  const enriched = getFlowConcepts(cas, { aiDescriptions });
  const enrichedFlow: any = enriched.flows.find((f: any) => f.flow_id === orderFlow.flow_id);
  assert.equal(enrichedFlow.description, 'Creates an order and persists it.');
  assert.equal(enrichedFlow.description_source, 'ai');
  assert.equal(enrichedFlow.steps[0].description_source, 'ai');
  assert.equal(enrichedFlow.steps[0].description, 'Receives and validates the incoming order request.');
  for (const step of enrichedFlow.steps.slice(1)) {
    assert.equal(step.description_source, 'deterministic-label');
  }
  // Deterministic fallback stays intact when no store entry matches.
  const deployFlow: any = enriched.flows.find((f: any) => f.entry_point === 'ep_deploy');
  assert.equal(deployFlow.description_source, undefined);
});

test('get_flow_coverage speaks the flow_concepts vocabulary: flows measured over the union set, chains reported as chains', () => {
  const cas = buildCas();
  const coverage: any = getFlowCoverage(cas);
  const concepts = getFlowConcepts(cas, { maxFlows: 10_000 });
  assert.equal(coverage.total_flows, concepts.total_available);
  assert.equal(coverage.total_chains, 1);
  assert.deepEqual(coverage.chains_by_coverage_status, { 'partially-covered': 1 });
  // The terminal flow joins its chain's coverage; the deploy flow has no
  // measured chain and lands in unmeasured_flows (honest, not not-covered).
  assert.equal(coverage.flows_by_coverage_status['partially-covered'], 1);
  assert.equal(coverage.unmeasured_flows, coverage.total_flows - 1);
  // Back-compat alias still present.
  assert.deepEqual(coverage.by_coverage_status, coverage.chains_by_coverage_status);
});

/**
 * FLOW-FLOODING regression (live prj_pBm2e9vJJ2wl8WbJ / miniflux measurement:
 * entry_points_by_type http:213 vs test:1234, get_flow_concepts total_available
 * 1324, top-20 role_breakdown core:0). buildTerminalFlows (the PRIMARY flow
 * path whenever the CAS has entry-to-exit call_chains) used to sort chains
 * purely by `chain.id` — significance-blind — so a test-heavy CAS could fill
 * the entire maxFlows probe window with test-rooted flows regardless of how
 * few real product entries there were. Chain ids below are deliberately
 * alphabetically EARLIER for the test entries and LATER for the http entry,
 * so a lexicographic-only sort would put every test flow ahead of the one
 * real product flow — exactly the shape that starved role_breakdown on the
 * live CAS.
 */
function buildFloodedCas(): CASOutput {
  const testCount = 5;
  const testNodes = Array.from({ length: testCount }, (_, i) => ([
    { id: `n_test_${i}`, name: `TestSuite${i}`, type: 'function', qualified_name: `TestSuite${i}`, source: { file: `test/suite${i}.test.ts`, line: 1 } },
  ])).flat();
  const testEntryPoints = Array.from({ length: testCount }, (_, i) => ({
    id: `ep_test_${i}`, source_node: `n_test_${i}`, type: 'test' as const, name: `TestSuite${i}`,
    handler: { node_id: `n_test_${i}`, method_name: `TestSuite${i}`, file: `test/suite${i}.test.ts` },
  }));
  const testExitPoints = Array.from({ length: testCount }, (_, i) => ({
    id: `xp_test_${i}`, source_node: `n_test_${i}`, type: 'file' as const, name: `assertResult${i}`,
    target: { resource: `fixture_${i}` },
  }));
  // Chain ids "chain_a0".."chain_a4" sort BEFORE "chain_z_http" lexicographically.
  const testChains = Array.from({ length: testCount }, (_, i) => ({
    id: `chain_a${i}`,
    chain_type: 'entry-to-exit' as const,
    entry_point: { node_id: `n_test_${i}`, method_name: `TestSuite${i}`, entry_point_id: `ep_test_${i}` },
    exit_point: { node_id: `n_test_${i}`, method_name: `assertResult${i}`, exit_point_id: `xp_test_${i}` },
    call_path: [{ call_id: `ct${i}`, node_id: `n_test_${i}`, method_name: `TestSuite${i}`, depth: 0 }],
    characteristics: {
      total_calls: 1, max_depth: 1, has_external_calls: false,
      has_database_calls: false, has_async_calls: false,
      is_circular: false, is_recursive: false, complexity_score: 1,
    },
    risk_analysis: { risk_level: 'low' as const, risk_factors: [] },
  }));

  return {
    analysis_id: 'test-flow-flooding',
    nodes: [
      ...testNodes,
      { id: 'n_http', name: 'handleCreateOrder', type: 'controller', qualified_name: 'handleCreateOrder', category: 'entry', source: { file: 'src/orders.ts', line: 1 } },
      { id: 'n_httpSave', name: 'saveOrder', type: 'function', qualified_name: 'saveOrder', category: 'data', source: { file: 'src/orders.ts', line: 20 } },
    ],
    edges: [
      { id: 'e_http', source: 'n_http', target: 'n_httpSave', type: 'calls' },
    ],
    entry_points: [
      ...testEntryPoints,
      {
        id: 'ep_http', source_node: 'n_http', type: 'http', name: 'createOrder',
        trigger: { method: 'POST', path: '/orders' },
        handler: { node_id: 'n_http', method_name: 'handleCreateOrder', file: 'src/orders.ts' },
      },
    ],
    exit_points: [
      ...testExitPoints,
      { id: 'xp_http', source_node: 'n_httpSave', type: 'database', name: 'saveOrder', target: { resource: 'orders_table' } },
    ],
    data_lineage: [
      {
        entity_id: 'entity_order', entity_name: 'Order', sensitive_fields: [],
        writers: [{ node_id: 'n_httpSave' }], readers: [],
        external_recipients: [], boundaries_crossed: [], entry_point_flows_carrying: [],
        exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
      },
    ],
    call_chains: [
      ...testChains,
      {
        id: 'chain_z_http',
        chain_type: 'entry-to-exit',
        entry_point: { node_id: 'n_http', method_name: 'handleCreateOrder', entry_point_id: 'ep_http' },
        exit_point: { node_id: 'n_httpSave', method_name: 'saveOrder', exit_point_id: 'xp_http' },
        call_path: [
          { call_id: 'ch1', node_id: 'n_http', method_name: 'handleCreateOrder', depth: 0 },
          { call_id: 'ch2', node_id: 'n_httpSave', method_name: 'saveOrder', depth: 1 },
        ],
        characteristics: {
          total_calls: 2, max_depth: 2, has_external_calls: false,
          has_database_calls: true, has_async_calls: false,
          is_circular: false, is_recursive: false, complexity_score: 1,
        },
        risk_analysis: { risk_level: 'low', risk_factors: [] },
      },
    ],
    capabilities: [
      {
        id: 'cap_orders', name: 'Order Management', category: 'core', criticality: 'high',
        operations: [{ action: 'create order', entry_point_id: 'ep_http', entry_point_type: 'http' }],
      },
    ],
  } as unknown as CASOutput;
}

test('flow-flooding fix: a 1-slot window is NOT crowded out by test-rooted terminal chains despite alphabetically-earlier chain ids', () => {
  const result = getFlowConcepts(buildFloodedCas(), { maxFlows: 1 });
  assert.equal(result.flows.length, 1);
  assert.equal(result.flows[0].entry_point, 'ep_http');
});

test('flow-flooding fix: test-rooted flows still surface after product flows (ordered, never dropped)', () => {
  const result = getFlowConcepts(buildFloodedCas(), { maxFlows: 100 });
  const entryOrder = result.flows.map((f: any) => f.entry_point);
  assert.equal(entryOrder[0], 'ep_http');
  assert.equal(entryOrder.length, 6);
  assert.ok(entryOrder.slice(1).every((id: string) => id.startsWith('ep_test_')));
});

test('flow-flooding fix: role_breakdown gains a dedicated test bucket instead of polluting core/supporting/infrastructure', () => {
  const result: any = getFlowConcepts(buildFloodedCas(), { maxFlows: 100 });
  assert.equal(result.role_breakdown.test, 5);
  const httpFlow = result.flows.find((f: any) => f.entry_point === 'ep_http');
  assert.equal(httpFlow.role, 'core');
  const testFlow = result.flows.find((f: any) => f.entry_point === 'ep_test_0');
  assert.equal(testFlow.role, 'test');
});

test('flow-flooding fix: entry_point_totals reports the honest product-vs-test split independent of the probe window', () => {
  const result: any = getFlowConcepts(buildFloodedCas(), { maxFlows: 1 });
  assert.deepEqual(result.entry_point_totals, { product: 1, test: 5 });
});

test('flow-flooding fix: total_available stays honest (not silently truncated) and gaps flag the test-dominated total', () => {
  const result: any = getFlowConcepts(buildFloodedCas(), { maxFlows: 1 });
  assert.equal(result.truncated, true);
  assert.ok(result.total_available >= 6);
  assert.ok(result.gaps.some((g: string) => /dominated by test entry points/.test(g)));
});

test('flow-flooding fix: a pure-test repo still lists its flows (no empty-page regression)', () => {
  const cas = buildFloodedCas();
  cas.entry_points = (cas.entry_points || []).filter(ep => ep.type === 'test');
  cas.call_chains = (cas.call_chains || []).filter(c => c.id !== 'chain_z_http');
  const result: any = getFlowConcepts(cas, { maxFlows: 100 });
  assert.equal(result.flows.length, 5);
  assert.equal(result.role_breakdown.test, 5);
  assert.deepEqual(result.entry_point_totals, { product: 0, test: 5 });
});
