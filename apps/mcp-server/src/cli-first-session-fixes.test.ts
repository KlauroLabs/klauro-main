import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  checkNodeSupportedForNativeBuild,
  buildAnalysisStatusLine,
  DEFAULT_MAX_NODE,
  DEFAULT_MIN_NODE,
  detectBuildNodeVersion,
  buildUpdateSpawnEnv,
  resolveSupportedNodeRange,
} from './cli';
import { isNetworkUnreachableError, requireConnectorEntitlement, unreachableServerError } from './connector-auth';

// ---------------------------------------------------------------------------
// P0: Node-version gate (install.sh + `klauro update`)
// The verified ceiling: tree-sitter 0.25.x (no shipped prebuilds, binding.gyp
// pins -std=c++17) compiles against Node 22 headers and fails on 23/24/25/26
// with v8config.h "C++20 or later required".
// ---------------------------------------------------------------------------

test('checkNodeSupportedForNativeBuild: 18-22 pass with the baked-in defaults', () => {
  for (const major of [18, 20, 22]) {
    assert.equal(checkNodeSupportedForNativeBuild(major, null).ok, true, `node ${major} should be supported`);
  }
  assert.equal(DEFAULT_MIN_NODE, 18);
  assert.equal(DEFAULT_MAX_NODE, 22);
});

test('checkNodeSupportedForNativeBuild: 23+ fail with an actionable message (no manifest)', () => {
  for (const major of [23, 24, 25, 26]) {
    const result = checkNodeSupportedForNativeBuild(major, null);
    assert.equal(result.ok, false, `node ${major} must be gated`);
    assert.match(result.message || '', /Klauro currently supports Node 18-22; you have \d+/);
    assert.match(result.message || '', /nvm install 22|volta install node@22/);
  }
});

test('checkNodeSupportedForNativeBuild: too-old node fails with an upgrade message', () => {
  const result = checkNodeSupportedForNativeBuild(16, null);
  assert.equal(result.ok, false);
  assert.match(result.message || '', /you have 16/);
});

test('checkNodeSupportedForNativeBuild: the hosted manifest widens the range without a new CLI', () => {
  const manifest = { min_node: 18, max_node: 24, supported_node_range: '18-24' };
  assert.equal(checkNodeSupportedForNativeBuild(24, manifest).ok, true);
  const gated = checkNodeSupportedForNativeBuild(26, manifest);
  assert.equal(gated.ok, false);
  assert.match(gated.message || '', /18-24/);
});

test('update node gate accepts only a complete coherent hosted range', () => {
  assert.deepEqual(resolveSupportedNodeRange({ min_node: 18, max_node: 24 }), { min: 18, max: 24, range: '18-24' });
  assert.deepEqual(resolveSupportedNodeRange({ min_node: 18 }), { min: 18, max: 22, range: '18-22' });
  assert.deepEqual(resolveSupportedNodeRange({ min_node: 24, max_node: 18 }), { min: 18, max: 22, range: '18-22' });
  assert.deepEqual(resolveSupportedNodeRange({ min_node: 18, max_node: 999 }), { min: 18, max: 22, range: '18-22' });
});

// ---------------------------------------------------------------------------
// #59 regression: `klauro update` must gate on the node that ACTUALLY drives
// the native build (target.nodeBin when the resolved prefix carries its own
// node), and every child process npm spawns during the install (node-gyp
// included) must resolve `node` to that SAME binary — not whatever happens
// to be first on PATH — or the gate can pass while the compile still runs
// under an unsupported node.
// ---------------------------------------------------------------------------

async function writeFakeNodeShim(dir: string, version: string): Promise<string> {
  const nodePath = path.join(dir, 'node');
  await fs.writeFile(nodePath, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return nodePath;
}

test('detectBuildNodeVersion: reads the RESOLVED prefix node, not process.version, when nodeBin is set', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-update-node-'));
  try {
    const nodeBin = await writeFakeNodeShim(dir, 'v22.11.0');
    const version = detectBuildNodeVersion({ nodeBin }, { processVersion: 'v26.4.0' });
    assert.equal(version, 'v22.11.0', 'must use the prefix node, not the unrelated process.version fallback');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('detectBuildNodeVersion: falls back to processVersion when no nodeBin was resolved', () => {
  assert.equal(detectBuildNodeVersion({ nodeBin: undefined }, { processVersion: 'v20.9.0' }), 'v20.9.0');
});

test('detectBuildNodeVersion + checkNodeSupportedForNativeBuild: an unsupported ACTIVE node is refused with the actionable message even when process.version looks fine', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-update-node-'));
  try {
    // Simulates the field bug: the process running `klauro update` reports a
    // supported version, but the prefix that actually owns the install (and
    // will run npm/node-gyp) carries an unsupported node.
    const nodeBin = await writeFakeNodeShim(dir, 'v26.4.0');
    const version = detectBuildNodeVersion({ nodeBin }, { processVersion: 'v22.11.0' });
    const major = Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
    const result = checkNodeSupportedForNativeBuild(major, null);
    assert.equal(result.ok, false);
    assert.match(result.message || '', /Klauro currently supports Node 18-22; you have 26/);
    assert.match(result.message || '', /nvm install 22|volta install node@22/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('detectBuildNodeVersion + checkNodeSupportedForNativeBuild: a supported resolved node proceeds past the gate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-update-node-'));
  try {
    const nodeBin = await writeFakeNodeShim(dir, 'v20.15.0');
    const version = detectBuildNodeVersion({ nodeBin });
    const major = Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
    assert.equal(checkNodeSupportedForNativeBuild(major, null).ok, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('buildUpdateSpawnEnv: prepends the resolved node\'s directory to PATH so child `env node` lookups (node-gyp) resolve to it first', () => {
  const env = buildUpdateSpawnEnv({ nodeBin: '/opt/nvm/versions/node/v22.11.0/bin/node' }, { PATH: '/usr/local/bin:/usr/bin' });
  assert.equal(env.PATH, '/opt/nvm/versions/node/v22.11.0/bin:/usr/local/bin:/usr/bin');
});

test('buildUpdateSpawnEnv: leaves env untouched when no nodeBin was resolved (npm run via PATH as before)', () => {
  const baseEnv = { PATH: '/usr/local/bin:/usr/bin' };
  assert.equal(buildUpdateSpawnEnv({ nodeBin: undefined }, baseEnv), baseEnv);
});

test('buildUpdateSpawnEnv: an actual `env node` child process resolves the prefix node first, proving the PATH fix closes the #59 gap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-update-path-'));
  try {
    const nodeBin = await writeFakeNodeShim(dir, 'v22.11.0');
    // A decoy "node" earlier in the base PATH simulates the homebrew node 26
    // that caused the field failure: unfixed, `env node` would find this one.
    const decoyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-update-decoy-'));
    await writeFakeNodeShim(decoyDir, 'v26.4.0');
    const env = buildUpdateSpawnEnv({ nodeBin }, { PATH: `${decoyDir}:${process.env.PATH ?? ''}` });
    const result = spawnSync('env', ['node'], { encoding: 'utf8', env });
    assert.equal((result.stdout || '').trim(), 'v22.11.0', 'child `env node` must resolve the prefix node, not the decoy earlier on PATH');
    await fs.rm(decoyDir, { recursive: true, force: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P1: `klauro status` must consult the hosted analysis state for a bound repo
// (cold-customer audit: seconds after a successful hosted init+analysis,
// status said "not analyzed (klauro analyze .)").
// ---------------------------------------------------------------------------

const localNotAnalyzed = { analyzed: false, analysis_complete: false } as const;

test('buildAnalysisStatusLine: hosted ready beats the empty local store', () => {
  const line = buildAnalysisStatusLine({
    repoPath: '/repo',
    hostedProjectId: 'prj_abc',
    hosted: { status: 'ready', analysis_id: 'ana_1', summary: { name: 'My System', analysis_timestamp: '2026-07-12T00:00:00Z' } },
    local: localNotAnalyzed,
  });
  assert.match(line, /analyzed on server/);
  assert.match(line, /My System/);
  assert.doesNotMatch(line, /not analyzed/);
});

test('buildAnalysisStatusLine: hosted populating reports in-progress, never "not analyzed"', () => {
  const line = buildAnalysisStatusLine({
    repoPath: '/repo',
    hostedProjectId: 'prj_abc',
    hosted: { status: 'populating' },
    local: localNotAnalyzed,
  });
  assert.match(line, /server analysis in progress/);
  assert.doesNotMatch(line, /not analyzed/);
});

test('buildAnalysisStatusLine: offline/unbound falls back to local-store wording', () => {
  const notAnalyzed = buildAnalysisStatusLine({ repoPath: '/repo', hostedProjectId: null, hosted: null, local: localNotAnalyzed });
  assert.match(notAnalyzed, /not analyzed\s+\(klauro analyze \.\)/);

  const analyzedLocally = buildAnalysisStatusLine({
    repoPath: '/repo',
    hostedProjectId: null,
    hosted: null,
    local: { analyzed: true, analysis_complete: true, system: 'Local System', staleness: 'fresh', analyzed_at: '2026-07-12T00:00:00Z' },
  });
  assert.match(analyzedLocally, /Local System/);
  assert.match(analyzedLocally, /fresh/);
});

test('buildAnalysisStatusLine: hosted no_analysis uses local wording (server confirmed nothing)', () => {
  const line = buildAnalysisStatusLine({
    repoPath: '/repo',
    hostedProjectId: 'prj_abc',
    hosted: { status: 'no_analysis' },
    local: localNotAnalyzed,
  });
  assert.match(line, /not analyzed/);
});

// ---------------------------------------------------------------------------
// P1: wrong/unreachable --server-url must NOT be misdiagnosed as an auth
// problem ("Klauro account required. Run `klauro login`").
// ---------------------------------------------------------------------------

test('isNetworkUnreachableError classifies DNS/conn/timeout errors, not HTTP-level errors', () => {
  const dns = new TypeError('fetch failed');
  (dns as any).cause = Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' });
  assert.equal(isNetworkUnreachableError(dns), true);

  const refused = new TypeError('fetch failed');
  (refused as any).cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.equal(isNetworkUnreachableError(refused), true);

  assert.equal(isNetworkUnreachableError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), true);
  assert.equal(isNetworkUnreachableError(new TypeError('fetch failed')), true);

  assert.equal(isNetworkUnreachableError(new Error('Klauro account check failed with HTTP 401')), false);
  assert.equal(isNetworkUnreachableError(undefined), false);
});

test('unreachableServerError names the URL and tells the user to check it', () => {
  const cause = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const error = unreachableServerError('https://nope.invalid', cause);
  assert.match(error.message, /Could not reach https:\/\/nope\.invalid/);
  assert.match(error.message, /check the server URL/);
  assert.match(error.message, /ENOTFOUND/);
  assert.doesNotMatch(error.message, /login/i);
});

test('requireConnectorEntitlement: an unreachable server-url reports "Could not reach", never "account required"', async () => {
  // Signed out for this test: point the auth store at an empty temp file and
  // strip token env vars.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-auth-'));
  const saved: Record<string, string | undefined> = {};
  for (const key of ['KLAURO_ACCOUNT_TOKEN', 'KLAURO_AUTH_TOKEN', 'KLAURO_ANALYZER_TOKEN', 'KLAURO_CONNECTOR_AUTH_DISABLED', 'KLAURO_AUTH_CONFIG_PATH']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KLAURO_AUTH_CONFIG_PATH = path.join(dir, 'auth.json');
  try {
    // .invalid TLD is reserved (RFC 2606): guaranteed NXDOMAIN, no network dependency on a real host.
    await assert.rejects(
      () => requireConnectorEntitlement({ serverUrl: 'https://klauro-cold-audit-nonexistent.invalid' }),
      (error: Error) => {
        assert.match(error.message, /Could not reach https:\/\/klauro-cold-audit-nonexistent\.invalid/);
        assert.doesNotMatch(error.message, /account required/i);
        return true;
      },
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (saved.KLAURO_AUTH_CONFIG_PATH === undefined) delete process.env.KLAURO_AUTH_CONFIG_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P0: install.sh gate — run the REAL script with fake `node`/`npm` shims on
// PATH and assert it refuses unsupported majors BEFORE npm install starts.
// ---------------------------------------------------------------------------

const installShPath = path.resolve(__dirname, '..', 'scripts', 'install.sh');

async function runInstallShWithFakeNode(nodeVersion: string, options: { manifest?: object; env?: Record<string, string> } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-install-gate-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  const npmMarker = path.join(dir, 'npm-was-called');
  await fs.writeFile(path.join(bin, 'node'), `#!/bin/sh\necho "${nodeVersion}"\n`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'npm'), `#!/bin/sh\ntouch "${npmMarker}"\nexit 0\n`, { mode: 0o755 });
  // Manifest served over file:// so the test exercises the real curl consult
  // path with zero network.
  let klauroUrl = 'http://127.0.0.1:1'; // unreachable fast → baked-in defaults
  if (options.manifest) {
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(dir, 'dist', 'latest.json'), JSON.stringify(options.manifest));
    klauroUrl = `file://${dir}`;
  }
  const result = spawnSync('sh', [installShPath], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      KLAURO_URL: klauroUrl,
      ...options.env,
    },
  });
  const npmCalled = await fs.access(npmMarker).then(() => true, () => false);
  await fs.rm(dir, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, npmCalled };
}

test('install.sh: Node 26 is refused with a plain message BEFORE npm install runs', async () => {
  const run = await runInstallShWithFakeNode('v26.4.0');
  assert.notEqual(run.status, 0);
  assert.match(run.output, /Klauro currently supports Node 18-22; you have 26/);
  assert.match(run.output, /nvm install 22/);
  assert.equal(run.npmCalled, false, 'npm install must never start on an unsupported node');
});

test('install.sh: Node 22 passes the gate and reaches npm install', async () => {
  const run = await runInstallShWithFakeNode('v22.11.0');
  assert.equal(run.status, 0, run.output);
  assert.equal(run.npmCalled, true);
});

test('install.sh: Node 17 is refused (floor still enforced)', async () => {
  const run = await runInstallShWithFakeNode('v17.9.1');
  assert.notEqual(run.status, 0);
  assert.match(run.output, /too old/);
  assert.equal(run.npmCalled, false);
});

test('install.sh: the hosted manifest max_node widens the range', async () => {
  const run = await runInstallShWithFakeNode('v24.1.0', {
    manifest: { version: '9.9.9', min_node: 18, max_node: 24, supported_node_range: '18-24' },
  });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.npmCalled, true);
});

test('install.sh: an incomplete hosted range cannot accidentally widen support', async () => {
  const run = await runInstallShWithFakeNode('v24.1.0', { manifest: { version: '9.9.9', min_node: 18 } });
  assert.notEqual(run.status, 0);
  assert.match(run.output, /supports Node 18-22/);
  assert.equal(run.npmCalled, false);
});

test('install.sh: a contradictory hosted range falls back to the baked safety gate', async () => {
  const run = await runInstallShWithFakeNode('v24.1.0', { manifest: { version: '9.9.9', min_node: 24, max_node: 18 } });
  assert.notEqual(run.status, 0);
  assert.match(run.output, /supports Node 18-22/);
  assert.equal(run.npmCalled, false);
});

test('install.sh: KLAURO_SKIP_NODE_CHECK=1 bypasses the ceiling (documented escape hatch)', async () => {
  const run = await runInstallShWithFakeNode('v26.4.0', { env: { KLAURO_SKIP_NODE_CHECK: '1' } });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.npmCalled, true);
});

// ---------------------------------------------------------------------------
// Unknown flags must error by name, never fall through to the positional path
// slot (an unrecognized `--flag` otherwise becomes a directory to "connect"
// and dies with a baffling ENOENT on a folder literally named --flag).
// ---------------------------------------------------------------------------
import { parseArgs } from './cli';

test('parseArgs: an unknown --flag errors by name instead of becoming the path', () => {
  assert.throws(() => parseArgs(['init', '--headless']), /Unknown option: --headless/);
  assert.throws(() => parseArgs(['init', '--no-such-flag']), /Unknown option: --no-such-flag/);
});

test('parseArgs: a real positional path still lands in the path slot', () => {
  const parsed = parseArgs(['init', '/tmp/some-repo']);
  assert.equal(parsed.path, '/tmp/some-repo');
});

// ---------------------------------------------------------------------------
// §AUTH-LIFECYCLE — reset-password / change-password / admin-mint-reset-token
// flag parsing. Only the parsing itself is unit-testable here (the commands
// make real network/filesystem calls); account-store.test.ts covers the
// underlying AccountStore behavior end to end.
// ---------------------------------------------------------------------------

test('parseArgs: reset-password token/new-password flags', () => {
  const parsed = parseArgs(['reset-password', '--token', 'krt_abc123', '--new-password', 'a-new-password-1']);
  assert.equal(parsed.resetToken, 'krt_abc123');
  assert.equal(parsed.newPassword, 'a-new-password-1');
  assert.equal(parsed.resetTokenStdin, false);
  assert.equal(parsed.newPasswordStdin, false);

  const stdinVariant = parseArgs(['reset-password', '--token-stdin', '--new-password-stdin']);
  assert.equal(stdinVariant.resetTokenStdin, true);
  assert.equal(stdinVariant.newPasswordStdin, true);
});

test('parseArgs: change-password current/new-password flags', () => {
  const parsed = parseArgs(['change-password', '--current-password', 'old-pw-1', '--new-password', 'new-pw-2']);
  assert.equal(parsed.currentPassword, 'old-pw-1');
  assert.equal(parsed.newPassword, 'new-pw-2');
});

test('parseArgs: admin-mint-reset-token email/data-dir/minted-by flags', () => {
  const parsed = parseArgs(['admin-mint-reset-token', '--email', 'owner@example.com', '--data-dir', '/data', '--minted-by', 'operator:me@example.com']);
  assert.equal(parsed.email, 'owner@example.com');
  assert.equal(parsed.dataDir, '/data');
  assert.equal(parsed.mintedBy, 'operator:me@example.com');
});
