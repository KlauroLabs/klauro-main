import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveFileAwareTestScript } from './agent-test-command';

test('file-aware test selection follows declared simple aliases', () => {
  assert.equal(resolveFileAwareTestScript({ test: 'npm run verify', verify: 'jest --runInBand' }), 'test');
  assert.equal(resolveFileAwareTestScript({ test: 'vitest run' }), 'test');
  assert.equal(resolveFileAwareTestScript({ 'test:unit': 'node --test', test: 'jest' }), 'test:unit');
});

test('composite scripts and existing selectors never imply focused forwarding', () => {
  for (const script of [
    'npm run test:jest && npm run test:node',
    'jest src/all.test.ts',
    'node --test "src/**/*.test.ts"',
    'node scripts/test-suite.mjs',
    'jest; echo done',
    'vitest',
    'CUSTOM=1 jest',
  ]) {
    assert.equal(resolveFileAwareTestScript({ test: script }), null, script);
  }
});

test('alias cycles and missing scripts stay unresolved', () => {
  assert.equal(resolveFileAwareTestScript({ test: 'npm run unit', unit: 'npm test' }), null);
  assert.equal(resolveFileAwareTestScript({ test: 'npm run missing' }), null);
  assert.equal(resolveFileAwareTestScript({}), null);
});
