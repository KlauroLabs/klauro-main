import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccountHttpError, AccountStore } from './account-store';

test('project telemetry credentials are hashed, project-bound, ingest-only, and persistent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-project-telemetry-credential-'));
  try {
    const store = new AccountStore(root);
    const owner = await store.register({
      email: 'telemetry-owner@example.com',
      password: 'password-1234',
      workspaceName: 'Telemetry',
    });
    const workspace = (await store.listWorkspaces(owner.user.id))[0];
    const firstProject = await store.createProject(owner.user.id, workspace.id, { name: 'First' });
    const secondProject = await store.createProject(owner.user.id, workspace.id, { name: 'Second' });

    const issued = await store.issueProjectTelemetryCredential(owner.user.id, firstProject.id);
    assert.match(issued.token, /^kt_[A-Za-z0-9_-]+$/);
    assert.equal(issued.scope, 'telemetry:ingest');
    assert.equal((await store.authenticateProjectTelemetryCredential(issued.token, firstProject.id))?.id, issued.id);
    assert.equal(await store.authenticateProjectTelemetryCredential(issued.token, secondProject.id), null);
    assert.equal(await store.authenticate(issued.token), null, 'telemetry token cannot authenticate account APIs');

    const stored = fs.readFileSync(path.join(root, 'accounts', 'accounts.json'), 'utf8');
    assert.equal(stored.includes(issued.token), false);
    const parsed = JSON.parse(stored);
    assert.match(parsed.telemetry_credentials[0].token_hash, /^[0-9a-f]{64}$/);
    assert.equal(parsed.telemetry_credentials[0].scope, 'telemetry:ingest');

    const reloaded = new AccountStore(root);
    assert.equal((await reloaded.authenticateProjectTelemetryCredential(issued.token, firstProject.id))?.project_id, firstProject.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rotation and revocation invalidate prior project telemetry credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-project-telemetry-rotation-'));
  try {
    const store = new AccountStore(root);
    const owner = await store.register({ email: 'owner@example.com', password: 'password-1234', workspaceName: 'Telemetry' });
    const workspace = (await store.listWorkspaces(owner.user.id))[0];
    const project = await store.createProject(owner.user.id, workspace.id, { name: 'Service' });
    const first = await store.issueProjectTelemetryCredential(owner.user.id, project.id);
    const rotated = await store.rotateProjectTelemetryCredential(owner.user.id, project.id, first.id);

    assert.equal(await store.authenticateProjectTelemetryCredential(first.token, project.id), null);
    assert.equal((await store.authenticateProjectTelemetryCredential(rotated.token, project.id))?.id, rotated.id);
    await store.revokeProjectTelemetryCredential(owner.user.id, project.id, rotated.id);
    assert.equal(await store.authenticateProjectTelemetryCredential(rotated.token, project.id), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only workspace owners and admins can manage project telemetry credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-project-telemetry-access-'));
  try {
    const store = new AccountStore(root);
    const owner = await store.register({ email: 'owner@example.com', password: 'password-1234', workspaceName: 'Telemetry' });
    const member = await store.register({ email: 'member@example.com', password: 'password-1234', workspaceName: 'Personal' });
    const outsider = await store.register({ email: 'outsider@example.com', password: 'password-1234', workspaceName: 'Other' });
    const workspace = (await store.listWorkspaces(owner.user.id))[0];
    await store.addWorkspaceUser(owner.user.id, workspace.id, { email: member.user.email, role: 'member' });
    const project = await store.createProject(owner.user.id, workspace.id, { name: 'Private Service' });

    for (const userId of [member.user.id, outsider.user.id]) {
      await assert.rejects(
        () => store.issueProjectTelemetryCredential(userId, project.id),
        (error: unknown) => error instanceof AccountHttpError && (error.statusCode === 403 || error.statusCode === 404),
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
