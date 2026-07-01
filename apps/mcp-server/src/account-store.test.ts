import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccountHttpError, AccountStore } from './account-store';

test('account store creates users, default workspaces, sessions, and projects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-'));
  const store = new AccountStore(root);

  try {
    const created = await store.register({
      email: 'Owner@Example.com',
      name: 'Owner User',
      password: 'correct horse battery staple',
      workspaceName: 'Main Workspace',
    });

    assert.equal(created.user.email, 'owner@example.com');
    assert.ok(created.token.startsWith('ks_'));
    assert.equal((await store.authenticate(created.token))?.id, created.user.id);

    const workspaces = await store.listWorkspaces(created.user.id);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].name, 'Main Workspace');
    assert.equal(workspaces[0].role, 'owner');

    const project = await store.createProject(created.user.id, workspaces[0].id, {
      name: 'API',
      repo_url: 'https://github.com/example/api',
      local_path: '/tmp/api',
    });

    assert.equal(project.workspace_id, workspaces[0].id);
    assert.equal((await store.listProjects(created.user.id, workspaces[0].id)).length, 1);
    assert.equal((await store.getProjectForUser(created.user.id, project.id))?.name, 'API');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account store supports many users across many workspaces', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-members-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'owner@example.com', password: 'password-1234', workspaceName: 'Alpha' });
    const member = await store.register({ email: 'member@example.com', password: 'password-1234', workspaceName: 'Personal' });
    const alpha = (await store.listWorkspaces(owner.user.id))[0];
    const beta = await store.createWorkspace(owner.user.id, { name: 'Beta' });

    await store.addWorkspaceUser(owner.user.id, alpha.id, { email: member.user.email, role: 'member' });
    await store.addWorkspaceUser(owner.user.id, beta.id, { email: member.user.email, role: 'admin' });

    const memberWorkspaces = await store.listWorkspaces(member.user.id);
    assert.deepEqual(memberWorkspaces.map(workspace => workspace.name).sort(), ['Alpha', 'Beta', 'Personal']);
    assert.equal((await store.listWorkspaceUsers(member.user.id, alpha.id)).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account store rejects invalid login and cross-workspace project access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-authz-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'owner@example.com', password: 'password-1234', workspaceName: 'Owned' });
    const outsider = await store.register({ email: 'outsider@example.com', password: 'password-1234', workspaceName: 'Other' });
    const workspace = (await store.listWorkspaces(owner.user.id))[0];
    const project = await store.createProject(owner.user.id, workspace.id, { name: 'Private Repo' });

    await assert.rejects(
      () => store.login({ email: owner.user.email, password: 'wrong-password' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 401,
    );
    await assert.rejects(
      () => store.getProjectForUser(outsider.user.id, project.id),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 404,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
