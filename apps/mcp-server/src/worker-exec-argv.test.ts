import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerExecArgvForEntry } from './worker-exec-argv';

const TSX_ARGV = ['--require', '/app/node_modules/tsx/dist/preflight.cjs', '--import', 'file:///app/node_modules/tsx/dist/loader.mjs'];

test('compiled entries do not inherit TypeScript loaders from a tsx parent', () => {
  assert.deepEqual(workerExecArgvForEntry(TSX_ARGV, '/app/dist-hosted/hosted-project-query-worker.cjs'), []);
  assert.deepEqual(workerExecArgvForEntry(['--import=file:///x/tsx/dist/loader.mjs', '--require=/x/ts-node/register'], '/app/worker.js'), []);
});

test('TypeScript entries keep the parent loaders', () => {
  assert.deepEqual(workerExecArgvForEntry(TSX_ARGV, '/app/src/hosted-project-query-worker.ts'), TSX_ARGV);
  assert.deepEqual(workerExecArgvForEntry(['--import', 'tsx'], '/app/src/worker.mts'), ['--import', 'tsx']);
});

test('non-TypeScript loaders survive for every entry kind', () => {
  const argv = ['--require', '/app/instrument.cjs', '--import=file:///app/otel.mjs', '--enable-source-maps'];
  assert.deepEqual(workerExecArgvForEntry(argv, '/app/worker.cjs'), argv);
});

test('eval, print, heap and test-runner flags are dropped', () => {
  const argv = ['-e', 'code', '--print=1', '--max-old-space-size=512', '--max_old_space_size', '256', '--test', '--test-only', '--experimental-test-coverage', '--inspect'];
  assert.deepEqual(workerExecArgvForEntry(argv, '/app/worker.cjs'), ['--inspect']);
});
