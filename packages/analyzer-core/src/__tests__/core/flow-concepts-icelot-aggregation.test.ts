import { computeFlowConcepts, attachTelemetryToFlows } from '../../analyzer/core/flow-concepts';
import type { FacetProvenance } from '../../analyzer/core/flow-concepts';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  CASDataEntity,
  CASCallChain,
} from '../../types/cas.types';

/**
 * D2 — ICELOT aggregation/reframe rules + facet provenance
 * (docs/SEMANTIC-MODEL.md: "a flow's ICELOT aggregates its steps and adds
 * flow-level semantics … never a simple union").
 *
 * Fixture: handleCreateOrder(req) -> validateOrder (guard, reads Order)
 *          -> saveOrder (writes Order, db exit) -> notifyWarehouse (webhook
 *          exit, its OWN last-step guard + declared throws).
 * Role-based segmentation (docs/SEMANTIC-MODEL.md Step doctrine) MERGES
 * handleCreateOrder (Validate role — its own entry_point security/validation
 * facts) with the adjacent validateOrder (Validate role — guard-clause name
 * pattern) into ONE initiating Validate step ("a validator/form boundary IS a
 * Validate step" regardless of how many functions realize it). Segmentation
 * yields 3 steps (Validate [handleCreateOrder + validateOrder], Persist
 * [saveOrder], Call [notifyWarehouse]), so initiating (step 0) ≠ gating guard
 * (also step 0 here — it's the SAME step, see test (a)) ≠ terminal (step 2)
 * stay distinct enough for every reframe rule to be separately observable.
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

function buildCas(): CASOutput {
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
      // LAST-step guard: must stay STEP-level, never promoted to the flow
      // (it gates nothing downstream of itself).
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
  ];

  const edges: CASEdge[] = [
    { id: 'e1', source: 'n_handleCreateOrder', target: 'n_validateOrder', type: 'calls' },
    { id: 'e2', source: 'n_validateOrder', target: 'n_saveOrder', type: 'calls' },
    { id: 'e3', source: 'n_saveOrder', target: 'n_notifyWarehouse', type: 'calls' },
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
    } as any,
  ];

  return {
    cas_version: '1.0.0',
    analysis_timestamp: '2026-01-01T00:00:00.000Z',
    analysis_id: 'test-d2',
    system: { name: 'test-system' } as any,
    nodes, edges, entry_points, exit_points, data_lineage, entities,
    capabilities: [],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

/** Same chain, but anchored on a recorded entry-to-exit TERMINAL call chain so
 *  the terminus enrichment path (and its provenance stamp) runs. */
function buildTerminalCas(): CASOutput {
  const cas = buildCas();
  const call_chains: CASCallChain[] = [
    {
      id: 'chain_createOrder',
      chain_type: 'entry-to-exit',
      entry_point: { node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder', entry_point_id: 'ep_createOrder' },
      exit_point: { node_id: 'n_notifyWarehouse', method_name: 'notifyWarehouse', exit_point_id: 'xp_notifyWarehouse' },
      call_path: [
        { call_id: 'c0', node_id: 'n_handleCreateOrder', method_name: 'handleCreateOrder', depth: 0 },
        { call_id: 'c1', node_id: 'n_validateOrder', method_name: 'validateOrder', depth: 1 },
        { call_id: 'c2', node_id: 'n_saveOrder', method_name: 'saveOrder', depth: 2 },
        { call_id: 'c3', node_id: 'n_notifyWarehouse', method_name: 'notifyWarehouse', depth: 3 },
      ],
      characteristics: {
        total_calls: 3, max_depth: 3, has_external_calls: true,
        has_database_calls: true, has_async_calls: false,
        is_circular: false, is_recursive: false, complexity_score: 1,
      },
      risk_analysis: { risk_level: 'low', risk_factors: [] },
    } as CASCallChain,
  ];
  (cas as any).call_chains = call_chains;
  return cas;
}

describe('D2 — flow-level ICELOT is a REFRAME, not a union', () => {
  const cas = buildCas();
  const flows = computeFlowConcepts(cas);
  const flow = flows[0];

  test('fixture segments into ≥3 steps so initiating/gating/terminal are distinct', () => {
    expect(flows).toHaveLength(1);
    expect(flow.steps.length).toBeGreaterThanOrEqual(3);
  });

  test('(a) flow Input = INITIATING input only; interior inputs demoted to internal_inputs_count', () => {
    // The initiating step is now the MERGED Validate step (handleCreateOrder's
    // own auth/validation facts + the adjacent validateOrder's guard-clause
    // validation collapse into ONE step per the Step doctrine's merge rule —
    // same semantic role, sequential nodes) — so ITS params/reads honestly ARE
    // the flow input, not demoted:
    expect(flow.contract.input).toEqual(
      expect.arrayContaining(['req: CreateOrderRequest', 'order: Order', 'reads Order'])
    );
    // …interior (non-initiating, non-terminal) step input is still demoted,
    // never unioned up — here just notifyWarehouse's own param (saveOrder's
    // own param duplicates the initiating step's already-counted 'order: Order'):
    expect(flow.contract.input).not.toContain('saved: SavedOrder');
    expect(flow.contract.internal_inputs_count).toBe(1);
    const validateStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_validateOrder'))!;
    expect(validateStep.contract.input).toContain('reads Order');
    // validateOrder's step IS the merged initiating step (step 0).
    expect(validateStep).toBe(flow.steps[0]);
  });

  test('(b) flow Output = TERMINAL output only; intermediate returns demoted to internal_outputs_count', () => {
    expect(flow.contract.output).toContain('NotifyResult');
    // intermediate returns stay on their steps, not the flow:
    expect(flow.contract.output).not.toContain('boolean');
    expect(flow.contract.output).not.toContain('SavedOrder');
    expect(flow.contract.output).not.toContain('Promise<OrderResponse>');
    expect(flow.contract.internal_outputs_count).toBeGreaterThanOrEqual(3);
  });

  test('(c) flow Effects = union deduped, each stamped with the contributing step', () => {
    expect(flow.contract.side_effects.state_changes).toContain('orders_table');
    expect(flow.contract.side_effects.external_integrations).toContain('warehouse-service');
    const persistStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_saveOrder'))!;
    const prov = flow.contract.facet_provenance!.find(p => p.facet === 'state_change' && p.value === 'orders_table')!;
    expect(prov).toBeDefined();
    expect(prov.contributed_by_step_ids).toEqual([persistStep.step_id]);
    expect(prov.source).toBe('deterministic');
    expect(prov.evidence).toContain('xp_saveOrder');
  });

  test('(d) a guard on an EARLY step is promoted to the flow; a guard on the LAST step is not', () => {
    // step-1 guard (validateOrder) gates everything downstream → flow-level:
    const promoted = flow.contract.constraints.find(c => c.kind === 'business-rule' && /order\.total/.test(c.rule));
    expect(promoted).toBeDefined();
    // last-step guard (notifyWarehouse) gates nothing downstream → step-level ONLY:
    const lastStep = flow.steps[flow.steps.length - 1];
    expect(lastStep.functions.some(f => f.function_id === 'n_notifyWarehouse')).toBe(true);
    expect(lastStep.contract.constraints.some(c => c.kind === 'business-rule' && /warehouseUp/.test(c.rule))).toBe(true);
    expect(flow.contract.constraints.some(c => c.kind === 'business-rule' && /warehouseUp/.test(c.rule))).toBe(false);
  });

  test("(d) entry-scoped 'error' constraints stay flow-level even from the last step", () => {
    const err = flow.contract.constraints.find(c => c.kind === 'error' && /WarehouseError/.test(c.rule));
    expect(err).toBeDefined();
  });

  test('entry-point auth/validation constraints (step 0) are flow-level', () => {
    expect(flow.contract.constraints.some(c => c.kind === 'auth')).toBe(true);
    expect(flow.contract.constraints.some(c => c.kind === 'validation')).toBe(true);
  });
});

describe('D2 — facet provenance walkability (flow facet → step → code fact)', () => {
  const cas = buildCas();
  const flow = computeFlowConcepts(cas)[0];

  test('every flow-level provenance record names real steps and lifts real step evidence', () => {
    expect(flow.contract.facet_provenance!.length).toBeGreaterThan(0);
    const stepById = new Map(flow.steps.map(s => [s.step_id, s]));
    for (const p of flow.contract.facet_provenance!) {
      expect(p.source).toBe('deterministic');
      expect(p.evidence.length).toBeGreaterThan(0);
      expect(p.contributed_by_step_ids!.length).toBeGreaterThan(0);
      for (const stepId of p.contributed_by_step_ids!) {
        const step = stepById.get(stepId)!;
        expect(step).toBeDefined();
        // the walk continues: the named step's OWN contract carries the entry
        // (facet arrays for I/O/effects; constraints carry the rule inline).
        const c = step.contract;
        const holds =
          (p.facet === 'input' && c.input.includes(p.value)) ||
          (p.facet === 'output' && c.output.includes(p.value)) ||
          (p.facet === 'state_change' && c.side_effects.state_changes.includes(p.value)) ||
          (p.facet === 'external_integration' && c.side_effects.external_integrations.includes(p.value)) ||
          (p.facet === 'constraint' && c.constraints.some(k => k.rule === p.value)) ||
          (p.facet === 'logic' && Boolean(c.logic) && p.value.includes(c.logic));
        expect(holds).toBe(true);
      }
    }
  });

  test('step-level facet entries consistently carry code-fact evidence (no bare entries)', () => {
    for (const step of flow.steps) {
      const prov = step.contract.facet_provenance || [];
      const evidenceFor = (facet: FacetProvenance['facet'], value: string) =>
        prov.find(p => p.facet === facet && p.value === value)?.evidence;
      for (const v of step.contract.input) expect(evidenceFor('input', v)).toBeTruthy();
      for (const v of step.contract.output) expect(evidenceFor('output', v)).toBeTruthy();
      for (const v of step.contract.side_effects.state_changes) expect(evidenceFor('state_change', v)).toBeTruthy();
      for (const v of step.contract.side_effects.external_integrations) expect(evidenceFor('external_integration', v)).toBeTruthy();
      // step-level records are the code evidence themselves — no step attribution needed:
      for (const p of prov) expect(p.contributed_by_step_ids).toBeUndefined();
    }
  });

  test('terminus-folded entries on terminal flows carry provenance citing the resolved exit point', () => {
    const terminalFlow = computeFlowConcepts(buildTerminalCas())[0];
    expect(terminalFlow.terminus?.exit_point_id).toBe('xp_notifyWarehouse');
    // the webhook emission was folded into Output with terminus provenance:
    const out = terminalFlow.contract.output.find(o => /warehouse-service/.test(o))!;
    expect(out).toBeDefined();
    const prov = terminalFlow.contract.facet_provenance!.find(p => p.facet === 'output' && p.value === out)!;
    expect(prov).toBeDefined();
    expect(prov.evidence).toContain('xp_notifyWarehouse');
    const lastStep = terminalFlow.steps[terminalFlow.steps.length - 1];
    expect(prov.contributed_by_step_ids).toContain(lastStep.step_id);
  });

  test('telemetry join stamps flow-level telemetry provenance (evidence-gated)', () => {
    const flows = computeFlowConcepts(buildCas());
    const joined = attachTelemetryToFlows(flows, [
      { static_id: 'ep_createOrder', entry_point_id: 'ep_createOrder', request_count: 100, error_rate: 0.01, source: 'ingested' },
    ]);
    const f = joined[0];
    expect(f.contract.telemetry).toBeDefined();
    const prov = f.contract.facet_provenance!.find(p => p.facet === 'telemetry')!;
    expect(prov).toBeDefined();
    expect(prov.value).toBe('ep_createOrder');
    expect(prov.source).toBe('deterministic');
    expect(flows[0].contract.telemetry).toBeUndefined();
    // no observations → no telemetry facet AND no telemetry provenance:
    const bare = computeFlowConcepts(buildCas())[0];
    expect(bare.contract.telemetry).toBeUndefined();
    expect((bare.contract.facet_provenance || []).some(p => p.facet === 'telemetry')).toBe(false);
  });
});

describe('D2 — AI-reframe plug point + determinism', () => {
  test('logic_summary is ABSENT everywhere in deterministic runs (AI-only-or-absent)', () => {
    for (const cas of [buildCas(), buildTerminalCas()]) {
      for (const flow of computeFlowConcepts(cas)) {
        expect(flow.contract.logic_summary).toBeUndefined();
        for (const step of flow.steps) expect(step.contract.logic_summary).toBeUndefined();
      }
    }
  });

  test('aggregation + provenance are byte-stable run-to-run (sorted, deterministic)', () => {
    const a = JSON.stringify(computeFlowConcepts(buildCas()));
    const b = JSON.stringify(computeFlowConcepts(buildCas()));
    expect(a).toBe(b);
    const ta = JSON.stringify(computeFlowConcepts(buildTerminalCas()));
    const tb = JSON.stringify(computeFlowConcepts(buildTerminalCas()));
    expect(ta).toBe(tb);
  });

  test('provenance lists are sorted: (facet, value) order, sorted step ids', () => {
    const flow = computeFlowConcepts(buildCas())[0];
    const prov = flow.contract.facet_provenance!;
    const keys = prov.map(p => `${p.facet}\u0000${p.value}`);
    expect(keys).toEqual([...keys].sort());
    for (const p of prov) {
      expect(p.contributed_by_step_ids).toEqual([...p.contributed_by_step_ids!].sort());
    }
  });

  test('single-step flow: its input IS the initiating input, its output IS the terminal output, its guards gate the flow', () => {
    const cas = buildCas();
    // collapse to a single node chain: remove edges so only the handler traces.
    (cas as any).edges = [];
    const flow = computeFlowConcepts(cas)[0];
    expect(flow.steps).toHaveLength(1);
    expect(flow.contract.input).toEqual(flow.steps[0].contract.input);
    expect(flow.contract.output).toEqual(flow.steps[0].contract.output);
    expect(flow.contract.internal_inputs_count).toBeUndefined();
    expect(flow.contract.internal_outputs_count).toBeUndefined();
    // entry-point auth constraint on the only step still gates the flow:
    expect(flow.contract.constraints.some(c => c.kind === 'auth')).toBe(true);
  });
});
