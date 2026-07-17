import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  CASCallChain,
  SystemCapability,
} from '../../types/cas.types';

/**
 * FLOW-FLOODING fix (live prj_pBm2e9vJJ2wl8WbJ / miniflux measurement:
 * entry_points_by_type http:213 vs test:1234, get_flow_concepts total_available
 * 1324, top-20 role_breakdown core:0).
 *
 * buildTerminalFlows is the PRIMARY flow derivation path whenever the CAS
 * carries entry-to-exit call_chains (the common case for any repo with
 * traced call graphs). It used to sort candidate chains purely by
 * `chain.id.localeCompare(...)` — deterministic, but with no regard for
 * entry-point significance. On a test-heavy CAS, test-rooted chains can sort
 * anywhere in that id space (chain ids are `chain:<entry_point_id>`, and
 * entry-point ids are assigned in file/discovery order, not product-vs-test
 * order) — so the maxFlows probe window used by getFlowConcepts could fill
 * entirely with test flows even when plenty of real product entry points
 * existed. The fix mirrors the class-rank sort already proven for the
 * entry-point-rooted union path (computeEntryPointFlows): real/non-test
 * chains sort before test-rooted chains, tie-broken by the original
 * lexicographic id order so output stays byte-stable within a class.
 *
 * This fixture deliberately gives the test-rooted chains alphabetically
 * EARLIER ids ("chain_a0".."chain_a4") than the one product chain
 * ("chain_z_http") — a pure id sort would put every test chain first.
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

function buildFloodedTerminalCas(): CASOutput {
  const testCount = 5;
  const nodes: CASNode[] = [
    ...Array.from({ length: testCount }, (_, i) =>
      node({ id: `n_test_${i}`, name: `TestSuite${i}`, type: 'function' })),
    node({ id: 'n_http', name: 'handleCreateOrder', type: 'controller', category: 'entry' }),
    node({ id: 'n_httpSave', name: 'saveOrder', type: 'function', category: 'data' }),
  ];
  const edges: CASEdge[] = [
    { id: 'e_http', source: 'n_http', target: 'n_httpSave', type: 'calls' },
  ];
  const entry_points: CASEntryPoint[] = [
    ...Array.from({ length: testCount }, (_, i) => ({
      id: `ep_test_${i}`, source_node: `n_test_${i}`, type: 'test' as const, name: `TestSuite${i}`,
      handler: { node_id: `n_test_${i}`, method_name: `TestSuite${i}` },
    })),
    {
      id: 'ep_http', source_node: 'n_http', type: 'http', name: 'createOrder',
      trigger: { method: 'POST', path: '/orders' },
      handler: { node_id: 'n_http', method_name: 'handleCreateOrder' },
    },
  ];
  const exit_points: CASExitPoint[] = [
    ...Array.from({ length: testCount }, (_, i) => ({
      id: `xp_test_${i}`, source_node: `n_test_${i}`, type: 'file', name: `assertResult${i}`,
      target: { resource: `fixture_${i}` },
    } as CASExitPoint)),
    {
      id: 'xp_http', source_node: 'n_httpSave', type: 'database', name: 'saveOrder',
      target: { resource: 'orders_table' },
    } as CASExitPoint,
  ];
  const data_lineage: CASEntityLineage[] = [
    {
      entity_id: 'entity_order', entity_name: 'Order', sensitive_fields: [],
      writers: [{ node_id: 'n_httpSave' } as any], readers: [],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
  ];
  // Chain ids "chain_a0".."chain_a4" sort BEFORE "chain_z_http" lexicographically.
  const testChains: CASCallChain[] = Array.from({ length: testCount }, (_, i) => ({
    id: `chain_a${i}`,
    chain_type: 'entry-to-exit',
    entry_point: { node_id: `n_test_${i}`, method_name: `TestSuite${i}`, entry_point_id: `ep_test_${i}` },
    exit_point: { node_id: `n_test_${i}`, method_name: `assertResult${i}`, exit_point_id: `xp_test_${i}` },
    call_path: [{ call_id: `ct${i}`, node_id: `n_test_${i}`, method_name: `TestSuite${i}`, depth: 0 }],
    characteristics: {
      total_calls: 1, max_depth: 1, has_external_calls: false,
      has_database_calls: false, has_async_calls: false,
      is_circular: false, is_recursive: false, complexity_score: 1,
    },
    risk_analysis: { risk_level: 'low', risk_factors: [] },
  }));
  const call_chains: CASCallChain[] = [
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
  ];
  const system_capabilities: SystemCapability[] = [
    {
      id: 'cap_orders', name: 'Order Management', category: 'core', criticality: 'high',
      operations: [{ action: 'create order', entry_point_id: 'ep_http', entry_point_type: 'http' }],
    } as any,
  ];

  return {
    analysis_id: 'test-terminal-flooding',
    nodes, edges, entry_points, exit_points, data_lineage, call_chains, system_capabilities,
  } as unknown as CASOutput;
}

describe('buildTerminalFlows (via computeFlowConcepts) — significance-first chain ordering', () => {
  test('a 1-slot maxFlows window prefers the product chain over test chains despite alphabetically-earlier test chain ids', () => {
    const flows = computeFlowConcepts(buildFloodedTerminalCas(), { maxFlows: 1 });
    expect(flows).toHaveLength(1);
    expect(flows[0].entry_point).toBe('ep_http');
  });

  test('test-rooted terminal chains still produce flows — ordered after product chains, never dropped', () => {
    const flows = computeFlowConcepts(buildFloodedTerminalCas(), { maxFlows: 100 });
    expect(flows).toHaveLength(6);
    expect(flows[0].entry_point).toBe('ep_http');
    expect(flows.slice(1).every(f => f.entry_point.startsWith('ep_test_'))).toBe(true);
    // Within the test class, original (id) order is preserved (stable sort).
    expect(flows.slice(1).map(f => f.entry_point)).toEqual(['ep_test_0', 'ep_test_1', 'ep_test_2', 'ep_test_3', 'ep_test_4']);
  });

  test('a pure-test CAS (no product chains at all) still surfaces every test flow', () => {
    const cas = buildFloodedTerminalCas();
    cas.entry_points = (cas.entry_points || []).filter(ep => ep.type === 'test');
    cas.call_chains = (cas.call_chains || []).filter(c => c.id !== 'chain_z_http');
    const flows = computeFlowConcepts(cas, { maxFlows: 100 });
    expect(flows).toHaveLength(5);
  });
});
