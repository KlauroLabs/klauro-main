import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cachedEstreeParse,
  clearEstreeParseCache,
  getEstreeParseCacheRetention,
  getEstreeParseCacheStats,
} from './estree-parse-cache';

test('reuses a live syntax tree without retaining ownership of it', () => {
  clearEstreeParseCache();
  const first = cachedEstreeParse('export const value = 1;', { loc: true });
  const second = cachedEstreeParse('export const value = 1;', { loc: true });

  assert.equal(second, first);
  assert.deepEqual(getEstreeParseCacheStats(), { hits: 1, misses: 1, size: 1 });
});

test('clear resets syntax tree references and cache evidence', () => {
  clearEstreeParseCache();
  cachedEstreeParse('export const value = 1;', { loc: true });
  clearEstreeParseCache();

  assert.deepEqual(getEstreeParseCacheStats(), { hits: 0, misses: 0, size: 0 });
  assert.equal(getEstreeParseCacheRetention().estimatedBytes, 0);
});

test('strong syntax tree retention stays within its heap-scaled budget', () => {
  clearEstreeParseCache();
  for (let index = 0; index < 256; index++) {
    cachedEstreeParse(`export const value${index} = '${'x'.repeat(4096)}';`, { loc: true });
  }

  const retention = getEstreeParseCacheRetention();
  assert.ok(retention.estimatedBytes > 0);
  assert.ok(retention.estimatedBytes <= retention.limitBytes);
});
