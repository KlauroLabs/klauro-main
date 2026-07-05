import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { ENTRY_POINT_TYPES, CASEntryPoint, CASContribution } from '../../types/cas.types';

/**
 * Parity guard: the CASEntryPoint['type'] union (ENTRY_POINT_TYPES, the single
 * source of truth) and the orchestrator's isValidEntryPoint() allowlist must not
 * drift. Historically isValidEntryPoint() kept a HARDCODED, separate allowlist —
 * adding a new entry-point kind to the union silently dropped it from output
 * (bit type-data ML and cat-api), and the allowlist accumulated dead entries
 * ('grpc'/'graphql') no analyzer emits (the gRPC analyzer emits 'rpc').
 *
 * These tests fail loudly if anyone reintroduces that drift.
 */

const orch = new AnalyzerOrchestrator() as any;

function makeEntryPoint(type: CASEntryPoint['type'], id: string): CASEntryPoint {
  return {
    id,
    source_node: `node_${id}`,
    type,
    name: `entry-${id}`,
  };
}

describe('entry-point type parity', () => {
  it('every ENTRY_POINT_TYPES member is accepted by isValidEntryPoint', () => {
    for (const type of ENTRY_POINT_TYPES) {
      const ep = makeEntryPoint(type, `ep_${type}`);
      expect({ type, accepted: orch.isValidEntryPoint(ep) }).toEqual({ type, accepted: true });
    }
  });

  it('rejects a type that is not in the source-of-truth array', () => {
    // 'grpc'/'graphql' were dead allowlist entries; no analyzer emits them
    // (gRPC handlers are emitted as 'rpc'). They must NOT be accepted.
    for (const bogus of ['grpc', 'graphql', 'totally-made-up']) {
      const ep = makeEntryPoint(bogus as CASEntryPoint['type'], `ep_${bogus}`);
      expect({ bogus, accepted: orch.isValidEntryPoint(ep) }).toEqual({ bogus, accepted: false });
    }
  });

  it('representative emitted entry-point kinds round-trip through the merge without being dropped', () => {
    // A cross-section of the union, including the newer data/ML, embedded, and
    // desktop-app kinds that a drifted allowlist would silently swallow.
    const kinds: CASEntryPoint['type'][] = [
      'http', 'cli', 'websocket', 'message', 'event', 'schedule',
      'page', 'route', 'lifecycle', 'test', 'api', 'file',
      'task', 'pipeline', 'notebook-cell', 'train',
      'interrupt', 'driver', 'ipc', 'command', 'rpc',
    ];

    const source: CASContribution = {
      entry_points: kinds.map((k, i) => makeEntryPoint(k, `ep_${k}_${i}`)),
      analyzer_metadata: { analyzer_id: 'parity-test', analyzer_name: 'parity-test', contribution_type: 'framework' },
    };

    const target = { allNodes: [], allEdges: [], allEntryPoints: [], allExitPoints: [] };
    orch.mergeAnalysisResult(target, source, { analyzerId: 'parity-test' });

    const survivingTypes = new Set((target.allEntryPoints as CASEntryPoint[]).map(ep => ep.type));
    for (const k of kinds) {
      expect({ kind: k, survived: survivingTypes.has(k) }).toEqual({ kind: k, survived: true });
    }
    expect(target.allEntryPoints.length).toBe(kinds.length);
  });

  it('has no duplicate members in ENTRY_POINT_TYPES', () => {
    expect(new Set(ENTRY_POINT_TYPES).size).toBe(ENTRY_POINT_TYPES.length);
  });
});
