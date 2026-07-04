import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import { computeFlowStructuralLinks, computeConflictBehavioralLinks } from '../../analyzer/core/structural-cross-links';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  CASDataEntity,
  SystemCapability,
  CASParadigmConformance,
  CASArchitecturalConflict,
  CASPrincipleViolation,
} from '../../types/cas.types';

/**
 * Fixture: the same route -> validate -> persist -> notify chain used by
 * flow-concepts.test.ts, plus a paradigm_conformance deviation ON the
 * persist step's function (n_saveOrder skips the service layer / writes
 * directly) and an architectural_conflict + principle_violation whose
 * evidence resolves back to that same function/file — so both directions of
 * the cross-link (flow -> structural, structural -> flow) have a real,
 * non-trivial assertion.
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return {
    qualified_name: overrides.name,
    ...overrides,
  } as CASNode;
}

function buildFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_handleCreateOrder', name: 'handleCreateOrder', type: 'controller', category: 'entry' }),
    node({
      id: 'n_validateOrder',
      name: 'validateOrder',
      type: 'function',
      category: 'business',
      source: { file: 'src/orders/validate.ts', line: 1, end_line: 10 },
    }),
    node({
      id: 'n_saveOrder',
      name: 'saveOrder',
      type: 'function',
      category: 'data',
      source: { file: 'src/orders/repository.ts', line: 1, end_line: 5 },
    }),
    node({ id: 'n_notifyWarehouse', name: 'notifyWarehouse', type: 'function', category: 'business' }),
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
    },
  ];

  const exit_points: CASExitPoint[] = [
    { id: 'xp_saveOrder', source_node: 'n_saveOrder', type: 'database', name: 'saveOrder', target: { resource: 'orders_table' } } as CASExitPoint,
    { id: 'xp_notifyWarehouse', source_node: 'n_notifyWarehouse', type: 'webhook', name: 'notifyWarehouse', target: { service_id: 'warehouse-service' } } as CASExitPoint,
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
      invariants: [],
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

  // The paradigm deviation's node_id (n_saveOrder) is exactly the persist
  // step's function — this is the flow -> structural link under test.
  const paradigm_conformance: CASParadigmConformance[] = [
    {
      paradigm: 'entry-service-repository-layering',
      description: 'Entry-layer handlers reach repositories through a service-layer hop',
      adoption: { following_count: 8, comparable_count: 10, adoption_rate: 0.8, evidence_files: ['src/orders/service.ts'] },
      deviations: [
        {
          file: 'src/orders/repository.ts',
          node_id: 'n_saveOrder',
          kind: 'layer-skipping-call',
          detail: 'saveOrder is called directly, skipping the service layer',
          severity: 'warning',
        },
      ],
    },
  ];

  // Architectural conflict evidence is file-based (competing[].files) —
  // resolved back to n_saveOrder via its source.file, the structural ->
  // flow link under test.
  const architectural_conflicts: CASArchitecturalConflict[] = [
    {
      id: 'paradigm-conflict:entry-service-repository-layering',
      kind: 'pattern-conflict',
      concern: 'entry-to-repository call path',
      competing: [
        { label: 'layered', files: ['src/orders/service.ts'], share: 0.8 },
        { label: 'direct repository call', files: ['src/orders/repository.ts'], share: 0.2 },
      ],
      severity: 'medium',
      evidence: ['src/orders/repository.ts: saveOrder called directly'],
      suggested_alignment: 'Route saveOrder through the service layer.',
    },
  ];

  const principle_violations: CASPrincipleViolation[] = [
    {
      id: 'layering:n_saveOrder',
      principle: 'layering',
      file: 'src/orders/repository.ts',
      node_id: 'n_saveOrder',
      detail: 'saveOrder called directly, skipping the service layer',
      severity: 'warning',
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
    paradigm_conformance,
    architectural_conflicts,
    principle_violations,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

describe('structural cross-links: flow -> structural (layer + paradigm deviation)', () => {
  const cas = buildFixtureCas();
  const flows = computeFlowConcepts(cas);
  const links = computeFlowStructuralLinks(cas, flows);

  test('every step resolves a real architectural layer from node classification', () => {
    const flow = flows[0];
    const linked = links.get(flow.flow_id)!;
    expect(linked).toBeDefined();
    for (const step of flow.steps) {
      const stepLinks = linked.steps.get(step.step_id)!;
      expect(stepLinks.layers.length).toBeGreaterThan(0);
    }
    // flow-level union of layers must include the entry layer and the data layer
    expect(linked.flow.layers).toContain('entry');
    expect(linked.flow.layers).toContain('data');
  });

  test('the step containing n_saveOrder carries the real paradigm deviation', () => {
    const flow = flows[0];
    const linked = links.get(flow.flow_id)!;
    const persistStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_saveOrder'))!;
    const stepLinks = linked.steps.get(persistStep.step_id)!;
    expect(stepLinks.paradigm_deviations.length).toBe(1);
    expect(stepLinks.paradigm_deviations[0].paradigm).toBe('entry-service-repository-layering');
    // flow-level aggregate must also carry it, tagged with the right step_id
    expect(linked.flow.paradigm_deviations.some(d => d.step_id === persistStep.step_id)).toBe(true);
  });

  test('a step with no deviating function has an empty paradigm_deviations list (never fabricated)', () => {
    const flow = flows[0];
    const linked = links.get(flow.flow_id)!;
    const validateStep = flow.steps.find(s => s.functions.some(f => f.function_id === 'n_validateOrder'))!;
    const stepLinks = linked.steps.get(validateStep.step_id)!;
    expect(stepLinks.paradigm_deviations).toEqual([]);
  });
});

describe('structural cross-links: structural -> flow (conflict/violation -> flow/step/capability)', () => {
  const cas = buildFixtureCas();
  const flows = computeFlowConcepts(cas);

  test('the architectural conflict resolves to the real flow/step/capability via file-based evidence', () => {
    const { conflicts } = computeConflictBehavioralLinks(
      cas,
      flows,
      cas.architectural_conflicts!,
      cas.principle_violations!
    );
    const link = conflicts.get('paradigm-conflict:entry-service-repository-layering');
    expect(link).toBeDefined();
    expect(link!.flow_ids).toContain(flows[0].flow_id);
    expect(link!.capability_ids).toContain('cap_order_management');
    const persistStep = flows[0].steps.find(s => s.functions.some(f => f.function_id === 'n_saveOrder'))!;
    expect(link!.step_ids).toContain(persistStep.step_id);
  });

  test('the principle violation (node_id-based evidence) resolves to the same flow/step', () => {
    const { violations } = computeConflictBehavioralLinks(
      cas,
      flows,
      cas.architectural_conflicts!,
      cas.principle_violations!
    );
    const link = violations.get('layering:n_saveOrder');
    expect(link).toBeDefined();
    expect(link!.flow_ids).toContain(flows[0].flow_id);
    const persistStep = flows[0].steps.find(s => s.functions.some(f => f.function_id === 'n_saveOrder'))!;
    expect(link!.step_ids).toContain(persistStep.step_id);
  });

  test('a conflict/violation whose evidence matches no traced flow function is honestly omitted, not guessed', () => {
    const unrelatedConflict: CASArchitecturalConflict = {
      id: 'unrelated-conflict',
      kind: 'pattern-overlap',
      concern: 'unrelated concern',
      competing: [{ label: 'x', files: ['some/totally/unrelated/file.ts'], share: 1 }],
      severity: 'low',
      evidence: [],
      suggested_alignment: 'n/a',
    };
    const { conflicts } = computeConflictBehavioralLinks(cas, flows, [unrelatedConflict], []);
    expect(conflicts.has('unrelated-conflict')).toBe(false);
  });
});
