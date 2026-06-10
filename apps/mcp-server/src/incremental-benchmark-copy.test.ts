import test from 'node:test';
import assert from 'node:assert/strict';
import { isBenchmarkCopyExcludedPath } from './incremental-benchmark';

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
