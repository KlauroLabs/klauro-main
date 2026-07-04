import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  CASDataEntity,
  SystemCapability,
} from '../../types/cas.types';

/**
 * Fixture: a route -> validate(guard) -> persist(write) -> notify(external)
 * chain, the canonical shape the spec asks to assert against:
 *   handleCreateOrder (route/controller)
 *     -> validateOrder (guard clause: throws when !order.total > 0 style)
 *     -> saveOrder (writes Order entity)
 *     -> notifyWarehouse (calls an external webhook)
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return {
    qualified_name: overrides.name,
    ...overrides,
  } as CASNode;
}

function buildFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node({
      id: 'n_handleCreateOrder',
      name: 'handleCreateOrder',
      type: 'controller',
      category: 'entry',
    }),
    node({
      id: 'n_validateOrder',
      name: 'validateOrder',
      type: 'function',
      category: 'business',
      source: {
        file: 'src/orders/validate.ts',
        line: 1,
        end_line: 10,
        raw: [
          'function validateOrder(order) {',
          '  if (!order.total > 0) {',
          '    throw new Error("total must be positive");',
          '  }',
          '  if (order.status !== "PENDING") {',
          '    throw new Error("order must be PENDING");',
          '  }',
          '  return true;',
          '}',
        ].join('\n'),
      },
    }),
    node({
      id: 'n_saveOrder',
      name: 'saveOrder',
      type: 'function',
      category: 'data',
    }),
    node({
      id: 'n_notifyWarehouse',
      name: 'notifyWarehouse',
      type: 'function',
      category: 'business',
    }),
  ];

  const edges: CASEdge[] = [
    { id: 'e1', source: 'n_handleCreateOrder', target: 'n_validateOrder', type: 'calls' },
    { id: 'e2', source: 'n_validateOrder', target: 'n_saveOrder', type: 'calls' },
    { id: 'e3', source: 'n_saveOrder', target: 'n_notifyWarehouse', type: 'calls' },
  ];

  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_createOrder',
      source_node: 'n_handleCreateOrder',
      type: 'http',
      name: 'createOrder',
      trigger: { method: 'POST', path: '/orders' },
      handler: { node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder' },
      security: { authenticated: true, guards: ['AuthGuard'] },
      input: { validation: ['total must be a positive number'] },
    },
  ];

  const exit_points: CASExitPoint[] = [
    {
      id: 'xp_saveOrder',
      source_node: 'n_saveOrder',
      type: 'database',
      name: 'saveOrder',
      target: { resource: 'orders_table' },
    } as CASExitPoint,
    {
      id: 'xp_notifyWarehouse',
      source_node: 'n_notifyWarehouse',
      type: 'webhook',
      name: 'notifyWarehouse',
      target: { service_id: 'warehouse-service' },
    } as CASExitPoint,
  ];

  const data_lineage: CASEntityLineage[] = [
    {
      entity_id: 'entity_order',
      entity_name: 'Order',
      sensitive_fields: [],
      writers: [{ node_id: 'n_saveOrder' } as any],
      readers: [{ node_id: 'n_validateOrder' } as any],
      external_recipients: [{ service: 'warehouse-service' } as any],
      boundaries_crossed: [],
      journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: true, sensitive: false },
    },
  ];

  const data_entities: CASDataEntity[] = [
    {
      id: 'entity_order',
      name: 'Order',
      lifecycle: { created_by: ['n_saveOrder'], read_by: ['n_validateOrder'], updated_by: [], deleted_by: [] },
      invariants: [
        { description: 'order total must be positive', enforced_by: ['n_validateOrder'], source: 'validation' },
      ],
    },
  ];

  const system_capabilities: SystemCapability[] = [
    {
      id: 'cap_order_management',
      name: 'Order Management',
      description: 'Create and manage orders',
      category: 'core',
      operations: [{ entry_point_id: 'ep_createOrder', entry_point_type: 'http', action: 'create' }],
      related_entities: ['Order'],
      related_domains: [],
      criticality: 'high',
      criticality_factors: [],
    },
  ];

  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test',
    system: { name: 'test-system' } as any,
    nodes,
    edges,
    entry_points,
    exit_points,
    data_lineage,
    data_entities,
    system_capabilities,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('computeFlowConcepts', () => {
  const cas = buildFixtureCas();
  const flows = computeFlowConcepts(cas);

  test('produces exactly one flow for the single entry point', () => {
    expect(flows.length).toBe(1);
  });

  test('flow links capability_id and touched entities', () => {
    const flow = flows[0];
    expect(flow.entry_point).toBe('ep_createOrder');
    expect(flow.capability_id).toBe('cap_order_management');
    expect(flow.entities).toContain('Order');
  });

  test('segments into named steps, not one-function noise', () => {
    const flow = flows[0];
    expect(flow.steps.length).toBeGreaterThan(1);
    const names = flow.steps.map(s => s.name);
    expect(names.some(n => /validate/i.test(n))).toBe(true);
    expect(names.some(n => /persist|order/i.test(n))).toBe(true);
    expect(names.some(n => /call|warehouse/i.test(n))).toBe(true);
  });

  test('step function refs are correct and ordered', () => {
    const flow = flows[0];
    const allFunctionIds = flow.steps.flatMap(s => s.functions.map(f => f.function_id));
    expect(allFunctionIds).toEqual(
      expect.arrayContaining(['n_handleCreateOrder', 'n_validateOrder', 'n_saveOrder', 'n_notifyWarehouse'])
    );
    // orders must be monotonically increasing
    const orders = flow.steps.map(s => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  test('state_changes vs external_integrations are split correctly', () => {
    const flow = flows[0];
    const persistStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_saveOrder'));
    const notifyStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_notifyWarehouse'));
    expect(persistStep).toBeDefined();
    expect(notifyStep).toBeDefined();

    // the persist step must record a state change (DB write / entity update)
    expect(persistStep!.contract.side_effects.state_changes.length).toBeGreaterThan(0);

    // the notify step (or flow aggregate) must record the external integration
    const flowExternal = flow.contract.side_effects.external_integrations;
    expect(flowExternal.some(x => /warehouse/i.test(x))).toBe(true);
  });

  test('at least one constraint is derived from the guard clause / invariant', () => {
    const flow = flows[0];
    const validateStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_validateOrder'));
    expect(validateStep).toBeDefined();
    expect(validateStep!.contract.constraints.length).toBeGreaterThan(0);
    // flow-level aggregate must also carry it
    expect(flow.contract.constraints.length).toBeGreaterThan(0);
  });

  test('honest gaps: target with no match reports a gap, not a fabricated flow', () => {
    const noMatch = computeFlowConcepts(cas, { target: 'nonexistent-route-xyz' });
    expect(noMatch.length).toBe(0);
  });

  test('step-level entities are derived alongside flow-level entities', () => {
    const flow = flows[0];
    const persistStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_saveOrder'));
    expect(persistStep).toBeDefined();
    expect(persistStep!.entities).toContain('Order');
    // a step that never touches the entity (the notify step) must not
    // fabricate entity membership just because the flow overall touches it.
    const notifyStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_notifyWarehouse'));
    expect(notifyStep!.entities).not.toContain('Order');
  });
});

/**
 * Fixture: a FRONTEND-shaped flow (react_route -> component -> hook_usage,
 * ids look like `hook_usage_src_app_...`) that, via a call edge, reaches a
 * BACKEND-shaped node (`method_class_...`) whose id is the exact string a
 * data_entities[].lifecycle toucher array names. This is the real-repo shape
 * (verified against this repo and zerac-api): both data_lineage and
 * data_entities.lifecycle already key on literal CAS node ids — there is no
 * separate id-namespace encoding to translate, only a call-graph reachability
 * gap once an edge crosses from a frontend-typed node into a backend-typed
 * one. This fixture asserts computeFlowConcepts credits the entity onto both
 * the flow and the specific step that reaches the backend node once that
 * edge exists, using the SAME literal id on both sides of the boundary.
 */
function buildCrossBoundaryFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'react_route_app_index_tsx__orders', name: 'OrdersRoute', type: 'react_route', category: 'entry' }),
    node({ id: 'component_src_app_Orders_tsx_Orders', name: 'Orders', type: 'functional_component', category: 'presentation' }),
    node({
      id: 'hook_usage_src_app_Orders_tsx_Orders_useQuery_1',
      name: 'useQuery usage',
      type: 'hook_usage',
      category: 'business',
    }),
    // backend-shaped node id, reached only via the hook->backend edge below —
    // this is the exact id data_entities.lifecycle/data_lineage name as a
    // toucher, proving no translation is needed once the edge exists.
    node({
      id: 'method_class_apps/api/src/orders/orders.service.ts_OrdersService_0_findAll_1',
      name: 'findAll',
      type: 'method',
      category: 'data',
    }),
  ];

  const edges: CASEdge[] = [
    { id: 'e1', source: 'react_route_app_index_tsx__orders', target: 'component_src_app_Orders_tsx_Orders', type: 'renders' },
    { id: 'e2', source: 'component_src_app_Orders_tsx_Orders', target: 'hook_usage_src_app_Orders_tsx_Orders_useQuery_1', type: 'uses' },
    // the hook->backend bridge edge (edgelink's concurrent work) — traceForwardChain
    // must follow it since it matches the generic 'calls'-family/traversable check.
    {
      id: 'e3',
      source: 'hook_usage_src_app_Orders_tsx_Orders_useQuery_1',
      target: 'method_class_apps/api/src/orders/orders.service.ts_OrdersService_0_findAll_1',
      type: 'calls',
    },
  ];

  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_orders_route',
      source_node: 'react_route_app_index_tsx__orders',
      type: 'route',
      name: 'OrdersRoute',
      trigger: { path: '/orders' },
    },
  ];

  const data_entities: CASDataEntity[] = [
    {
      id: 'entity_order',
      name: 'Order',
      lifecycle: {
        created_by: [],
        read_by: ['method_class_apps/api/src/orders/orders.service.ts_OrdersService_0_findAll_1'],
        updated_by: [],
        deleted_by: [],
      },
    },
  ];

  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test-cross-boundary',
    system: { name: 'test-system' } as any,
    nodes,
    edges,
    entry_points,
    exit_points: [],
    data_lineage: [],
    data_entities,
    system_capabilities: [],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('computeFlowConcepts — cross-namespace entity derivation', () => {
  const cas = buildCrossBoundaryFixtureCas();
  const flows = computeFlowConcepts(cas);

  test('a frontend-rooted flow that reaches a backend node via a call edge derives the entity that node touches', () => {
    expect(flows.length).toBe(1);
    const flow = flows[0];
    expect(flow.entities).toContain('Order');
  });

  test('the specific step containing the backend node carries the entity, not just the flow aggregate', () => {
    const flow = flows[0];
    const backendStep = flow.steps.find(s =>
      s.functions.some(f => f.function_id === 'method_class_apps/api/src/orders/orders.service.ts_OrdersService_0_findAll_1')
    );
    expect(backendStep).toBeDefined();
    expect(backendStep!.entities).toContain('Order');
  });
});

/**
 * Fixture: system_capabilities references a handler node directly via the
 * `node:<id>` operation shape, but cas.entry_points never surfaces that node
 * as a root (the real gap found on zerac-api: NestJS controller methods are
 * called from a route, but no entry_points entry names the controller method
 * itself). computeFlowConcepts must synthesize a traceable root from the
 * capability operation so the flow — and its entities — are still derivable,
 * and must say so honestly in `gaps` rather than presenting it as a normal
 * entry-point-rooted flow.
 */
function buildCapabilityOnlyRootFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node({
      id: 'method_class_apps/api/src/billing/billing.controller.ts_BillingController_0_charge_1',
      name: 'charge',
      type: 'method',
      category: 'entry',
    }),
    node({
      id: 'method_class_apps/api/src/billing/billing.service.ts_BillingService_0_chargeCard_1',
      name: 'chargeCard',
      type: 'method',
      category: 'business',
    }),
  ];

  const edges: CASEdge[] = [
    {
      id: 'e1',
      source: 'method_class_apps/api/src/billing/billing.controller.ts_BillingController_0_charge_1',
      target: 'method_class_apps/api/src/billing/billing.service.ts_BillingService_0_chargeCard_1',
      type: 'calls',
    },
  ];

  const data_entities: CASDataEntity[] = [
    {
      id: 'entity_billing',
      name: 'Billing',
      lifecycle: {
        created_by: ['method_class_apps/api/src/billing/billing.service.ts_BillingService_0_chargeCard_1'],
        read_by: [],
        updated_by: [],
        deleted_by: [],
      },
    },
  ];

  const system_capabilities: SystemCapability[] = [
    {
      id: 'cap_billing_management',
      name: 'Billing Management',
      description: 'Charge cards',
      category: 'core',
      operations: [{
        entry_point_id: 'node:method_class_apps/api/src/billing/billing.controller.ts_BillingController_0_charge_1',
        entry_point_type: 'internal',
        action: 'charge',
      }],
      related_entities: ['Billing'],
      related_domains: [],
      criticality: 'high',
      criticality_factors: [],
    },
  ];

  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test-capability-only-root',
    system: { name: 'test-system' } as any,
    nodes,
    edges,
    entry_points: [], // the real-repo gap: NO entry_points at all for this controller method.
    exit_points: [],
    data_lineage: [],
    data_entities,
    system_capabilities,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('computeFlowConcepts — capability-operation-only root synthesis', () => {
  const cas = buildCapabilityOnlyRootFixtureCas();
  const flows = computeFlowConcepts(cas);

  test('synthesizes a flow root from the capability operation when entry_points has none', () => {
    expect(flows.length).toBe(1);
    expect(flows[0].capability_id).toBe('cap_billing_management');
  });

  test('the synthesized flow honestly reports the synthesis in gaps', () => {
    expect(flows[0].gaps).toBeDefined();
    expect(flows[0].gaps!.some(g => /synthesized/i.test(g))).toBe(true);
  });

  test('the synthesized flow still derives real entities from the backend chain it reaches', () => {
    expect(flows[0].entities).toContain('Billing');
  });
});
