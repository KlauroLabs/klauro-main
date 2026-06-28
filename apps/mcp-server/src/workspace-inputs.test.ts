import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { shouldSkipWorkspaceInput } from './workspace-inputs';

test('workspace input policy excludes matching top-level folders', () => {
  const root = path.resolve('/tmp/klauro-workspace');
  const skip = shouldSkipWorkspaceInput(
    path.join(root, 'ztray'),
    root,
    ['ztray/**'],
  );

  assert.equal(skip?.reason, 'excluded by workspace source policy');
  assert.equal(skip?.matched_pattern, 'ztray/**');
});

test('workspace input policy excludes nested workspace folders', () => {
  const root = path.resolve('/tmp/klauro-workspace');
  const skip = shouldSkipWorkspaceInput(
    path.join(root, 'archived', 'demo-api'),
    root,
    ['archived/**'],
  );

  assert.equal(skip?.matched_pattern, 'archived/**');
});

test('workspace input policy rejects paths outside the workspace root', () => {
  const root = path.resolve('/tmp/klauro-workspace');
  const skip = shouldSkipWorkspaceInput(
    path.resolve('/tmp/other-workspace/api'),
    root,
    [],
  );

  assert.equal(skip?.reason, 'outside workspace root');
});

test('workspace input policy keeps unrelated folders', () => {
  const root = path.resolve('/tmp/klauro-workspace');
  const skip = shouldSkipWorkspaceInput(
    path.join(root, 'admin-api'),
    root,
    ['ztray/**', 'website/**'],
  );

  assert.equal(skip, null);
});
