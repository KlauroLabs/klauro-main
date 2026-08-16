import test from 'node:test';
import assert from 'node:assert/strict';
import { isBenchmarkCopyExcludedPath } from './incremental-benchmark';
import { requiresIncrementalGitBaseline } from './incremental-benchmark-execution';
import { provesIncrementalLocality } from './incremental-locality-proof';

test('product incremental proofs always establish a Git baseline', () => {
  assert.equal(requiresIncrementalGitBaseline(false, 'klauro-product'), true);
  assert.equal(requiresIncrementalGitBaseline(undefined, 'klauro-product'), true);
  assert.equal(requiresIncrementalGitBaseline(true, 'in-process-harness'), true);
  assert.equal(requiresIncrementalGitBaseline(false, 'in-process-harness'), false);
});

test('incremental benchmark repo copies exclude binary package artifacts', () => {
  assert.equal(
    isBenchmarkCopyExcludedPath('Hoggan Scientific/packages/FreeSpire.Doc.7.1.13/lib/netstandard2.0/Spire.Doc.dll'),
    true,
  );
  assert.equal(isBenchmarkCopyExcludedPath('packages/Spire.Pdf.1.0.0/lib/net45/Spire.Pdf.dll'), true);
  assert.equal(
    isBenchmarkCopyExcludedPath('Hoggan Scientific/packages/Grpc.Core.2.30.0/native/ios/universal/libgrpc.a'),
    true,
  );
  assert.equal(isBenchmarkCopyExcludedPath('packages/Grpc.Core.2.30.0/native/linux/libgrpc.so'), true);
  assert.equal(isBenchmarkCopyExcludedPath('src/users/users.service.ts'), false);
  assert.equal(isBenchmarkCopyExcludedPath('migrations/20260609000000_add_users.sql'), false);
});

test('incremental locality accepts an affected closure that spans the complete repository', () => {
  assert.equal(provesIncrementalLocality({
    strategy: 'project-contribution-refresh',
    directChangedFiles: 1,
    graphAffectedFiles: 2,
    analyzedFiles: 3,
    reusedFiles: 0,
  }), true);
  assert.equal(provesIncrementalLocality({
    strategy: 'project-contribution-refresh',
    directChangedFiles: 1,
    graphAffectedFiles: 0,
    analyzedFiles: 1,
    reusedFiles: 0,
  }), true);
});

test('incremental locality rejects unnecessary analysis and full rebuilds', () => {
  assert.equal(provesIncrementalLocality({
    strategy: 'project-contribution-refresh',
    directChangedFiles: 1,
    graphAffectedFiles: 0,
    analyzedFiles: 20,
    reusedFiles: 0,
  }), false);
  assert.equal(provesIncrementalLocality({
    strategy: 'full-rebuild',
    directChangedFiles: 1,
    graphAffectedFiles: 0,
    analyzedFiles: 1,
    reusedFiles: 0,
  }), false);
});
