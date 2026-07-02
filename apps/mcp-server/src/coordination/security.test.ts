import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendSecurityAudit,
  assertSameTenant,
  getSecurityStoreDir,
  isVisibleToRequester,
  loadRedactionRules,
  readSecurityAudit,
  redactInFlightDiff,
  TenantMismatchError,
  type InFlightDiffFile,
} from './security';

async function freshProjectDir(withIgnore?: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-security-test-'));
  if (withIgnore !== undefined) {
    await fsp.writeFile(path.join(dir, '.klauroignore'), withIgnore, 'utf8');
  }
  return dir;
}

async function freshCoordDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-coord-test-'));
  process.env.KLAURO_COORD_DIR = dir;
  return dir;
}

// ---------------------------------------------------------------------------
// Redaction / ignore filter
// ---------------------------------------------------------------------------

test('redactInFlightDiff drops .env, *.pem, id_rsa with reason=secret-pattern', async () => {
  const projectDir = await freshProjectDir();
  const rules = await loadRedactionRules(projectDir);

  const diff: InFlightDiffFile[] = [
    { path: '.env', content: 'SECRET=abc123' },
    { path: 'certs/server.pem', content: '-----BEGIN CERTIFICATE-----' },
    { path: '.ssh/id_rsa', content: '-----BEGIN RSA PRIVATE KEY-----' },
  ];

  const { kept, dropped } = redactInFlightDiff(diff, rules);

  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 3);
  for (const d of dropped) {
    assert.equal(d.reason, 'secret-pattern');
    // the secret content must never appear anywhere in the dropped record.
    assert.equal((d as any).content, undefined);
  }
  const droppedPaths = dropped.map((d) => d.path).sort();
  assert.deepEqual(droppedPaths, ['.env', '.ssh/id_rsa', 'certs/server.pem'].sort());
});

test('redactInFlightDiff keeps a normal src file', async () => {
  const projectDir = await freshProjectDir();
  const rules = await loadRedactionRules(projectDir);

  const diff: InFlightDiffFile[] = [{ path: 'src/x.ts', content: 'export const x = 1;' }];
  const { kept, dropped } = redactInFlightDiff(diff, rules);

  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].path, 'src/x.ts');
  assert.equal(kept[0].content, 'export const x = 1;');
});

test('redactInFlightDiff honors a .klauroignore glob', async () => {
  const projectDir = await freshProjectDir('private-fixtures/**\ncustomer-dumps/**\n');
  const rules = await loadRedactionRules(projectDir);
  assert.equal(rules.ignorePath, path.join(projectDir, '.klauroignore'));

  const diff: InFlightDiffFile[] = [
    { path: 'private-fixtures/dump.json', content: '{"pii": true}' },
    { path: 'src/keep.ts', content: 'ok' },
  ];
  const { kept, dropped } = redactInFlightDiff(diff, rules);

  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].path, 'private-fixtures/dump.json');
  assert.equal(dropped[0].reason, 'klauroignore');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].path, 'src/keep.ts');
});

test('redactInFlightDiff decoy: environment.ts is NOT treated as a secret', async () => {
  const projectDir = await freshProjectDir();
  const rules = await loadRedactionRules(projectDir);

  const diff: InFlightDiffFile[] = [
    { path: 'src/config/environment.ts', content: 'export const ENV = "prod";' },
    { path: 'src/secretsService.ts', content: 'export function getSecretsService() {}' },
  ];
  const { kept, dropped } = redactInFlightDiff(diff, rules);

  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 2);
});

test('redactInFlightDiff diffOnly mode strips full-file content but keeps patch', async () => {
  const projectDir = await freshProjectDir();
  const rules = await loadRedactionRules(projectDir);

  const diff: InFlightDiffFile[] = [
    { path: 'src/x.ts', patch: '@@ -1 +1 @@\n-old\n+new', content: 'new' },
  ];
  const { kept } = redactInFlightDiff(diff, rules, { diffOnly: true });

  assert.equal(kept.length, 1);
  assert.equal(kept[0].content, undefined);
  assert.equal(kept[0].patch, '@@ -1 +1 @@\n-old\n+new');
});

// ---------------------------------------------------------------------------
// Tenancy / authz
// ---------------------------------------------------------------------------

test('isVisibleToRequester: same org+workspace is visible', () => {
  const record = { org_id: 'org-a', workspace_id: 'ws-1' };
  const requester = { org_id: 'org-a', workspace_id: 'ws-1' };
  assert.equal(isVisibleToRequester(record, requester), true);
  assert.doesNotThrow(() => assertSameTenant(record, requester));
});

test('isVisibleToRequester: cross-org record is NOT visible', () => {
  const record = { org_id: 'org-a', workspace_id: 'ws-1' };
  const requester = { org_id: 'org-b', workspace_id: 'ws-1' };
  assert.equal(isVisibleToRequester(record, requester), false);
  assert.throws(() => assertSameTenant(record, requester), TenantMismatchError);
});

test('isVisibleToRequester: same org, different workspace is NOT visible', () => {
  const record = { org_id: 'org-a', workspace_id: 'ws-1' };
  const requester = { org_id: 'org-a', workspace_id: 'ws-2' };
  assert.equal(isVisibleToRequester(record, requester), false);
});

test('isVisibleToRequester: InFlightSnapshot-shaped record using `workspace` field', () => {
  const record = { org_id: 'org-a', workspace: 'ws-1' };
  const requester = { org_id: 'org-a', workspace_id: 'ws-1' };
  assert.equal(isVisibleToRequester(record, requester), true);
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

test('appendSecurityAudit round-trips through readSecurityAudit', async () => {
  await freshCoordDir();
  const dir = getSecurityStoreDir('ws-test');

  await appendSecurityAudit(dir, {
    ts: new Date().toISOString(),
    actor: 'agent-a',
    action: 'publish-in-flight',
    workspace: 'ws-test',
    scope: 'src/foo.ts',
  });
  await appendSecurityAudit(dir, {
    ts: new Date().toISOString(),
    actor: 'agent-b',
    action: 'read-in-flight',
    workspace: 'ws-test',
    scope: 'src/foo.ts',
  });

  const entries = await readSecurityAudit(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].actor, 'agent-a');
  assert.equal(entries[0].action, 'publish-in-flight');
  assert.equal(entries[1].actor, 'agent-b');
  assert.equal(entries[1].action, 'read-in-flight');
});

test('readSecurityAudit returns empty array when no audit log exists yet', async () => {
  await freshCoordDir();
  const dir = getSecurityStoreDir('ws-never-touched');
  const entries = await readSecurityAudit(dir);
  assert.deepEqual(entries, []);
});
