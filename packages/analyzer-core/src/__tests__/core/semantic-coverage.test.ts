import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import { computeSemanticCoverage, toCompactSemanticCoverage } from '../../analyzer/core/semantic-coverage';
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

function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

/**
 * Fixture engineered so the reachable universe and the flow-step set DIVERGE in a
 * controlled way — the only shape where reachable_code_to_steps is meaningfully
 * < 1.0 (a terminal chain records a NARROW path through a wider reachable family):
 *
 *   Reachable from entry n_handleCreateOrder (call edges):
 *     handleCreateOrder -> validateOrder -> saveOrder -> notifyWarehouse -> genHelper
 *   The recorded entry-to-exit call_chain path is NARROW: [handleCreateOrder, saveOrder]
 *   (skips validate / notify / genHelper), so the terminal flow's steps cover only
 *   {handleCreateOrder, saveOrder}.
 *
 *   A SECOND, capability-less entry (health -> healthImpl) exercises
 *   flows_to_capabilities < 1.0.
 *
 * Expected:
 *   reachable executable nodes = {handleCreateOrder, validateOrder, saveOrder,
 *     notifyWarehouse, genHelper, healthCheck, healthImpl} = 7
 *   mapped-to-steps            = {handleCreateOrder, saveOrder} (terminal) +
 *                                {healthCheck, healthImpl} (health flow) = 4
 *   → reachable_code_to_steps = 4/7
 *   unmapped code_units = {validateOrder (no effects), notifyWarehouse (webhook
 *     effect), genHelper (framework-generated)} = 3
 *   flows_to_capabilities = 1/2 (order flow has a capability, health flow does not)
 */
function buildFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_handleCreateOrder', name: 'handleCreateOrder', type: 'controller', category: 'entry' }),
    node({ id: 'n_validateOrder', name: 'validateOrder', type: 'function', category: 'business' }),
    node({ id: 'n_saveOrder', name: 'saveOrder', type: 'function', category: 'data' }),
    node({ id: 'n_notifyWarehouse', name: 'notifyWarehouse', type: 'function', category: 'business' }),
    node({ id: 'n_genHelper', name: 'genHelper', type: 'function', category: 'business', metadata: { is_generated: true } as any }),
    node({ id: 'n_healthCheck', name: 'healthCheck', type: 'controller', category: 'entry' }),
    node({ id: 'n_healthImpl', name: 'healthImpl', type: 'function', category: 'business' }),
    // a NON-executable, unreachable node — must never enter the reachable universe.
    node({ id: 'n_OrderDto', name: 'OrderDto', type: 'entity', category: 'data' }),
  ];

  const edges: CASEdge[] = [
    { id: 'e1', source: 'n_handleCreateOrder', target: 'n_validateOrder', type: 'calls' },
    { id: 'e2', source: 'n_validateOrder', target: 'n_saveOrder', type: 'calls' },
    { id: 'e3', source: 'n_saveOrder', target: 'n_notifyWarehouse', type: 'calls' },
    { id: 'e4', source: 'n_notifyWarehouse', target: 'n_genHelper', type: 'calls' },
    { id: 'e5', source: 'n_healthCheck', target: 'n_healthImpl', type: 'calls' },
  ];

  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_createOrder', source_node: 'n_handleCreateOrder', type: 'http', name: 'createOrder',
      trigger: { method: 'POST', path: '/orders' },
      handler: { node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder' },
    } as CASEntryPoint,
    {
      id: 'ep_health', source_node: 'n_healthCheck', type: 'http', name: 'health',
      trigger: { method: 'GET', path: '/health' },
      handler: { node_id: 'n_healthCheck', method_name: 'healthCheck' },
    } as CASEntryPoint,
  ];

  const exit_points: CASExitPoint[] = [
    { id: 'xp_saveOrder', source_node: 'n_saveOrder', type: 'database', name: 'saveOrder', target: { resource: 'orders_table' } } as CASExitPoint,
    { id: 'xp_notifyWarehouse', source_node: 'n_notifyWarehouse', type: 'webhook', name: 'notifyWarehouse', target: { service_id: 'warehouse-service' } } as CASExitPoint,
  ];

  const data_lineage: CASEntityLineage[] = [
    {
      entity_id: 'entity_order', entity_name: 'Order', sensitive_fields: [],
      writers: [{ node_id: 'n_saveOrder' } as any], readers: [{ node_id: 'n_validateOrder' } as any],
      external_recipients: [], boundaries_crossed: [], entry_point_flows_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
  ];

  // NARROW recorded terminal path: entry -> save (skips validate/notify/genHelper).
  const call_chains: CASCallChain[] = [
    {
      id: 'chain_createOrder',
      chain_type: 'entry-to-exit',
      entry_point: { node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder', entry_point_id: 'ep_createOrder' },
      exit_point: { node_id: 'n_saveOrder', method_name: 'saveOrder', exit_point_id: 'xp_saveOrder' },
      call_path: [
        { call_id: 'c0', node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder', depth: 0 },
        { call_id: 'c1', node_id: 'n_saveOrder', method_name: 'saveOrder', depth: 1 },
      ],
      characteristics: { total_calls: 2, max_depth: 1, has_external_calls: false, has_database_calls: true, has_async_calls: false, is_circular: false, is_recursive: false, complexity_score: 1 },
    } as CASCallChain,
  ];

  const capabilities: SystemCapability[] = [
    {
      id: 'cap_order_management', name: 'Order Management', description: 'Create and manage orders', category: 'core',
      operations: [{ entry_point_id: 'ep_createOrder', entry_point_type: 'http', action: 'create' }],
      related_entities: ['Order'], related_domains: [], criticality: 'high', criticality_factors: [],
    } as SystemCapability,
  ];

  return {
    cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test',
    system: { name: 'test-system' } as any,
    nodes, edges, entry_points, exit_points, data_lineage, call_chains, capabilities,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('computeSemanticCoverage', () => {
  const cas = buildFixtureCas();
  const flows = computeFlowConcepts(cas);
  const cov = computeSemanticCoverage(cas, flows);

  test('reachable_code_to_steps counts only reachable executable nodes, narrow terminal path leaves some unmapped', () => {
    // 7 reachable executable nodes; the non-executable unreachable DTO is excluded.
    expect(cov.reachable_code_to_steps.total).toBe(7);
    expect(cov.reachable_code_to_steps.mapped).toBe(4);
    expect(cov.reachable_code_to_steps.ratio).toBeCloseTo(4 / 7, 4);
  });

  test('the non-executable DTO node never enters the reachable universe or unmapped list', () => {
    const allUnmapped = cov.unmapped.code_units.map(u => u.id);
    expect(allUnmapped).not.toContain('n_OrderDto');
  });

  test('unmapped code_units are exactly the reachable-but-unstepped nodes, with correct deterministic reasons', () => {
    const byId = new Map(cov.unmapped.code_units.map(u => [u.id, u.reason]));
    expect(new Set(byId.keys())).toEqual(new Set(['n_validateOrder', 'n_notifyWarehouse', 'n_genHelper']));
    // validateOrder: no exit point, not a lineage writer → no observable surface.
    expect(byId.get('n_validateOrder')).toBe('reachable-no-effects');
    // notifyWarehouse: has a webhook exit point → effects uncaptured by a step.
    expect(byId.get('n_notifyWarehouse')).toBe('reachable-with-effects-uncaptured');
    // genHelper: metadata.is_generated wins the classification.
    expect(byId.get('n_genHelper')).toBe('framework-generated');
  });

  test('steps_to_flows is the ~1.0 invariant (every step nested in a flow), no orphans', () => {
    expect(cov.steps_to_flows.mapped).toBe(cov.steps_to_flows.total);
    expect(cov.steps_to_flows.ratio).toBe(1);
    expect(cov.unmapped.steps.length).toBe(0);
  });

  test('flows_to_capabilities reflects the capability-less health flow honestly', () => {
    expect(cov.flows_to_capabilities.total).toBe(flows.length);
    // order flow relates to a capability; health flow does not.
    expect(cov.flows_to_capabilities.mapped).toBe(1);
    const capless = cov.unmapped.flows.map(f => f.name);
    expect(capless.some(n => /health/i.test(n))).toBe(true);
  });

  test('the capability-less health flow is diagnosed no-entity-evidence (it touches no entities at all)', () => {
    const health = cov.unmapped.flows.find(f => /health/i.test(f.name))!;
    expect(health.reason).toContain('no-entity-evidence');
    expect(health.reason).toContain('flow touches no entities this repo tracks');
  });

  test('ratios are byte-stable run-to-run (deterministic, Camp-B)', () => {
    const again = computeSemanticCoverage(cas, computeFlowConcepts(cas));
    expect(JSON.stringify(again)).toBe(JSON.stringify(cov));
  });

  test('unmapped lists sort stably and report an omitted count', () => {
    const ids = cov.unmapped.code_units.map(u => u.id);
    expect(ids).toEqual([...ids].sort());
    expect(cov.unmapped.code_units_omitted).toBe(0);
  });

  test('compact projection drops full lists but keeps ratios + counts', () => {
    const compact = toCompactSemanticCoverage(cov);
    expect(compact.reachable_code_to_steps).toEqual(cov.reachable_code_to_steps);
    expect(compact.unmapped_counts.code_units).toBe(3);
    expect(compact.unmapped_counts.flows).toBe(1);
    expect((compact as any).unmapped).toBeUndefined();
  });

  test('empty flow set → vacuous ratios (never a false zero)', () => {
    const empty = computeSemanticCoverage(cas, []);
    // no steps → nothing mapped; flows_to_capabilities/steps_to_flows vacuously 1.
    expect(empty.steps_to_flows.ratio).toBe(1);
    expect(empty.flows_to_capabilities.ratio).toBe(1);
    // reachable code still has a non-zero denominator, so its ratio is a real 0.
    expect(empty.reachable_code_to_steps.total).toBe(7);
    expect(empty.reachable_code_to_steps.mapped).toBe(0);
    expect(empty.reachable_code_to_steps.ratio).toBe(0);
  });
});

/**
 * Reason differentiation (WHY a flow is unmapped, not just THAT it is):
 * no-entity-evidence — the flow's path touches no tracked entity at all;
 * no-capability-match — it DOES touch real entities, but none of them
 * belong to any capability's related_entities, and no operation cites it.
 */
describe('computeSemanticCoverage — unmapped.flows reason differentiation', () => {
  test('a flow touching real entities that no capability declares is no-capability-match, distinct from no-entity-evidence', () => {
    const cas = buildFixtureCas();
    // A third, capability-less flow that DOES touch a real, tracked entity
    // ("Widget") — but no capability's related_entities includes it.
    (cas.nodes as CASNode[]).push(
      node({ id: 'n_widgetHandler', name: 'handleWidget', type: 'controller', category: 'entry' }),
      node({ id: 'n_saveWidget', name: 'saveWidget', type: 'function', category: 'data' }),
    );
    (cas.edges as CASEdge[]).push({ id: 'ew1', source: 'n_widgetHandler', target: 'n_saveWidget', type: 'calls' });
    (cas.entry_points as CASEntryPoint[]).push({
      id: 'ep_widget', source_node: 'n_widgetHandler', type: 'http', name: 'widget',
      trigger: { method: 'POST', path: '/widgets' },
      handler: { node_id: 'n_widgetHandler', method_name: 'handleWidget' },
    } as CASEntryPoint);
    (cas.data_lineage as CASEntityLineage[]).push({
      entity_id: 'entity_widget', entity_name: 'Widget', sensitive_fields: [],
      writers: [{ node_id: 'n_saveWidget' } as any], readers: [],
      external_recipients: [], boundaries_crossed: [], entry_point_flows_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    });

    const flows = computeFlowConcepts(cas);
    const cov = computeSemanticCoverage(cas, flows);

    const health = cov.unmapped.flows.find(f => /health/i.test(f.name))!;
    expect(health.reason).toContain('no-entity-evidence');

    const widget = cov.unmapped.flows.find(f => /widget/i.test(f.name))!;
    expect(widget).toBeDefined();
    expect(widget.reason).toContain('no-capability-match');
    expect(widget.reason).toContain('Widget');
    expect(widget.reason).not.toContain('no-entity-evidence');
  });
});
