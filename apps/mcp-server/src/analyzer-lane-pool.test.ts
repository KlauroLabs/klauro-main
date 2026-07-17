import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  __resetAnalysisLanesForTests,
  __setMemoryGuardOverrideForTests,
  __withLanePermitForTests,
  __getLanePermitsInUseForTests,
} from './analyzer';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    // Must await here (not just return the promise) — the finally below has
    // to run AFTER fn's async work completes, or the env vars get restored
    // while the test body is still mid-flight.
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('two different-project jobs overlap in time under concurrency 2', async () => {
  __resetAnalysisLanesForTests();
  await withEnv({ KLAURO_ANALYSIS_CONCURRENCY: '2' }, async () => {
    let aStarted = false;
    let bStartedWhileAWasRunning = false;

    const jobA = __withLanePermitForTests(async () => {
      aStarted = true;
      await sleep(40);
      return 'a';
    });
    // Give job A a moment to actually start before requesting the second permit.
    await sleep(5);
    const jobB = __withLanePermitForTests(async () => {
      bStartedWhileAWasRunning = aStarted;
      await sleep(5);
      return 'b';
    });

    const [a, b] = await Promise.all([jobA, jobB]);
    assert.equal(a, 'a');
    assert.equal(b, 'b');
    assert.equal(bStartedWhileAWasRunning, true, 'job B should start while job A is still running (concurrency 2, no head-of-line blocking)');
  });
});

test('a third job queues until a permit frees (bounded, not unbounded fan-out)', async () => {
  __resetAnalysisLanesForTests();
  await withEnv({ KLAURO_ANALYSIS_CONCURRENCY: '2' }, async () => {
    let peakConcurrent = 0;
    let currentConcurrent = 0;

    const makeJob = (ms: number) => __withLanePermitForTests(async () => {
      currentConcurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
      await sleep(ms);
      currentConcurrent -= 1;
    });

    await Promise.all([makeJob(30), makeJob(30), makeJob(30)]);
    assert.equal(peakConcurrent, 2, 'at most KLAURO_ANALYSIS_CONCURRENCY jobs should run at once');
  });
});

test('smallest waiting job is picked first when a slot frees', async () => {
  __resetAnalysisLanesForTests();
  await withEnv({ KLAURO_ANALYSIS_CONCURRENCY: '1' }, async () => {
    const order: string[] = [];

    // Occupy the single lane first.
    const holder = __withLanePermitForTests(async () => {
      await sleep(20);
    });
    await sleep(5);

    // Enqueue a large job first, then a small one — smallest should win
    // despite arriving second.
    const large = __withLanePermitForTests(async () => {
      order.push('large');
    }, 10_000);
    await sleep(2);
    const small = __withLanePermitForTests(async () => {
      order.push('small');
    }, 5);

    await Promise.all([holder, large, small]);
    assert.deepEqual(order, ['small', 'large'], 'smallest sizeHint should be scheduled before the larger one');
  });
});

test('age-based promotion prevents starving the whale behind a stream of small jobs', async () => {
  __resetAnalysisLanesForTests();
  await withEnv({ KLAURO_ANALYSIS_CONCURRENCY: '1', KLAURO_ANALYSIS_QUEUE_MAX_WAIT_MS: '15' }, async () => {
    const order: string[] = [];

    const holder = __withLanePermitForTests(async () => {
      await sleep(10);
    });
    await sleep(2);

    // Whale enqueues first with a huge size hint.
    const whale = __withLanePermitForTests(async () => {
      order.push('whale');
    }, 1_000_000);

    // Wait past the (short, test-only) starvation threshold, then a small job
    // arrives. Without age promotion the small job would always win on size.
    await sleep(25);
    const small = __withLanePermitForTests(async () => {
      order.push('small');
    }, 1);

    await Promise.all([holder, whale, small]);
    assert.deepEqual(order, ['whale', 'small'], 'a waiter past the max-wait threshold must be promoted ahead of size ordering');
  });
});

test('memory guard caps a second concurrent job at 1 lane but never blocks a lone job', async () => {
  __resetAnalysisLanesForTests();
  await withEnv({ KLAURO_ANALYSIS_CONCURRENCY: '2' }, async () => {
    __setMemoryGuardOverrideForTests(true); // force "tight"
    try {
      let peakConcurrent = 0;
      let currentConcurrent = 0;
      const makeJob = (ms: number) => __withLanePermitForTests(async () => {
        currentConcurrent += 1;
        peakConcurrent = Math.max(peakConcurrent, currentConcurrent);
        await sleep(ms);
        currentConcurrent -= 1;
      });

      await Promise.all([makeJob(20), makeJob(20)]);
      assert.equal(peakConcurrent, 1, 'under memory pressure only one analysis should run at a time');

      // A single job must never be blocked by the memory guard.
      const soleStart = Date.now();
      await makeJob(1);
      assert.ok(Date.now() - soleStart < 200, 'a lone job must be admitted immediately even when memory is tight');
    } finally {
      __setMemoryGuardOverrideForTests(null);
    }
  });
});

test('same-project exclusivity is unaffected: at most one lane permit in use for a single caller chain', async () => {
  __resetAnalysisLanesForTests();
  await withEnv({ KLAURO_ANALYSIS_CONCURRENCY: '2' }, async () => {
    assert.equal(__getLanePermitsInUseForTests(), 0);
    await __withLanePermitForTests(async () => {
      assert.equal(__getLanePermitsInUseForTests(), 1);
    });
    assert.equal(__getLanePermitsInUseForTests(), 0);
  });
});

test('a crashing job releases its permit and does not block the next job', async () => {
  __resetAnalysisLanesForTests();
  await withEnv({ KLAURO_ANALYSIS_CONCURRENCY: '1' }, async () => {
    await assert.rejects(
      __withLanePermitForTests(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );

    // The lane must be free again — a subsequent job should run without
    // waiting on the crashed one.
    const startedAt = Date.now();
    const result = await __withLanePermitForTests(async () => 'ok');
    assert.equal(result, 'ok');
    assert.ok(Date.now() - startedAt < 200, 'permit released by a crashing job must be immediately reusable');
  });
});
