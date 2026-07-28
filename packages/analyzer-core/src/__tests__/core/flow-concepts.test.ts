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

  test('constraints are first-class {kind, rule, evidence} records, not bare strings', () => {
    const flow = flows[0];
    for (const c of flow.contract.constraints) {
      expect(typeof c).toBe('object');
      expect(typeof c.kind).toBe('string');
      expect(typeof c.rule).toBe('string');
      expect(typeof c.evidence).toBe('string');
      expect(c.evidence.length).toBeGreaterThan(0); // evidence-gated: never empty
    }
    // the auth guard on the entry point must surface as an auth-kind constraint
    const authConstraint = flow.contract.constraints.find(c => c.kind === 'auth');
    expect(authConstraint).toBeDefined();
    expect(authConstraint!.rule).toMatch(/authenticated/i);
    // the guard clause in validateOrder's source must surface as a business-rule
    const bizRule = flow.contract.constraints.find(c => c.kind === 'business-rule');
    expect(bizRule).toBeDefined();
    // the data-entity invariant must surface as an invariant-kind constraint
    const invariant = flow.contract.constraints.find(c => c.kind === 'invariant');
    expect(invariant).toBeDefined();
    expect(invariant!.rule).toMatch(/total must be positive/i);
    // the validation-schema rule must surface as a validation-kind constraint
    const validation = flow.contract.constraints.find(c => c.kind === 'validation');
    expect(validation).toBeDefined();
  });

  test('no telemetry facet when there are no runtime observations (never fabricated)', () => {
    const flow = flows[0];
    expect(flow.contract.telemetry).toBeUndefined();
    for (const step of flow.steps) {
      expect(step.contract.telemetry).toBeUndefined();
    }
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

// ---------------------------------------------------------------------------
// FACET 5 (consistency constraints) + FACET 6 (telemetry) — the two new
// facets of the uniform understanding contract, both evidence-gated.
// ---------------------------------------------------------------------------
import {
  attachTelemetryToFlows,
  telemetryForNode,
  CONTRACT_MODEL_NAME,
  UNDERSTANDING_CONTRACT_FACETS,
  type RuntimeMetricLike,
} from '../../analyzer/core/flow-concepts';

describe('contract model naming', () => {
  test('exposes a single renamable model-name constant and the 6 facets', () => {
    expect(typeof CONTRACT_MODEL_NAME).toBe('string');
    expect(UNDERSTANDING_CONTRACT_FACETS).toEqual([
      'input', 'constraints', 'system_effects', 'logic', 'output', 'telemetry',
    ]);
    expect(CONTRACT_MODEL_NAME).toBe('ICELOT');
  });
});

describe('consistency constraints (facet 5, kind=consistency)', () => {
  test('a staleness-risky store read this unit owns becomes a consistency constraint', () => {
    const cas = buildFixtureCas();
    // saveOrder's DB exit reads a store the consistency model tagged eventual.
    (cas as any).consistency_model = {
      passive_seams: [],
      store_consistency: [
        {
          ref_id: 'xp_saveOrder', // must match this unit's own exit point id
          store: 'aurora-replica',
          consistency: {
            model: 'eventual',
            staleness_risk: true,
            cap_lean: 'AP',
            evidence: 'READ_REPLICA_URL env var -> reader endpoint',
          },
        },
      ],
      counts: { passive_replica: 1, passive_streaming: 0, strong_stores: 0, eventual_stores: 1, tunable_stores: 0 },
    };
    const flows = computeFlowConcepts(cas);
    const consistency = flows[0].contract.constraints.find(c => c.kind === 'consistency');
    expect(consistency).toBeDefined();
    expect(consistency!.rule).toMatch(/eventually consistent/i);
    expect(consistency!.evidence).toMatch(/READ_REPLICA_URL/);
  });

  test('a strong primary read carries NO consistency constraint (not fabricated)', () => {
    const cas = buildFixtureCas();
    (cas as any).consistency_model = {
      passive_seams: [],
      store_consistency: [
        {
          ref_id: 'xp_saveOrder',
          store: 'postgres-primary',
          consistency: { model: 'strong', staleness_risk: false, cap_lean: 'CP', evidence: 'primary connection' },
        },
      ],
      counts: { passive_replica: 0, passive_streaming: 0, strong_stores: 1, eventual_stores: 0, tunable_stores: 0 },
    };
    const flows = computeFlowConcepts(cas);
    expect(flows[0].contract.constraints.some(c => c.kind === 'consistency')).toBe(false);
  });
});

describe('error constraints (facet 2, kind=error)', () => {
  /** Add error-contract primitives onto the base fixture: n_validateOrder
   *  declares a throw in signature.throws, and a call chain runs
   *  entryPoint -> validateOrder (the thrower) with no try-catch pattern on
   *  the path — the exact shape get_error_contracts reads. */
  function withThrows(): CASOutput {
    const cas = buildFixtureCas();
    const validate = cas.nodes.find(n => n.id === 'n_validateOrder')!;
    (validate as any).signature = { ...(validate as any).signature, throws: ['ValidationError'] };
    (cas as any).call_chains = [
      {
        id: 'chain_createOrder',
        chain_type: 'entry-to-exit',
        entry_point: { node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder', entry_point_id: 'ep_createOrder' },
        call_path: [
          { call_id: 'c1', node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder', depth: 0 },
          { call_id: 'c2', node_id: 'n_validateOrder', method_name: 'validateOrder', depth: 1 },
        ],
        characteristics: { total_calls: 2, max_depth: 1, has_external_calls: false, has_database_calls: false, has_async_calls: false },
      },
    ];
    return cas;
  }

  test('a throwing node yields a kind:error "throws" constraint with the right rule + evidence', () => {
    const flows = computeFlowConcepts(withThrows());
    const errs = flows[0].contract.constraints.filter(c => c.kind === 'error');
    const thrown = errs.find(c => c.rule === 'throws ValidationError');
    expect(thrown).toBeDefined();
    expect(thrown!.evidence).toMatch(/signature\.throws includes ValidationError/);
    expect(thrown!.evidence).toMatch(/validateOrder/);
  });

  test('an uncaught throwing chain yields a kind:error "uncaught path to entry point" constraint naming the entry point', () => {
    const flows = computeFlowConcepts(withThrows());
    const errs = flows[0].contract.constraints.filter(c => c.kind === 'error');
    const uncaught = errs.find(c => c.rule.startsWith('uncaught path to entry point'));
    expect(uncaught).toBeDefined();
    expect(uncaught!.rule).toBe('uncaught path to entry point createOrder');
    expect(uncaught!.evidence).toMatch(/traverses throwing node/);
    expect(uncaught!.evidence).toMatch(/no try-catch/);
  });

  test('a try-catch on the chain suppresses the uncaught-path constraint (handled, not fabricated)', () => {
    const cas = withThrows();
    (cas as any).patterns = [
      { id: 'p_try', name: 'try-catch', confidence: 1, instances: ['n_handleCreateOrder'] },
    ];
    const flows = computeFlowConcepts(cas);
    const errs = flows[0].contract.constraints.filter(c => c.kind === 'error');
    // throws is still surfaced (the node still declares it)...
    expect(errs.some(c => c.rule === 'throws ValidationError')).toBe(true);
    // ...but the caught path is NOT reported as uncaught.
    expect(errs.some(c => c.rule.startsWith('uncaught path'))).toBe(false);
  });

  test('a clean node with no throws and no throwing chain carries NO error constraint (no fabrication)', () => {
    const flows = computeFlowConcepts(buildFixtureCas());
    expect(flows[0].contract.constraints.some(c => c.kind === 'error')).toBe(false);
  });
});

describe('telemetry join (facet 6)', () => {
  const cas = buildFixtureCas();
  const flows = computeFlowConcepts(cas);

  const metrics: RuntimeMetricLike[] = [
    {
      static_id: 'n_saveOrder',
      node_id: 'n_saveOrder',
      request_count: 1200,
      error_rate: 0.02,
      latency: { p50_ms: 4, p95_ms: 30, p99_ms: 90 },
      status_code_distribution: { '200': 1176, '500': 24 },
      source: 'ingested',
      last_seen: '2026-07-05T00:00:00.000Z',
    },
  ];

  test('attaches telemetry only to the step whose function has observations', () => {
    const cloned = computeFlowConcepts(cas);
    attachTelemetryToFlows(cloned, metrics);
    const persistStep = cloned[0].steps.find(s => s.functions.some(f => f.function_id === 'n_saveOrder'));
    expect(persistStep!.contract.telemetry).toBeDefined();
    expect(persistStep!.contract.telemetry!.request_count).toBe(1200);
    expect(persistStep!.contract.telemetry!.p99_ms).toBe(90);
    // a step with no matching observation stays telemetry-free (not zero-filled)
    const validateStep = cloned[0].steps.find(s => s.functions.some(f => f.function_id === 'n_validateOrder'));
    expect(validateStep!.contract.telemetry).toBeUndefined();
    // flow-level telemetry is present because one of its nodes matched
    expect(cloned[0].contract.telemetry).toBeDefined();
  });

  test('empty metrics leaves every telemetry facet absent', () => {
    const cloned = computeFlowConcepts(cas);
    attachTelemetryToFlows(cloned, []);
    expect(cloned[0].contract.telemetry).toBeUndefined();
    expect(cloned[0].steps.every(s => s.contract.telemetry === undefined)).toBe(true);
  });

  test('telemetryForNode returns metrics for a matching node and undefined otherwise', () => {
    expect(telemetryForNode('n_saveOrder', metrics)).toBeDefined();
    expect(telemetryForNode('n_nonexistent', metrics)).toBeUndefined();
    expect(telemetryForNode('n_saveOrder', [])).toBeUndefined();
  });

  // keep `flows` referenced so the top-level compute is exercised in this block too
  test('base compute still yields the flow used by these telemetry tests', () => {
    expect(flows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PACKET B1 — CapabilityFlowRelationship M:N with RELATIONAL roles
// (docs/SEMANTIC-MODEL.md: "Flow roles are RELATIONAL, not intrinsic" — the
// role lives on the capability↔flow EDGE). Deterministic derivation only:
// operation refs → primary; entity overlap → supporting; telemetry-dominated
// exits → observability; the query layer flips supporting → operational for
// classifier-grounded infrastructure flows.
// ---------------------------------------------------------------------------
import { applyFlowRoleToCapabilityRelationships, normalizeEntityKey, type FlowConcept } from '../../analyzer/core/flow-concepts';

function buildRelationshipFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_handleCreate', name: 'handleCreateOrder', type: 'controller', category: 'entry' }),
    node({ id: 'n_save', name: 'saveOrder', type: 'function', category: 'data' }),
    node({ id: 'n_handleTrack', name: 'handleTrackEvent', type: 'controller', category: 'entry' }),
    node({ id: 'n_emit', name: 'emitOrderMetric', type: 'function', category: 'business' }),
  ];
  const edges: CASEdge[] = [
    { id: 're1', source: 'n_handleCreate', target: 'n_save', type: 'calls' },
    { id: 're2', source: 'n_handleTrack', target: 'n_emit', type: 'calls' },
  ];
  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_create', source_node: 'n_handleCreate', type: 'http', name: 'createOrder',
      trigger: { method: 'POST', path: '/orders' },
      handler: { node_id: 'n_handleCreate', method_name: 'handleCreateOrder' },
    },
    {
      id: 'ep_track', source_node: 'n_handleTrack', type: 'http', name: 'trackOrderEvent',
      trigger: { method: 'POST', path: '/track' },
      handler: { node_id: 'n_handleTrack', method_name: 'handleTrackEvent' },
    },
  ];
  const exit_points: CASExitPoint[] = [
    { id: 'rxp_save', source_node: 'n_save', type: 'database', name: 'saveOrder', target: { resource: 'orders' } } as CASExitPoint,
    { id: 'rxp_emit', source_node: 'n_emit', type: 'analytics', name: 'orderMetric', target: { service_id: 'metrics-sink' } } as CASExitPoint,
  ];
  const data_lineage: CASEntityLineage[] = [
    {
      entity_id: 'entity_order', entity_name: 'Order', sensitive_fields: [],
      writers: [{ node_id: 'n_save' } as any],
      readers: [{ node_id: 'n_emit' } as any],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
  ];
  const system_capabilities: SystemCapability[] = [
    {
      id: 'cap_orders', name: 'Order Management', description: 'Create and manage orders', category: 'core',
      operations: [{ entry_point_id: 'ep_create', entry_point_type: 'http', action: 'create' }],
      related_entities: ['Order'], related_domains: [], criticality: 'high', criticality_factors: [],
    },
    {
      id: 'cap_fulfillment', name: 'Order Fulfillment', description: 'Fulfill orders', category: 'core',
      operations: [{ entry_point_id: 'ep_ship', entry_point_type: 'http', action: 'ship' }],
      related_entities: ['Order'], related_domains: [], criticality: 'high', criticality_factors: [],
    },
  ];
  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test-capability-relationships',
    system: { name: 'test-system' } as any,
    nodes, edges, entry_points, exit_points, data_lineage,
    data_entities: [],
    system_capabilities,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('capability_relationships — M:N with relational roles', () => {
  const cas = buildRelationshipFixtureCas();
  const flows = computeFlowConcepts(cas);
  const createFlow = flows.find(f => f.entry_point === 'ep_create')!;
  const trackFlow = flows.find(f => f.entry_point === 'ep_track')!;

  test('operation ref → primary edge, rationale cites the operation', () => {
    const rels = createFlow.capability_relationships!;
    const primary = rels.find(r => r.capability_id === 'cap_orders');
    expect(primary).toBeDefined();
    expect(primary!.role).toBe('primary');
    expect(primary!.rationale).toContain('"create"');
    expect(primary!.rationale).toContain('ep_create');
  });

  test('a flow relates to MULTIPLE capabilities with different roles', () => {
    const rels = createFlow.capability_relationships!;
    expect(rels.length).toBe(2);
    const supporting = rels.find(r => r.capability_id === 'cap_fulfillment');
    expect(supporting!.role).toBe('supporting');
    expect(supporting!.rationale).toContain('Order');
    expect(supporting!.rationale).toContain('not among the capability\'s operations');
  });

  test('back-compat: capability_id equals the primary relationship\'s capability', () => {
    expect(createFlow.capability_id).toBe('cap_orders');
  });

  test('telemetry-dominated flow relates as observability via entity overlap', () => {
    const rels = trackFlow.capability_relationships!;
    expect(rels.length).toBe(2);
    for (const rel of rels) {
      expect(rel.role).toBe('observability');
      expect(rel.rationale).toContain('Order');
      expect(rel.rationale).toMatch(/telemetry|analytics/);
    }
    // no operation references ep_track, so no primary and no capability_id
    expect(trackFlow.capability_id).toBeUndefined();
    expect((trackFlow.gaps || []).join(' ')).toContain('capability_id (primary) omitted');
  });

  test('deterministic: same CAS → identical relationship edges run-to-run', () => {
    const again = computeFlowConcepts(buildRelationshipFixtureCas());
    const againCreate = again.find(f => f.entry_point === 'ep_create')!;
    expect(againCreate.capability_relationships).toEqual(createFlow.capability_relationships);
  });

  test('no relation at all → field omitted (never []) with an honest gap', () => {
    const bare = buildRelationshipFixtureCas();
    (bare as any).system_capabilities = [];
    const bareFlows = computeFlowConcepts(bare);
    for (const f of bareFlows) {
      expect(f.capability_relationships).toBeUndefined();
      expect((f.gaps || []).join(' ')).toContain('capability_relationships omitted');
    }
  });
});

// ---------------------------------------------------------------------------
// DEFECT-1 regression: the two capability↔flow derivation paths that silently
// fired ZERO on real repos.
//   (b) related_entities carried as IDs ("entity_order") never matched flow
//       entities carried as NAMES ("Order") — a hard format mismatch that made
//       every entity-overlap edge vanish. normalizeEntityKey reconciles them.
//   (a-interior) a capability whose OWN entry-point handler is realized as an
//       interior STEP of a larger flow (not that flow's root) now links to it
//       as 'supporting' — "a capability whose anchor entry-points appear on a
//       flow's path links to it" (docs/SEMANTIC-MODEL.md).
// ---------------------------------------------------------------------------
describe('normalizeEntityKey — reconciles entity id-form and name-form', () => {
  test('entity_<name> id and the display name collapse to one key', () => {
    expect(normalizeEntityKey('entity_workingmemorysession')).toBe('workingmemorysession');
    expect(normalizeEntityKey('WorkingMemorySession')).toBe('workingmemorysession');
    expect(normalizeEntityKey('entity_workingmemorysession')).toBe(normalizeEntityKey('WorkingMemorySession'));
    // snake_case and casing variants of the same entity also collapse together.
    expect(normalizeEntityKey('working_memory_session')).toBe('workingmemorysession');
    // distinct entities stay distinct.
    expect(normalizeEntityKey('Order')).not.toBe(normalizeEntityKey('Invoice'));
  });
});

describe('capability↔flow path (b) — entity overlap survives id/name format gap', () => {
  test('related_entities in ID form ("entity_order") still overlap a flow touching "Order"', () => {
    const cas = buildRelationshipFixtureCas();
    // Rewrite the fulfillment capability's related_entities to the ID form the
    // real CAS emits (capability.related_entities are entity IDs; flow.entities
    // are display names). Pre-fix this NEVER matched and the edge vanished.
    (cas.system_capabilities as SystemCapability[])[1].related_entities = ['entity_order'];
    const flows = computeFlowConcepts(cas);
    const createFlow = flows.find(f => f.entry_point === 'ep_create')!;
    const supporting = createFlow.capability_relationships!.find(r => r.capability_id === 'cap_fulfillment');
    expect(supporting).toBeDefined();
    expect(supporting!.role).toBe('supporting');
  });
});

// ---------------------------------------------------------------------------
// Rule (c2): a CLI command a real (incl. Helm-templated) kubernetes_cronjob
// schedules relates to a capability whose entities its path touches as
// 'operational', not 'supporting' — scheduled upkeep work FOR that capability
// (docs/SEMANTIC-MODEL.md coverage invariants: operational/maintenance are
// exactly the roles for cron/console flows). Evidence-gated: only a real
// container command/schedule match upgrades the role; a bare CLI command with
// no CronJob reference stays 'supporting'.
// ---------------------------------------------------------------------------
function buildCronFixtureCas(includeCronJobNode = true): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_cronHandler', name: 'runReportNotifications', type: 'function', category: 'business' }),
    node({ id: 'n_writeInvoice', name: 'writeInvoiceSummary', type: 'function', category: 'data' }),
  ];
  const edges: CASEdge[] = [
    { id: 'ce1', source: 'n_cronHandler', target: 'n_writeInvoice', type: 'calls' },
  ];
  if (includeCronJobNode) {
    nodes.push(node({
      id: 'n_cronjob_reportsystem',
      name: 'CronJob: run-report-notifications-cron-job',
      type: 'kubernetes_cronjob',
      category: 'infra',
      metadata: {
        language: 'Helm',
        schedule: '30 */2 * * *',
        command: 'php bin/console app:reportsystem:run-notifications',
      } as any,
    }));
  }
  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_cron_reportsystem', source_node: 'n_cronHandler', type: 'cli', name: 'app:reportsystem:run-notifications',
      trigger: { pattern: 'app:reportsystem:run-notifications' },
      handler: { node_id: 'n_cronHandler', method_name: 'execute' },
      metadata: { commandName: 'app:reportsystem:run-notifications' } as any,
    },
  ];
  const exit_points: CASExitPoint[] = [];
  const data_lineage: CASEntityLineage[] = [
    {
      entity_id: 'entity_invoice', entity_name: 'Invoice', sensitive_fields: [],
      writers: [{ node_id: 'n_writeInvoice' } as any],
      readers: [], external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
  ];
  // No capability operation references ep_cron_reportsystem — only entity
  // overlap can relate this flow to cap_billing.
  const system_capabilities: SystemCapability[] = [
    {
      id: 'cap_billing', name: 'Billing', description: 'Invoice billing', category: 'core',
      operations: [{ entry_point_id: 'ep_other', entry_point_type: 'http', action: 'create' }],
      related_entities: ['Invoice'], related_domains: [], criticality: 'high', criticality_factors: [],
    },
  ];
  return {
    cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-cron',
    system: { name: 'test-system' } as any,
    nodes, edges, entry_points, exit_points, data_lineage,
    data_entities: [], system_capabilities, analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('capability↔flow rule (c2) — CLI command scheduled by a CronJob', () => {
  test('entity-overlap edge on a cron-scheduled CLI command → operational, rationale cites the schedule', () => {
    const flows = computeFlowConcepts(buildCronFixtureCas());
    const cronFlow = flows.find(f => f.entry_point === 'ep_cron_reportsystem')!;
    const rel = cronFlow.capability_relationships?.find(r => r.capability_id === 'cap_billing');
    expect(rel).toBeDefined();
    expect(rel!.role).toBe('operational');
    expect(rel!.rationale).toContain('Invoice');
    expect(rel!.rationale).toContain('30 */2 * * *');
    expect(rel!.rationale).toMatch(/CronJob/);
  });

  test('the SAME CLI command with no matching kubernetes_cronjob evidence stays supporting (no fabrication)', () => {
    const flows = computeFlowConcepts(buildCronFixtureCas(false));
    const cronFlow = flows.find(f => f.entry_point === 'ep_cron_reportsystem')!;
    const rel = cronFlow.capability_relationships?.find(r => r.capability_id === 'cap_billing');
    expect(rel).toBeDefined();
    expect(rel!.role).toBe('supporting');
  });

  test('an HTTP entry point sharing the same entity overlap is never cron-upgraded (cli-only evidence)', () => {
    const cas = buildCronFixtureCas();
    (cas.entry_points as CASEntryPoint[])[0] = {
      ...(cas.entry_points as CASEntryPoint[])[0],
      type: 'http',
      trigger: { method: 'POST', path: '/report-notifications' },
    };
    const flows = computeFlowConcepts(cas);
    const flow = flows.find(f => f.entry_point === 'ep_cron_reportsystem')!;
    const rel = flow.capability_relationships?.find(r => r.capability_id === 'cap_billing');
    expect(rel!.role).toBe('supporting');
  });
});

// ---------------------------------------------------------------------------
// SAME-HANDLER primary bridge: two analyzers can register distinct CLI entry
// points for the identical console command (e.g. a framework-detection pass
// and a language-level class-detection pass), sharing one handler node but
// carrying different entry_point ids. A capability operation anchored on
// EITHER sibling entry point should designate the flow rooted at that shared
// handler as 'primary' — real structural evidence (same handler node id),
// never a name heuristic.
// ---------------------------------------------------------------------------
function buildDuplicateEntryFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_liveHandler', name: 'execute', type: 'function', category: 'business' }),
  ];
  const entry_points: CASEntryPoint[] = [
    // The "declared primary" entry point a capability operation cites.
    {
      id: 'entry_cli_class_LiveCommand', source_node: 'n_liveHandler', type: 'cli', name: 'app:live',
      trigger: { pattern: 'app:live' },
      handler: { node_id: 'n_liveHandler', method_name: 'execute' },
      metadata: { commandName: 'app:live' } as any,
    },
    // A DUPLICATE entry point for the identical command, emitted by a second
    // analyzer, sharing the same handler node but a different id.
    {
      id: 'entry_cli_app_live', source_node: 'n_liveHandler', type: 'cli', name: 'bin/console app:live',
      trigger: { pattern: 'app:live' },
      handler: { node_id: 'n_liveHandler', method_name: 'execute' },
      metadata: { command_name: 'app:live' } as any,
    },
  ];
  const system_capabilities: SystemCapability[] = [
    {
      id: 'cap_ops', name: 'Operations', description: 'Liveness checks', category: 'core',
      operations: [{ entry_point_id: 'entry_cli_class_LiveCommand', entry_point_type: 'cli', action: 'Execute' }],
      related_entities: [], related_domains: [], criticality: 'medium', criticality_factors: [],
    },
  ];
  return {
    cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-dup-entry',
    system: { name: 'test-system' } as any,
    nodes, edges: [], entry_points, exit_points: [], data_lineage: [],
    data_entities: [], system_capabilities, analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('capability↔flow same-handler primary bridge — duplicate CLI entry points', () => {
  const flows = computeFlowConcepts(buildDuplicateEntryFixtureCas());

  test('the declared entry point is primary (baseline)', () => {
    const flow = flows.find(f => f.entry_point === 'entry_cli_class_LiveCommand')!;
    const rel = flow.capability_relationships?.find(r => r.capability_id === 'cap_ops');
    expect(rel!.role).toBe('primary');
  });

  test('the DUPLICATE entry point for the same handler node also resolves primary, not stranded', () => {
    const flow = flows.find(f => f.entry_point === 'entry_cli_app_live')!;
    const rel = flow.capability_relationships?.find(r => r.capability_id === 'cap_ops');
    expect(rel).toBeDefined();
    expect(rel!.role).toBe('primary');
    expect(rel!.rationale).toContain('entry_cli_class_LiveCommand');
  });
});

function buildInteriorFixtureCas(): CASOutput {
  // Parent flow (POST /parent) calls into the handler node of a SEPARATE entry
  // point (POST /child). A capability's operation references the CHILD entry
  // point; the child handler is therefore an INTERIOR node on the parent flow's
  // path. No entity overlap and no operation ref to the parent root exist — so
  // ONLY the interior-entry-point rule can produce the parent→capability edge.
  const nodes: CASNode[] = [
    node({ id: 'n_parent', name: 'handleParent', type: 'controller', category: 'entry' }),
    node({ id: 'n_child', name: 'handleChild', type: 'controller', category: 'entry' }),
  ];
  const edges: CASEdge[] = [
    { id: 'ie1', source: 'n_parent', target: 'n_child', type: 'calls' },
  ];
  const entry_points: CASEntryPoint[] = [
    { id: 'ep_parent', source_node: 'n_parent', type: 'http', name: 'parent',
      trigger: { method: 'POST', path: '/parent' },
      handler: { node_id: 'n_parent', method_name: 'handleParent' } },
    { id: 'ep_child', source_node: 'n_child', type: 'http', name: 'child',
      trigger: { method: 'POST', path: '/child' },
      handler: { node_id: 'n_child', method_name: 'handleChild' } },
  ];
  const system_capabilities: SystemCapability[] = [
    { id: 'cap_child', name: 'Child Capability', description: 'child op', category: 'core',
      operations: [{ entry_point_id: 'ep_child', entry_point_type: 'http', action: 'do' }],
      related_entities: [], related_domains: [], criticality: 'medium', criticality_factors: [] },
  ];
  return {
    cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test-interior', system: { name: 'test-system' } as any,
    nodes, edges, entry_points, exit_points: [], data_lineage: [],
    data_entities: [], system_capabilities, analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('capability↔flow path (a-interior) — anchor entry point realized as an interior step', () => {
  const flows = computeFlowConcepts(buildInteriorFixtureCas());
  const parentFlow = flows.find(f => f.entry_point === 'ep_parent')!;
  const childFlow = flows.find(f => f.entry_point === 'ep_child')!;

  test('child capability whose entry point is on the parent flow path → supporting', () => {
    const rel = parentFlow.capability_relationships?.find(r => r.capability_id === 'cap_child');
    expect(rel).toBeDefined();
    expect(rel!.role).toBe('supporting');
    expect(rel!.rationale).toContain('interior step');
    expect(rel!.rationale).toContain('ep_child');
  });

  test('the child flow itself still links primary via its own entry point', () => {
    const rel = childFlow.capability_relationships?.find(r => r.capability_id === 'cap_child');
    expect(rel!.role).toBe('primary');
  });

  test('a node:-anchored capability operation on the flow path interior-links as supporting (re-validation F3)', () => {
    const cas = buildInteriorFixtureCas();
    // Point the capability op at a direct `node:` reference rather than a real
    // entry point. Originally this shape was EXCLUDED from interior matching to
    // keep bare utility refs from blasting edges — but real hosted CAS showed
    // capability operations are PREDOMINANTLY node-anchored (the
    // capability-detection pass resolves operations straight to handler/method
    // nodes), so the exclusion made the supporting/observability vocabulary
    // unreachable (39/39 edges 'primary' on a fresh live analysis). A
    // capability-DECLARED operation anchor is evidence, not a guess —
    // deriveCapabilityOperationRoots already trusts the same shape to root
    // whole flows — and a flow passing through that anchor genuinely exercises
    // the capability: the doctrine's own many-to-many case ("a generic
    // authorizeRequest() may serve hundreds of steps").
    (cas.system_capabilities as SystemCapability[])[0].operations = [
      { entry_point_id: 'node:n_child', entry_point_type: 'http', action: 'do' },
    ];
    const f2 = computeFlowConcepts(cas);
    const parent2 = f2.find(f => f.entry_point === 'ep_parent')!;
    const interior = (parent2.capability_relationships || []).find(r =>
      r.capability_id === 'cap_child' && /interior step/.test(r.rationale));
    expect(interior).toBeDefined();
    expect(interior!.role).toBe('supporting');
  });
});

describe('applyFlowRoleToCapabilityRelationships — rule (c), operational upgrade', () => {
  const mkFlow = (): Pick<FlowConcept, 'capability_relationships'> => ({
    capability_relationships: [
      { capability_id: 'cap_a', role: 'primary', rationale: 'operation ref' },
      { capability_id: 'cap_b', role: 'supporting', rationale: 'shared entities (Order)' },
      { capability_id: 'cap_c', role: 'observability', rationale: 'telemetry exits' },
    ],
  });

  test('infrastructure role flips only supporting → operational, appending evidence', () => {
    const flow = mkFlow();
    applyFlowRoleToCapabilityRelationships(flow, 'infrastructure', ['entry point is a script file (deploy.sh)']);
    const [a, b, c] = flow.capability_relationships!;
    expect(a.role).toBe('primary');
    expect(b.role).toBe('operational');
    expect(b.rationale).toContain('deploy.sh');
    expect(b.rationale).toContain('semantic-role classifier');
    expect(c.role).toBe('observability');
  });

  test('non-infrastructure roles and missing relationships are no-ops', () => {
    const flow = mkFlow();
    applyFlowRoleToCapabilityRelationships(flow, 'core', []);
    expect(flow.capability_relationships![1].role).toBe('supporting');
    expect(() => applyFlowRoleToCapabilityRelationships({}, 'infrastructure')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PACKET C1 — flow STEP GRAPH (branch / error / compensation edges over the
// sequence backbone) + ASYNC CONTINUATIONS / SUBFLOWS. docs/SEMANTIC-MODEL.md
// (Flow): "Flow = semantic step GRAPH … the ordered step list is a PROJECTION
// of that graph"; "Async continuation ≠ new flow." All deterministic,
// evidence-gated, additive to FlowConcept.
// ---------------------------------------------------------------------------
import { stitchContinuations } from '../../analyzer/core/flow-concepts';

describe('C1 step_graph — sequence backbone + evidence-gated edge kinds', () => {
  test('a multi-step flow carries a step_graph whose backbone matches the ordered steps', () => {
    const flow = computeFlowConcepts(buildFixtureCas())[0];
    expect(flow.step_graph).toBeDefined();
    // one backbone edge per consecutive step pair, in step order.
    expect(flow.step_graph!.edges.length).toBe(flow.steps.length - 1);
    for (let i = 0; i < flow.steps.length - 1; i++) {
      expect(flow.step_graph!.edges[i].from_step_id).toBe(flow.steps[i].step_id);
      expect(flow.step_graph!.edges[i].to_step_id).toBe(flow.steps[i + 1].step_id);
    }
  });

  test('no branch/error/compensation evidence → every edge is a plain sequence edge (honest, not fabricated)', () => {
    const flow = computeFlowConcepts(buildFixtureCas())[0];
    for (const e of flow.step_graph!.edges) {
      expect(e.kind).toBe('sequence');
      expect(e.evidence).toBeUndefined(); // sequence edges carry no evidence string
    }
  });

  test('a conditional call edge out of a step upgrades its outgoing edge to a branch edge', () => {
    const cas = buildFixtureCas();
    // mark the validateOrder -> saveOrder call edge conditional (real CAS fact).
    cas.edges.find(e => e.id === 'e2')!.metadata = { conditional: true };
    const flow = computeFlowConcepts(cas)[0];
    const validateStepId = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_validateOrder'))!.step_id;
    const branchEdge = flow.step_graph!.edges.find(e => e.from_step_id === validateStepId);
    expect(branchEdge).toBeDefined();
    expect(branchEdge!.kind).toBe('branch');
    expect(branchEdge!.evidence).toMatch(/conditional/i);
  });

  test('a step on a throw path upgrades the edge INTO it to an error edge (reuses error-constraint evidence)', () => {
    const cas = buildFixtureCas();
    // n_saveOrder declares a throw + an uncaught chain reaches it — the exact
    // shape extractErrorConstraints reads. The persist step then carries a
    // kind:error constraint, so the edge leading into it is an error edge.
    // (n_validateOrder is deliberately NOT the throwing node here: under
    // role-based segmentation it MERGES with the entry-point handler — both
    // are 'validate' role, docs/SEMANTIC-MODEL.md's merge rule — into the
    // flow's INITIATING step, which by construction has no incoming edge to
    // upgrade. n_saveOrder's 'persist' role keeps it a distinct, non-initial
    // step, so the edge-upgrade rule stays fully exercised.)
    (cas.nodes.find(n => n.id === 'n_saveOrder') as any).signature = { throws: ['PersistenceError'] };
    (cas as any).call_chains = [
      {
        id: 'chain_createOrder',
        chain_type: 'entry-to-exit',
        entry_point: { node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder', entry_point_id: 'ep_createOrder' },
        exit_point: { node_id: 'n_notifyWarehouse', method_name: 'notifyWarehouse', exit_point_id: 'xp_notifyWarehouse' },
        call_path: [
          { call_id: 'c1', node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder', depth: 0 },
          { call_id: 'c2', node_id: 'n_validateOrder', method_name: 'validateOrder', depth: 1 },
          { call_id: 'c3', node_id: 'n_saveOrder', method_name: 'saveOrder', depth: 2 },
          { call_id: 'c4', node_id: 'n_notifyWarehouse', method_name: 'notifyWarehouse', depth: 3 },
        ],
        characteristics: { total_calls: 4, max_depth: 3, has_external_calls: true, has_database_calls: true, has_async_calls: false },
      },
    ];
    const flow = computeFlowConcepts(cas)[0];
    const persistStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_saveOrder'))!;
    // sanity: the persist step really carries the error constraint we key on,
    // and it is NOT the flow's initiating step (so an incoming edge exists).
    expect(persistStep.contract.constraints.some(c => c.kind === 'error')).toBe(true);
    expect(persistStep.step_id).not.toBe(flow.steps[0].step_id);
    const errEdge = flow.step_graph!.edges.find(e => e.to_step_id === persistStep.step_id);
    expect(errEdge).toBeDefined();
    expect(errEdge!.kind).toBe('error');
    expect(errEdge!.evidence).toMatch(/PersistenceError|throwing node/);
  });

  test('step_graph is byte-stable run-to-run (determinism)', () => {
    const a = computeFlowConcepts(buildFixtureCas())[0].step_graph;
    const b = computeFlowConcepts(buildFixtureCas())[0].step_graph;
    expect(a).toEqual(b);
  });
});

/**
 * Fixture with a PUBLISH → CONSUME seam: a terminal flow (POST /orders) ends at
 * an EVENT exit `order.created`; a separate EVENT entry point consumes
 * `order.created`. The publisher flow must CONTINUE INTO the consumer flow (same
 * end-to-end flow), and the consumer becomes a reusable subflow.
 */
function buildPublishConsumeFixtureCas(consumerChannel = 'order.created'): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_placeOrder', name: 'placeOrder', type: 'controller', category: 'entry' }),
    node({ id: 'n_emitOrderCreated', name: 'emitOrderCreated', type: 'function', category: 'business' }),
    node({ id: 'n_orderWorker', name: 'onOrderCreated', type: 'function', category: 'business' }),
    node({ id: 'n_persistOrder', name: 'persistOrderProjection', type: 'function', category: 'data' }),
  ];
  const edges: CASEdge[] = [
    { id: 'pe1', source: 'n_placeOrder', target: 'n_emitOrderCreated', type: 'calls' },
    { id: 'pe2', source: 'n_orderWorker', target: 'n_persistOrder', type: 'calls' },
  ];
  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_place', source_node: 'n_placeOrder', type: 'http', name: 'placeOrder',
      trigger: { method: 'POST', path: '/orders' },
      handler: { node_id: 'n_placeOrder', method_name: 'placeOrder' },
    },
    {
      id: 'ep_worker', source_node: 'n_orderWorker', type: 'event', name: 'onOrderCreated',
      trigger: { event: consumerChannel },
      handler: { node_id: 'n_orderWorker', method_name: 'onOrderCreated' },
    },
  ];
  const exit_points: CASExitPoint[] = [
    { id: 'xp_orderCreated', source_node: 'n_emitOrderCreated', type: 'event', name: 'orderCreated', target: { resource: 'order.created' } } as CASExitPoint,
  ];
  const call_chains = [
    {
      id: 'chain_place',
      chain_type: 'entry-to-exit',
      entry_point: { node_id: 'n_placeOrder', method_name: 'placeOrder', entry_point_id: 'ep_place' },
      exit_point: { node_id: 'n_emitOrderCreated', method_name: 'emitOrderCreated', exit_point_id: 'xp_orderCreated' },
      call_path: [
        { call_id: 'pc1', node_id: 'n_placeOrder', method_name: 'placeOrder', depth: 0 },
        { call_id: 'pc2', node_id: 'n_emitOrderCreated', method_name: 'emitOrderCreated', depth: 1 },
      ],
      characteristics: { total_calls: 2, max_depth: 1, has_external_calls: true, has_database_calls: false, has_async_calls: true },
    },
  ];
  return {
    cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test-publish-consume', system: { name: 'test-system' } as any,
    nodes, edges, entry_points, exit_points,
    call_chains,
    data_lineage: [], data_entities: [], system_capabilities: [],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('C1 async continuations — publish→consume seam stitches the SAME end-to-end flow', () => {
  const flows = computeFlowConcepts(buildPublishConsumeFixtureCas());
  const publisher = flows.find(f => f.terminus?.exit_point_id === 'xp_orderCreated')!;
  const consumer = flows.find(f => f.entry_point === 'ep_worker')!;

  test('both the publisher (terminal) and consumer (entry-point) flows exist', () => {
    expect(publisher).toBeDefined();
    expect(publisher.terminus!.kind).toBe('event');
    expect(consumer).toBeDefined();
  });

  test('the publisher CONTINUES INTO the consumer', () => {
    expect(publisher.continuations).toBeDefined();
    expect(publisher.continuations).toContain(consumer.flow_id);
  });

  test('the consumer is a reusable subflow with a back-ref to the publisher', () => {
    expect(consumer.is_subflow).toBe(true);
    expect(consumer.continued_from).toEqual([publisher.flow_id]);
    // the publisher is NOT itself a subflow (nothing continues into it).
    expect(publisher.is_subflow).toBeUndefined();
    expect(publisher.continued_from).toBeUndefined();
  });

  test('no seam match → no continuation stitched (evidence-gated, never fabricated)', () => {
    const flows2 = computeFlowConcepts(buildPublishConsumeFixtureCas('order.shipped'));
    for (const f of flows2) {
      expect(f.continuations).toBeUndefined();
      expect(f.continued_from).toBeUndefined();
      expect(f.is_subflow).toBeUndefined();
    }
  });

  test('deterministic: continuation edges are byte-stable run-to-run', () => {
    const again = computeFlowConcepts(buildPublishConsumeFixtureCas());
    const againPub = again.find(f => f.terminus?.exit_point_id === 'xp_orderCreated')!;
    expect(againPub.continuations).toEqual(publisher.continuations);
  });

  test('a consumer OUTSIDE the maxFlows window is partner-derived and still stitched (re-validation F2)', () => {
    // maxFlows: 1 → only the terminal publisher makes the window; the consumer
    // entry flow would previously never exist to stitch against (the stitch ran
    // over the CAPPED set, so on big repos continuations were unobservable).
    // Partner derivation must derive JUST the matched consumer and append it —
    // part of the SAME end-to-end flow, not an extra window slot.
    const windowed = computeFlowConcepts(buildPublishConsumeFixtureCas(), { maxFlows: 1 });
    const pub = windowed.find(f => f.terminus?.exit_point_id === 'xp_orderCreated')!;
    expect(pub).toBeDefined();
    const con = windowed.find(f => f.entry_point === 'ep_worker');
    expect(con).toBeDefined();
    expect(pub.continuations).toContain(con!.flow_id);
    expect(con!.is_subflow).toBe(true);
    expect(con!.continued_from).toEqual([pub.flow_id]);
    // Only the seam-matched partner is appended — no other extra flows ride in.
    expect(windowed.length).toBe(2);
  });

  test('stitchContinuations is a no-op on a <2-flow set and returns the same array', () => {
    const one = [{ flow_id: 'x', entry_point: 'ep' } as FlowConcept];
    expect(stitchContinuations(one, buildPublishConsumeFixtureCas())).toBe(one);
  });
});

/**
 * SEMANTIC SEGMENTATION (docs/SEMANTIC-MODEL.md, Step doctrine): "Step ↔ code
 * is many-to-many … a segmentation that emits one step per traced function
 * (named 'Process (fnName)') is a placeholder, not the model." This battery
 * exercises the role-based segmentation/naming rewrite directly: the
 * MERGE rule (many functions, same role -> one step), the SPLIT rule (one
 * function, multiple roles -> many steps), async dispatch, evidence-named
 * Process steps, the honest zero-evidence fallback, and the acceptance case
 * from a POST /bookings-style flow (Validate -> Create <Entity> [with a
 * state_change] -> Respond, never "2x Process").
 */
describe('role-based step segmentation (Step doctrine rewrite)', () => {
  test('ACCEPTANCE CASE: booking-creation flow segments as Validate -> Create <Entity> (state_change) -> Respond, not 2x Process', () => {
    const nodes: CASNode[] = [
      node({ id: 'n_handleCreateBooking', name: 'handleCreateBooking', type: 'controller', category: 'entry' }),
      node({ id: 'n_createBooking', name: 'createBooking', type: 'function', category: 'business' }),
      node({ id: 'n_respondBooking', name: 'finishRequest', type: 'function', category: 'business' }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'n_handleCreateBooking', target: 'n_createBooking', type: 'calls' },
      { id: 'e2', source: 'n_createBooking', target: 'n_respondBooking', type: 'calls' },
    ];
    const entry_points: CASEntryPoint[] = [{
      id: 'ep_createBooking', source_node: 'n_handleCreateBooking', type: 'http', name: 'createBooking',
      trigger: { method: 'POST', path: '/bookings' },
      handler: { node_id: 'n_handleCreateBooking', method_name: 'handleCreateBooking' },
      security: { authenticated: true },
      input: { validation: ['start/end dates must be valid'] },
    }];
    const exit_points: CASExitPoint[] = [
      { id: 'xp_respond', source_node: 'n_respondBooking', type: 'api', name: 'finishRequest', target: { resource: '/bookings' } } as CASExitPoint,
    ];
    const data_lineage: CASEntityLineage[] = [{
      entity_id: 'entity_booking', entity_name: 'Booking', sensitive_fields: [],
      writers: [{ node_id: 'n_createBooking' } as any], readers: [],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    }];
    const call_chains = [{
      id: 'chain_createBooking',
      chain_type: 'entry-to-exit',
      entry_point: { node_id: 'n_handleCreateBooking', method_name: 'handleCreateBooking', entry_point_id: 'ep_createBooking' },
      exit_point: { node_id: 'n_respondBooking', method_name: 'finishRequest', exit_point_id: 'xp_respond' },
      call_path: [
        { call_id: 'c1', node_id: 'n_handleCreateBooking', method_name: 'handleCreateBooking', depth: 0 },
        { call_id: 'c2', node_id: 'n_createBooking', method_name: 'createBooking', depth: 1 },
        { call_id: 'c3', node_id: 'n_respondBooking', method_name: 'finishRequest', depth: 2 },
      ],
      characteristics: { total_calls: 2, max_depth: 2, has_external_calls: false, has_database_calls: false, has_async_calls: false },
    }];
    const cas = {
      cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-booking',
      system: { name: 'test-system' } as any,
      nodes, edges, entry_points, exit_points, data_lineage, data_entities: [],
      system_capabilities: [], analyzer_contributions: [], call_chains,
    } as unknown as CASOutput;

    const flow = computeFlowConcepts(cas)[0];
    expect(flow.steps.length).toBe(3);
    expect(flow.steps.map(s => s.name)).toEqual(['Validate Request', 'Create Booking', 'Respond']);
    // never the old placeholder shape:
    expect(flow.steps.some(s => /^Process \(/.test(s.name))).toBe(false);
    const persistStep = flow.steps[1];
    expect(persistStep.contract.side_effects.state_changes).toContain('Booking updated');
  });

  test('MERGE: many functions with the SAME role collapse into ONE step', () => {
    const nodes: CASNode[] = [
      node({ id: 'n_root', name: 'handleSync', type: 'controller', category: 'entry' }),
      node({ id: 'n_save1', name: 'saveShipment', type: 'function', category: 'data' }),
      node({ id: 'n_save2', name: 'saveManifest', type: 'function', category: 'data' }),
      node({ id: 'n_save3', name: 'saveInvoice', type: 'function', category: 'data' }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'n_root', target: 'n_save1', type: 'calls' },
      { id: 'e2', source: 'n_save1', target: 'n_save2', type: 'calls' },
      { id: 'e3', source: 'n_save2', target: 'n_save3', type: 'calls' },
    ];
    const entry_points: CASEntryPoint[] = [{
      id: 'ep_sync', source_node: 'n_root', type: 'http', name: 'sync',
      trigger: { method: 'POST', path: '/sync' },
      handler: { node_id: 'n_root', method_name: 'handleSync' },
    }];
    const exit_points: CASExitPoint[] = [
      { id: 'xp1', source_node: 'n_save1', type: 'database', name: 'saveShipment', target: { resource: 'shipments' } } as CASExitPoint,
      { id: 'xp2', source_node: 'n_save2', type: 'database', name: 'saveManifest', target: { resource: 'manifests' } } as CASExitPoint,
      { id: 'xp3', source_node: 'n_save3', type: 'database', name: 'saveInvoice', target: { resource: 'invoices' } } as CASExitPoint,
    ];
    const cas = {
      cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-merge',
      system: { name: 'test-system' } as any,
      nodes, edges, entry_points, exit_points, data_lineage: [], data_entities: [],
      system_capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;

    const flow = computeFlowConcepts(cas)[0];
    // n_root has no role-indicating facts -> its own 'process' step; the three
    // persist writers all share role 'persist' and MERGE into one step.
    const persistStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_save1'))!;
    expect(persistStep.functions.map(f => f.function_id)).toEqual(
      expect.arrayContaining(['n_save1', 'n_save2', 'n_save3'])
    );
    expect(persistStep.functions.length).toBe(3);
  });

  test('SPLIT: one function whose OWN facts ground multiple roles yields multiple steps mapped to the SAME node', () => {
    const nodes: CASNode[] = [
      node({ id: 'n_root', name: 'handleAndPersist', type: 'controller', category: 'entry' }),
    ];
    const entry_points: CASEntryPoint[] = [{
      id: 'ep_thing', source_node: 'n_root', type: 'http', name: 'thing',
      trigger: { method: 'POST', path: '/thing' },
      handler: { node_id: 'n_root', method_name: 'handleAndPersist' },
      security: { authenticated: true, guards: ['AuthGuard'] },
    }];
    const exit_points: CASExitPoint[] = [
      { id: 'xp_db', source_node: 'n_root', type: 'database', name: 'handleAndPersist', target: { resource: 'things' } } as CASExitPoint,
    ];
    const cas = {
      cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-split',
      system: { name: 'test-system' } as any,
      nodes, edges: [], entry_points, exit_points, data_lineage: [], data_entities: [],
      system_capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;

    const flow = computeFlowConcepts(cas)[0];
    // ONE function (n_root), grounded for BOTH 'validate' (entry auth guard)
    // AND 'persist' (its own database exit). Both roles are still DERIVED —
    // but they no longer become two steps.
    //
    // CONTRACT CHANGE (comprehension lane): a step is a unit of the flow's
    // NARRATIVE, and two steps pointing at the identical function id with no
    // distinguishing sub-section read as two hops when only one hop happened.
    // Measured on real repos, that shape was pure noise (a React component
    // appearing as "Persist Data" then "Call <its own module>"), so adjacent
    // steps over the same function id set now COLLAPSE
    // (collapseDuplicateFunctionSteps). Nothing derived is discarded: both
    // role names survive in the step name, both descriptions survive in the
    // description, and both sets of typed code mappings survive on the step —
    // which is what keeps the many-to-many step<->code join (D1) intact.
    expect(flow.steps.length).toBe(1);
    expect(flow.steps[0].functions.some(f => f.function_id === 'n_root')).toBe(true);
    expect(flow.steps[0].name).toBe('Validate Request & Persist Data');
    expect(flow.gaps?.some(g => /collapsed/.test(g))).toBe(true);
    const mappings = (flow.steps[0].code_mappings || []).filter(m => m.code_region.node_id === 'n_root');
    expect(mappings.some(m => m.relationship === 'validates')).toBe(true);
    expect(mappings.some(m => m.relationship === 'causes_effect')).toBe(true);
    // every surviving mapping is attributed to the surviving step.
    expect((flow.steps[0].code_mappings || []).every(m => m.step_id === flow.steps[0].step_id)).toBe(true);
  });

  test('ASYNC DISPATCH: a message/event exit grounds a Publish/Dispatch step, distinct from an outbound API call', () => {
    const nodes: CASNode[] = [
      node({ id: 'n_root', name: 'handleOrderPaid', type: 'controller', category: 'entry' }),
      node({ id: 'n_publish', name: 'publishOrderShipped', type: 'function', category: 'business' }),
    ];
    const edges: CASEdge[] = [{ id: 'e1', source: 'n_root', target: 'n_publish', type: 'calls' }];
    const entry_points: CASEntryPoint[] = [{
      id: 'ep_paid', source_node: 'n_root', type: 'event', name: 'orderPaid',
      trigger: { event: 'order.paid' },
      handler: { node_id: 'n_root', method_name: 'handleOrderPaid' },
    }];
    const exit_points: CASExitPoint[] = [
      { id: 'xp_event', source_node: 'n_publish', type: 'event', name: 'publishOrderShipped', target: { resource: 'order.shipped' } } as CASExitPoint,
    ];
    const cas = {
      cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-dispatch',
      system: { name: 'test-system' } as any,
      nodes, edges, entry_points, exit_points, data_lineage: [], data_entities: [],
      system_capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;

    const flow = computeFlowConcepts(cas)[0];
    const dispatchStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_publish'))!;
    expect(dispatchStep.name).toBe('Publish order.shipped');
  });

  test('EVIDENCE-NAMED Process step: a business-logic node with no exits/lineage-writes still gets a verb+entity name, never a bare "Process (fnName)"', () => {
    const nodes: CASNode[] = [
      node({ id: 'n_root', name: 'handleQuote', type: 'controller', category: 'entry' }),
      node({ id: 'n_calc', name: 'calculateShippingCost', type: 'function', category: 'business' }),
    ];
    const edges: CASEdge[] = [{ id: 'e1', source: 'n_root', target: 'n_calc', type: 'calls' }];
    const entry_points: CASEntryPoint[] = [{
      id: 'ep_quote', source_node: 'n_root', type: 'http', name: 'quote',
      trigger: { method: 'GET', path: '/quote' },
      handler: { node_id: 'n_root', method_name: 'handleQuote' },
    }];
    const data_lineage: CASEntityLineage[] = [{
      entity_id: 'entity_shippingrate', entity_name: 'ShippingRate', sensitive_fields: [],
      writers: [], readers: [{ node_id: 'n_calc' } as any],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    }];
    const cas = {
      cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-process-named',
      system: { name: 'test-system' } as any,
      nodes, edges, entry_points, exit_points: [], data_lineage, data_entities: [],
      system_capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;

    const flow = computeFlowConcepts(cas)[0];
    const calcStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_calc'))!;
    expect(calcStep.name).toBe('Calculate ShippingRate');
    expect(calcStep.name).not.toMatch(/^Process \(/);
  });

  test('HONEST FALLBACK: a chain with zero role-indicating facts still yields a sane step, never a fabricated role, and reports a gap', () => {
    const nodes: CASNode[] = [
      node({ id: 'n_root', name: 'handleMystery', type: 'controller', category: 'entry' }),
      node({ id: 'n_opaque', name: 'doThing123', type: 'function', category: 'business' }),
    ];
    const edges: CASEdge[] = [{ id: 'e1', source: 'n_root', target: 'n_opaque', type: 'calls' }];
    const entry_points: CASEntryPoint[] = [{
      id: 'ep_mystery', source_node: 'n_root', type: 'http', name: 'mystery',
      trigger: { method: 'GET', path: '/mystery' },
      handler: { node_id: 'n_root', method_name: 'handleMystery' },
    }];
    const cas = {
      cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-fallback',
      system: { name: 'test-system' } as any,
      nodes, edges, entry_points, exit_points: [], data_lineage: [], data_entities: [],
      system_capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;

    const flow = computeFlowConcepts(cas)[0];
    // no crash, a sane (non-empty) step set:
    expect(flow.steps.length).toBeGreaterThan(0);
    const opaqueStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_opaque'))!;
    expect(opaqueStep).toBeDefined();
    // honest — not a fabricated role label, just the conservative fallback:
    // HONEST FALLBACK, LEGIBLE FORM: there is still no entity and no verb, so
    // the only real fact is the author's own identifier — presented as a
    // title-cased phrase rather than wrapped in "Process (…)". Same
    // information, and unlike the parenthesized form it distinguishes this
    // step from the next one. Still reported as a gap (asserted below).
    expect(opaqueStep.name).toBe('Do Thing123');
    expect(flow.gaps).toBeDefined();
    expect(flow.gaps!.some(g => /no validate\/persist\/dispatch\/call\/respond\/entity\/verb evidence/.test(g))).toBe(true);
  });

  test('DETERMINISM: segmentation + naming is byte-stable run-to-run for the same CAS', () => {
    const cas = buildFixtureCas();
    const a = JSON.stringify(computeFlowConcepts(cas));
    const b = JSON.stringify(computeFlowConcepts(buildFixtureCas()));
    expect(a).toBe(b);
  });
});
