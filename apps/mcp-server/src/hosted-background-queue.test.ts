import test from 'node:test';
import assert from 'node:assert/strict';
import { withHostedBackgroundPermit } from './hosted-background-queue';

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
