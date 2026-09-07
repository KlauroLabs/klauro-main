import { computeFlowConcepts, materializeNodeUnderstandingContracts, overlayRuntimeTelemetry } from '../../analyzer/core/flow-concepts';
import { validateUnderstandingContractIntegrity } from '../../analyzer/core/understanding-contract-integrity';
import type { CASNode, CASOutput, ContractTelemetry } from '../../types/cas.types';

function fixture(): CASOutput {
  const nodes: CASNode[] = [
    {
      id: 'handler', name: 'handleOrder', type: 'handler',
      signature: { parameters: [{ name: 'request', type: 'OrderRequest' }], return_type: 'OrderResponse' },
      source: { file: 'src/order.ts', line: 1, raw: 'if (!request.valid) throw new Error("invalid");' },
    } as CASNode,
    {
      id: 'persist', name: 'saveOrder', type: 'repository_operation',
      signature: { parameters: [{ name: 'order', type: 'Order' }], return_type: 'SavedOrder' },
    } as CASNode,
    { id: 'module', name: 'OrdersModule', type: 'module' } as CASNode,
  ];
  return {
    cas_version: '3.0.0', analysis_id: 'icelot-contract', analysis_timestamp: '2026-08-28T00:00:00.000Z',
    system: { id: 'system', name: 'system', type: 'application', root_path: '.' },
    nodes,
    edges: [{ id: 'edge-call', source: 'handler', target: 'persist', type: 'calls' }],
    entry_points: [{ id: 'entry', source_node: 'handler', type: 'http', name: 'POST /orders', handler: { node_id: 'handler' }, security: { authenticated: true } }],
    exit_points: [{ id: 'exit-db', source_node: 'persist', type: 'database', name: 'save', target: { resource: 'orders' } }],
    entities: [{ id: 'entity-order', name: 'Order', lifecycle: { created_by: ['persist'], read_by: [], updated_by: [], deleted_by: [] }, invariants: [] }],
    analyzer_contributions: [], capabilities: [],
  } as unknown as CASOutput;
}

function aggregateLogicFixture(): CASOutput {
  const cas = fixture();
  const persist = cas.nodes.find(node => node.id === 'persist')!;
  persist.implementation = { control_flow: { branch: ['saved'] } } as any;
  cas.nodes.push({
    id: 'observe', name: 'observeOrder', type: 'function',
    signature: { parameters: [], return_type: 'void' },
  } as CASNode);
  cas.flows = [{
    flow_id: 'flow-aggregate', name: 'Aggregate', intent: 'Aggregate', entry_point: 'entry', entities: [],
    contract: {} as any,
    steps: [
      {
        step_id: 'step-handler', order: 0, name: 'Handle', description: 'Handle', description_source: 'deterministic-label',
        contract: {} as any, functions: [{ function_id: 'handler' }], entities: [],
      },
      {
        step_id: 'step-persist', order: 1, name: 'Persist', description: 'Persist', description_source: 'deterministic-label',
        contract: {} as any, functions: [{ function_id: 'persist' }], entities: [],
      },
      {
        step_id: 'step-observe', order: 2, name: 'Observe', description: 'Observe', description_source: 'deterministic-label',
        contract: {} as any, functions: [{ function_id: 'observe' }], entities: [],
      },
    ],
  } as any];
  materializeNodeUnderstandingContracts(cas);
  return cas;
}

function transferFixture(): CASOutput {
  const cas = aggregateLogicFixture();
  cas.exit_points!.push({ id: 'exit-transfer', source_node: 'observe', type: 'api', name: 'send' });
  cas.data_lineage = [{
    entity_id: 'entity-order', entity_name: 'Order', sensitive_fields: [],
    writers: [{ node_id: 'persist', via: 'source' }],
    readers: [{ node_id: 'handler', via: 'source' }],
    external_recipients: [{ exit_point_id: 'exit-transfer', service: 'delivery-service', via_node: 'observe' }],
    boundaries_crossed: [], journeys_carrying: [],
    exposure: { unguarded_paths: 0, external_transfer: true, sensitive: false },
  }];
  return cas;
}

describe('canonical code-unit ICELOT contracts', () => {
  test('attributes entity transfers only to the carrier while preserving node-to-flow evidence', () => {
    const cas = transferFixture();
    const lineageBefore = JSON.stringify(cas.data_lineage);
    materializeNodeUnderstandingContracts(cas);
    for (const id of ['handler', 'persist']) {
      expect(cas.nodes.find(node => node.id === id)?.contract?.side_effects.external_integrations)
        .not.toContain('delivery-service');
    }
    const carrier = cas.nodes.find(node => node.id === 'observe')!.contract!;
    expect(carrier.side_effects.external_integrations).toContain('delivery-service');
    expect(carrier.facet_provenance?.find(item => item.facet === 'external_integration' && item.value === 'delivery-service')
      ?.contributed_by_node_ids).toEqual(['observe']);
    const flow = cas.flows![0];
    for (const step of flow.steps.filter(step => step.step_id !== 'step-observe')) {
      expect(step.contract.side_effects.external_integrations).not.toContain('delivery-service');
    }
    expect(flow.steps.find(step => step.step_id === 'step-observe')?.contract.side_effects.external_integrations)
      .toContain('delivery-service');
    expect(flow.contract.side_effects.external_integrations).toContain('delivery-service');
    const provenance = flow.contract.facet_provenance?.filter(item => item.facet === 'external_integration' && item.value === 'delivery-service');
    expect(provenance?.length).toBeGreaterThan(0);
    for (const item of provenance || []) {
      expect(item.contributed_by_node_ids).toEqual(['observe']);
      expect(item.contributed_by_step_ids).toEqual(['step-observe']);
    }
    expect(JSON.stringify(cas.data_lineage)).toBe(lineageBefore);
    expect(validateUnderstandingContractIntegrity(cas)).toEqual([]);
  });

  test('resolves a missing lineage carrier through its known exit point without attributing unrelated writers', () => {
    const cas = transferFixture();
    delete cas.data_lineage![0].external_recipients[0].via_node;
    materializeNodeUnderstandingContracts(cas);
    expect(cas.nodes.find(node => node.id === 'observe')?.contract?.side_effects.external_integrations)
      .toContain('delivery-service');
    expect(cas.nodes.find(node => node.id === 'persist')?.contract?.side_effects.external_integrations)
      .not.toContain('delivery-service');
    expect(cas.data_lineage![0].external_recipients[0].via_node).toBeUndefined();
  });

  test('retains unknown transfer evidence on the entity without inventing a responsible function', () => {
    const cas = transferFixture();
    cas.data_lineage![0].external_recipients = [{ exit_point_id: 'unresolved-exit', service: 'unresolved-service' }];
    const lineageBefore = JSON.stringify(cas.data_lineage);
    materializeNodeUnderstandingContracts(cas);
    expect(cas.nodes.every(node => !node.contract?.side_effects.external_integrations.includes('unresolved-service'))).toBe(true);
    expect(cas.nodes.find(node => node.id === 'observe')?.contract?.side_effects.external_integrations).toContain('api:send');
    expect(JSON.stringify(cas.data_lineage)).toBe(lineageBefore);
  });
  test('materializes only behavioral code units with evidence-backed facets and explicit abstentions', () => {
    const cas = fixture();
    materializeNodeUnderstandingContracts(cas);

    const handler = cas.nodes.find(node => node.id === 'handler')!;
    const persist = cas.nodes.find(node => node.id === 'persist')!;
    expect(cas.nodes.find(node => node.id === 'module')?.contract).toBeUndefined();
    expect(handler.contract?.input).toEqual(['request: OrderRequest']);
    expect(handler.contract?.output).toEqual(['OrderResponse']);
    expect(handler.contract?.logic).toContain('calls saveOrder');
    expect(handler.contract?.constraints.some(constraint => constraint.kind === 'auth')).toBe(true);
    expect(persist.contract?.side_effects.state_changes).toEqual(expect.arrayContaining(['orders', 'Order created']));
    expect(persist.contract?.logic).toBe('');
    expect(persist.contract?.facet_abstentions?.logic).toBe('no-source-evidence');
    expect(persist.contract?.facet_abstentions?.telemetry).toBe('no-runtime-observation');

    for (const node of [handler, persist]) {
      for (const provenance of node.contract?.facet_provenance || []) {
        expect(provenance.contributed_by_node_ids).toEqual([node.id]);
      }
    }
    expect(validateUnderstandingContractIntegrity(cas)).toEqual([]);
  });

  test('steps aggregate node contracts and flows retain the node-to-step-to-flow lineage', () => {
    const cas = fixture();
    const flow = computeFlowConcepts(cas)[0];
    expect(flow).toBeDefined();
    expect(flow.steps.flatMap(step => step.functions.map(fn => fn.function_id))).toEqual(expect.arrayContaining(['handler', 'persist']));
    for (const step of flow.steps) {
      const stepNodeIds = new Set(step.functions.map(fn => fn.function_id));
      for (const provenance of step.contract.facet_provenance || []) {
        expect(provenance.contributed_by_node_ids?.every(id => stepNodeIds.has(id))).toBe(true);
      }
    }
    const stepIds = new Set(flow.steps.map(step => step.step_id));
    for (const provenance of flow.contract.facet_provenance || []) {
      expect(provenance.contributed_by_node_ids?.length).toBeGreaterThan(0);
      expect(provenance.contributed_by_step_ids?.every(id => stepIds.has(id))).toBe(true);
    }
    expect(validateUnderstandingContractIntegrity(cas)).toEqual([]);
  });

  test('runtime telemetry overlays a response contract without mutating persisted static truth', () => {
    const cas = fixture();
    materializeNodeUnderstandingContracts(cas);
    const original = cas.nodes[0].contract!;
    const before = JSON.stringify(original);
    const telemetry: ContractTelemetry = { static_id: 'handler', request_count: 12, error_rate: 0, source: 'ingested' };
    const overlaid = overlayRuntimeTelemetry(original, telemetry, ['handler']);
    expect(overlaid.telemetry).toEqual(telemetry);
    expect(overlaid.facet_abstentions?.telemetry).toBeUndefined();
    expect(JSON.stringify(original)).toBe(before);
    expect(original.telemetry).toBeUndefined();
  });

  test('rebuilds changed node contracts without contaminating an unaffected node', () => {
    const cas = fixture();
    materializeNodeUnderstandingContracts(cas);
    const unchangedBefore = JSON.stringify(cas.nodes.find(node => node.id === 'persist')!.contract);
    const handler = cas.nodes.find(node => node.id === 'handler')!;
    handler.signature = { ...handler.signature, return_type: 'UpdatedOrderResponse' };
    materializeNodeUnderstandingContracts(cas);
    expect(handler.contract?.output).toEqual(['UpdatedOrderResponse']);
    expect(JSON.stringify(cas.nodes.find(node => node.id === 'persist')!.contract)).toBe(unchangedBefore);
    expect(validateUnderstandingContractIntegrity(cas)).toEqual([]);
  });

  test('fails integrity for missing abstentions and fabricated lineage', () => {
    const cas = fixture();
    materializeNodeUnderstandingContracts(cas);
    const handler = cas.nodes.find(node => node.id === 'handler')!;
    delete handler.contract!.facet_abstentions;
    handler.contract!.facet_provenance![0].contributed_by_node_ids = ['missing-node'];
    const codes = validateUnderstandingContractIntegrity(cas).map(issue => issue.code);
    expect(codes).toContain('missing-facet-abstention');
    expect(codes).toContain('dangling-node-provenance');
  });

  test('retains lineage state change when the same node is only lifecycle-classified as a reader', () => {
    const cas = fixture();
    cas.entities![0].lifecycle = { created_by: [], read_by: ['persist'], updated_by: [], deleted_by: [] };
    cas.data_lineage = [{
      entity_id: 'entity-order', entity_name: 'Order', sensitive_fields: [],
      writers: [{ node_id: 'persist' } as any], readers: [{ node_id: 'persist' } as any],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    }];
    materializeNodeUnderstandingContracts(cas);
    expect(cas.nodes.find(node => node.id === 'persist')?.contract?.side_effects.state_changes)
      .toContain('Order updated');
  });

  test('aggregate provenance preserves exact evidence for every node contributing the same value', () => {
    const cas = fixture();
    const handler = cas.nodes.find(node => node.id === 'handler')!;
    const persist = cas.nodes.find(node => node.id === 'persist')!;
    handler.signature = { parameters: [{ name: 'shared', type: 'string' }], return_type: 'boolean' };
    persist.signature = { parameters: [{ name: 'shared', type: 'string' }], return_type: 'boolean' };
    cas.flows = [{
      flow_id: 'flow-shared', name: 'Shared', intent: 'Shared', entry_point: 'entry', entities: [],
      contract: handler.contract!,
      steps: [{
        step_id: 'step-shared', order: 0, name: 'Shared', description: 'Shared', description_source: 'deterministic-label',
        contract: handler.contract!, functions: [{ function_id: 'handler' }, { function_id: 'persist' }], entities: [],
      }],
    } as any];
    materializeNodeUnderstandingContracts(cas);
    const stepProvenance = cas.flows[0].steps[0].contract.facet_provenance!
      .find(provenance => provenance.facet === 'input' && provenance.value === 'shared: string')!;
    expect(stepProvenance.contributed_by_node_ids).toEqual(['handler', 'persist']);
    expect(stepProvenance.evidence).toContain('node handler signature.parameters');
    expect(stepProvenance.evidence).toContain('node persist signature.parameters');
    const flowProvenance = cas.flows[0].contract.facet_provenance!
      .find(provenance => provenance.facet === 'input' && provenance.value === 'shared: string')!;
    expect(flowProvenance.contributed_by_step_ids).toEqual(['step-shared']);
    expect(flowProvenance.contributed_by_node_ids).toEqual(['handler', 'persist']);
    expect(flowProvenance.evidence).toBe(stepProvenance.evidence);
    expect(validateUnderstandingContractIntegrity(cas)).toEqual([]);
  });

  test('rejects aggregate child-value masquerading and recursively validates nested CAS children', () => {
    const child = fixture();
    child.flows = [{
      flow_id: 'flow-child', name: 'Child', intent: 'Child', entry_point: 'entry', entities: [],
      contract: {} as any,
      steps: [{
        step_id: 'step-child', order: 0, name: 'Child', description: 'Child', description_source: 'deterministic-label',
        contract: {} as any, functions: [{ function_id: 'handler' }, { function_id: 'persist' }], entities: [],
      }],
    } as any];
    materializeNodeUnderstandingContracts(child);
    const inputProvenance = child.flows[0].steps[0].contract.facet_provenance!
      .find(provenance => provenance.facet === 'input' && provenance.value === 'request: OrderRequest')!;
    inputProvenance.contributed_by_node_ids = ['persist'];
    const parent = {
      ...fixture(),
      nodes: [],
      edges: [],
      entry_points: [],
      exit_points: [],
      entities: [],
      data_lineage: [],
      flows: [],
      steps: [],
      children: [child],
    } as unknown as CASOutput;
    expect(validateUnderstandingContractIntegrity(parent).map(issue => issue.code))
      .toContain('misattributed-facet-provenance');
  });

  test('rejects a fabricated aggregate facet value even when it cites an allowed child', () => {
    const cas = aggregateLogicFixture();
    const step = cas.flows![0].steps[0];
    step.contract.input.push('fabricated input');
    step.contract.facet_provenance!.push({
      facet: 'input', value: 'fabricated input', contributed_by_node_ids: ['handler'],
      source: 'deterministic', evidence: 'fabricated evidence',
    });
    expect(validateUnderstandingContractIntegrity(cas).map(issue => issue.code))
      .toContain('misattributed-facet-provenance');
  });

  test('validates aggregate Logic value, exact contributors, and unioned evidence', () => {
    const valid = aggregateLogicFixture();
    const validLogic = valid.flows![0].contract.facet_provenance!
      .find(provenance => provenance.facet === 'logic')!;
    expect(validLogic.contributed_by_step_ids).toEqual(['step-handler', 'step-persist']);
    expect(validLogic.contributed_by_node_ids).toEqual(['handler', 'persist']);
    expect(validLogic.evidence).toContain('node handler');
    expect(validLogic.evidence).toContain('node persist');
    expect(validateUnderstandingContractIntegrity(valid)).toEqual([]);

    const corrupted = [
      (cas: CASOutput) => {
        const flow = cas.flows![0];
        const provenance = flow.contract.facet_provenance!.find(entry => entry.facet === 'logic')!;
        flow.contract.logic = 'fabricated aggregate logic';
        provenance.value = flow.contract.logic;
      },
      (cas: CASOutput) => {
        const provenance = cas.flows![0].contract.facet_provenance!.find(entry => entry.facet === 'logic')!;
        provenance.contributed_by_step_ids = ['step-handler'];
      },
      (cas: CASOutput) => {
        const provenance = cas.flows![0].contract.facet_provenance!.find(entry => entry.facet === 'logic')!;
        provenance.contributed_by_step_ids = ['step-handler', 'step-observe', 'step-persist'];
      },
      (cas: CASOutput) => {
        const provenance = cas.flows![0].contract.facet_provenance!.find(entry => entry.facet === 'logic')!;
        provenance.evidence = 'evidence from only one child';
      },
    ];
    for (const corrupt of corrupted) {
      const cas = aggregateLogicFixture();
      corrupt(cas);
      expect(validateUnderstandingContractIntegrity(cas).map(issue => issue.code))
        .toContain('misattributed-facet-provenance');
    }
  });

  test('retains complete provenance when a code unit has more than 200 evidence-backed values', () => {
    const cas = fixture();
    const handler = cas.nodes.find(node => node.id === 'handler')!;
    const persist = cas.nodes.find(node => node.id === 'persist')!;
    handler.signature = {
      ...handler.signature,
      parameters: Array.from({ length: 240 }, (_, index) => ({ name: `field${index}`, type: 'string' })),
    };
    persist.implementation = { control_flow: { branch: ['saved'] } } as any;
    materializeNodeUnderstandingContracts(cas);
    expect(handler.contract?.input).toHaveLength(240);
    expect(handler.contract?.facet_provenance?.filter(provenance => provenance.facet === 'input')).toHaveLength(240);
    expect(handler.contract?.facet_provenance?.some(provenance => provenance.facet === 'logic')).toBe(true);
    expect(validateUnderstandingContractIntegrity(cas)).toEqual([]);
    cas.flows = [{
      flow_id: 'flow-combined', name: 'Combined', intent: 'Combined', entry_point: 'entry', entities: [],
      contract: handler.contract!,
      steps: [{
        step_id: 'step-combined', order: 0, name: 'Combined', description: 'Combined', description_source: 'deterministic-label',
        contract: handler.contract!, functions: [{ function_id: 'handler' }, { function_id: 'persist' }], entities: [],
      }],
    } as any];
    materializeNodeUnderstandingContracts(cas);
    const step = cas.flows[0].steps[0];
    expect(step.contract.facet_provenance?.some(provenance => provenance.facet === 'logic' && provenance.value === step.contract.logic)).toBe(true);
    expect(cas.flows[0].contract.facet_provenance?.some(provenance => provenance.facet === 'logic' && provenance.value === cas.flows![0].contract.logic)).toBe(true);
    expect(validateUnderstandingContractIntegrity(cas)).toEqual([]);
  });

  test('keeps compact persisted overhead bounded per behavioral code unit', () => {
    const cas = fixture();
    cas.nodes = Array.from({ length: 1_000 }, (_, index) => ({
      id: `node-${index}`, name: `unit${index}`, type: 'function',
      signature: { parameters: [{ name: 'value', type: 'string' }], return_type: 'boolean' },
    } as CASNode));
    cas.edges = [];
    cas.entry_points = [];
    cas.exit_points = [];
    cas.entities = [];
    const before = Buffer.byteLength(JSON.stringify(cas));
    materializeNodeUnderstandingContracts(cas);
    const addedBytes = Buffer.byteLength(JSON.stringify(cas)) - before;
    expect(addedBytes / cas.nodes.length).toBeLessThan(1_200);
    expect(validateUnderstandingContractIntegrity(cas)).toEqual([]);
  });
  test('rejects a fabricated node facet even when it cites the owning node', () => {
    const cas = fixture();
    materializeNodeUnderstandingContracts(cas);
    const handler = cas.nodes.find(node => node.id === 'handler')!;
    handler.contract!.input.push('fabricated input');
    handler.contract!.facet_provenance!.push({
      facet: 'input', value: 'fabricated input', contributed_by_node_ids: ['handler'],
      source: 'deterministic', evidence: 'node handler signature.parameters',
    });

    expect(validateUnderstandingContractIntegrity(cas).map(issue => issue.code))
      .toContain('deterministic-contract-mismatch');
  });

  test('requires exact non-Logic step and node contributors with merged evidence', () => {
    const build = () => {
      const cas = fixture();
      cas.entities![0].lifecycle = { created_by: [], read_by: [], updated_by: [], deleted_by: [] };
      cas.data_lineage = [{
        entity_id: 'entity-order', entity_name: 'Order', sensitive_fields: [],
        writers: [{ node_id: 'handler' } as any, { node_id: 'persist' } as any],
        readers: [], external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
        exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
      }];
      cas.flows = [{
        flow_id: 'flow-shared-effect', name: 'Shared effect', intent: 'Shared effect', entry_point: 'entry', entities: [],
        contract: {} as any,
        steps: [
          { step_id: 'step-handler', order: 0, name: 'Handle', description: 'Handle', description_source: 'deterministic-label', contract: {} as any, functions: [{ function_id: 'handler' }], entities: [] },
          { step_id: 'step-persist', order: 1, name: 'Persist', description: 'Persist', description_source: 'deterministic-label', contract: {} as any, functions: [{ function_id: 'persist' }], entities: [] },
          { step_id: 'step-observe', order: 2, name: 'Observe', description: 'Observe', description_source: 'deterministic-label', contract: {} as any, functions: [{ function_id: 'observe' }], entities: [] },
        ],
      } as any];
      materializeNodeUnderstandingContracts(cas);
      return cas;
    };
    const valid = build();
    const validProvenance = valid.flows![0].contract.facet_provenance!
      .find(entry => entry.facet === 'state_change' && entry.value === 'Order updated')!;
    expect(validProvenance.contributed_by_step_ids).toEqual(['step-handler', 'step-persist']);
    expect(validProvenance.contributed_by_node_ids).toEqual(['handler', 'persist']);
    expect(validateUnderstandingContractIntegrity(valid)).toEqual([]);

    const corruptions = [
      (entry: typeof validProvenance) => { entry.contributed_by_step_ids = ['step-handler']; },
      (entry: typeof validProvenance) => { entry.contributed_by_step_ids = ['step-handler', 'step-observe', 'step-persist']; },
      (entry: typeof validProvenance) => { entry.contributed_by_node_ids = ['handler']; },
      (entry: typeof validProvenance) => { entry.contributed_by_node_ids = ['handler', 'observe', 'persist']; },
      (entry: typeof validProvenance) => { entry.evidence = 'evidence from only one contributor'; },
    ];
    for (const corrupt of corruptions) {
      const cas = build();
      const provenance = cas.flows![0].contract.facet_provenance!
        .find(entry => entry.facet === 'state_change' && entry.value === 'Order updated')!;
      corrupt(provenance);
      expect(validateUnderstandingContractIntegrity(cas).map(issue => issue.code))
        .toContain('misattributed-facet-provenance');
    }
  });

  test('validates serialized contracts and independently reloaded recursive children', () => {
    const child = fixture();
    computeFlowConcepts(child);
    const reloadedChild = JSON.parse(JSON.stringify(child)) as CASOutput;
    expect(validateUnderstandingContractIntegrity(reloadedChild)).toEqual([]);

    const parent = fixture();
    computeFlowConcepts(parent);
    parent.children = [reloadedChild];
    const reloadedParent = JSON.parse(JSON.stringify(parent)) as CASOutput;
    expect(validateUnderstandingContractIntegrity(reloadedParent)).toEqual([]);
  });

  test('rejects omitted, reclassified, and structurally altered aggregate contracts', () => {
    const corruptions: Array<(cas: CASOutput) => void> = [
      cas => {
        const step = cas.flows![0].steps[0];
        const omitted = step.contract.input.shift();
        step.contract.facet_provenance = step.contract.facet_provenance?.filter(entry =>
          entry.facet !== 'input' || entry.value !== omitted);
      },
      cas => {
        const flow = cas.flows![0];
        const value = flow.contract.side_effects.state_changes[0];
        flow.contract.side_effects.state_changes = flow.contract.side_effects.state_changes.slice(1);
        flow.contract.side_effects.external_integrations.push(value);
        const provenance = flow.contract.facet_provenance?.find(entry =>
          entry.facet === 'state_change' && entry.value === value);
        if (provenance) provenance.facet = 'external_integration';
      },
      cas => {
        const step = cas.flows![0].steps[0];
        step.contract.constraints[0].kind = step.contract.constraints[0].kind === 'auth' ? 'validation' : 'auth';
      },
      cas => {
        const provenance = cas.flows![0].contract.facet_provenance![0];
        provenance.contributed_by_step_ids = [
          ...(provenance.contributed_by_step_ids || []),
          'step-extra',
        ];
      },
    ];
    for (const corrupt of corruptions) {
      const cas = aggregateLogicFixture();
      corrupt(cas);
      expect(validateUnderstandingContractIntegrity(cas).map(issue => issue.code))
        .toContain('deterministic-contract-mismatch');
    }
  });

});
