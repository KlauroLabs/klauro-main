import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import type {
  CASCallChain,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASNode,
  CASOutput,
  SystemCapability,
} from '../../types/cas.types';

/**
 * REGRESSION (2026-07-21 fresh prod CAS): every AI-authored system capability
 * shipped with ZERO flow links while behavior_surfaces kept theirs. Mechanism:
 * on the deferred-AI path, deriveEntryPointContractAndCapability persists
 * related_flows onto the DETERMINISTIC capability objects at assembly time;
 * the background AI catalog pass then REPLACES the array contents
 * (systemCapabilities.splice in applyAIInterpretation) with fresh objects that
 * carry no related_flows, and nothing re-derived afterwards. The fix re-runs
 * the derivation inside the deferred-enrichment closure, after the catalog is
 * final. These tests pin the derivation semantics that fix relies on.
 */

const orch = new AnalyzerOrchestrator() as any;

function node(id: string, name: string, type: string): CASNode {
  return { id, name, qualified_name: name, type } as CASNode;
}

function buildCas(): {
  cas: CASOutput;
  entryPoints: CASEntryPoint[];
  systemCapabilities: SystemCapability[];
} {
  const nodes: CASNode[] = [
    node('n_handler', 'handleCreateOrder', 'controller'),
    node('n_save', 'saveOrder', 'function'),
  ];
  const edges: CASEdge[] = [
    { id: 'e1', source: 'n_handler', target: 'n_save', type: 'calls' },
  ];
  const entryPoints: CASEntryPoint[] = [
    {
      id: 'ep_createOrder',
      source_node: 'n_handler',
      type: 'http',
      name: 'createOrder',
      trigger: { method: 'POST', path: '/orders' },
      handler: { node_id: 'n_handler', method_name: 'handleCreateOrder' },
    },
  ];
  const exitPoints: CASExitPoint[] = [
    {
      id: 'xp_save',
      source_node: 'n_save',
      type: 'database',
      name: 'saveOrder',
      target: { resource: 'orders_table' },
    } as CASExitPoint,
  ];
  const systemCapabilities: SystemCapability[] = [
    {
      id: 'cap_orders_deterministic',
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
  const cas = {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test',
    nodes,
    edges,
    entry_points: entryPoints,
    exit_points: exitPoints,
    call_chains: [],
    data_lineage: [],
    entities: [],
    capabilities: systemCapabilities,
    behavior_surfaces: [],
    analyzer_contributions: [],
  } as unknown as CASOutput;
  return { cas, entryPoints, systemCapabilities };
}

function derive(cas: CASOutput, entryPoints: CASEntryPoint[]): CASEntryPoint[] {
  return orch.deriveEntryPointContractAndCapability(entryPoints, {
    nodes: cas.nodes,
    edges: cas.edges,
    entry_points: cas.entry_points,
    exit_points: cas.exit_points,
    call_chains: cas.call_chains,
    data_lineage: cas.data_lineage,
    capabilities: cas.capabilities,
    behavior_surfaces: cas.behavior_surfaces,
  });
}

describe('capability→flow link persistence across the deferred-AI catalog splice', () => {
  test('fixture derives at least one flow (flows must never be zero on a repo with entry points)', () => {
    const { cas } = buildCas();
    const flows = computeFlowConcepts(cas, {});
    expect(flows.length).toBeGreaterThan(0);
  });

  test('a capability with operation evidence gets non-empty related_flows persisted', () => {
    const { cas, entryPoints, systemCapabilities } = buildCas();
    derive(cas, entryPoints);
    expect(systemCapabilities[0].related_flows?.length).toBeGreaterThan(0);
  });

  test('re-deriving after an AI-catalog splice restores links onto the replacement objects', () => {
    const { cas, entryPoints, systemCapabilities } = buildCas();
    derive(cas, entryPoints);
    expect(systemCapabilities[0].related_flows?.length).toBeGreaterThan(0);

    // Simulate applyAIInterpretation's catalog replacement: same array, new
    // AI-authored object with operation evidence but no related_flows.
    const aiCap: SystemCapability = {
      id: 'cap_orders_ai',
      name: 'Manage Customer Orders',
      description: 'Lets operators create and track orders end to end',
      category: 'core',
      operations: [{ entry_point_id: 'ep_createOrder', entry_point_type: 'http', action: 'create' }],
      related_entities: ['Order'],
      related_domains: [],
      criticality: 'high',
      criticality_factors: [],
    };
    systemCapabilities.splice(0, systemCapabilities.length, aiCap);

    // The defect: after the splice the shipped catalog has no links at all.
    expect(aiCap.related_flows).toBeUndefined();

    // The fix (deferred-enrichment closure re-runs the derivation): links are
    // recomputed against the FINAL catalog and persist onto the AI objects.
    derive(cas, entryPoints);
    expect(aiCap.related_flows?.length).toBeGreaterThan(0);
    expect(aiCap.related_flows![0].flow_id).toBeTruthy();
  });
});

describe('stampChainCriticalityFromStructuralImportance', () => {
  function chain(id: string, epId: string | undefined, pathNodeIds: string[]): CASCallChain {
    return {
      id,
      chain_type: 'entry-to-exit',
      entry_point: { node_id: pathNodeIds[0], method_name: id, entry_point_id: epId },
      call_path: pathNodeIds.map((nodeId, index) => ({
        call_id: `${id}_${index}`,
        node_id: nodeId,
        method_name: nodeId,
        depth: index,
      })),
      characteristics: {
        total_calls: pathNodeIds.length - 1,
        max_depth: pathNodeIds.length - 1,
        has_external_calls: false,
        has_database_calls: false,
        has_async_calls: false,
        is_circular: false,
        is_recursive: false,
        complexity_score: 1,
      },
      risk_analysis: { risk_level: 'low', risk_factors: [] },
      criticality: 'low',
      criticality_factors: [],
    } as CASCallChain;
  }

  function importanceNodes(scoreById: Record<string, number>): CASNode[] {
    return Object.entries(scoreById).map(([id, score]) => ({
      ...node(id, id, 'function'),
      structural_importance: score,
    }));
  }

  const entryPoints: CASEntryPoint[] = [
    { id: 'ep_a', source_node: 'n_a', type: 'cli', name: 'a' },
    { id: 'ep_b', source_node: 'n_b', type: 'cli', name: 'b' },
    { id: 'ep_c', source_node: 'n_c', type: 'cli', name: 'c' },
    { id: 'ep_t', source_node: 'n_t', type: 'test', name: 't' },
    { id: 'ep_h', source_node: 'n_h', type: 'http', name: 'h' },
  ];

  test('criticality distribution is rank-based, not degenerate all-low, even with concentrated mass', () => {
    // Importance mass concentrated in one node — the real-graph shape where an
    // absolute threshold classifies everything low.
    const nodes = importanceNodes({ n_a: 0.9, n_b: 0.004, n_c: 0.003, n_t: 0.002, n_h: 0 });
    const chains = [
      chain('chain:ep_a', 'ep_a', ['n_a']),
      chain('chain:ep_b', 'ep_b', ['n_b']),
      chain('chain:ep_c', 'ep_c', ['n_c']),
      chain('chain:ep_t', 'ep_t', ['n_t']),
      chain('chain:ep_h', 'ep_h', ['n_h']),
    ];
    orch.stampChainCriticalityFromStructuralImportance(chains, nodes, entryPoints);

    const byId = new Map(chains.map(c => [c.id, c]));
    // Top-ranked mass is critical; the distribution has more than one tier.
    expect(byId.get('chain:ep_a')!.criticality).toBe('critical');
    const levels = new Set(chains.map(c => c.criticality));
    expect(levels.size).toBeGreaterThan(1);
    expect(chains.every(c => c.criticality === 'low')).toBe(false);
    // Test-entry chains never rise above low.
    expect(byId.get('chain:ep_t')!.criticality).toBe('low');
    // The legacy http floor survives: a zero-mass http chain stays medium.
    expect(byId.get('chain:ep_h')!.criticality).toBe('medium');
    // Provenance factor is recorded on ranked chains.
    expect(byId.get('chain:ep_a')!.criticality_factors).toContain('structural-importance-rank');
  });

  test('no-op on a CAS without the structural-importance layer', () => {
    const nodes = [node('n_a', 'n_a', 'function')];
    const chains = [chain('chain:ep_a', 'ep_a', ['n_a'])];
    chains[0].criticality = 'medium';
    orch.stampChainCriticalityFromStructuralImportance(chains, nodes, entryPoints);
    expect(chains[0].criticality).toBe('medium');
    expect(chains[0].criticality_factors).not.toContain('structural-importance-rank');
  });

  test('deterministic: same inputs produce identical assignments across runs', () => {
    const build = () => {
      const nodes = importanceNodes({ n_a: 0.5, n_b: 0.5, n_c: 0.1 });
      const chains = [
        chain('chain:ep_b', 'ep_b', ['n_b']),
        chain('chain:ep_a', 'ep_a', ['n_a']),
        chain('chain:ep_c', 'ep_c', ['n_c']),
      ];
      orch.stampChainCriticalityFromStructuralImportance(chains, nodes, entryPoints);
      return chains.map(c => `${c.id}=${c.criticality}`).sort();
    };
    expect(build()).toEqual(build());
  });
});
