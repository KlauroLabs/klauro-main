import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { resolveSelfUpdateTarget, isUnboundHostedProjectId, probeHostedProjectBinding } from './cli';
import { writeProjectBindingIntoConfig, loadKlauroConfig } from './klauro-config';

// --- BUG 1: `klauro update` must target the RUNNING installation's prefix ---

test('resolveSelfUpdateTarget derives the prefix from the installed CLI realpath (nvm install, homebrew npm on PATH)', () => {
  // The field bug: homebrew node 26 owns PATH's npm, but the CLI actually
  // running was installed under nvm node 22's global prefix.
  const nvmPrefix = '/Users/dev/.nvm/versions/node/v22.11.0';
  const target = resolveSelfUpdateTarget({
    platform: 'darwin',
    execPath: `${nvmPrefix}/bin/node`,
    scriptPath: `${nvmPrefix}/bin/klauro`,
    realpath: () => `${nvmPrefix}/lib/node_modules/klauro/dist/cli.cjs`,
    exists: (p) => p === `${nvmPrefix}/bin/npm` || p === `${nvmPrefix}/bin/node`,
  });
  assert.equal(target.prefix, nvmPrefix);
  assert.equal(target.prefixSource, 'cli-realpath');
  // And it uses the prefix's own npm+node, not PATH's homebrew pair.
  assert.equal(target.npmBin, `${nvmPrefix}/bin/npm`);
  assert.equal(target.nodeBin, `${nvmPrefix}/bin/node`);
});

test('resolveSelfUpdateTarget prefers the DETECTED prefix’s npm/node even when the process runs under a different node (homebrew node driving an nvm-installed CLI)', () => {
  // The exact ABI trap: PATH's homebrew node 26 launched the nvm-installed
  // CLI. npm must come from (and run with) the nvm prefix so node-gyp builds
  // tree-sitter for node 22, not 26.
  const nvmPrefix = '/Users/dev/.nvm/versions/node/v22.11.0';
  const target = resolveSelfUpdateTarget({
    platform: 'darwin',
    execPath: '/opt/homebrew/Cellar/node/26.4.0/bin/node',
    scriptPath: `${nvmPrefix}/bin/klauro`,
    realpath: () => `${nvmPrefix}/lib/node_modules/@klauro/mcp-server/dist/cli.cjs`,
    exists: (p) => p.startsWith(nvmPrefix) || p.startsWith('/opt/homebrew'),
  });
  assert.equal(target.prefix, nvmPrefix);
  assert.equal(target.prefixSource, 'cli-realpath');
  assert.equal(target.npmBin, `${nvmPrefix}/bin/npm`);
  assert.equal(target.nodeBin, `${nvmPrefix}/bin/node`);
});

test('resolveSelfUpdateTarget falls back to the running node prefix when the script is not a global install (dev run)', () => {
  const target = resolveSelfUpdateTarget({
    platform: 'darwin',
    execPath: '/opt/homebrew/bin/node',
    scriptPath: '/Users/dev/repo/apps/mcp-server/src/cli.ts',
    realpath: (p) => p, // no node_modules marker in the path
    exists: () => false, // no npm beside node either
  });
  assert.equal(target.prefix, '/opt/homebrew');
  assert.equal(target.prefixSource, 'exec-path');
  assert.equal(target.npmBin, 'npm'); // PATH npm, pinned by --prefix at the call site
});

test('resolveSelfUpdateTarget survives a realpath failure (deleted bin) via the exec-path fallback', () => {
  const target = resolveSelfUpdateTarget({
    platform: 'linux',
    execPath: '/usr/local/bin/node',
    scriptPath: '/usr/local/bin/klauro',
    realpath: () => { throw new Error('ENOENT'); },
    exists: (p) => p === '/usr/local/bin/npm',
  });
  assert.equal(target.prefix, '/usr/local');
  assert.equal(target.prefixSource, 'exec-path');
  assert.equal(target.npmBin, '/usr/local/bin/npm');
});

test('resolveSelfUpdateTarget handles the Windows layout (prefix = node dir, node_modules directly under it)', () => {
  const target = resolveSelfUpdateTarget({
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    scriptPath: 'C:\\Program Files\\nodejs\\klauro.cmd',
    realpath: () => 'C:\\Program Files\\nodejs\\node_modules\\klauro\\dist\\cli.cjs',
    exists: (p) => p === 'C:\\Program Files\\nodejs\\npm.cmd',
  });
  assert.equal(target.prefix, 'C:\\Program Files\\nodejs');
  assert.equal(target.prefixSource, 'cli-realpath');
  assert.equal(target.npmBin, 'C:\\Program Files\\nodejs\\npm.cmd');
});

// --- BUG 2: stale unbound .klaurorc must self-heal on `klauro init` ---

test('isUnboundHostedProjectId: null / missing / placeholder ids are unbound; prj_ ids are bound', () => {
  assert.equal(isUnboundHostedProjectId(null), true);
  assert.equal(isUnboundHostedProjectId(undefined), true);
  assert.equal(isUnboundHostedProjectId(''), true);
  assert.equal(isUnboundHostedProjectId('local-project'), true);
  assert.equal(isUnboundHostedProjectId(123), true);
  assert.equal(isUnboundHostedProjectId('prj_wbW33mwfETn1N41'), false);
});

test('writeProjectBindingIntoConfig binds an unbound .klaurorc additively, preserving user customizations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-heal-'));
  try {
    // A stale config as an old broken CLI wrote it: project.id null, plus
    // user-tuned source excludes and a hand-picked name that must survive.
    const stale = {
      version: 1,
      kind: 'project',
      project: { name: 'my-custom-name', id: null },
      source: { roots: ['.'], exclude: ['**/generated/**', '**/*.snap'] },
      analyzer: { serverUrl: 'https://mcp.klauro.com' },
    };
    const configPath = path.join(dir, '.klaurorc');
    await fs.writeFile(configPath, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

    const result = await writeProjectBindingIntoConfig(dir, {
      projectId: 'prj_abc123',
      workspaceId: 'wsp_xyz789',
      organizationId: 'wsp_xyz789',
      projectName: 'server-derived-name',
      kind: 'project',
    });
    assert.equal(result.configPath, configPath);

    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // Bound now:
    assert.equal(raw.project.id, 'prj_abc123');
    assert.equal(raw.project.workspaceId, 'wsp_xyz789');
    assert.equal(raw.project.organizationId, 'wsp_xyz789');
    // Additive: the user's name and source customizations were NOT clobbered.
    assert.equal(raw.project.name, 'my-custom-name');
    assert.deepEqual(raw.source.exclude, ['**/generated/**', '**/*.snap']);
    assert.equal(raw.analyzer.serverUrl, 'https://mcp.klauro.com');

    // And the healed config now loads as bound (the init no-op-verify path).
    const loaded = await loadKlauroConfig(dir);
    assert.equal(isUnboundHostedProjectId(loaded.config.project.id), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeProjectBindingIntoConfig fills the name only when the file has none', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-heal-'));
  try {
    await fs.writeFile(path.join(dir, '.klaurorc'), `${JSON.stringify({ version: 1, project: { id: null } }, null, 2)}\n`, 'utf8');
    await writeProjectBindingIntoConfig(dir, { projectId: 'prj_1', projectName: 'from-server' });
    const raw = JSON.parse(await fs.readFile(path.join(dir, '.klaurorc'), 'utf8'));
    assert.equal(raw.project.name, 'from-server');
    assert.equal(raw.project.id, 'prj_1');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('probeHostedProjectBinding: only a definite server 404 reports not_found (rebind trigger); 200 = bound; everything else indeterminate', async () => {
  const fetchFor = (status: number) =>
    (async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch;

  // A live project for this account — the binding is real, never rebind.
  assert.equal(await probeHostedProjectBinding('https://mcp.klauro.com', 'tok', 'prj_live', fetchFor(200)), 'bound');
  // The server does not know the project for this account — the ONLY case
  // that licenses a rebind (with explicit --workspace intent at the call site).
  assert.equal(await probeHostedProjectBinding('https://mcp.klauro.com', 'tok', 'prj_gone', fetchFor(404)), 'not_found');
  // Expired token / server trouble / overload: NOT evidence the binding is
  // stale — must never trigger a rebind.
  assert.equal(await probeHostedProjectBinding('https://mcp.klauro.com', 'tok', 'prj_x', fetchFor(401)), 'indeterminate');
  assert.equal(await probeHostedProjectBinding('https://mcp.klauro.com', 'tok', 'prj_x', fetchFor(500)), 'indeterminate');
  assert.equal(await probeHostedProjectBinding('https://mcp.klauro.com', 'tok', 'prj_x', fetchFor(524)), 'indeterminate');
  // Network failure: same — leave the file untouched.
  const netFail = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  assert.equal(await probeHostedProjectBinding('https://mcp.klauro.com', 'tok', 'prj_x', netFail), 'indeterminate');
});

test('probeHostedProjectBinding URL-encodes the project id into GET /api/projects/{id}', async () => {
  let requested: string | undefined;
  const capture = (async (url: string) => {
    requested = url;
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  await probeHostedProjectBinding('https://mcp.klauro.com', 'tok', 'prj_a/b', capture);
  assert.equal(requested, 'https://mcp.klauro.com/api/projects/prj_a%2Fb');
});

test('writeProjectBindingIntoConfig refuses to run without an existing .klaurorc (init owns creation)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-heal-'));
  try {
    await assert.rejects(
      () => writeProjectBindingIntoConfig(dir, { projectId: 'prj_1' }),
      /No \.klaurorc found/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
