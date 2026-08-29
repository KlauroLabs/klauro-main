import {
  resolveTreeSitterWorkerPath,
  treeSitterWorkerExecArgv,
} from '../../analyzer/core/tree-sitter-worker-runtime';

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
  it('uses the sibling bundled worker artifact in packaged runtimes', () => {
    expect(resolveTreeSitterWorkerPath(
      '/app/dist-hosted/tree-sitter-ts-worker.cjs',
      '/app/packages/analyzer-core/dist/analyzer/core/tree-sitter-ts-worker.js',
      '/app/packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts',
      candidate => candidate.endsWith('.cjs')
    )).toBe('/app/dist-hosted/tree-sitter-ts-worker.cjs');
  });

  it('uses the compiled worker artifact when production built it', () => {
    expect(resolveTreeSitterWorkerPath(
      '/app/dist-hosted/tree-sitter-ts-worker.cjs',
      '/app/packages/analyzer-core/dist/analyzer/core/tree-sitter-ts-worker.js',
      '/app/packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts',
      candidate => candidate.includes('/dist/')
    )).toBe('/app/packages/analyzer-core/dist/analyzer/core/tree-sitter-ts-worker.js');
  });

  it('falls back to the TypeScript worker for source development', () => {
    expect(resolveTreeSitterWorkerPath(
      '/app/dist-hosted/tree-sitter-ts-worker.cjs',
      '/app/packages/analyzer-core/dist/analyzer/core/tree-sitter-ts-worker.js',
      '/app/packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts',
      () => false
    )).toBe('/app/packages/analyzer-core/src/analyzer/core/tree-sitter-ts-worker.ts');
  });
});
