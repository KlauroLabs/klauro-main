import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as http from 'node:http';

const REQUIRE = () => import('./self-telemetry');

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.KLAURO_SELF_TELEMETRY;
  if (value === undefined) delete process.env.KLAURO_SELF_TELEMETRY;
  else process.env.KLAURO_SELF_TELEMETRY = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.KLAURO_SELF_TELEMETRY;
    else process.env.KLAURO_SELF_TELEMETRY = prev;
  }
}

test('selfTelemetryEnabled: gate is off by default and for falsy values', async () => {
  const { selfTelemetryEnabled } = await REQUIRE();
  for (const v of [undefined, '', '0', 'false', 'off', 'no', 'FALSE']) {
    withEnv(v, () => assert.equal(selfTelemetryEnabled(), false, `expected disabled for ${JSON.stringify(v)}`));
  }
});

test('selfTelemetryEnabled: gate is on for truthy values', async () => {
  const { selfTelemetryEnabled } = await REQUIRE();
  for (const v of ['1', 'true', 'yes', 'on']) {
    withEnv(v, () => assert.equal(selfTelemetryEnabled(), true, `expected enabled for ${JSON.stringify(v)}`));
  }
});

test('instrumentHttpHandler: returns the ORIGINAL handler unchanged when gate is off', async () => {
  const { instrumentHttpHandler } = await REQUIRE();
  withEnv(undefined, () => {
    const original = (_req: http.IncomingMessage, _res: http.ServerResponse) => {};
    assert.equal(instrumentHttpHandler(original), original, 'gate off must not wrap');
  });
});

test('instrumentHttpHandler: wraps and still invokes the handler when gate is on', async () => {
  const { instrumentHttpHandler } = await REQUIRE();
  withEnv('1', () => {
    let called = false;
    const original = (_req: http.IncomingMessage, _res: http.ServerResponse) => { called = true; };
    const wrapped = instrumentHttpHandler(original);
    assert.notEqual(wrapped, original, 'gate on should wrap');
    // Fake req/res with a finish-hook registrar; wrapper must never throw and must call through.
    const res = { statusCode: 200, on(_e: string, _l: () => void) { return this; } } as unknown as http.ServerResponse;
    const req = { method: 'GET', url: '/x' } as unknown as http.IncomingMessage;
    wrapped(req, res);
    assert.equal(called, true, 'wrapped handler must invoke the original');
  });
});

test('initSelfTelemetry: no-op returns false when gate is off', async () => {
  const { initSelfTelemetry } = await REQUIRE();
  withEnv(undefined, () => assert.equal(initSelfTelemetry(), false));
});
