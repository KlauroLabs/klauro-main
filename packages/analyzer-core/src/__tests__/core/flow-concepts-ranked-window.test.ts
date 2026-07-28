import { computeFlowConcepts, rankStoredFlowRefs } from '../../analyzer/core/flow-concepts';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASFlowRef,
  CASCallChain,
} from '../../types/cas.types';

/**
 * RANK BEFORE TRUNCATING (P0).
 *
 * The flow window used to be "whatever derivation produced first" — an order
 * that correlates with SHALLOW, because the terminal-chain pass runs first and
 * terminal chains stop at their exit point. Measured on real stored analyses:
 * the first 50 flows averaged 1.1-2.2 steps while the full set averaged
 * 2.2-3.5 with maxima of 16-18, and the fully-evidenced multi-constraint flows
 * sat entirely outside the window. There was also no `offset`, so flow #51+
 * was unreachable by ANY parameter — the truncation hint's advertised remedy
 * ("pass max_flows, max 50") was capped at the same number as the complaint.
 *
 * The fixture below is the defect in miniature: five 1-step leaves whose chain
 * ids sort BEFORE the one deep multi-step flow, so derivation order alone puts
 * every leaf ahead of the flow worth reading.
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

const LEAF_COUNT = 5;

function buildRankableCas(): CASOutput {
  const nodes: CASNode[] = [
    ...Array.from({ length: LEAF_COUNT }, (_, i) =>
      node({ id: `n_leaf_${i}`, name: `pingHandler${i}`, type: 'controller', category: 'entry', structural_importance: 0.1 })),
    node({ id: 'n_deep_entry', name: 'handleCreateOrder', type: 'controller', category: 'entry', structural_importance: 0.9 }),
    node({ id: 'n_deep_validate', name: 'validateOrderPayload', type: 'function', category: 'business', structural_importance: 0.5 }),
    node({ id: 'n_deep_price', name: 'priceOrder', type: 'service', category: 'business', structural_importance: 0.5 }),
    node({ id: 'n_deep_save', name: 'saveOrder', type: 'repository', category: 'data', structural_importance: 0.4 }),
  ];
  const edges: CASEdge[] = [
    { id: 'e1', source: 'n_deep_entry', target: 'n_deep_validate', type: 'calls' },
    { id: 'e2', source: 'n_deep_validate', target: 'n_deep_price', type: 'calls' },
    { id: 'e3', source: 'n_deep_price', target: 'n_deep_save', type: 'calls' },
  ];
  const entry_points: CASEntryPoint[] = [
    ...Array.from({ length: LEAF_COUNT }, (_, i) => ({
      id: `ep_leaf_${i}`, source_node: `n_leaf_${i}`, type: 'http' as const, name: `ping${i}`,
      trigger: { method: 'GET', path: `/ping/${i}` },
      handler: { node_id: `n_leaf_${i}`, method_name: `pingHandler${i}` },
    })),
    {
      id: 'ep_deep', source_node: 'n_deep_entry', type: 'http', name: 'createOrder',
      trigger: { method: 'POST', path: '/orders' },
      handler: { node_id: 'n_deep_entry', method_name: 'handleCreateOrder' },
    },
  ] as CASEntryPoint[];
  const exit_points: CASExitPoint[] = [
    ...Array.from({ length: LEAF_COUNT }, (_, i) => ({
      id: `xp_leaf_${i}`, source_node: `n_leaf_${i}`, type: 'api', name: `respondPong${i}`,
      target: { resource: `pong_${i}` },
    } as CASExitPoint)),
    {
      id: 'xp_deep', source_node: 'n_deep_save', type: 'database', name: 'saveOrder',
      target: { resource: 'orders_table' },
    } as CASExitPoint,
  ];

  // Leaf chain ids sort BEFORE the deep chain id — derivation order alone puts
  // every 1-step leaf ahead of the multi-step flow.
  const call_chains: CASCallChain[] = [
    ...Array.from({ length: LEAF_COUNT }, (_, i) => ({
      id: `chain_a${i}`,
      chain_type: 'entry-to-exit',
      entry_point: { node_id: `n_leaf_${i}`, method_name: `pingHandler${i}`, entry_point_id: `ep_leaf_${i}` },
      exit_point: { node_id: `n_leaf_${i}`, method_name: `respondPong${i}`, exit_point_id: `xp_leaf_${i}` },
      call_path: [{ call_id: `cl${i}`, node_id: `n_leaf_${i}`, method_name: `pingHandler${i}`, depth: 0 }],
      characteristics: {
        total_calls: 1, max_depth: 1, has_external_calls: false,
        has_database_calls: false, has_async_calls: false,
        is_circular: false, is_recursive: false, complexity_score: 1,
      },
      risk_analysis: { risk_level: 'low', risk_factors: [] },
    })),
    {
      id: 'chain_z_deep',
      chain_type: 'entry-to-exit',
      entry_point: { node_id: 'n_deep_entry', method_name: 'handleCreateOrder', entry_point_id: 'ep_deep' },
      exit_point: { node_id: 'n_deep_save', method_name: 'saveOrder', exit_point_id: 'xp_deep' },
      call_path: [
        { call_id: 'cd0', node_id: 'n_deep_entry', method_name: 'handleCreateOrder', depth: 0 },
        { call_id: 'cd1', node_id: 'n_deep_validate', method_name: 'validateOrderPayload', depth: 1 },
        { call_id: 'cd2', node_id: 'n_deep_price', method_name: 'priceOrder', depth: 2 },
        { call_id: 'cd3', node_id: 'n_deep_save', method_name: 'saveOrder', depth: 3 },
      ],
      characteristics: {
        total_calls: 4, max_depth: 4, has_external_calls: false,
        has_database_calls: true, has_async_calls: false,
        is_circular: false, is_recursive: false, complexity_score: 4,
      },
      risk_analysis: { risk_level: 'medium', risk_factors: [] },
    },
  ] as unknown as CASCallChain[];

  // The materialized flow index the analyzer persists for every derived flow —
  // the ranking input. step_count/criticality/terminus/capability links here
  // are the same facts the derived flows carry, so ranking costs nothing.
  const flows: CASFlowRef[] = [
    ...Array.from({ length: LEAF_COUNT }, (_, i) => ({
      flow_id: `flow::chain_a${i}`,
      name: `Ping ${i}`,
      intent: 'ping',
      entry_point: `ep_leaf_${i}`,
      call_chain_id: `chain_a${i}`,
      criticality: 'low' as const,
      step_count: 1,
      terminus: { kind: 'api', produces: `pong_${i}` },
    })),
    {
      flow_id: 'flow::chain_z_deep',
      name: 'Create Order',
      intent: 'create order',
      entry_point: 'ep_deep',
      call_chain_id: 'chain_z_deep',
      criticality: 'high' as const,
      capability_ids: ['cap_orders'],
      step_count: 3,
      terminus: { kind: 'database', produces: 'orders_table' },
    },
  ];

  return {
    analysis_id: 'test-ranked-window',
    nodes, edges, entry_points, exit_points, call_chains,
    flow_graph: {
      capabilities: [], dependencies: [], flows,
      topology: { root_capabilities: [], leaf_capabilities: [], critical_path: [], max_depth: 0 },
    },
  } as unknown as CASOutput;
}

describe('rank before truncating — the flow window is ordered by significance', () => {
  test('a 1-slot window returns the DEEP multi-step flow, not the alphabetically-first 1-step leaf', () => {
    const flows = computeFlowConcepts(buildRankableCas(), { maxFlows: 1 });
    expect(flows).toHaveLength(1);
    expect(flows[0].flow_id).toBe('flow::chain_z_deep');
    expect(flows[0].steps.length).toBeGreaterThan(1);
  });

  test('the deep flow outranks every 1-step leaf in the full ranked order', () => {
    const ranked = rankStoredFlowRefs(buildRankableCas());
    expect(ranked).toHaveLength(LEAF_COUNT + 1);
    expect(ranked[0].flow_id).toBe('flow::chain_z_deep');
  });

  test('ranking is byte-stable: identical input produces the identical order', () => {
    const a = rankStoredFlowRefs(buildRankableCas()).map(r => r.flow_id);
    const b = rankStoredFlowRefs(buildRankableCas()).map(r => r.flow_id);
    expect(a).toEqual(b);
    const flowsA = JSON.stringify(computeFlowConcepts(buildRankableCas(), { maxFlows: 3 }));
    const flowsB = JSON.stringify(computeFlowConcepts(buildRankableCas(), { maxFlows: 3 }));
    expect(flowsA).toBe(flowsB);
  });

  test('a test-rooted flow never outranks a product flow, whatever its depth', () => {
    const cas = buildRankableCas();
    // Make the deepest flow test-rooted: the product class gate must demote it
    // below every 1-step product leaf.
    cas.entry_points = (cas.entry_points || []).map(ep =>
      ep.id === 'ep_deep' ? ({ ...ep, type: 'test' } as CASEntryPoint) : ep);
    const ranked = rankStoredFlowRefs(cas);
    expect(ranked[ranked.length - 1].flow_id).toBe('flow::chain_z_deep');
  });

  test('page 2 returns different flows than page 1, and the union is the total', () => {
    const cas = buildRankableCas();
    const total = (cas.flow_graph?.flows || []).length;
    const page1 = computeFlowConcepts(cas, { maxFlows: 3, offset: 0 }).map(f => f.flow_id);
    const page2 = computeFlowConcepts(cas, { maxFlows: 3, offset: 3 }).map(f => f.flow_id);
    expect(page1).toHaveLength(3);
    expect(page2).toHaveLength(3);
    expect(page1.some(id => page2.includes(id))).toBe(false);
    expect(new Set([...page1, ...page2]).size).toBe(total);
  });

  test('criticality is joined from the materialized flow index instead of reported undefined', () => {
    const flows = computeFlowConcepts(buildRankableCas(), { maxFlows: 6 });
    const deep = flows.find(f => f.flow_id === 'flow::chain_z_deep');
    expect(deep?.criticality).toBe('high');
    expect(flows.find(f => f.flow_id === 'flow::chain_a0')?.criticality).toBe('low');
  });

  test('a CAS with no materialized flow index falls back to the legacy order, unchanged', () => {
    const cas = buildRankableCas();
    delete (cas as { flow_graph?: unknown }).flow_graph;
    expect(rankStoredFlowRefs(cas)).toHaveLength(0);
    const flows = computeFlowConcepts(cas, { maxFlows: 1 });
    // Legacy behaviour: derivation order, i.e. the alphabetically-first chain.
    expect(flows).toHaveLength(1);
    expect(flows[0].flow_id).toBe('flow::chain_a0');
  });

  test('an uncapped, un-offset ask still derives the full union (a lagging index can never drop a flow)', () => {
    const cas = buildRankableCas();
    // Index deliberately missing one real flow — the uncapped path must not
    // inherit that gap.
    cas.flow_graph!.flows = (cas.flow_graph!.flows || []).filter(f => f.flow_id !== 'flow::chain_a4');
    const flows = computeFlowConcepts(cas, {});
    expect(flows.map(f => f.flow_id)).toContain('flow::chain_a4');
  });
});
