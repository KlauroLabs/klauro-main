import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveWorkspaceTarget } from './cli';

// Task #64: `klauro account-workspaces` / `klauro account-workspace-attach`
// arg-resolution coverage. The route/rebuild behavior is covered end to end
// in workspace-attach.test.ts; this file is pure-function coverage for the
// CLI-side parsing and workspace-target resolution, following the
// cli-first-session-fixes.test.ts pattern of importing exported pure
// functions directly from './cli' rather than shelling out.

test('parseArgs: account-workspace-attach reads --workspace and --path', () => {
  const args = parseArgs(['account-workspace-attach', '--workspace', 'wsp_abc123', '--path', '/tmp/some-repo']);
  assert.equal(args.command, 'account-workspace-attach');
  assert.equal(args.workspace, 'wsp_abc123');
  assert.equal(args.path, '/tmp/some-repo');
});

test('parseArgs: account-workspace-attach accepts a bare positional path (defaults path slot, not workspace)', () => {
  const args = parseArgs(['account-workspace-attach', '--workspace', 'Acme Team', '.']);
  assert.equal(args.command, 'account-workspace-attach');
  assert.equal(args.workspace, 'Acme Team');
  assert.equal(args.path, '.');
});

test('parseArgs: account-workspaces takes only global flags', () => {
  const args = parseArgs(['account-workspaces', '--json', '--server-url', 'https://mcp.klauro.com']);
  assert.equal(args.command, 'account-workspaces');
  assert.equal(args.json, true);
  assert.equal(args.serverUrl, 'https://mcp.klauro.com');
});

test('resolveWorkspaceTarget: matches by exact id even when a name collides', () => {
  const workspaces = [
    { id: 'wsp_1', name: 'wsp_1' }, // pathological but must not confuse id vs name matching
    { id: 'wsp_2', name: 'Acme Team' },
  ];
  assert.equal(resolveWorkspaceTarget(workspaces, 'wsp_2').id, 'wsp_2');
});

test('resolveWorkspaceTarget: matches by unique name (case-insensitive)', () => {
  const workspaces = [
    { id: 'wsp_1', name: 'Acme Team' },
    { id: 'wsp_2', name: 'Other Team' },
  ];
  assert.equal(resolveWorkspaceTarget(workspaces, 'acme team').id, 'wsp_1');
});

test('resolveWorkspaceTarget: matches by unique name prefix', () => {
  const workspaces = [
    { id: 'wsp_1', name: 'Acme Team' },
    { id: 'wsp_2', name: 'Other Team' },
  ];
  assert.equal(resolveWorkspaceTarget(workspaces, 'acme').id, 'wsp_1');
});

test('resolveWorkspaceTarget: ambiguous name throws a listing error, not a silent pick', () => {
  const workspaces = [
    { id: 'wsp_1', name: 'Acme Team' },
    { id: 'wsp_2', name: 'Acme Team West' },
  ];
  assert.throws(() => resolveWorkspaceTarget(workspaces, 'acme'), /matches multiple workspaces/);
});

test('resolveWorkspaceTarget: unknown target throws a not-found error', () => {
  const workspaces = [{ id: 'wsp_1', name: 'Acme Team' }];
  assert.throws(() => resolveWorkspaceTarget(workspaces, 'does-not-exist'), /No workspace found matching/);
});
