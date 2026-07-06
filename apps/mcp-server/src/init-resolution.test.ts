import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { decideInitFlow, resolveNamedChoice, normalizeRepoIdentity } from './init-resolution';
import { AccountStore } from './account-store';

const workspaces = [
  { id: 'wsp_1', name: "Michael's Workspace" },
  { id: 'wsp_2', name: 'Team Platform' },
  { id: 'wsp_3', name: 'Team Payments' },
];

test('resolveNamedChoice: exact case-insensitive name wins', () => {
  const result = resolveNamedChoice(workspaces, 'team platform');
  assert.ok('match' in result && result.match.id === 'wsp_2');
});

test('resolveNamedChoice: 1-based number shorthand is accepted', () => {
  const result = resolveNamedChoice(workspaces, '1');
  assert.ok('match' in result && result.match.id === 'wsp_1');
});

test('resolveNamedChoice: unique prefix resolves', () => {
  const result = resolveNamedChoice(workspaces, "michael");
  assert.ok('match' in result && result.match.id === 'wsp_1');
});

test('resolveNamedChoice: ambiguous prefix reports the candidates (no silent pick)', () => {
  const result = resolveNamedChoice(workspaces, 'team');
  assert.ok('ambiguous' in result);
  assert.equal((result as { ambiguous: typeof workspaces }).ambiguous.length, 2);
});

test('resolveNamedChoice: unknown name is notFound (re-prompt, not a crash)', () => {
  const result = resolveNamedChoice(workspaces, 'nonexistent');
  assert.ok('notFound' in result);
});

test('resolveNamedChoice: empty input is notFound', () => {
  assert.ok('notFound' in resolveNamedChoice(workspaces, '   '));
});

test('decideInitFlow: recognized remote -> reconnect recommendation', () => {
  const flow = decideInitFlow({
    project: { id: 'prj_1', name: 'poc' },
    workspace: { id: 'wsp_1', name: 'ZeracLabs' },
  });
  assert.equal(flow.mode, 'reconnect');
  assert.match(flow.recommendation ?? '', /already connected to project "poc" in workspace "ZeracLabs"/);
});

test('decideInitFlow: unrecognized remote -> fresh flow', () => {
  const flow = decideInitFlow(null);
  assert.equal(flow.mode, 'fresh');
  assert.equal(flow.recommendation, undefined);
});

test('normalizeRepoIdentity: scheme/.git/case differences collapse to one identity', () => {
  const a = normalizeRepoIdentity('https://github.com/ZeracLabs/poc.git');
  const b = normalizeRepoIdentity('https://github.com/zeraclabs/poc');
  assert.ok(a && a === b);
});

test('AccountStore.findProjectByRepoUrl: recognizes a connected remote across workspaces (normalized)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-init-recog-'));
  try {
    const store = new AccountStore(root);
    const { user } = await store.register({ email: 'me@example.com', password: 'password-1234', name: 'Me' });
    const ws = await store.createWorkspace(user.id, { name: 'ZeracLabs' });
    await store.createProject(user.id, ws.id, {
      name: 'poc',
      repo_url: 'git@github.com:ZeracLabs/poc.git',
      local_path: '/tmp/poc',
    });

    // Different scheme + no .git suffix + different case still recognizes.
    const found = await store.findProjectByRepoUrl(user.id, 'https://github.com/zeraclabs/poc');
    assert.ok(found, 'expected the connected remote to be recognized');
    assert.equal(found!.project.name, 'poc');
    assert.equal(found!.workspace.name, 'ZeracLabs');
    assert.equal(found!.role, 'owner');

    // An unconnected remote is not recognized.
    const miss = await store.findProjectByRepoUrl(user.id, 'https://github.com/other/repo');
    assert.equal(miss, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
