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
 * UNION-path fixture (gap: the all-or-nothing switch). One terminal
 * entry-to-exit chain must NOT suppress the entry-point flows of significant
 * dead-end entries:
 *   - ep_orders  (http)  -> n_orders -> n_saveOrder (db write)  — has a
 *     recorded entry-to-exit chain, BUT the chain's call_path only records
 *     the handler node, missing the writer (exercises entry-family rollup).
 *   - ep_events  (event) -> n_onUserEvent -> n_applyEvent        — dead-ends
 *     (no exit chain), authenticated: a significant entry that deserves a flow.
 *   - ep_test    (test)  — must never become a union flow.
 *   - ep_noop    (http)  -> n_noop, single node, no exits/lineage/guards —
 *     trivial dead flow, excluded from the union.
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

function buildUnionCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_orders', name: 'handleCreateOrder', type: 'controller', category: 'entry' }),
    node({ id: 'n_saveOrder', name: 'saveOrder', type: 'function', category: 'data' }),
    node({ id: 'n_onUserEvent', name: 'onUserEvent', type: 'handler', category: 'entry' }),
    node({ id: 'n_applyEvent', name: 'applyEvent', type: 'function', category: 'business' }),
    node({ id: 'n_testHelper', name: 'testHelper', type: 'function', category: 'business' }),
    node({ id: 'n_noop', name: 'noop', type: 'function', category: 'business' }),
  ];
  const edges: CASEdge[] = [
    { id: 'e1', source: 'n_orders', target: 'n_saveOrder', type: 'calls' },
    { id: 'e2', source: 'n_onUserEvent', target: 'n_applyEvent', type: 'calls' },
  ];
  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_orders', source_node: 'n_orders', type: 'http', name: 'createOrder',
      trigger: { method: 'POST', path: '/orders' },
      handler: { node_id: 'n_orders', method_name: 'handleCreateOrder' },
    },
    {
      id: 'ep_events', source_node: 'n_onUserEvent', type: 'event', name: 'userEvent',
      trigger: { event: 'user.updated' },
      handler: { node_id: 'n_onUserEvent', method_name: 'onUserEvent' },
      security: { authenticated: true },
    },
    {
      id: 'ep_test', source_node: 'n_testHelper', type: 'test', name: 'testHelper',
      handler: { node_id: 'n_testHelper', method_name: 'testHelper' },
    },
    {
      id: 'ep_noop', source_node: 'n_noop', type: 'http', name: 'noop',
      handler: { node_id: 'n_noop', method_name: 'noop' },
    },
  ];
  const exit_points: CASExitPoint[] = [
    {
      id: 'xp_db', source_node: 'n_saveOrder', type: 'database', name: 'saveOrder',
      target: { resource: 'orders_table' },
    } as CASExitPoint,
  ];
  const data_lineage: CASEntityLineage[] = [
    {
      entity_id: 'entity_order', entity_name: 'Order', sensitive_fields: [],
      writers: [{ node_id: 'n_saveOrder' } as any], readers: [],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
  ];
  const call_chains: CASCallChain[] = [
    {
      id: 'chain_orders',
      chain_type: 'entry-to-exit',
      entry_point: { node_id: 'n_orders', method_name: 'handleCreateOrder', entry_point_id: 'ep_orders' },
      exit_point: { node_id: 'n_saveOrder', method_name: 'saveOrder', exit_point_id: 'xp_db' },
      // Deliberately records ONLY the handler node — the writer (n_saveOrder)
      // is missing from the path, exercising the entry-family entity rollup.
      call_path: [
        { call_id: 'c1', node_id: 'n_orders', method_name: 'handleCreateOrder', depth: 0 },
      ],
      characteristics: {
        total_calls: 1, max_depth: 1, has_external_calls: false,
        has_database_calls: true, has_async_calls: false,
        is_circular: false, is_recursive: false, complexity_score: 1,
      },
      risk_analysis: { risk_level: 'low', risk_factors: [] },
    },
  ];
  const system_capabilities: SystemCapability[] = [
    {
      id: 'cap_orders', name: 'Order Management', category: 'core', criticality: 'high',
      operations: [{ action: 'create order', entry_point_id: 'ep_orders', entry_point_type: 'http' }],
    } as any,
    {
      id: 'cap_events', name: 'Event Processing', category: 'core', criticality: 'medium',
      operations: [{ action: 'apply user event', entry_point_id: 'ep_events', entry_point_type: 'event' }],
    } as any,
  ];

  return {
    analysis_id: 'test-union',
    nodes, edges, entry_points, exit_points, data_lineage, call_chains, system_capabilities,
  } as unknown as CASOutput;
}

describe('computeFlowConcepts — union of terminal + dead-end entry flows', () => {
  const cas = buildUnionCas();
  const flows = computeFlowConcepts(cas);

  test('terminal flows do NOT suppress entry-point flows (union, not all-or-nothing)', () => {
    const terminal = flows.find(f => f.flow_id === 'flow::chain_orders');
    const deadEnd = flows.find(f => f.entry_point === 'ep_events');
    expect(terminal).toBeDefined();
    expect(deadEnd).toBeDefined();
  });

  test('dedup by entry point — terminal wins, no duplicate flow for the covered entry', () => {
    const forOrders = flows.filter(f => f.entry_point === 'ep_orders');
    expect(forOrders).toHaveLength(1);
    expect(forOrders[0].flow_id).toBe('flow::chain_orders');
    expect(forOrders[0].terminus?.kind).toBe('database');
  });

  test('union significance filter: test entries and trivial no-surface entries are excluded', () => {
    expect(flows.find(f => f.entry_point === 'ep_test')).toBeUndefined();
    expect(flows.find(f => f.entry_point === 'ep_noop')).toBeUndefined();
  });

  test('capability_id is stamped on terminal AND union entry-point flows', () => {
    expect(flows.find(f => f.entry_point === 'ep_orders')?.capability_id).toBe('cap_orders');
    expect(flows.find(f => f.entry_point === 'ep_events')?.capability_id).toBe('cap_events');
  });

  test('entities attach via the entry-point family even when the chain path missed the writer node', () => {
    const terminal = flows.find(f => f.flow_id === 'flow::chain_orders')!;
    // call_path only had n_orders; the Order writer (n_saveOrder) is reached
    // through the handler's forward family.
    expect(terminal.entities).toContain('Order');
  });

  test('maxFlows caps the union (terminal first, entry flows fill the remainder)', () => {
    const capped = computeFlowConcepts(cas, { maxFlows: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0].flow_id).toBe('flow::chain_orders');
  });

  test('every step carries description_source=deterministic-label by default', () => {
    for (const flow of flows) {
      for (const step of flow.steps) {
        expect(step.description_source).toBe('deterministic-label');
      }
    }
  });

  test('the nameStep seam flips description_source to ai when it overrides (interpretive provenance)', () => {
    const aiFlows = computeFlowConcepts(cas, {
      nameStep: (step) => step.order === 0 ? { description: 'AI-authored step description.' } : undefined,
    });
    const withAi = aiFlows.find(f => f.entry_point === 'ep_events')!;
    expect(withAi.steps[0].description_source).toBe('ai');
    expect(withAi.steps[0].description).toBe('AI-authored step description.');
    const untouched = withAi.steps.find(s => s.order > 0);
    if (untouched) expect(untouched.description_source).toBe('deterministic-label');
  });
});
