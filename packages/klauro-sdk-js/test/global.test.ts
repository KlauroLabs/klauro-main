import test from 'node:test';
import assert from 'node:assert/strict';
import * as klauro from '../src/index';

test('global API is a safe no-op before init()', async () => {
  // Never throws when uninitialized.
  klauro.record('x');
  klauro.recordEvent({ type: 'custom', signal: 'y' });
  klauro.captureError(new Error('z'));
  klauro.incrementCounter('c');
  klauro.recordGauge('g', 1);
  const span = klauro.startSpan('s');
  span.setAttribute('k', 'v');
  span.end();
  await klauro.flush();
  assert.equal(klauro.getClient(), undefined);
});

test('init() returns a client and getClient() exposes it', async () => {
  const captures: Array<{ events: unknown[] }> = [];
  const client = klauro.init({
    projectId: 'p',
    flushInterval: 0,
    fetchImpl: (async (_u: any, init: any) => {
      captures.push(JSON.parse(init.body));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch,
  });
  assert.equal(klauro.getClient(), client);
  klauro.record('booted');
  await klauro.flush();
  assert.equal(captures[0].events.length, 1);
  await klauro.shutdown();
  assert.equal(klauro.getClient(), undefined);
});

test('init() requires a projectId', () => {
  assert.throws(() => klauro.init({} as never), /projectId/);
});
