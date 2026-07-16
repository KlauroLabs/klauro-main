import { CASEntryPoint, SystemCapability } from '../../types/cas.types';
import type { FlowConcept } from '../../analyzer/core/flow-concepts';

// ANALYSIS-TIME WIRING (not the pure-function unit tests in
// entry-point-enrichment.test.ts, which cover attachFlowContract/
// attachCapability in isolation): this proves the orchestrator's private
// `deriveEntryPointContractAndCapability` correctly (a) derives flows via
// computeFlowConcepts, (b) INVERTS each flow's capability_relationships
// (capability -> flow, role on the edge) into the CapabilityLike[] shape
// attachCapability expects, and (c) applies both enrichment joins onto the
// real entry_points array so contract/capability land on the persisted CAS.
// computeFlowConcepts itself is mocked here — its own derivation is covered
// by flow-concepts' own test suite; this test's job is the NEW glue code.
jest.mock('../../analyzer/core/flow-concepts', () => {
  const actual = jest.requireActual('../../analyzer/core/flow-concepts');
  return {
    ...actual,
    computeFlowConcepts: jest.fn(),
  };
});

import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

const mockedComputeFlowConcepts = computeFlowConcepts as jest.MockedFunction<typeof computeFlowConcepts>;

// Private-method access, same pattern as ai/orchestrator-internals.test.ts.
const orch = new AnalyzerOrchestrator() as any;

function entryPoint(id: string): CASEntryPoint {
  return {
    id,
    source_node: `node_${id}`,
    type: 'http',
    name: `handler_${id}`,
    handler: { node_id: `node_${id}`, method_name: `handle_${id}` },
  } as CASEntryPoint;
}

describe('orchestrator: analysis-time entry-point contract+capability enrichment', () => {
  afterEach(() => {
    mockedComputeFlowConcepts.mockReset();
  });

  it('attaches input/output contract derived from the flow, joined by entry_point id', () => {
    const ep = entryPoint('ep_1');
    const flow: FlowConcept = {
      flow_id: 'flow_1',
      name: 'Create Order',
      intent: 'Create Order',
      entry_point: 'ep_1',
      entities: [],
      contract: {
        input: ['orderId: string'],
        logic: 'creates an order',
        side_effects: { state_changes: [], external_integrations: [] },
        output: ['Order'],
        constraints: [],
      },
      steps: [],
    };
    mockedComputeFlowConcepts.mockReturnValue([flow]);

    const result: CASEntryPoint[] = orch.deriveEntryPointContractAndCapability([ep], {
      nodes: [],
      edges: [],
      entry_points: [ep],
      exit_points: [],
      call_chains: [],
      data_lineage: [],
      system_capabilities: [],
      behavior_surfaces: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].input).toEqual({
      fields: [{ name: 'orderId', type: 'string' }],
      is_positional_only: false,
    });
    expect(result[0].output).toEqual({ type: 'Order', is_named_type: true, is_void: false });
  });

  it('inverts flow.capability_relationships (capability -> flow/role) into capabilities on the entry point', () => {
    const ep = entryPoint('ep_2');
    const flow: FlowConcept = {
      flow_id: 'flow_2',
      name: 'Cancel Order',
      intent: 'Cancel Order',
      entry_point: 'ep_2',
      entities: [],
      contract: {
        input: [],
        logic: 'cancels an order',
        side_effects: { state_changes: [], external_integrations: [] },
        output: [],
        constraints: [],
      },
      capability_relationships: [
        { capability_id: 'cap_orders', role: 'primary', rationale: 'operation ref' },
        { capability_id: 'cap_notifications', role: 'observability', rationale: 'telemetry exits' },
      ],
      steps: [],
    };
    mockedComputeFlowConcepts.mockReturnValue([flow]);

    const capabilities: SystemCapability[] = [
      { id: 'cap_orders', name: 'Manage Orders' } as SystemCapability,
      { id: 'cap_notifications', name: 'Notifications' } as SystemCapability,
    ];

    const result: CASEntryPoint[] = orch.deriveEntryPointContractAndCapability([ep], {
      nodes: [],
      edges: [],
      entry_points: [ep],
      exit_points: [],
      call_chains: [],
      data_lineage: [],
      system_capabilities: capabilities,
      behavior_surfaces: [],
    });

    expect(result[0].capabilities).toEqual(
      expect.arrayContaining([
        { capability_id: 'cap_orders', capability_name: 'Manage Orders', role: 'primary' },
        { capability_id: 'cap_notifications', capability_name: 'Notifications', role: 'observability' },
      ])
    );
    expect(result[0].capabilities).toHaveLength(2);
  });

  it('is evidence-gated: leaves entry points untouched when no flows are derivable', () => {
    const ep = entryPoint('ep_3');
    mockedComputeFlowConcepts.mockReturnValue([]);

    const result: CASEntryPoint[] = orch.deriveEntryPointContractAndCapability([ep], {
      nodes: [],
      edges: [],
      entry_points: [ep],
      exit_points: [],
      call_chains: [],
      data_lineage: [],
      system_capabilities: [],
      behavior_surfaces: [],
    });

    expect(result).toEqual([ep]);
    expect(result[0].input).toBeUndefined();
    expect(result[0].capabilities).toBeUndefined();
  });

  it('never throws and falls back to the original entry points when derivation errors', () => {
    const ep = entryPoint('ep_4');
    mockedComputeFlowConcepts.mockImplementation(() => {
      throw new Error('boom');
    });

    const result: CASEntryPoint[] = orch.deriveEntryPointContractAndCapability([ep], {
      nodes: [],
      edges: [],
      entry_points: [ep],
      exit_points: [],
      call_chains: [],
      data_lineage: [],
      system_capabilities: [],
      behavior_surfaces: [],
    });

    expect(result).toEqual([ep]);
  });
});
