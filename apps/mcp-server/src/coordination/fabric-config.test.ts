/**
 * fabric-config.test.ts — the config-file + CLI-driven transport resolution
 * for the remote coordination fabric (docs/FABRIC-REMOTE.md). Locks the
 * precedence contract: explicit args > .klaurorc fabric section (a disabled
 * section beats env — `klauro fabric off` means OFF) > FAB_* env escape
 * hatch > local default. And the security contract: the token is resolved
 * from the credential store / env at call time, never from .klaurorc.
 */
import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  DEFAULT_FABRIC_WORKSPACE,
  detectWorkspaceIdentity,
  findFabricProjectRoot,
  hostedCoordinationWorkspace,
  normalizeGitRemote,
  resolveFabricSettings,
  resolveFabricToken,
  writeFabricSection,
} from './fabric-config';

let root: string;
let savedAuthPath: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-fabric-config-test-'));
  // Point the credential store at an isolated file so tests never read the
  // developer's real ~/.klauro/auth.json.
  savedAuthPath = process.env.KLAURO_AUTH_CONFIG_PATH;
  process.env.KLAURO_AUTH_CONFIG_PATH = path.join(root, 'auth.json');
});

afterEach(() => {
  if (savedAuthPath === undefined) delete process.env.KLAURO_AUTH_CONFIG_PATH;
  else process.env.KLAURO_AUTH_CONFIG_PATH = savedAuthPath;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.klaurorc'), `${JSON.stringify(config, null, 2)}\n`);
}

function seedAuth(serverUrl: string, token: string): void {
  fs.writeFileSync(process.env.KLAURO_AUTH_CONFIG_PATH!, JSON.stringify({
    version: 1,
    defaultServerUrl: serverUrl,
    accounts: { [serverUrl]: { token, updated_at: new Date().toISOString() } },
  }));
}

// Env passed to resolveFabricSettings in tests: empty by default so the host
// shell's variables can never leak into an assertion.
const noEnv: NodeJS.ProcessEnv = {};

test('no config + no env = local mode with the default workspace (original behavior)', async () => {
  const dir = path.join(root, 'plain');
  fs.mkdirSync(dir, { recursive: true });
  const settings = await resolveFabricSettings({ cwd: dir, env: noEnv });
  assert.equal(settings.remote, undefined);
  assert.equal(settings.workspace, DEFAULT_FABRIC_WORKSPACE);
  assert.equal(settings.workspaceSource, 'default');
});

test('.klaurorc fabric enabled routes remote with the config workspace, token from the credential store', async () => {
  const dir = path.join(root, 'repo');
  writeConfig(dir, { version: 1, fabric: { enabled: true, endpoint: 'http://127.0.0.1:9999', workspace: 'team-ws' } });
  seedAuth('http://127.0.0.1:9999', 'stored-token');
  const settings = await resolveFabricSettings({ cwd: dir, env: noEnv });
  assert.equal(settings.remote?.baseUrl, 'http://127.0.0.1:9999');
  assert.equal(settings.remote?.token, 'stored-token');
  assert.equal(settings.remoteSource, 'config');
  assert.equal(settings.workspace, 'team-ws');
  assert.equal(settings.workspaceSource, 'config');
});

test('config is found by walking UP from a subdirectory (git-style)', async () => {
  const dir = path.join(root, 'repo');
  writeConfig(dir, { version: 1, fabric: { enabled: true, endpoint: 'http://127.0.0.1:9999', workspace: 'team-ws' } });
  const sub = path.join(dir, 'src', 'deep', 'nested');
  fs.mkdirSync(sub, { recursive: true });
  const settings = await resolveFabricSettings({ cwd: sub, env: noEnv });
  assert.equal(settings.remote?.baseUrl, 'http://127.0.0.1:9999');
  assert.equal(settings.workspace, 'team-ws');
  assert.equal(findFabricProjectRoot(sub)?.root, dir);
});

test('explicit args beat config; explicit token beats the store', async () => {
  const dir = path.join(root, 'repo');
  writeConfig(dir, { version: 1, fabric: { enabled: true, endpoint: 'http://config:1', workspace: 'config-ws' } });
  const settings = await resolveFabricSettings({
    cwd: dir,
    env: noEnv,
    explicitUrl: 'http://explicit:2',
    explicitToken: 'explicit-token',
    explicitWorkspace: 'explicit-ws',
  });
  assert.equal(settings.remote?.baseUrl, 'http://explicit:2');
  assert.equal(settings.remote?.token, 'explicit-token');
  assert.equal(settings.remoteSource, 'explicit');
  assert.equal(settings.workspace, 'explicit-ws');
  assert.equal(settings.workspaceSource, 'explicit');
});

test('a DISABLED fabric section beats env vars — `klauro fabric off` means OFF', async () => {
  const dir = path.join(root, 'repo');
  writeConfig(dir, { version: 1, fabric: { enabled: false, endpoint: 'http://config:1', workspace: 'config-ws' } });
  const settings = await resolveFabricSettings({
    cwd: dir,
    env: { FAB_REMOTE_URL: 'http://env:3', FAB_REMOTE_TOKEN: 'env-token', FAB_WS: 'env-ws' },
  });
  assert.equal(settings.remote, undefined);
  // Workspace still honors the config section even when disabled, so local
  // claims land where the team expects.
  assert.equal(settings.workspace, 'config-ws');
});

test('env vars remain a working escape hatch when NO config exists (CI)', async () => {
  const dir = path.join(root, 'plain');
  fs.mkdirSync(dir, { recursive: true });
  const settings = await resolveFabricSettings({
    cwd: dir,
    env: { FAB_REMOTE_URL: 'http://env:3', FAB_REMOTE_TOKEN: 'env-token', FAB_WS: 'env-ws' },
  });
  assert.equal(settings.remote?.baseUrl, 'http://env:3');
  assert.equal(settings.remote?.token, 'env-token');
  assert.equal(settings.remoteSource, 'env');
  assert.equal(settings.workspace, 'env-ws');
  assert.equal(settings.workspaceSource, 'env');
});

test('config workspace beats FAB_WS; FAB_WS beats the default', async () => {
  const dir = path.join(root, 'repo');
  writeConfig(dir, { version: 1, fabric: { enabled: false, workspace: 'config-ws' } });
  const withConfig = await resolveFabricSettings({ cwd: dir, env: { FAB_WS: 'env-ws' } });
  assert.equal(withConfig.workspace, 'config-ws');

  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  const withEnv = await resolveFabricSettings({ cwd: plain, env: { FAB_WS: 'env-ws' } });
  assert.equal(withEnv.workspace, 'env-ws');
});

test('malformed .klaurorc degrades to the env-then-local chain, never throws', async () => {
  const dir = path.join(root, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.klaurorc'), '{not json');
  const settings = await resolveFabricSettings({ cwd: dir, env: noEnv });
  assert.equal(settings.remote, undefined);
  assert.equal(settings.workspace, DEFAULT_FABRIC_WORKSPACE);
});

test('resolveFabricToken precedence: explicit > FAB_REMOTE_TOKEN > credential store; never from .klaurorc', () => {
  seedAuth('http://127.0.0.1:9999', 'stored-token');
  assert.equal(resolveFabricToken('http://127.0.0.1:9999', {}, 'explicit'), 'explicit');
  assert.equal(resolveFabricToken('http://127.0.0.1:9999', { FAB_REMOTE_TOKEN: 'ci-token' }), 'ci-token');
  assert.equal(resolveFabricToken('http://127.0.0.1:9999', {}), 'stored-token');
});

test('writeFabricSection is additive: only the fabric key changes, no token ever lands in the file', () => {
  const dir = path.join(root, 'repo');
  writeConfig(dir, { version: 1, project: { name: 'my-app', id: 'proj-123' }, analyzer: { serverUrl: 'http://x' }, custom_key: 'preserved' });
  const { configPath, created } = writeFabricSection(dir, { enabled: true, endpoint: 'http://127.0.0.1:9999', workspace: 'ws' });
  assert.equal(created, false);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(raw.custom_key, 'preserved');
  assert.equal(raw.project.id, 'proj-123');
  assert.deepEqual(raw.fabric, { enabled: true, endpoint: 'http://127.0.0.1:9999', workspace: 'ws' });
  assert.ok(!fs.readFileSync(configPath, 'utf8').includes('token'));
});

test('writeFabricSection creates a minimal config when none exists', () => {
  const dir = path.join(root, 'fresh');
  fs.mkdirSync(dir, { recursive: true });
  const { configPath, created } = writeFabricSection(dir, { enabled: true, endpoint: 'http://x', workspace: 'ws' });
  assert.equal(created, true);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.project.name, 'fresh');
  assert.equal(raw.fabric.enabled, true);
});

test('workspace identity precedence: project.id > git remote hash > repo basename', () => {
  const dir = path.join(root, 'identity-repo');
  fs.mkdirSync(dir, { recursive: true });

  // 1. project.id wins when present.
  assert.deepEqual(detectWorkspaceIdentity(dir, 'proj-123'), { workspace: 'proj-123', source: 'project-id' });

  // 3. no project.id, no git remote -> repo basename.
  const noGit = detectWorkspaceIdentity(dir);
  assert.equal(noGit.source, 'repo-basename');
  assert.equal(noGit.workspace, 'identity-repo');

  // 2. a git remote produces a stable, clone-independent id.
  try {
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:Acme/My-App.git'], { stdio: 'ignore' });
  } catch {
    return; // No git on this machine — the other two branches are covered.
  }
  const fromGit = detectWorkspaceIdentity(dir);
  assert.equal(fromGit.source, 'git-remote');
  assert.match(fromGit.workspace, /^my-app-[0-9a-f]{8}$/);

  // The SAME identity from the https form of the same remote (a second
  // machine cloning over https must land in the same workspace).
  const dir2 = path.join(root, 'identity-repo-2');
  fs.mkdirSync(dir2, { recursive: true });
  try {
    execFileSync('git', ['-C', dir2, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir2, 'remote', 'add', 'origin', 'https://github.com/Acme/My-App.git'], { stdio: 'ignore' });
  } catch {
    return;
  }
  assert.equal(detectWorkspaceIdentity(dir2).workspace, fromGit.workspace);
});

test('normalizeGitRemote converges ssh/https/trailing-.git forms', () => {
  const expected = 'github.com/acme/my-app';
  assert.equal(normalizeGitRemote('git@github.com:Acme/My-App.git'), expected);
  assert.equal(normalizeGitRemote('https://github.com/acme/my-app'), expected);
  assert.equal(normalizeGitRemote('https://github.com/Acme/My-App.git'), expected);
  assert.equal(normalizeGitRemote('ssh://git@github.com/acme/my-app.git'), expected);
});

test('remote probes address the bound project id unless the configured workspace is already a hosted id', () => {
  assert.strictEqual(hostedCoordinationWorkspace('Klauro', 'prj_abc'), 'prj_abc');
  assert.strictEqual(hostedCoordinationWorkspace('poc', 'prj_abc'), 'prj_abc');
  assert.strictEqual(hostedCoordinationWorkspace('wsp_team', 'prj_abc'), 'wsp_team');
  assert.strictEqual(hostedCoordinationWorkspace('prj_other', 'prj_abc'), 'prj_other');
  assert.strictEqual(hostedCoordinationWorkspace('Klauro', undefined), 'Klauro');
  assert.strictEqual(hostedCoordinationWorkspace('Klauro', '  '), 'Klauro');
});
