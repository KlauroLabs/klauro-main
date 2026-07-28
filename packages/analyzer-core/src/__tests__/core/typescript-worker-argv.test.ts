import {
  resolveTreeSitterWorkerPath,
  treeSitterWorkerExecArgv,
} from '../../analyzer/languages/typescript-javascript-analyzer';

describe('treeSitterWorkerExecArgv', () => {
  it('keeps TypeScript loader flags but removes worker-incompatible heap flags', () => {
    expect(treeSitterWorkerExecArgv([
      '--require',
      '/tsx/preflight.cjs',
      '--import',
      'file:///tsx/loader.mjs',
      '--max-old-space-size=4096',
      '--max_old_space_size=2048',
    ])).toEqual([
      '--require',
      '/tsx/preflight.cjs',
      '--import',
      'file:///tsx/loader.mjs',
    ]);
  });
});

describe('resolveTreeSitterWorkerPath', () => {
  it('uses the compiled worker artifact when production built it', () => {
    expect(resolveTreeSitterWorkerPath(
      '/app/packages/analyzer-core/dist/analyzer/core/tree-sitter-ts-worker.js',
      '/app/packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts',
      candidate => candidate.includes('/dist/')
    )).toBe('/app/packages/analyzer-core/dist/analyzer/core/tree-sitter-ts-worker.js');
  });

  it('falls back to the TypeScript worker for source development', () => {
    expect(resolveTreeSitterWorkerPath(
      '/app/packages/analyzer-core/dist/analyzer/core/tree-sitter-ts-worker.js',
      '/app/packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts',
      () => false
    )).toBe('/app/packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts');
  });
});
