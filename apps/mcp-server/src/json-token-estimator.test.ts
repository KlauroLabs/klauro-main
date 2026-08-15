import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatedJsonTokens } from './cross-codebase-analysis';

test('JSON token estimation matches serialized length without materializing the full document', () => {
  const shared = { label: 'service\nname', count: 4, missing: undefined };
  const value = {
    shared,
    repeated: [shared, true, null, undefined, Number.NaN],
    generated_at: new Date('2026-08-15T00:00:00.000Z'),
  };

  assert.equal(estimatedJsonTokens(value), Math.ceil(JSON.stringify(value).length / 4));
});

test('JSON token estimation rejects circular values', () => {
  const value: Record<string, unknown> = {};
  value.self = value;

  assert.throws(() => estimatedJsonTokens(value), /circular values/);
});
