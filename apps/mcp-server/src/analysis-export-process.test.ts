import assert from 'node:assert/strict';
import test from 'node:test';
import { typescriptLoaderArgs } from './analysis-export-process';

test('export worker source entries prefer tsx and fall back to ts-node, failing loudly when neither exists', () => {
  assert.deepEqual(typescriptLoaderArgs(specifier => `/resolved/${specifier}`), ['--import', '/resolved/tsx']);
  assert.deepEqual(
    typescriptLoaderArgs(specifier => { if (specifier === 'tsx') throw new Error('missing'); return `/resolved/${specifier}`; }),
    ['--require', '/resolved/ts-node/register/transpile-only'],
  );
  assert.throws(() => typescriptLoaderArgs(() => { throw new Error('missing'); }), /No TypeScript loader/);
  assert.equal(typescriptLoaderArgs()[0], '--import');
});
