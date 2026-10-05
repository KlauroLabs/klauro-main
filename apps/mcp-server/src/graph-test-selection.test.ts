import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { findTests } from './test-query';

function fixture(guessed: boolean): CASOutput {
  const node = (id: string, file: string) => ({ id, name: id, type: 'function', source: { file, line: 1 } });
  return {
    nodes: [
      node('src/price.ts:total', 'src/price.ts'),
      node('src/cart.ts:checkout', 'src/cart.ts'),
      node('tests/flow.test.ts:it1', 'tests/flow.test.ts'),
      node('tests/other.test.ts:it2', 'tests/other.test.ts'),
    ],
    edges: [
      { id: 'e1', source: 'src/cart.ts:checkout', target: 'src/price.ts:total', type: 'calls', ...(guessed ? { metadata: { attributes: { via: 'name' } } } : {}) },
      { id: 'e2', source: 'tests/flow.test.ts:it1', target: 'src/cart.ts:checkout', type: 'calls' },
    ],
    entry_points: [
      { id: 'a', type: 'test', source_node: 'tests/flow.test.ts:it1' },
      { id: 'b', type: 'test', source_node: 'tests/other.test.ts:it2' },
    ],
    test_suites: [
      { id: 'suite:tests/flow.test.ts', name: 'flow', file_path: 'tests/flow.test.ts', tests: [] },
      { id: 'suite:tests/other.test.ts', name: 'other', file_path: 'tests/other.test.ts', tests: [] },
    ],
  } as unknown as CASOutput;
}

test('a test that reaches the changed unit through resolved calls is selected and the answer is exact', () => {
  const found = findTests(fixture(false), { nodeId: 'src/price.ts:total' }) as any;
  assert.deepEqual(found.suites.map((suite: any) => suite.file_path), ['tests/flow.test.ts']);
  assert.equal(found.resolution.answer_basis, 'exact-by-graph');
  assert.equal(found.resolution.matches[0].basis, 'exact-by-graph');
  assert.match(found.resolution.matches[0].reason, /2 calls away/);
});

test('a hop matched on the name alone is reported as such', () => {
  const found = findTests(fixture(true), { nodeId: 'src/price.ts:total' }) as any;
  assert.equal(found.resolution.matches[0].basis, 'graph-with-name-guess');
  assert.equal(found.resolution.answer_basis, 'includes-name-based-matches');
  assert.match(found.resolution.matches[0].reason, /name alone/);
});

test('a file path asks the same question of every unit the file holds', () => {
  const found = findTests(fixture(false), { filePath: 'src/price.ts' }) as any;
  assert.equal(found.suites[0].file_path, 'tests/flow.test.ts');
  assert.equal(found.resolution.matches[0].basis, 'exact-by-graph');
});
