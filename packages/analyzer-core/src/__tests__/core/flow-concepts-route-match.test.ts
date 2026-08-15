// ---------------------------------------------------------------------------
// Route-match capability relationship evidence: a flow whose own PATH NODES
// carry real outbound API exit points (e.g. an Angular UI flow's per-call
// HttpClient extraction, angular-analyzer.ts) relates to a capability whose
// operation's declared trigger (method, path) matches — even though the flow
// never runs THROUGH that capability's handler node (it can't: the call
// crosses a real network boundary). Before this fix, a UI flow's only exit
// evidence was a single synthetic 'various' endpoint that could never match
// any real route, so deriveCapabilityRelationships (flow-concepts.ts) had no
// way to relate a frontend flow to the backend capability it actually calls.
// ---------------------------------------------------------------------------
import { computeFlowConcepts } from '../../analyzer/core/flow-concepts';
import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  SystemCapability,
} from '../../types/cas.types';

function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return { qualified_name: overrides.name, ...overrides } as CASNode;
}

/**
 * A single UI-flow fixture: one route entry point rooted at `n_ui`, whose
 * node carries one 'api' exit point calling (`callMethod`, `callPath`). One
 * capability, `cap_fuel`, declares an operation whose trigger is
 * (`opMethod`, `opPath`) — deliberately anchored on a DIFFERENT entry point
 * (`ep_fuel_backend`) than the flow's own root, and sharing NO related
 * entities, so only the route-match rule (never opMatch/interiorOp/entity
 * overlap) can produce a relationship.
 */
function buildRouteMatchCas(args: {
  callMethod: string;
  callPath: string;
  opMethod: string;
  opPath: string;
}): CASOutput {
  const { callMethod, callPath, opMethod, opPath } = args;

  const nodes: CASNode[] = [
    node({ id: 'n_ui', name: 'FuelStationsPage', type: 'component', category: 'entry' }),
  ];
  const edges: CASEdge[] = [];
  const entry_points: CASEntryPoint[] = [
    {
      id: 'ep_ui',
      source_node: 'n_ui',
      type: 'route',
      name: 'FuelStationsPage',
      handler: { node_id: 'n_ui', method_name: 'FuelStationsPage' },
    },
  ];
  const exit_points: CASExitPoint[] = [
    {
      id: 'exit_ui_api_call',
      source_node: 'n_ui',
      type: 'api',
      name: `${callMethod} ${callPath}`,
      target: { service_id: 'external-api', endpoint: callPath },
      operation: { action: 'read-write', method: callMethod, async: true },
    } as CASExitPoint,
  ];
  const capabilities: SystemCapability[] = [
    {
      id: 'cap_fuel',
      name: 'Fuel Management',
      description: 'Fuel station and card management',
      category: 'core',
      operations: [
        {
          entry_point_id: 'ep_fuel_backend',
          entry_point_type: 'http',
          action: 'listFuelStations',
          path_or_command: opPath,
          trigger: { method: opMethod, path: opPath },
        },
      ],
      related_entities: [],
      related_domains: [],
      criticality: 'medium',
      criticality_factors: [],
    },
    // A second, unrelated capability with no trigger at all, to confirm the
    // route-match rule never fires spuriously when there's nothing to match.
    {
      id: 'cap_unrelated',
      name: 'Unrelated Capability',
      description: 'No operations that could ever match',
      category: 'core',
      operations: [
        { entry_point_id: 'ep_other', entry_point_type: 'cli', action: 'doSomethingElse' },
      ],
      related_entities: [],
      related_domains: [],
      criticality: 'low',
      criticality_factors: [],
    },
  ];

  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test-route-match',
    system: { name: 'test-system' } as any,
    nodes,
    edges,
    entry_points,
    exit_points,
    data_lineage: [],
    entities: [],
    capabilities,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

function relationshipsFor(cas: CASOutput) {
  const flows = computeFlowConcepts(cas);
  const flow = flows.find(f => f.entry_point === 'ep_ui')!;
  expect(flow).toBeTruthy();
  return flow.capability_relationships || [];
}

describe('deriveCapabilityRelationships — route-match evidence', () => {
  it('POSITIVE: exact (method, path) match relates the flow as supporting, citing the route', () => {
    const cas = buildRouteMatchCas({
      callMethod: 'GET',
      callPath: '/api/web/fuel/stations',
      opMethod: 'GET',
      opPath: '/api/web/fuel/stations',
    });
    const rels = relationshipsFor(cas);
    const rel = rels.find(r => r.capability_id === 'cap_fuel');
    expect(rel).toBeTruthy();
    expect(rel!.role).toBe('supporting');
    expect(rel!.rationale).toContain('GET /api/web/fuel/stations');
    expect(rel!.rationale).toContain('listFuelStations');
  });

  it('POSITIVE: path-param-aware match — a concrete call segment matches a :param operation segment', () => {
    const cas = buildRouteMatchCas({
      callMethod: 'GET',
      callPath: '/api/web/fuel/42',
      opMethod: 'GET',
      opPath: '/api/web/fuel/:id',
    });
    const rels = relationshipsFor(cas);
    expect(rels.find(r => r.capability_id === 'cap_fuel')).toBeTruthy();
  });

  it('POSITIVE: base_ref suffix match — a shorter symbolic-base tail matches the operation\'s trailing segments', () => {
    // angular-analyzer.ts's per-call extraction, when the template literal's
    // base identifier can't be resolved to a same-file literal, keeps only
    // the tail ('/fuel/cards') rather than the full operation route
    // ('/api/web/fuel/cards') — the base prefix the call site couldn't see.
    const cas = buildRouteMatchCas({
      callMethod: 'GET',
      callPath: '/fuel/cards',
      opMethod: 'GET',
      opPath: '/api/web/fuel/cards',
    });
    const rels = relationshipsFor(cas);
    expect(rels.find(r => r.capability_id === 'cap_fuel')).toBeTruthy();
  });

  it('NEGATIVE: method mismatch never matches, even on an identical path', () => {
    const cas = buildRouteMatchCas({
      callMethod: 'GET',
      callPath: '/api/web/fuel/stations',
      opMethod: 'POST',
      opPath: '/api/web/fuel/stations',
    });
    const rels = relationshipsFor(cas);
    expect(rels.find(r => r.capability_id === 'cap_fuel')).toBeUndefined();
  });

  it('NEGATIVE: segment-count mismatch never matches — a route is not a prefix/suffix of an unrelated longer route', () => {
    const cas = buildRouteMatchCas({
      callMethod: 'GET',
      callPath: '/api/web/fuel/stations/nearby',
      opMethod: 'GET',
      opPath: '/api/web/fuel/stations',
    });
    const rels = relationshipsFor(cas);
    expect(rels.find(r => r.capability_id === 'cap_fuel')).toBeUndefined();
  });

  it('never relates via name similarity alone — an operation with no trigger at all is never matched', () => {
    const cas = buildRouteMatchCas({
      callMethod: 'GET',
      callPath: '/api/web/fuel/stations',
      opMethod: 'GET',
      opPath: '/api/web/fuel/stations',
    });
    const rels = relationshipsFor(cas);
    expect(rels.find(r => r.capability_id === 'cap_unrelated')).toBeUndefined();
  });
});
