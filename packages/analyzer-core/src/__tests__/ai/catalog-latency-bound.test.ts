import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

// TASK #107: proves the capability-catalog AI call's latency-bound mechanism
// (awaitAiBoundedThenUncapped) under FORCED provider degradation, using an
// injected-delay stub in place of a real provider (no network, no product
// internals beyond the orchestrator method itself). Reaches the private
// method via a typed `any` handle, matching orchestrator-internals.test.ts.
//
// Two invariants under test, matching the task's completeness requirement:
//   1. BOUND: a call that would have stalled far past the bounded window
//      (simulating the measured 83.6s/215.8s live outliers, scaled down for
//      test speed) is abandoned in favor of a fresh attempt — wall clock for
//      the bounded phase never exceeds maxBoundedAttempts * perAttemptTimeoutMs
//      by more than scheduling slop.
//   2. COMPLETION: even when EVERY bounded attempt is cut off (full outage
//      simulation), the stage still returns the real value from the final
//      uncapped attempt — never throws, never substitutes a degraded/empty
//      result purely because of elapsed time.
const orch = new AnalyzerOrchestrator() as any;

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    (timer as NodeJS.Timeout).unref?.();
  }).then(() => value);
}

describe('awaitAiBoundedThenUncapped (task #107 capability-catalog latency bound)', () => {
  it('abandons a stalled attempt and succeeds on a fresh fast retry, well under the naive worst case', async () => {
    let calls = 0;
    const attemptFactory = async (attemptIndex: number) => {
      calls += 1;
      if (attemptIndex === 1) {
        // Simulates the measured degraded outlier (215.8s), scaled down: this
        // attempt would eventually resolve, but far outside the bound.
        return delay(2000, 'STALLED_ANSWER_TOO_LATE');
      }
      // A fresh connection resolves quickly, as the task's own hypothesis
      // predicts ("may well be answered in 15s on a second attempt").
      return delay(20, `FRESH_ANSWER_attempt_${attemptIndex}`);
    };

    const startedAt = Date.now();
    const result = await orch.awaitAiBoundedThenUncapped(attemptFactory, 'test-op', {
      perAttemptTimeoutMs: 150,
      maxBoundedAttempts: 3,
      slowWarnMs: 1000,
    });
    const elapsed = Date.now() - startedAt;

    expect(result).toBe('FRESH_ANSWER_attempt_2');
    // Bounded: abandoned attempt 1 at ~150ms, succeeded on attempt 2 quickly —
    // total should be a small multiple of perAttemptTimeoutMs, nowhere near
    // the 2000ms the stalled first attempt would have taken to resolve.
    expect(elapsed).toBeLessThan(600);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('NEVER abandons the stage entirely: when every bounded attempt is cut off, the final uncapped attempt still returns the real answer', async () => {
    let boundedCalls = 0;
    let finalCallStarted = false;
    const attemptFactory = async (attemptIndex: number) => {
      if (attemptIndex <= 3) {
        boundedCalls += 1;
        // Every bounded attempt stalls past its bound (full-outage simulation).
        return delay(500, `SHOULD_NEVER_WIN_${attemptIndex}`);
      }
      // The 4th call is the guaranteed final, uncapped attempt: it takes
      // longer than any single bounded window but must still be awaited to
      // completion and its real value returned — this is the completeness
      // invariant (never give up, never ship a synthetic/degraded result).
      finalCallStarted = true;
      return delay(120, 'REAL_FINAL_ANSWER');
    };

    const result = await orch.awaitAiBoundedThenUncapped(attemptFactory, 'test-op-outage', {
      perAttemptTimeoutMs: 40,
      maxBoundedAttempts: 3,
      slowWarnMs: 10000,
    });

    expect(boundedCalls).toBe(3);
    expect(finalCallStarted).toBe(true);
    // The real, provider-produced answer — never an empty/degraded substitute
    // introduced merely because the bounded phase ran out.
    expect(result).toBe('REAL_FINAL_ANSWER');
  });

  it('propagates a genuine synchronous provider error immediately rather than waiting out the per-attempt bound', async () => {
    const attemptFactory = async (attemptIndex: number) => {
      if (attemptIndex < 2) throw new Error('provider auth failed');
      return 'RECOVERED';
    };
    const startedAt = Date.now();
    const result = await orch.awaitAiBoundedThenUncapped(attemptFactory, 'test-op-error', {
      perAttemptTimeoutMs: 5000,
      maxBoundedAttempts: 3,
      slowWarnMs: 10000,
    });
    expect(result).toBe('RECOVERED');
    // A thrown error is not a timeout: retry happens immediately, not after
    // waiting out perAttemptTimeoutMs.
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});
