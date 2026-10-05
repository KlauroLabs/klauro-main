import test from 'node:test';
import assert from 'node:assert/strict';
import { storageDiagnosticsEnabled, writeStorageDiagnostic } from './storage-diagnostics';

test('storage diagnostics stay silent unless the host opts in', () => {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    writeStorageDiagnostic({ event: 'segmented_cas_sections_written' }, {});
    writeStorageDiagnostic({ event: 'segmented_cas_sections_written' }, { KLAURO_STORAGE_DIAGNOSTICS: '0' });
    assert.deepEqual(lines, []);
    writeStorageDiagnostic({ event: 'compact_cas_postings_merged' }, { KLAURO_STORAGE_DIAGNOSTICS: '1' });
    assert.deepEqual(lines, ['{"event":"compact_cas_postings_merged"}\n']);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(storageDiagnosticsEnabled({}), false);
  assert.equal(storageDiagnosticsEnabled({ KLAURO_STORAGE_DIAGNOSTICS: 'true' }), true);
});
