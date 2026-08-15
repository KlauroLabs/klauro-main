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

  it('aborts each timed-out attempt before starting the next one', async () => {
    let active = 0;
    let peakActive = 0;
    let aborted = 0;
    const attemptFactory = (attemptIndex: number, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      if (attemptIndex === 2) {
        active -= 1;
        resolve('RECOVERED');
        return;
      }
      signal?.addEventListener('abort', () => {
        aborted += 1;
        active -= 1;
        reject(signal.reason);
      }, { once: true });
    });

    const result = await orch.awaitAiBoundedThenUncapped(attemptFactory, 'test-op-abort', {
      perAttemptTimeoutMs: 20,
      maxBoundedAttempts: 3,
      slowWarnMs: 1000,
    });

    expect(result).toBe('RECOVERED');
    expect(aborted).toBe(1);
    expect(active).toBe(0);
    expect(peakActive).toBe(1);
  });

  // TASK #107 HARD CUTOFF: the three tests above prove the pre-existing
  // completeness invariant is untouched. These prove the NEW hard-deadline
  // gate added on top of it, in both directions per the task's own
  // requirement: it must fire (and degrade honestly, not silently) under a
  // slow/degraded path, and it must NOT fire — behavior must be byte-for-byte
  // the old completeness-guaranteeing behavior — on a healthy run that never
  // approaches the deadline.

  it('does NOT fire on a healthy run: with a hardDeadlineAt far in the future, behavior is unchanged (completes normally)', async () => {
    let calls = 0;
    const attemptFactory = async (attemptIndex: number) => {
      calls += 1;
      return delay(10, `OK_${attemptIndex}`);
    };
    const result = await orch.awaitAiBoundedThenUncapped(attemptFactory, 'test-op-healthy', {
      perAttemptTimeoutMs: 5000,
      maxBoundedAttempts: 3,
      slowWarnMs: 10000,
      hardDeadlineAt: Date.now() + 60_000,
    });
    expect(result).toBe('OK_1');
    expect(calls).toBe(1);
  });

  it('does NOT fire on a healthy run that legitimately needs the guaranteed-completion final attempt, as long as it starts before the deadline', async () => {
    let boundedCalls = 0;
    const attemptFactory = async (attemptIndex: number) => {
      if (attemptIndex <= 3) {
        boundedCalls += 1;
        return delay(200, `SHOULD_NEVER_WIN_${attemptIndex}`);
      }
      return delay(20, 'REAL_FINAL_ANSWER_WITHIN_DEADLINE');
    };
    const result = await orch.awaitAiBoundedThenUncapped(attemptFactory, 'test-op-healthy-final', {
      perAttemptTimeoutMs: 40,
      maxBoundedAttempts: 3,
      slowWarnMs: 10000,
      // Bounded phase costs ~3*40ms = 120ms; deadline is comfortably after
      // that, so the completeness-guaranteeing final attempt must still run.
      hardDeadlineAt: Date.now() + 5000,
    });
    expect(boundedCalls).toBe(3);
    expect(result).toBe('REAL_FINAL_ANSWER_WITHIN_DEADLINE');
  });

  it('FIRES when the hard deadline has already passed before the first attempt: abandons immediately, never starts an attempt, degrades honestly (distinguishable error, not a silent empty/truncated result)', async () => {
    let attemptsStarted = 0;
    const attemptFactory = async () => {
      attemptsStarted += 1;
      return delay(10, 'SHOULD_NEVER_RUN');
    };
    await expect(orch.awaitAiBoundedThenUncapped(attemptFactory, 'test-op-expired', {
      perAttemptTimeoutMs: 1000,
      maxBoundedAttempts: 3,
      slowWarnMs: 10000,
      hardDeadlineAt: Date.now() - 1,
    })).rejects.toThrow('ai-catalog-hard-deadline-exceeded');
    expect(attemptsStarted).toBe(0);
  });

  it('FIRES mid-flight: once the deadline passes during the bounded phase, no further attempts start — including the would-be-guaranteed final attempt — and the abandonment is reported via a distinguishable error, not silent completion', async () => {
    let calls = 0;
    let finalAttemptStarted = false;
    const startedAt = Date.now();
    // Deadline lands after attempt 1's bound elapses but long before 3 bounded
    // attempts (or the guaranteed final one) could otherwise complete.
    const hardDeadlineAt = startedAt + 60;
    const attemptFactory = async (attemptIndex: number) => {
      calls += 1;
      if (attemptIndex === 4) finalAttemptStarted = true;
      // Every attempt stalls well past its bound (degraded-provider shape).
      return delay(500, `SHOULD_NEVER_WIN_${attemptIndex}`);
    };
    await expect(orch.awaitAiBoundedThenUncapped(attemptFactory, 'test-op-mid-deadline', {
      perAttemptTimeoutMs: 40,
      maxBoundedAttempts: 3,
      slowWarnMs: 10000,
      hardDeadlineAt,
    })).rejects.toThrow('ai-catalog-hard-deadline-exceeded');
    expect(finalAttemptStarted).toBe(false);
    // Abandoned close to the deadline, not after riding out all 3*40ms bounded
    // attempts plus a 500ms "final" attempt.
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(calls).toBeLessThan(3);
  });
});
