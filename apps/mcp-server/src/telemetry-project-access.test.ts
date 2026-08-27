import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AccountStore } from './account-store';
import { ingestTelemetryBatch, loadIngestedTelemetry } from './telemetry-ingestion';
import { resolveAuthorizedHostedTelemetryStorage, resolveAuthorizedTelemetryProject } from './telemetry-project-access';

test('account telemetry access resolves canonical analysis ids and rejects cross-project access', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-access-'));
  const storage = path.join(root, 'storage');
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;
  try {
    const accounts = new AccountStore(root);
    const owner = await accounts.register({ email: 'telemetry-owner@example.com', password: 'password-1234', workspaceName: 'Owner' });
    const outsider = await accounts.register({ email: 'telemetry-outsider@example.com', password: 'password-1234', workspaceName: 'Outsider' });
    const workspace = (await accounts.listWorkspaces(owner.user.id))[0];
    const project = await accounts.createProject(owner.user.id, workspace.id, { name: 'Runtime API' });

    const preAnalysis = await resolveAuthorizedTelemetryProject(accounts, `user:${owner.user.id}`, project.id);
    assert.deepEqual(preAnalysis, { requested_id: project.id, storage_id: project.id });
    assert.deepEqual(await resolveAuthorizedTelemetryProject(accounts, 'shared-token', project.id), preAnalysis);
    assert.equal(await resolveAuthorizedTelemetryProject(accounts, `user:${outsider.user.id}`, project.id), null);
    assert.equal(await resolveAuthorizedTelemetryProject(accounts, `user:${owner.user.id}`, '/arbitrary/server/path'), null);

    await ingestTelemetryBatch(null, project.id, [{ event_id: 'before-analysis', kind: 'request', route: '/orders' }]);
    await accounts.setProjectAnalysisId(owner.user.id, project.id, 'acct_canonical_analysis');
    const analyzed = await resolveAuthorizedTelemetryProject(accounts, `user:${owner.user.id}`, project.id);
    assert.deepEqual(analyzed, { requested_id: project.id, storage_id: 'acct_canonical_analysis' });
    assert.deepEqual(await resolveAuthorizedTelemetryProject(accounts, 'shared-token', project.id), analyzed);
    assert.equal((await loadIngestedTelemetry('acct_canonical_analysis')).length, 1);
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fs.remove(root);
  }
});


test('hosted telemetry storage migrates legacy identities into the canonical analysis workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-hosted-telemetry-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
  try {
    const accounts = new AccountStore(root);
    const owner = await accounts.register({ email: 'hosted-telemetry-owner@example.com', password: 'password-1234', workspaceName: 'Owner' });
    const outsider = await accounts.register({ email: 'hosted-telemetry-outsider@example.com', password: 'password-1234', workspaceName: 'Outsider' });
    const workspace = (await accounts.listWorkspaces(owner.user.id))[0];
    const project = await accounts.createProject(owner.user.id, workspace.id, { name: 'Runtime API' });
    await ingestTelemetryBatch(null, project.id, [{ event_id: 'project-key', kind: 'request', route: '/orders' }]);
    const analysisId = 'acct_canonical_analysis';
    await accounts.setProjectAnalysisId(owner.user.id, project.id, analysisId);
    await resolveAuthorizedTelemetryProject(accounts, `user:${owner.user.id}`, project.id);
    await ingestTelemetryBatch(null, analysisId, [{ event_id: 'analysis-key', kind: 'request', route: '/orders' }]);
    const canonicalWorkspace = path.join(root, 'workspaces', analysisId);
    const resolved = await resolveAuthorizedHostedTelemetryStorage(
      accounts,
      `user:${owner.user.id}`,
      project.id,
      id => path.join(root, 'workspaces', id),
    );
    assert.deepEqual(resolved, {
      requested_id: project.id,
      analysis_id: analysisId,
      storage_key: canonicalWorkspace,
    });
    assert.equal((await loadIngestedTelemetry(canonicalWorkspace)).length, 2);
    assert.equal((await loadIngestedTelemetry(project.id)).length, 0);
    assert.equal((await loadIngestedTelemetry(analysisId)).length, 0);
    assert.equal(await resolveAuthorizedHostedTelemetryStorage(
      accounts,
      `user:${outsider.user.id}`,
      project.id,
      id => path.join(root, 'workspaces', id),
    ), null);
    assert.deepEqual(await resolveAuthorizedHostedTelemetryStorage(
      accounts,
      `user:${owner.user.id}`,
      project.id,
      id => path.join(root, 'workspaces', id),
    ), resolved, 'repeated canonical resolution is idempotent');
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fs.remove(root);
  }
});
