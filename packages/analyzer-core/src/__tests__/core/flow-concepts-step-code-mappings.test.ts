import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import type { FlowStep, StepCodeMapping } from '../../analyzer/core/flow-concepts';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  CASDataEntity,
} from '../../types/cas.types';

/**
 * D1 — StepCodeMapping many-to-many (docs/SEMANTIC-MODEL.md, Step):
 * typed step↔code mappings, each grounded in a CAS fact; a node can carry
 * multiple mappings within a step, and the same node mapped into different
 * steps can carry different relationships. sub_segments is the AI-only plug
 * point and must be ABSENT in every deterministic run.
 */

function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

/** The canonical route -> validate -> persist -> notify fixture (same shape as
 *  flow-concepts.test.ts), entry-point-rooted (no call_chains by default). */
function buildFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_handleCreateOrder', name: 'handleCreateOrder', type: 'controller', category: 'entry' }),
    node({
      id: 'n_validateOrder', name: 'validateOrder', type: 'function', category: 'business',
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
    node({ id: 'n_saveOrder', name: 'saveOrder', type: 'function', category: 'data' }),
    node({ id: 'n_notifyWarehouse', name: 'notifyWarehouse', type: 'function', category: 'business' }),
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
      security: { authenticated: true, guards: ['AuthGuard'] },
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
      invariants: [{ description: 'order total must be positive', enforced_by: ['n_validateOrder'], source: 'validation' }],
    } as any,
  ];
  return {
    cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test',
    system: { name: 'test-system' } as any,
    nodes, edges, entry_points, exit_points, data_lineage, entities,
    capabilities: [], analyzer_contributions: [],
  } as unknown as CASOutput;
}

/** Terminal-chain variant of the same fixture: the pre-computed entry-to-exit
 *  chain ends at the webhook exit — grounds 'completes'. */
function withTerminalChain(cas: CASOutput): CASOutput {
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
  return cas;
}

function mappingsFor(step: FlowStep, nodeId: string): StepCodeMapping[] {
  return (step.code_mappings || []).filter(m => m.code_region.node_id === nodeId);
}

function stepWithFn(steps: FlowStep[], nodeId: string): FlowStep {
  const step = steps.find(s => s.functions.some(f => f.function_id === nodeId));
  expect(step).toBeDefined();
  return step!;
}

describe('D1 code_mappings — relationship rules (evidence-gated, deterministic)', () => {
  const flow = computeFlowConcepts(buildFixtureCas())[0];

  test('every step carries code_mappings; every mapping is well-formed (step_id, confidence 1.0, NO sub_segments)', () => {
    expect(flow.steps.length).toBeGreaterThan(1);
    for (const step of flow.steps) {
      expect(step.code_mappings).toBeDefined();
      expect(step.code_mappings!.length).toBeGreaterThan(0);
      for (const m of step.code_mappings!) {
        expect(m.step_id).toBe(step.step_id);
        expect(m.confidence).toBe(1.0);
        expect(m.contribution.length).toBeGreaterThan(0);
        // AI-only-or-absent plug point: NEVER populated deterministically.
        expect(m.sub_segments).toBeUndefined();
      }
    }
  });

  test('initiates — the entry-point-bound node of the FIRST step', () => {
    const first = flow.steps[0];
    const rels = mappingsFor(first, 'n_handleCreateOrder').map(m => m.relationship);
    expect(rels).toContain('initiates');
    const initiates = mappingsFor(first, 'n_handleCreateOrder').find(m => m.relationship === 'initiates')!;
    expect(initiates.contribution).toMatch(/entry point/i);
  });

  test('validates — a node contributing non-error constraints (guard clause / entry auth+validation / invariant)', () => {
    // the guard-clause + invariant node
    const validateStep = stepWithFn(flow.steps, 'n_validateOrder');
    const v = mappingsFor(validateStep, 'n_validateOrder').filter(m => m.relationship === 'validates');
    expect(v.length).toBe(1); // deduped per (node, relationship)
    expect(v[0].contribution).toMatch(/guard clause|invariant/i);
    // the entry-point handler carries auth guards + input.validation facts
    const first = flow.steps[0];
    const handlerRels = mappingsFor(first, 'n_handleCreateOrder').map(m => m.relationship);
    expect(handlerRels).toContain('validates');
  });

  test('many-to-many WITHIN a step: one node carries multiple typed mappings (initiates + validates)', () => {
    const first = flow.steps[0];
    const rels = mappingsFor(first, 'n_handleCreateOrder').map(m => m.relationship).sort();
    expect(rels).toEqual(expect.arrayContaining(['initiates', 'validates']));
    expect(rels.length).toBeGreaterThanOrEqual(2);
  });

  test('causes_effect — nodes with state-changing / integration exits, contribution cites the exit point', () => {
    const persist = stepWithFn(flow.steps, 'n_saveOrder');
    const pm = mappingsFor(persist, 'n_saveOrder').find(m => m.relationship === 'causes_effect');
    expect(pm).toBeDefined();
    expect(pm!.contribution).toMatch(/xp_saveOrder.*state change/);
    const notify = stepWithFn(flow.steps, 'n_notifyWarehouse');
    const nm = mappingsFor(notify, 'n_notifyWarehouse').find(m => m.relationship === 'causes_effect');
    expect(nm).toBeDefined();
    expect(nm!.contribution).toMatch(/xp_notifyWarehouse.*external integration/);
  });

  test('code_region — line_range/file only when the node carries real span facts, never invented', () => {
    const validateStep = stepWithFn(flow.steps, 'n_validateOrder');
    const withSpan = mappingsFor(validateStep, 'n_validateOrder')[0];
    expect(withSpan.code_region.file).toBe('src/orders/validate.ts');
    expect(withSpan.code_region.line_range).toEqual([1, 10]);
    const persist = stepWithFn(flow.steps, 'n_saveOrder');
    const noSpan = mappingsFor(persist, 'n_saveOrder')[0];
    expect(noSpan.code_region.file).toBeUndefined();
    expect(noSpan.code_region.line_range).toBeUndefined();
  });

  test('completes — only on a terminal-chain flow, on the node resolving the terminus', () => {
    // entry-point-rooted flow: no terminus → completes NEVER derived (omitted, not fabricated).
    for (const step of flow.steps) {
      expect((step.code_mappings || []).some(m => m.relationship === 'completes')).toBe(false);
    }
    const terminalFlow = computeFlowConcepts(withTerminalChain(buildFixtureCas()))[0];
    expect(terminalFlow.terminus?.exit_point_id).toBe('xp_notifyWarehouse');
    const lastStep = terminalFlow.steps[terminalFlow.steps.length - 1];
    const cm = mappingsFor(lastStep, 'n_notifyWarehouse').find(m => m.relationship === 'completes');
    expect(cm).toBeDefined();
    expect(cm!.contribution).toMatch(/xp_notifyWarehouse/);
    // and the same node ALSO carries causes_effect — multiple mappings on the terminus node.
    expect(mappingsFor(lastStep, 'n_notifyWarehouse').some(m => m.relationship === 'causes_effect')).toBe(true);
  });

  test('branches — a node with a conditional control-flow successor (edge.metadata.conditional)', () => {
    const cas = buildFixtureCas();
    cas.edges.find(e => e.id === 'e2')!.metadata = { conditional: true };
    const f = computeFlowConcepts(cas)[0];
    const validateStep = stepWithFn(f.steps, 'n_validateOrder');
    const bm = mappingsFor(validateStep, 'n_validateOrder').find(m => m.relationship === 'branches');
    expect(bm).toBeDefined();
    expect(bm!.contribution).toMatch(/conditional/i);
  });

  test('handles_failure — a node that is a try-catch pattern instance', () => {
    const cas = buildFixtureCas();
    (cas as any).patterns = [{ name: 'try-catch', instances: ['n_notifyWarehouse'] }];
    const f = computeFlowConcepts(cas)[0];
    const notify = stepWithFn(f.steps, 'n_notifyWarehouse');
    const hm = mappingsFor(notify, 'n_notifyWarehouse').find(m => m.relationship === 'handles_failure');
    expect(hm).toBeDefined();
    expect(hm!.contribution).toMatch(/try-catch/);
  });

  test('provides_input / consumes_output — data_lineage-derivable ONLY (writer feeds the next step\'s reader)', () => {
    // writer (persist) step is followed by a reader step of the same entity.
    const cas = buildFixtureCas();
    // rewire: handle -> save (writes Order) -> validate (reads Order): the write
    // step now PRECEDES the read step, so provides_input/consumes_output fire.
    cas.edges.length = 0;
    cas.edges.push(
      { id: 'e1', source: 'n_handleCreateOrder', target: 'n_saveOrder', type: 'calls' },
      { id: 'e2', source: 'n_saveOrder', target: 'n_validateOrder', type: 'calls' },
    );
    const f = computeFlowConcepts(cas)[0];
    const writerStep = stepWithFn(f.steps, 'n_saveOrder');
    const readerStep = stepWithFn(f.steps, 'n_validateOrder');
    expect(writerStep.order).toBeLessThan(readerStep.order);
    const pi = mappingsFor(writerStep, 'n_saveOrder').find(m => m.relationship === 'provides_input');
    expect(pi).toBeDefined();
    expect(pi!.contribution).toMatch(/"Order".*next step/);
    const co = mappingsFor(readerStep, 'n_validateOrder').find(m => m.relationship === 'consumes_output');
    expect(co).toBeDefined();
    expect(co!.contribution).toMatch(/"Order".*previous step/);
    // in the ORIGINAL fixture the read precedes the write → neither fires (no fabrication).
    const orig = computeFlowConcepts(buildFixtureCas())[0];
    for (const step of orig.steps) {
      expect((step.code_mappings || []).some(m => m.relationship === 'provides_input')).toBe(false);
      expect((step.code_mappings || []).some(m => m.relationship === 'consumes_output')).toBe(false);
    }
  });

  test('observes — a node whose exits are telemetry-only and writes nothing', () => {
    const cas = buildFixtureCas();
    cas.nodes.push(node({ id: 'n_trackEvent', name: 'trackEvent', type: 'function', category: 'business' }));
    cas.edges.push({ id: 'e4', source: 'n_notifyWarehouse', target: 'n_trackEvent', type: 'calls' });
    (cas.exit_points as CASExitPoint[]).push(
      { id: 'xp_track', source_node: 'n_trackEvent', type: 'analytics', name: 'trackEvent', target: { service_id: 'segment' } } as CASExitPoint
    );
    const f = computeFlowConcepts(cas)[0];
    const trackStep = stepWithFn(f.steps, 'n_trackEvent');
    const om = mappingsFor(trackStep, 'n_trackEvent').find(m => m.relationship === 'observes');
    expect(om).toBeDefined();
    expect(om!.contribution).toMatch(/telemetry/i);
    // telemetry-only node must NOT be causes_effect.
    expect(mappingsFor(trackStep, 'n_trackEvent').some(m => m.relationship === 'causes_effect')).toBe(false);
  });
});

describe('D1 code_mappings — defaults (implements / partially_implements)', () => {
  function buildPlainChainCas(logicNodeIds: string[]): CASOutput {
    const nodes: CASNode[] = [
      node({ id: 'n_root', name: 'handleThing', type: 'controller', category: 'entry' }),
      ...logicNodeIds.map(id => node({ id, name: id.replace(/^n_/, ''), type: 'function', category: 'business' })),
    ];
    const edges: CASEdge[] = logicNodeIds.map((id, i) => ({
      id: `e${i}`,
      source: i === 0 ? 'n_root' : logicNodeIds[i - 1],
      target: id,
      type: 'calls',
    }));
    const entry_points: CASEntryPoint[] = [{
      id: 'ep_thing', source_node: 'n_root', type: 'http', name: 'thing',
      trigger: { method: 'GET', path: '/thing' },
      handler: { node_id: 'n_root', method_name: 'handleThing' },
    }];
    return {
      cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-plain',
      system: { name: 'test-system' } as any,
      nodes, edges, entry_points, exit_points: [], data_lineage: [], entities: [],
      capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;
  }

  test('sole node of a segment with no specific facts → implements', () => {
    const f = computeFlowConcepts(buildPlainChainCas(['n_doWork']))[0];
    const step = stepWithFn(f.steps, 'n_doWork');
    const m = mappingsFor(step, 'n_doWork');
    expect(m.map(x => x.relationship)).toEqual(['implements']);
  });

  test('multi-node segment with no specific facts → each node partially_implements', () => {
    const f = computeFlowConcepts(buildPlainChainCas(['n_stepA', 'n_stepB']))[0];
    // both plain business/logic nodes coalesce into ONE segment (same character+layer).
    const step = stepWithFn(f.steps, 'n_stepA');
    expect(step.functions.map(fn => fn.function_id)).toEqual(expect.arrayContaining(['n_stepA', 'n_stepB']));
    for (const id of ['n_stepA', 'n_stepB']) {
      expect(mappingsFor(step, id).map(x => x.relationship)).toEqual(['partially_implements']);
    }
  });

  test('a node with a specific relationship does NOT also get the default mapping', () => {
    const f = computeFlowConcepts(buildFixtureCas())[0];
    const first = f.steps[0]; // handler: initiates + validates, no implements
    const rels = mappingsFor(first, 'n_handleCreateOrder').map(m => m.relationship);
    expect(rels).not.toContain('implements');
    expect(rels).not.toContain('partially_implements');
  });
});

describe('D1 code_mappings — many-to-many ACROSS steps (shared node, different relationships)', () => {
  test('the same node mapped into two flows\' steps carries different relationships in each', () => {
    // n_shared is an INTERIOR plain node of flow A, and the ROOT of flow B.
    const nodes: CASNode[] = [
      node({ id: 'n_rootA', name: 'handleA', type: 'controller', category: 'entry' }),
      node({ id: 'n_shared', name: 'sharedHelper', type: 'function', category: 'business' }),
    ];
    const edges: CASEdge[] = [
      { id: 'e1', source: 'n_rootA', target: 'n_shared', type: 'calls' },
    ];
    const entry_points: CASEntryPoint[] = [
      {
        id: 'ep_a', source_node: 'n_rootA', type: 'http', name: 'a',
        trigger: { method: 'GET', path: '/a' },
        handler: { node_id: 'n_rootA', method_name: 'handleA' },
      },
      {
        // flow B is rooted directly at the shared helper (e.g. an event binding).
        id: 'ep_b', source_node: 'n_shared', type: 'event', name: 'b',
        trigger: { event: 'thing.happened' },
        handler: { node_id: 'n_shared', method_name: 'sharedHelper' },
      },
    ];
    const cas = {
      cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-shared',
      system: { name: 'test-system' } as any,
      nodes, edges, entry_points, exit_points: [], data_lineage: [], entities: [],
      capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;

    const flows = computeFlowConcepts(cas);
    const flowA = flows.find(f => f.entry_point === 'ep_a')!;
    const flowB = flows.find(f => f.entry_point === 'ep_b')!;
    expect(flowA).toBeDefined();
    expect(flowB).toBeDefined();

    const sharedInA = flowA.steps.flatMap(s => (s.code_mappings || []).filter(m => m.code_region.node_id === 'n_shared'));
    const sharedInB = flowB.steps.flatMap(s => (s.code_mappings || []).filter(m => m.code_region.node_id === 'n_shared'));
    expect(sharedInA.length).toBeGreaterThan(0);
    expect(sharedInB.length).toBeGreaterThan(0);
    // interior helper in A → implements; root of B → initiates. Same node, two
    // steps, DIFFERENT relationships — the many-to-many point.
    expect(sharedInA.map(m => m.relationship)).toContain('implements');
    expect(sharedInB.map(m => m.relationship)).toContain('initiates');
    // and the mappings belong to different steps (step_id differs).
    expect(sharedInA[0].step_id).not.toBe(sharedInB[0].step_id);
  });
});

describe('D1 code_mappings — determinism, ordering, cap, additivity', () => {
  test('byte-stable run-to-run (same CAS → identical serialized flows incl. mappings)', () => {
    const a = JSON.stringify(computeFlowConcepts(withTerminalChain(buildFixtureCas())));
    const b = JSON.stringify(computeFlowConcepts(withTerminalChain(buildFixtureCas())));
    expect(a).toBe(b);
  });

  test('mappings sorted by (node_id, relationship)', () => {
    const flows = computeFlowConcepts(withTerminalChain(buildFixtureCas()));
    for (const flow of flows) {
      for (const step of flow.steps) {
        const keys = (step.code_mappings || []).map(m => `${m.code_region.node_id}\u0000${m.relationship}`);
        expect(keys).toEqual([...keys].sort());
        // deduped: no (node, relationship) pair twice.
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });

  test('cap: overflow is truncated to 50 with an honest code_mappings_truncated count', () => {
    // 39 repository nodes fanned out from the root, each with a database exit
    // (causes_effect) AND a conditional out-edge (branches) → 78 mappings in one
    // persist segment → capped at 50, 28 reported truncated.
    const fanout = Array.from({ length: 39 }, (_, i) => `n_p${String(i).padStart(2, '0')}`);
    const nodes: CASNode[] = [
      node({ id: 'n_root', name: 'handleBig', type: 'controller', category: 'entry' }),
      ...fanout.map(id => node({ id, name: id, type: 'repository', category: 'data' })),
    ];
    const edges: CASEdge[] = [
      ...fanout.map((id, i) => ({ id: `e${i}`, source: 'n_root', target: id, type: 'calls' } as CASEdge)),
      ...fanout.map((id, i) => ({ id: `c${i}`, source: id, target: 'n_root', type: 'calls', metadata: { conditional: true } } as CASEdge)),
    ];
    const entry_points: CASEntryPoint[] = [{
      id: 'ep_big', source_node: 'n_root', type: 'http', name: 'big',
      trigger: { method: 'POST', path: '/big' },
      handler: { node_id: 'n_root', method_name: 'handleBig' },
    }];
    const exit_points: CASExitPoint[] = fanout.map((id, i) => ({
      id: `xp_${i}`, source_node: id, type: 'database', name: id, target: { resource: `table_${i}` },
    } as CASExitPoint));
    const cas = {
      cas_version: '1.0.0', analysis_timestamp: new Date().toISOString(), analysis_id: 'test-cap',
      system: { name: 'test-system' } as any,
      nodes, edges, entry_points, exit_points, data_lineage: [], entities: [],
      capabilities: [], analyzer_contributions: [],
    } as unknown as CASOutput;

    const f = computeFlowConcepts(cas)[0];
    const bigStep = stepWithFn(f.steps, fanout[0]);
    expect(bigStep.functions.length).toBe(39);
    expect(bigStep.code_mappings!.length).toBe(50);
    expect(bigStep.code_mappings_truncated).toBe(28);
    // steps that did NOT overflow carry no zero-filled marker.
    const rootStep = f.steps[0];
    expect(rootStep.code_mappings_truncated).toBeUndefined();
  });

  test('additive: existing step surface (functions/contract/entities/step_graph) is unchanged by mappings', () => {
    const cas = buildFixtureCas();
    const flow = computeFlowConcepts(cas)[0];
    for (const step of flow.steps) {
      expect(step.functions.length).toBeGreaterThan(0);
      expect(step.contract).toBeDefined();
      expect(Array.isArray(step.entities)).toBe(true);
      expect(step.description_source).toBe('deterministic-label');
    }
    expect(flow.step_graph).toBeDefined();
    // mapping node ids ⊆ the step's own function ids (mappings never reach
    // outside the step's segment).
    for (const step of flow.steps) {
      const fnIds = new Set(step.functions.map(fn => fn.function_id));
      for (const m of step.code_mappings || []) {
        expect(fnIds.has(m.code_region.node_id)).toBe(true);
      }
    }
  });
});
