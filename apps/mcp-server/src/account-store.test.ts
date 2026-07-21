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

// §COORD-AUTH-401 regression — TASK #68: a 10-agent fleet reported
// /v1/coordination/* flipping from working to 401 ~30-40 min into a session,
// with the same Bearer token freshly read from disk each time. Root cause:
// every AccountStore mutation used to be a bare `load()` ... `save(db)` pair
// with NO locking around the read-modify-write span — `save()`'s writeQueue
// only serialized the physical `fs.writeJson` calls, not the critical
// section. Two concurrent mutations (e.g. one lane's `/v1/analyze` push
// calling setProjectAnalysisId while another lane logs in) could both load()
// the same snapshot, mutate independently, then the second save() clobbers
// the first — silently dropping the first mutation's session/data (a lost
// update). This test fires a burst of concurrent session-creating (login)
// and non-session (setProjectAnalysisId) mutations at ONE store instance —
// the same shape a multi-lane fleet produces — and asserts every session
// survives and authenticates. Before the AccountStore.mutate() fix, this
// reliably lost sessions under concurrency; after the fix, none are lost.
test('concurrent account mutations never lose a session (lost-update regression)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-race-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'fleet-owner@example.com', password: 'password-1234', workspaceName: 'Fleet' });
    const workspace = (await store.listWorkspaces(owner.user.id))[0];
    const project = await store.createProject(owner.user.id, workspace.id, { name: 'Coordinated Repo' });

    const LANES = 25;
    // Every lane registers its own account (each register() call is itself
    // a multi-record mutation: user + workspace + membership + session) AND
    // concurrently the "owner" lane hammers setProjectAnalysisId — the
    // highest-frequency real-world write (fires on every /v1/analyze push) —
    // to maximize interleaving against the registrations.
    const registrations = Promise.all(
      Array.from({ length: LANES }, (_, i) =>
        store.register({ email: `lane-${i}@example.com`, password: 'password-1234' })),
    );
    const pushes = Promise.all(
      Array.from({ length: LANES }, (_, i) =>
        store.setProjectAnalysisId(owner.user.id, project.id, `analysis-${i}`)),
    );

    const [lanes] = await Promise.all([registrations, pushes]);

    // Every lane's session must still authenticate — none silently dropped
    // by an overwritten save().
    for (const lane of lanes) {
      const authed = await store.authenticate(lane.token);
      assert.ok(authed, `session for ${lane.user.email} was lost to a concurrent-write race`);
      assert.equal(authed?.id, lane.user.id);
    }

    // The owner's own original session (created by the very first register())
    // must ALSO have survived every subsequent concurrent mutation.
    assert.ok(await store.authenticate(owner.token), 'the pre-existing owner session was dropped by a concurrent mutation');

    // The project write itself must have landed (whichever push happened to
    // be last is fine — the point is the store is never left corrupt/blank).
    const finalProject = await store.getProjectForUser(owner.user.id, project.id);
    assert.ok(finalProject?.analysis_id?.startsWith('analysis-'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
