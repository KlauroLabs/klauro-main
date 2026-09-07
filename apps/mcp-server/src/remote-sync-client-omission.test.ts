import assert from 'node:assert/strict';
import test from 'node:test';
import { workingTreeSyncRequired } from './remote-sync-client';

const manifest = (oversize?: Array<{ path: string; bytes: number }>) => ({ ...(oversize ? { excluded_oversize_files: oversize } : {}) }) as any;

test('an omission-only dirty tree still requires a sync so the hosted manifest discloses the exclusion', () => {
  assert.equal(workingTreeSyncRequired({ changed_files: [], manifest: manifest() }), false, 'a clean tree stays a cheap no-op');
  assert.equal(workingTreeSyncRequired({ changed_files: [], manifest: manifest([]) }), false);
  assert.equal(workingTreeSyncRequired({ changed_files: [], manifest: manifest([{ path: 'src/huge.ts', bytes: 9_000_000 }]) }), true, 'the only edit crossing the size limit must not be silently dropped');
  assert.equal(workingTreeSyncRequired({ changed_files: [{ path: 'src/a.ts' } as any], manifest: manifest() }), true);
});
