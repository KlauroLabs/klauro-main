import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { getBuildIdentity } from '../../analyzer/core/build-identity';
import { CAS_VERSION, type CASOutput } from '../../types/cas.types';

/**
 * Guards the analyzer-build cache-invalidation contract added for task #99:
 * incremental analysis must force a full rebuild of derived artifacts when the
 * ANALYZER build/version changes, not only when target files change — otherwise
 * an engine/deriver fix is masked by cached derived layers on unchanged files.
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
 * validation, call chains, analysis facts, description) so the only variable
 * under test is the analyzer_build stamp.
 */
function healthyPreviousOutput(overrides: Partial<CASOutput> = {}): CASOutput {
  return {
    cas_version: CAS_VERSION,
    analyzer_build: getBuildIdentity().version,
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

describe('analyzer-build incremental invalidation', () => {
  it('takes the fast path (no rebuild) when the analyzer build matches and files/schema are unchanged', () => {
    const orch = new AnalyzerOrchestrator();
    const previous = healthyPreviousOutput();

    const reason = fullRebuildReason(orch, previous);

    expect(reason).toBeNull();
  });

  it('forces a full rebuild when the stored analyzer build differs from the current build', () => {
    const orch = new AnalyzerOrchestrator();
    // Simulate an analyzer-version bump: the persisted output was produced by an
    // OLDER analyzer build. Files are unchanged, but the engine changed.
    const previous = healthyPreviousOutput({ analyzer_build: 'stale-0.0.1+deadbeef' });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).not.toBeNull();
    expect(reason).toContain('Analyzer build changed');
    expect(reason).toContain('stale-0.0.1+deadbeef');
    expect(reason).toContain(getBuildIdentity().version);
  });

  it('forces a full rebuild for legacy analyses that were never stamped (undefined -> current)', () => {
    const orch = new AnalyzerOrchestrator();
    const previous = healthyPreviousOutput({ analyzer_build: undefined });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).not.toBeNull();
    expect(reason).toContain('Analyzer build changed');
    expect(reason).toContain('unstamped');
  });

  it('prioritizes the analyzer-build trigger over other rebuild reasons', () => {
    const orch = new AnalyzerOrchestrator();
    // Both the analyzer build AND the cas_version differ; the analyzer-build
    // reason must win because it is checked first.
    const previous = healthyPreviousOutput({
      analyzer_build: 'stale-0.0.1+deadbeef',
      cas_version: '0.0.0',
    });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).toContain('Analyzer build changed');
  });

  it('does not fire the analyzer-build trigger for a matching build (isolates it from other triggers)', () => {
    const orch = new AnalyzerOrchestrator();
    // Matching analyzer build, but cas_version drifted — a DIFFERENT trigger must
    // fire, proving the analyzer-build check does not over-rebuild on match.
    const previous = healthyPreviousOutput({ cas_version: '0.0.0' });

    const reason = fullRebuildReason(orch, previous);

    expect(reason).not.toBeNull();
    expect(reason).not.toContain('Analyzer build changed');
    expect(reason).toContain('CAS version changed');
  });
});
