import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { EXIT_POINT_TYPES, CASExitPoint, CASContribution } from '../../types/cas.types';

/**
 * Parity guard: the CASExitPoint['type'] union (EXIT_POINT_TYPES, the single
 * source of truth) and the orchestrator's isValidExitPoint() allowlist must not
 * drift. Historically isValidExitPoint() kept a HARDCODED, separate allowlist —
 * it REJECTED 'event' (a real union member, so event exit points were silently
 * dropped) while carrying dead kinds
 * ('http'/'grpc'/'graphql'/'queue'/'email'/'sms'/'external_api') no analyzer
 * emits (every exit point flows through createExitPoint(), whose type is
 * compile-locked to the union; the only `as CASExitPoint` casts emit 'sdk').
 *
 * These tests fail loudly if anyone reintroduces that drift.
 */

const orch = new AnalyzerOrchestrator() as any;

function makeExitPoint(type: CASExitPoint['type'], id: string): CASExitPoint {
  return {
    id,
    source_node: `node_${id}`,
    type,
    name: `exit-${id}`,
    // target a clearly-external sdk so the noise filter never fires for 'sdk';
    // every other kind is accepted on type membership alone.
    target: { sdk: 'stripe', endpoint: 'https://api.stripe.com' },
  };
}

describe('exit-point type parity', () => {
  it('every EXIT_POINT_TYPES member is accepted by isValidExitPoint', () => {
    for (const type of EXIT_POINT_TYPES) {
      const ep = makeExitPoint(type, `ep_${type}`);
      expect({ type, accepted: orch.isValidExitPoint(ep) }).toEqual({ type, accepted: true });
    }
  });

  it('rejects a type that is not in the source-of-truth array', () => {
    // 'http'/'grpc'/'graphql'/'queue'/'email'/'sms'/'external_api' were dead
    // allowlist entries; no analyzer emits them (outbound HTTP calls surface as
    // 'api', messaging as 'message'). They must NOT be accepted.
    for (const bogus of ['http', 'grpc', 'graphql', 'queue', 'email', 'sms', 'external_api', 'totally-made-up']) {
      const ep = makeExitPoint(bogus as CASExitPoint['type'], `ep_${bogus}`);
      expect({ bogus, accepted: orch.isValidExitPoint(ep) }).toEqual({ bogus, accepted: false });
    }
  });

  it('representative emitted exit-point kinds round-trip through the merge without being dropped', () => {
    // The full union, including 'event' — the kind the drifted allowlist used to
    // silently swallow — plus the types real analyzers emit today (api, sdk,
    // message, cache, database, verified against ~/dev bench runs).
    const kinds: CASExitPoint['type'][] = [
      'database', 'api', 'file', 'message', 'event', 'cache', 'sdk',
      'webhook', 'navigation', 'client_storage', 'analytics',
    ];

    const source: CASContribution = {
      exit_points: kinds.map((k, i) => makeExitPoint(k, `ep_${k}_${i}`)),
      analyzer_metadata: { analyzer_id: 'parity-test', analyzer_name: 'parity-test', contribution_type: 'framework' },
    };

    const target = { allNodes: [], allEdges: [], allEntryPoints: [], allExitPoints: [] };
    orch.mergeAnalysisResult(target, source, { analyzerId: 'parity-test' });

    const survivingTypes = new Set((target.allExitPoints as CASExitPoint[]).map(ep => ep.type));
    for (const k of kinds) {
      expect({ kind: k, survived: survivingTypes.has(k) }).toEqual({ kind: k, survived: true });
    }
    expect(target.allExitPoints.length).toBe(kinds.length);
  });

  it('has no duplicate members in EXIT_POINT_TYPES', () => {
    expect(new Set(EXIT_POINT_TYPES).size).toBe(EXIT_POINT_TYPES.length);
  });
});
