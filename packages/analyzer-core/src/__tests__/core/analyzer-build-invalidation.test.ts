import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { getBuildIdentity } from '../../analyzer/core/build-identity';
import { getStageFingerprints } from '../../analyzer/core/stage-fingerprint';
import { CAS_VERSION, type CASOutput } from '../../types/cas.types';

/**
 * Guards the analyzer-build cache-invalidation contract added for task #99 and
 * narrowed to STAGE FINGERPRINTS for the cross-version-cache fix: incremental
 * analysis must force a full rebuild of derived artifacts when the
 * parser-layer or derived-layer fingerprint changes, not only when target
 * files change — otherwise an engine/deriver fix is masked by cached derived
 * layers on unchanged files. But a whole-build version bump that touches
 * NEITHER layer (an MCP-tool-only or WAS-only release) must NOT force a full
 * rebuild — that was the live-incident bug (every deploy => cold whale
 * rebuild for every project) this scheme fixes.
 *
 * The decision lives in the private `fullRebuildReasonForPreviousOutput`, which
 * `orchestrateIncrementalAnalysis` consults before taking the fast path. We
 * exercise that gate directly so the test is deterministic and does not need a
 * full project analysis run.
 */
function fullRebuildReason(orch: AnalyzerOrchestrator, previousOutput: CASOutput): string | null {
  // Private method — access by bracket notation to test the decision in isolation.
  return (orch as unknown as {
    fullRebuildReasonForPreviousOutput(o: CASOutput): string | null;
  }).fullRebuildReasonForPreviousOutput(previousOutput);
}

/**
 * A previous output that passes every OTHER full-rebuild trigger (cas_version,
 * validation, call chains, analysis facts, description) AND carries the
 * CURRENT stage fingerprints, so the only variable under test is whatever the
 * caller overrides (analyzer_build / parser_fingerprint / derived_fingerprint).
 */
function healthyPreviousOutput(overrides: Partial<CASOutput> = {}): CASOutput {
  const fingerprints = getStageFingerprints();
  return {
    cas_version: CAS_VERSION,
    analyzer_build: getBuildIdentity().version,
    parser_fingerprint: fingerprints.parser_fingerprint,
    derived_fingerprint: fingerprints.derived_fingerprint,
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test-analysis',
    system: { id: 'system_test', name: 'test' } as CASOutput['system'],
    nodes: [],
    edges: [],
    entry_points: [],
    analyzer_contributions: [],
    analysis_facts: [{ id: 'fact-1' }] as unknown as CASOutput['analysis_facts'],
    call_chains: [],
    validation: { graph_integrity: {} } as unknown as CASOutput['validation'],
    ...overrides,
  } as CASOutput;
}

describe('stage-fingerprint incremental invalidation', () => {
  it('takes the fast path (no rebuild) when build + stage fingerprints match and files/schema are unchanged', () => {
    const orch = new AnalyzerOrchestrator();
    const previous = healthyPreviousOutput();

    const reason = fullRebuildReason(orch, previous);

    expect(reason).toBeNull();
  });

  it('does NOT force a full rebuild when analyzer_build differs but both stage fingerprints match (MCP-tool/WAS-only release)', () => {
    const orch = new AnalyzerOrchestrator();
    // Simulate the exact live incident: the whole-monorepo build stamp moved
    // (a release happened) but neither the parser nor the derived layer's
    // source files changed — the persisted derived artifacts are still valid.
    const previous = healthyPreviousOutput({ analyzer_build: 'stale-0.0.1+deadbeef' });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).toBeNull();
  });

  it('forces a full rebuild when the parser-layer fingerprint differs', () => {
    const orch = new AnalyzerOrchestrator();
    const previous = healthyPreviousOutput({ parser_fingerprint: 'stale-parser-fp' });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).not.toBeNull();
    expect(reason).toContain('Parser-layer fingerprint changed');
    expect(reason).toContain('stale-parser-fp');
  });

  it('forces a full rebuild when the derived-layer fingerprint differs (parser layer unchanged)', () => {
    const orch = new AnalyzerOrchestrator();
    const previous = healthyPreviousOutput({ derived_fingerprint: 'stale-derived-fp' });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).not.toBeNull();
    expect(reason).toContain('Derived-layer fingerprint changed');
    expect(reason).toContain('stale-derived-fp');
  });

  it('forces a full rebuild for legacy analyses with no persisted stage fingerprints (never reuse on ambiguity)', () => {
    const orch = new AnalyzerOrchestrator();
    const previous = healthyPreviousOutput({
      analyzer_build: 'stale-0.0.1+deadbeef',
      parser_fingerprint: undefined,
      derived_fingerprint: undefined,
    });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).not.toBeNull();
    expect(reason).toContain('Analyzer build changed');
    expect(reason).toContain('no stage fingerprints on persisted output');
  });

  it('forces a full rebuild for legacy analyses that were never stamped at all (undefined -> current)', () => {
    const orch = new AnalyzerOrchestrator();
    const previous = healthyPreviousOutput({
      analyzer_build: undefined,
      parser_fingerprint: undefined,
      derived_fingerprint: undefined,
    });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).not.toBeNull();
    expect(reason).toContain('Analyzer build changed');
    expect(reason).toContain('unstamped');
  });

  it('prioritizes the parser-fingerprint trigger over other rebuild reasons', () => {
    const orch = new AnalyzerOrchestrator();
    // Both the parser fingerprint AND the cas_version differ; the fingerprint
    // reason must win because it is checked first.
    const previous = healthyPreviousOutput({
      parser_fingerprint: 'stale-parser-fp',
      cas_version: '0.0.0',
    });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).toContain('Parser-layer fingerprint changed');
  });

  it('does not fire the fingerprint trigger for matching fingerprints (isolates it from other triggers)', () => {
    const orch = new AnalyzerOrchestrator();
    // Matching stage fingerprints, but cas_version drifted — a DIFFERENT
    // trigger must fire, proving the fingerprint check does not over-rebuild
    // on match.
    const previous = healthyPreviousOutput({ cas_version: '0.0.0' });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).not.toBeNull();
    expect(reason).not.toContain('fingerprint changed');
    expect(reason).toContain('CAS version changed');
  });
});
