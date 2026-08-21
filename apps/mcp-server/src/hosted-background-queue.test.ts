import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerHostedBackgroundPreflight,
  registerHostedMemoryHeavyCancellation,
  withHostedBackgroundPermit,
  withHostedForegroundPermit,
} from './hosted-background-queue';

test('hosted memory-heavy background work is globally serialized after failures', async () => {
  let active = 0;
  let peak = 0;
  const run = async (fail = false): Promise<void> => withHostedBackgroundPermit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active -= 1;
    if (fail) throw new Error('expected');
  });

  const results = await Promise.allSettled([run(), run(true), run()]);
  assert.equal(peak, 1);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('foreground queries can run while memory-heavy work waits in preflight', async () => {
  let releasePreflight!: () => void;
  let foregroundRan = false;
  const unregister = registerHostedBackgroundPreflight(() => new Promise<void>(resolve => { releasePreflight = resolve; }));
  try {
    const background = withHostedBackgroundPermit(async () => undefined, { releaseForegroundMemory: true });
    await new Promise(resolve => setImmediate(resolve));
    await withHostedForegroundPermit(async () => { foregroundRan = true; });
    assert.equal(foregroundRan, true);
    releasePreflight();
    await background;
  } finally {
    unregister();
  }
});

test('foreground queries cancel active memory-heavy work before proceeding', async () => {
  let releaseBackground!: () => void;
  let cancelled = false;
  const background = withHostedBackgroundPermit(async () => {
    const unregister = registerHostedMemoryHeavyCancellation(() => {
      cancelled = true;
      releaseBackground();
    });
    try {
      await new Promise<void>(resolve => { releaseBackground = resolve; });
    } finally {
      unregister();
    }
  }, { releaseForegroundMemory: true });
  await new Promise(resolve => setImmediate(resolve));
  await withHostedForegroundPermit(async () => undefined);
  await background;
  assert.equal(cancelled, true);
});

test('background work waits for foreground queries and runs their memory-release preflight', async () => {
  const order: string[] = [];
  let releaseForeground!: () => void;
  const unregister = registerHostedBackgroundPreflight(() => { order.push('preflight'); });
  try {
    const foreground = withHostedForegroundPermit(async () => {
      order.push('foreground-start');
      await new Promise<void>(resolve => { releaseForeground = resolve; });
      order.push('foreground-end');
    });
    await new Promise(resolve => setImmediate(resolve));
    const background = withHostedBackgroundPermit(
      async () => { order.push('background'); },
      { releaseForegroundMemory: true },
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['foreground-start']);
    releaseForeground();
    await Promise.all([foreground, background]);
    assert.deepEqual(order, ['foreground-start', 'foreground-end', 'preflight', 'background']);
  } finally {
    unregister();
  }
});

test('lightweight telemetry persistence never queues a foreground query', async () => {
  let releaseBackground!: () => void;
  let foregroundRan = false;
  const background = withHostedBackgroundPermit(async () => {
    await new Promise<void>(resolve => { releaseBackground = resolve; });
  });
  await new Promise(resolve => setImmediate(resolve));
  const foreground = withHostedForegroundPermit(async () => { foregroundRan = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(foregroundRan, true);
  releaseBackground();
  await Promise.all([background, foreground]);
});
