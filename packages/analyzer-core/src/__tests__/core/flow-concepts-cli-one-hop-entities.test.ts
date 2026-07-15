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
 * CLI one-hop entity association (see flow-concepts.ts makeCliOneHopEntities):
 * a console-command handler routinely delegates persistence one call away
 * (live truckspy shape: an ElectronicLoggingDeviceController-adjacent CLI
 * command -> a DataTransferManager -> persist(FMCSADataTransfer)) through a
 * 'delegates_to' or 'queries' edge — types traceForwardChain does NOT
 * traverse (TRAVERSABLE_EDGE_TYPES is calls, invokes, any type containing
 * "call", renders, uses — only)
 * — so the writer node never lands in the flow's own traced node set and
 * entitiesForNodes sees no touching node.
 *
 * Two CAS shapes exercise both flow-construction paths that call
 * entitiesForNodes:
 *   - ep_cli_dead_end (cli, no exit chain) -> computeEntryPointFlows path
 *   - chain_cli_terminal (cli, entry-to-exit chain whose call_path records
 *     ONLY the handler node) -> buildTerminalFlows path
 * A THIRD entry point (ep_http_dead_end, same delegates_to shape but type
 * 'http') proves the supplement is CLI-scoped — an HTTP flow with the
 * identical delegation shape stays entity-less, by design (no per-flow
 * document-frequency ubiquity guard exists at the flow layer, unlike the
 * capability-building one-hop pass, so widening past cli would risk smearing
 * entities across unrelated HTTP flows).
 */
function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

function buildCliOneHopCas(): CASOutput {
  const nodes: CASNode[] = [
    node({ id: 'n_cli_handler', name: 'TransferDataCommand.execute', type: 'command', category: 'entry' }),
    node({ id: 'n_data_transfer_manager', name: 'DataTransferManager.persist', type: 'function', category: 'data' }),
    node({ id: 'n_cli_terminal_handler', name: 'BuildDataFileCommand.execute', type: 'command', category: 'entry' }),
    node({ id: 'n_data_transfer_manager_2', name: 'DataTransferManager.persistFile', type: 'function', category: 'data' }),
    node({ id: 'n_http_handler', name: 'FmcsaController.transfer', type: 'controller', category: 'entry' }),
    node({ id: 'n_data_transfer_manager_3', name: 'DataTransferManager.persistHttp', type: 'function', category: 'data' }),
  ];
  const edges: CASEdge[] = [
    // delegates_to — NOT in TRAVERSABLE_EDGE_TYPES, so the dead-end chain's
    // traceForwardChain never reaches n_data_transfer_manager.
    { id: 'e1', source: 'n_cli_handler', target: 'n_data_transfer_manager', type: 'delegates_to' },
    { id: 'e2', source: 'n_cli_terminal_handler', target: 'n_data_transfer_manager_2', type: 'queries' },
    { id: 'e3', source: 'n_http_handler', target: 'n_data_transfer_manager_3', type: 'delegates_to' },
  ];
  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_cli_dead_end', source_node: 'n_cli_handler', type: 'cli', name: 'eld:fmcsa:transfer',
      trigger: { pattern: 'eld:fmcsa:transfer' },
      handler: { node_id: 'n_cli_handler', method_name: 'execute' },
      security: { authenticated: true },
    },
    {
      id: 'ep_cli_terminal', source_node: 'n_cli_terminal_handler', type: 'cli', name: 'eld:fmcsa:buildDataFile',
      trigger: { pattern: 'eld:fmcsa:buildDataFile' },
      handler: { node_id: 'n_cli_terminal_handler', method_name: 'execute' },
    },
    {
      id: 'ep_http_dead_end', source_node: 'n_http_handler', type: 'http', name: 'transfer',
      trigger: { method: 'POST', path: '/api/eld/fmcsa/transfer' },
      handler: { node_id: 'n_http_handler', method_name: 'transfer' },
      security: { authenticated: true },
    },
  ];
  const exit_points: CASExitPoint[] = [
    {
      id: 'xp_db', source_node: 'n_data_transfer_manager_2', type: 'database', name: 'persistFile',
      target: { resource: 'fmcsa_transfers_table' },
    } as CASExitPoint,
  ];
  const data_lineage: CASEntityLineage[] = [
    {
      entity_id: 'entity_fmcsa_data_transfer', entity_name: 'FMCSADataTransfer', sensitive_fields: [],
      writers: [{ node_id: 'n_data_transfer_manager' } as any], readers: [],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
    {
      entity_id: 'entity_fmcsa_data_transfer', entity_name: 'FMCSADataTransfer', sensitive_fields: [],
      writers: [{ node_id: 'n_data_transfer_manager_2' } as any], readers: [],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
    {
      entity_id: 'entity_fmcsa_data_transfer', entity_name: 'FMCSADataTransfer', sensitive_fields: [],
      writers: [{ node_id: 'n_data_transfer_manager_3' } as any], readers: [],
      external_recipients: [], boundaries_crossed: [], journeys_carrying: [],
      exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
    },
  ];
  const call_chains: CASCallChain[] = [
    {
      id: 'chain_cli_terminal',
      chain_type: 'entry-to-exit',
      entry_point: { node_id: 'n_cli_terminal_handler', method_name: 'execute', entry_point_id: 'ep_cli_terminal' },
      exit_point: { node_id: 'n_data_transfer_manager_2', method_name: 'persistFile', exit_point_id: 'xp_db' },
      // Deliberately records ONLY the handler node — the queries-delegated
      // writer (n_data_transfer_manager_2) is missing from the recorded path,
      // exercising the CLI one-hop supplement (not the entry-family rollup,
      // which only fires for the dead-end/entry-point-rooted shape).
      call_path: [
        { call_id: 'c1', node_id: 'n_cli_terminal_handler', method_name: 'execute', depth: 0 },
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
      id: 'cap_eld', name: 'ELD FMCSA Transfer', category: 'core', criticality: 'high',
      related_entities: ['FMCSADataTransfer'],
      operations: [],
    } as any,
  ];

  return {
    analysis_id: 'test-cli-one-hop',
    nodes, edges, entry_points, exit_points, data_lineage, call_chains, system_capabilities,
  } as unknown as CASOutput;
}

describe('computeFlowConcepts — CLI one-hop entity association', () => {
  const cas = buildCliOneHopCas();
  const flows = computeFlowConcepts(cas);

  test('a dead-end CLI flow picks up the entity its handler delegates to one hop away (delegates_to)', () => {
    const flow = flows.find(f => f.entry_point === 'ep_cli_dead_end');
    expect(flow).toBeDefined();
    expect(flow!.entities).toContain('FMCSADataTransfer');
  });

  test('a terminal-chain CLI flow whose recorded path misses the writer still picks it up (queries)', () => {
    const flow = flows.find(f => f.flow_id === 'flow::chain_cli_terminal');
    expect(flow).toBeDefined();
    expect(flow!.entities).toContain('FMCSADataTransfer');
  });

  test('the one-hop supplement is CLI-scoped: an HTTP flow with the identical delegation shape stays entity-less', () => {
    const flow = flows.find(f => f.entry_point === 'ep_http_dead_end');
    expect(flow).toBeDefined();
    expect(flow!.entities).not.toContain('FMCSADataTransfer');
  });

  test('the recovered entity is real evidence, not a guess: it flows through to capability_relationships via entity overlap', () => {
    const flow = flows.find(f => f.entry_point === 'ep_cli_dead_end')!;
    const rel = flow.capability_relationships?.find(r => r.capability_id === 'cap_eld');
    expect(rel).toBeDefined();
    expect(rel!.role).toBe('supporting');
    expect(rel!.rationale).toContain('FMCSADataTransfer');
  });
});
