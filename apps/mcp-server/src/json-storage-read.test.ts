import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionParseLimits } from './json-storage-read';

const GiB = 1024 * 1024 * 1024;

test('a single section is parsed buffered up to a quarter of the heap while the concurrent budget stays at an eighth', () => {
  const limits = sectionParseLimits(2240 * 1024 * 1024, {});
  assert.equal(limits.expansion, 24);
  assert.equal(limits.parsedSectionBudget, 280 * 1024 * 1024);
  assert.equal(limits.bufferedSectionLimit, 560 * 1024 * 1024);
  const graphSection = 13_463_215 * limits.expansion;
  assert.ok(graphSection > limits.parsedSectionBudget);
  assert.ok(graphSection <= limits.bufferedSectionLimit);
});

test('a section larger than a quarter of the heap still streams', () => {
  const limits = sectionParseLimits(768 * 1024 * 1024, {});
  assert.ok(13_463_215 * limits.expansion > limits.bufferedSectionLimit);
});

test('an explicit budget governs both limits and the expansion override is honored', () => {
  const limits = sectionParseLimits(4 * GiB, { KLAURO_SECTION_PARSE_BUDGET_MB: '100', KLAURO_SECTION_PARSE_EXPANSION: '8' });
  assert.equal(limits.expansion, 8);
  assert.equal(limits.parsedSectionBudget, 100 * 1024 * 1024);
  assert.equal(limits.bufferedSectionLimit, 100 * 1024 * 1024);
});
