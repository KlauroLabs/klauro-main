/**
 * `categories` STRUCTURAL SHAPE.
 *
 * Every stored CAS shipped a corrupted `categories` tree: a flat analyzer tag
 * list (`categories: ['validation', 'contracts', ...]`) was lifted into
 * `contribution.categories`, and the orchestrator's merge then spread the
 * STRING "validation" character by character into the descriptor slot,
 * producing `{"0":{"0":{"0":"v","types":[],"frameworks":[],"languages":[]},…}}`.
 * These tests pin the two gates that make that unrepresentable: tag lists never
 * become `contribution.categories`, and the merge never spreads a non-object.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerOrchestrator } from './orchestrator';
import { isCASCategoriesShape, normalizeCategoryTags } from './base-analyzer';
import { CASCategories } from '../../types/cas.types';

function merge(...sources: unknown[]): CASCategories {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const target: CASCategories = {};
  for (const source of sources) orchestrator.mergeCategories(target, source);
  return target;
}

/** True when any value anywhere in the tree is character-indexed — the exact
 *  corruption signature (`{"0":"v","1":"a",…}`). */
function isCharacterIndexed(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  const numericSingleChar = entries.filter(([key, item]) =>
    /^\d+$/.test(key) && typeof item === 'string' && item.length === 1);
  if (numericSingleChar.length > 1) return true;
  return entries.some(([, item]) => isCharacterIndexed(item));
}

test('a flat analyzer tag list never becomes a CASCategories tree', () => {
  assert.equal(isCASCategoriesShape(['validation', 'contracts', 'input-validation']), false);
  assert.equal(isCASCategoriesShape('validation'), false);
  assert.equal(isCASCategoriesShape({}), false, 'an empty object carries no categories');
  assert.equal(isCASCategoriesShape({ '1': { modules: { name: 'Modules', types: ['file'] } } }), true);
  // A level whose values are strings is the corrupted shape, not a tree.
  assert.equal(isCASCategoriesShape({ '0': { '0': 'v' } }), false);

  assert.deepEqual(normalizeCategoryTags(['validation', 'validation', ' contracts ', '', 7]), ['validation', 'contracts']);
  assert.deepEqual(normalizeCategoryTags({ nested: true }), []);
});

test('mergeCategories skips non-object contributions instead of spreading them character by character', () => {
  const merged = merge(
    ['validation', 'contracts', 'input-validation'],
    ['observability'],
    'infrastructure',
    { '0': ['validation'] },
    { '0': { '0': 'validation' } },
  );

  assert.deepEqual(merged, {}, 'no malformed contribution reaches the tree');
  assert.equal(isCharacterIndexed(merged), false);
});

test('mergeCategories unions well-formed descriptors and never emits a character-indexed entry', () => {
  const merged = merge(
    { '1': { modules: { name: 'Modules', types: ['file'], languages: ['typescript'] } } },
    { '1': { modules: { types: ['module'], languages: ['javascript'], description: 'Source files and modules' } } },
    { '2': { services: { name: 'Services', frameworks: ['nest'] } } },
  );

  assert.deepEqual(merged['1'].modules, {
    name: 'Modules',
    description: 'Source files and modules',
    types: ['file', 'module'],
    frameworks: [],
    languages: ['typescript', 'javascript'],
  });
  assert.equal(merged['2'].services.name, 'Services');
  assert.equal(isCharacterIndexed(merged), false);

  // Every entry is a well-formed descriptor object with the declared shape.
  for (const level of Object.values(merged)) {
    assert.equal(typeof level, 'object');
    for (const descriptor of Object.values(level)) {
      assert.ok(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor));
      for (const field of ['types', 'frameworks', 'languages'] as const) {
        if (descriptor[field] !== undefined) {
          assert.ok(Array.isArray(descriptor[field]));
          assert.ok(descriptor[field]!.every(item => typeof item === 'string'));
        }
      }
    }
  }
});

test('a corrupted descriptor already in the tree is replaced by a well-formed one, never merged into', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const target = { '0': { '0': 'validation' } } as unknown as CASCategories;
  orchestrator.mergeCategories(target, { '0': { '0': { name: 'Validation', types: ['schema'] } } });

  assert.deepEqual(target['0']['0'], { name: 'Validation', types: ['schema'] });
  assert.equal(isCharacterIndexed(target), false);
});
