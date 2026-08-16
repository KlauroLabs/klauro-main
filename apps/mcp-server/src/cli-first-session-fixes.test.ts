import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  checkNodeVersionForUpdate,
  buildAnalysisStatusLine,
  DEFAULT_MIN_NODE,
  detectBuildNodeVersion,
  buildUpdateSpawnEnv,
  isRunningAsSeaBinary,
  resolveSeaPlatformId,
} from './cli';
import { isNetworkUnreachableError, requireConnectorEntitlement, unreachableServerError } from './connector-auth';
import { fetchHostedAnalysisState } from './status-report';

// ---------------------------------------------------------------------------
// §NODE-GATE-PHANTOM (2026-08-09): there is no longer an upper Node-version
// ceiling on the CLIENT — the published tarball has `dependencies: {}` /
// `optionalDependencies: {}` and zero `.node` binaries, so nothing ever
// compiles on `npm install -g` regardless of Node version (verified: v1.0.131
// runs unmodified on Node 26). The tree-sitter/C++20 compile ceiling this
// section used to test is real for the HOSTED analyzer/server image, not
// here. The primary install path is now the self-contained (Node SEA)
// binary, which needs no machine Node at all — see
// installed-sea-entry.test.ts / self-update.test.ts for that path.
// ---------------------------------------------------------------------------

test('checkNodeVersionForUpdate: no upper bound — even very new Node majors pass', () => {
  for (const major of [18, 20, 22, 24, 26, 30]) {
    assert.equal(checkNodeVersionForUpdate(major).ok, true, `node ${major} should not be refused`);
  }
  assert.equal(DEFAULT_MIN_NODE, 18);
});

test('checkNodeVersionForUpdate: below the declared floor is a non-blocking warning, not "ok: false forever"', () => {
  const result = checkNodeVersionForUpdate(16);
  assert.equal(result.ok, false);
  assert.match(result.message || '', /you have 16/);
  // The caller (runSelfUpdate) treats !ok as a stderr warning and proceeds
  // anyway — see self-update.test.ts — never as a thrown refusal.
});

test('isRunningAsSeaBinary: false under plain node (this test itself is not a SEA binary)', () => {
  assert.equal(isRunningAsSeaBinary(), false);
});

test('resolveSeaPlatformId: maps known OS/arch pairs to the published binary ids', () => {
  assert.equal(resolveSeaPlatformId('darwin', 'arm64'), 'macos-arm64');
  assert.equal(resolveSeaPlatformId('darwin', 'x64'), 'macos-x64');
  assert.equal(resolveSeaPlatformId('linux', 'x64'), 'linux-x64');
  assert.equal(resolveSeaPlatformId('linux', 'arm64'), 'linux-arm64');
  assert.equal(resolveSeaPlatformId('win32', 'x64'), 'win-x64');
});

test('resolveSeaPlatformId: unknown combinations return null rather than guessing', () => {
  assert.equal(resolveSeaPlatformId('linux', 'ia32'), null);
  assert.equal(resolveSeaPlatformId('win32', 'arm64'), null);
  assert.equal(resolveSeaPlatformId('freebsd', 'x64'), null);
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

test('detectBuildNodeVersion + checkNodeVersionForUpdate: resolves the ACTUAL prefix node (not process.version) and a very new major is never refused', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-update-node-'));
  try {
    // #59 was about resolving the RIGHT node (the one that actually runs the
    // install), not about refusing it — the resolution behavior below is
    // still worth pinning even though nothing here gets refused anymore.
    const nodeBin = await writeFakeNodeShim(dir, 'v26.4.0');
    const version = detectBuildNodeVersion({ nodeBin }, { processVersion: 'v22.11.0' });
    assert.equal(version, 'v26.4.0', 'must resolve the prefix node, not the unrelated process.version fallback');
    const major = Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
    assert.equal(checkNodeVersionForUpdate(major).ok, true, 'no upper bound — Node 26 is not refused');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('detectBuildNodeVersion + checkNodeVersionForUpdate: a below-floor resolved node warns but is still "not ok" for the caller to act on', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-update-node-'));
  try {
    const nodeBin = await writeFakeNodeShim(dir, 'v16.20.0');
    const version = detectBuildNodeVersion({ nodeBin });
    const major = Number.parseInt(version.replace(/^v/, '').split('.')[0], 10);
    assert.equal(checkNodeVersionForUpdate(major).ok, false);
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

test('hosted project 404 is reported as inaccessible instead of stale local analysis', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Project not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const hosted = await fetchHostedAnalysisState('https://example.test', 'token', 'prj_other_workspace');
    assert.equal(hosted?.status, 'inaccessible');
    const line = buildAnalysisStatusLine({
      repoPath: '/repo',
      hostedProjectId: 'prj_other_workspace',
      hosted,
      local: { analyzed: true, analysis_complete: true, system: 'Old Local Analysis', staleness: 'stale' },
    });
    assert.match(line, /inaccessible/);
    assert.match(line, /another workspace/);
    assert.doesNotMatch(line, /Old Local Analysis/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('requireConnectorEntitlement retries transient timeouts during active analysis', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('analysis temporarily occupied the API'), { name: 'TimeoutError' });
    return new Response(JSON.stringify({
      user: { id: 'user-1', email: 'beta@example.com' },
      entitlement: { status: 'active', plan: 'beta' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const identity = await requireConnectorEntitlement({
    serverUrl: 'https://mcp.klauro.com',
    token: 'test-token',
    fetchImpl: fetchImpl as typeof fetch,
    timeoutMs: 10,
    retryDelaysMs: [0, 0],
  });

  assert.equal(attempts, 3);
  assert.equal(identity.entitlement.status, 'active');
});

test('requireConnectorEntitlement never retries an HTTP authentication rejection', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: 'session expired' }), { status: 401 });
  };

  await assert.rejects(
    () => requireConnectorEntitlement({
      serverUrl: 'https://mcp.klauro.com',
      token: 'expired-token',
      fetchImpl: fetchImpl as typeof fetch,
      retryDelaysMs: [0, 0],
    }),
    /session expired/,
  );
  assert.equal(attempts, 1);
});

// ---------------------------------------------------------------------------
// P0: install.sh — self-contained binary is the PRIMARY install path, no
// machine Node/npm required at all; npm is only an EMERGENCY fallback for a
// platform with no published binary (or a broken one). Run the REAL script
// against a fake local "server" directory served over file://, so this
// exercises actual curl/sha256sum/mktemp calls, not a mocked shell.
// ---------------------------------------------------------------------------

const installShPath = path.resolve(__dirname, '..', 'scripts', 'install.sh');

/** The same OS/arch -> platform-id mapping install.sh computes, so tests work
 *  on whatever machine runs them instead of assuming macOS/arm64. */
function currentPlatformKey(): string {
  const osId = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : '';
  const archId = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : '';
  return osId && archId ? `${osId}_${archId}` : '';
}

async function runInstallSh(options: {
  /** When set, a fake "server" directory is created with dist/latest.json and,
   *  if `fakeBinary` is given, dist/klauro-<platform> populated from it — the
   *  install.sh path under test is driven entirely by what this manifest
   *  advertises, exactly like the real server. */
  manifest?: Record<string, unknown>;
  /** Shell script content for the fake downloadable binary (must handle a
   *  `version` argv and exit 0 for install.sh's smoke test to pass). Omit to
   *  test the "no binary available" / checksum-mismatch fallback paths. */
  fakeBinary?: string;
  /** Node/npm shims on PATH for the npm-fallback path. Omit to test that the
   *  binary path never needs them at all. */
  fakeNode?: { version: string };
  /** Places a `klauro` on PATH (in the same `bin` dir used for node/npm
   *  shims, so it is earlier on PATH than anything install.sh's own PATH
   *  edit could ever reach) BEFORE install.sh runs, reproducing the shadow
   *  incident. 'owned-symlink' reproduces the real npm-global shape exactly
   *  (`<bin>/klauro -> ../lib/node_modules/@klauro/mcp-server/dist/cli.cjs`)
   *  so the takeover logic's positive-identification check has something
   *  real to match. 'unrelated' is some other program that happens to be
   *  named klauro and must never be touched. */
  existingKlauro?: { kind: 'owned-symlink' | 'unrelated'; script?: string; unwritableDir?: boolean };
  env?: Record<string, string>;
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-install-sh-'));
  const home = path.join(dir, 'home');
  await fs.mkdir(home, { recursive: true });
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  const npmMarker = path.join(dir, 'npm-was-called');
  if (options.fakeNode) {
    await fs.writeFile(path.join(bin, 'node'), `#!/bin/sh\necho "${options.fakeNode.version}"\n`, { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'npm'), `#!/bin/sh\ntouch "${npmMarker}"\nexit 0\n`, { mode: 0o755 });
  }

  let existingKlauroPath: string | null = null;
  if (options.existingKlauro) {
    if (options.existingKlauro.kind === 'owned-symlink') {
      const pkgDir = path.join(dir, 'lib', 'node_modules', '@klauro', 'mcp-server', 'dist');
      await fs.mkdir(pkgDir, { recursive: true });
      const cliPath = path.join(pkgDir, 'cli.cjs');
      await fs.writeFile(
        cliPath,
        options.existingKlauro.script ?? '#!/bin/sh\necho "{\\"version\\":\\"1.0.99+oldstalesha\\"}"\n',
        { mode: 0o755 },
      );
      existingKlauroPath = path.join(bin, 'klauro');
      await fs.symlink(path.relative(bin, cliPath), existingKlauroPath);
    } else {
      existingKlauroPath = path.join(bin, 'klauro');
      await fs.writeFile(
        existingKlauroPath,
        options.existingKlauro.script ?? '#!/bin/sh\necho "some other program also named klauro"\nexit 0\n',
        { mode: 0o755 },
      );
    }
    if (options.existingKlauro.unwritableDir) {
      await fs.chmod(bin, 0o555);
      if (process.getuid?.() === 0) {
        await fs.chmod(dir, 0o755);
        await fs.chmod(home, 0o777);
      }
    }
  }

  let klauroUrl = 'file:///nonexistent-klauro-test-server'; // no manifest reachable → npm fallback path
  if (options.manifest) {
    const platformKey = currentPlatformKey();
    const manifest = { ...options.manifest };
    if (options.fakeBinary && platformKey) {
      await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
      const binaryPath = path.join(dir, 'dist', `klauro-${platformKey.replace('_', '-')}`);
      await fs.writeFile(binaryPath, options.fakeBinary, { mode: 0o755 });
      const crypto = await import('node:crypto');
      const sha256 = crypto.createHash('sha256').update(await fs.readFile(binaryPath)).digest('hex');
      (manifest as Record<string, string>)[`bin_${platformKey}_path`] = `/dist/klauro-${platformKey.replace('_', '-')}`;
      (manifest as Record<string, string>)[`bin_${platformKey}_sha256`] = sha256;
    } else {
      await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    }
    await fs.writeFile(path.join(dir, 'dist', 'latest.json'), JSON.stringify(manifest));
    klauroUrl = `file://${dir}`;
  }

  const unprivileged = options.existingKlauro?.unwritableDir && process.getuid?.() === 0;
  const result = spawnSync('sh', [installShPath], {
    encoding: 'utf8',
    timeout: 30000,
    ...(unprivileged ? { uid: 65534, gid: 65534 } : {}),
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      SHELL: '/bin/sh',
      KLAURO_URL: klauroUrl,
      KLAURO_INSTALL_DIR: path.join(home, '.klauro', 'bin'),
      ...options.env,
    },
  });
  const npmCalled = await fs.access(npmMarker).then(() => true, () => false);
  const installedBinaryPath = path.join(home, '.klauro', 'bin', 'klauro');
  const binaryInstalled = await fs.access(installedBinaryPath).then(() => true, () => false);

  let existingKlauroLinkTarget: string | null = null;
  let existingKlauroRanOutput: string | null = null;
  if (existingKlauroPath) {
    if (options.existingKlauro?.unwritableDir) {
      await fs.chmod(bin, 0o755); // restore so cleanup/inspection below can proceed
    }
    existingKlauroLinkTarget = await fs.readlink(existingKlauroPath).catch(() => null);
    try {
      existingKlauroRanOutput = spawnSync(existingKlauroPath, ['version'], { encoding: 'utf8' }).stdout ?? null;
    } catch {
      existingKlauroRanOutput = null;
    }
  }

  await fs.rm(dir, { recursive: true, force: true });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    npmCalled,
    binaryInstalled,
    existingKlauroLinkTarget,
    existingKlauroRanOutput,
  };
}

test('install.sh: no machine Node/npm on PATH — a valid binary manifest entry installs with zero npm calls', async () => {
  const run = await runInstallSh({
    manifest: { version: '9.9.9' },
    fakeBinary: '#!/bin/sh\necho "{\\"version\\":\\"9.9.9\\"}"\nexit 0\n',
    // Deliberately NOT providing fakeNode: proves the binary path never
    // shells out to node/npm at all, on a PATH that has neither.
  });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.npmCalled, false, 'the binary path must never invoke npm');
  assert.equal(run.binaryInstalled, true, run.output);
});

test('install.sh: checksum mismatch refuses the binary and falls back to npm', async () => {
  // Built manually (not via runInstallSh's helper) so the manifest can
  // advertise a deliberately WRONG sha256 for a real downloadable binary.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-install-sh-bad-sha-'));
  try {
    const home = path.join(dir, 'home');
    const bin = path.join(dir, 'bin');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    const npmMarker = path.join(dir, 'npm-was-called');
    await fs.writeFile(path.join(bin, 'node'), `#!/bin/sh\necho "v20.10.0"\n`, { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'npm'), `#!/bin/sh\ntouch "${npmMarker}"\nexit 0\n`, { mode: 0o755 });
    const platformKey = currentPlatformKey();
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(dir, 'dist', `klauro-${platformKey.replace('_', '-')}`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(path.join(dir, 'dist', 'latest.json'), JSON.stringify({
      version: '9.9.9',
      [`bin_${platformKey}_path`]: `/dist/klauro-${platformKey.replace('_', '-')}`,
      [`bin_${platformKey}_sha256`]: '0'.repeat(64), // definitely wrong
    }));
    const result = spawnSync('sh', [installShPath], {
      encoding: 'utf8', timeout: 30000,
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, SHELL: '/bin/sh', KLAURO_URL: `file://${dir}` },
    });
    assert.match(`${result.stdout}${result.stderr}`, /Checksum mismatch/);
    assert.match(`${result.stdout}${result.stderr}`, /Installing via npm instead, which requires Node\.js/);
    const npmCalled = await fs.access(npmMarker).then(() => true, () => false);
    assert.equal(npmCalled, true, 'a bad checksum must fall back to npm, not silently install unverified bits');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('install.sh: no binary published for this platform falls back to npm and tells the user Node.js is required', async () => {
  const run = await runInstallSh({ fakeNode: { version: 'v20.10.0' } });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.npmCalled, true);
  assert.match(run.output, /No prebuilt klauro is available/);
  assert.match(run.output, /Installing via npm instead, which requires Node\.js/);
});

// ---------------------------------------------------------------------------
// PATH-resolution takeover: a successful "Installed klauro" message that a
// stale `klauro` earlier on PATH still shadows is not a success — see the
// real incident this reproduces at the top of this suite's git history.
// install.sh must resolve what `klauro` will actually execute, take over
// its own prior npm-global install when it finds one (verified by symlink
// target, not by path guessing), and refuse to claim success otherwise.
// ---------------------------------------------------------------------------

test('install.sh: no pre-existing klauro anywhere on PATH — clean install, no shadow noise', async () => {
  const run = await runInstallSh({
    manifest: { version: '9.9.9' },
    fakeBinary: '#!/bin/sh\necho "{\\"version\\":\\"9.9.9\\"}"\nexit 0\n',
  });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.binaryInstalled, true, run.output);
  assert.doesNotMatch(run.output, /Repointed shadowing/);
  assert.doesNotMatch(run.output, /not a recognized klauro-brand install/);
  assert.doesNotMatch(run.output, /This install is NOT complete/);
});

test('install.sh: a klauro-owned npm-global symlink earlier on PATH is taken over — klauro resolves to the new version in the SAME shell', async () => {
  const run = await runInstallSh({
    manifest: { version: '9.9.9' },
    fakeBinary: '#!/bin/sh\necho "{\\"version\\":\\"9.9.9\\"}"\nexit 0\n',
    existingKlauro: { kind: 'owned-symlink' },
  });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.binaryInstalled, true, run.output);
  assert.match(run.output, /Repointed shadowing klauro installs/);
  assert.match(run.output, /klauro now resolves to/);
  assert.match(run.output, /npm ls -g/, 'must say the package manager record is now stale');
  // The proof that matters: without any shell restart, the exact file that
  // was on PATH before install.sh ran now points at the freshly-installed
  // binary, and actually running it returns the NEW version, not the old
  // stale 1.0.99 one baked into the fixture.
  assert.notEqual(run.existingKlauroLinkTarget, null);
  assert.match(String(run.existingKlauroRanOutput), /9\.9\.9/);
});

test('install.sh: an unverified klauro earlier on PATH is left untouched and the install FAILS loudly, not a false success', async () => {
  const run = await runInstallSh({
    manifest: { version: '9.9.9' },
    fakeBinary: '#!/bin/sh\necho "{\\"version\\":\\"9.9.9\\"}"\nexit 0\n',
    existingKlauro: { kind: 'unrelated' },
  });
  assert.notEqual(run.status, 0, 'a shadowing binary we cannot prove is ours must fail the install, not warn-and-succeed');
  assert.match(run.output, /not a recognized klauro-brand install/);
  assert.match(run.output, /This install is NOT complete/);
  // Left untouched: still the original fixture script, not repointed.
  assert.equal(run.existingKlauroLinkTarget, null);
  assert.doesNotMatch(String(run.existingKlauroRanOutput), /9\.9\.9/);
});

test('install.sh: a klauro-owned symlink in an unwritable directory fails loudly with the exact sudo command, no silent success', async () => {
  const run = await runInstallSh({
    manifest: { version: '9.9.9' },
    fakeBinary: '#!/bin/sh\necho "{\\"version\\":\\"9.9.9\\"}"\nexit 0\n',
    existingKlauro: { kind: 'owned-symlink', unwritableDir: true },
  });
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /is not writable/);
  assert.match(run.output, /sudo ln -sf/);
  assert.match(run.output, /This install is NOT complete/);
});

test('install.sh: npm fallback with no Node at all fails loudly with an actionable message (no silent hang)', async () => {
  const run = await runInstallSh({}); // no manifest, no fakeNode — nothing on PATH
  assert.notEqual(run.status, 0);
  assert.match(run.output, /can't be installed on .* without Node\.js/);
});

test('install.sh: npm fallback below the declared Node floor WARNS but still proceeds (no refusal)', async () => {
  const run = await runInstallSh({ fakeNode: { version: 'v16.20.0' } });
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /Warning:.*older than klauro's declared minimum/);
  assert.equal(run.npmCalled, true, 'a below-floor Node must still be allowed to try — this is a warning, not a gate');
});

test('install.sh: KLAURO_SKIP_NODE_CHECK is gone — setting it does nothing (no upper bound left to skip)', async () => {
  const run = await runInstallSh({ fakeNode: { version: 'v20.10.0' }, env: { KLAURO_SKIP_NODE_CHECK: '1' } });
  assert.doesNotMatch(run.output, /KLAURO_SKIP_NODE_CHECK/, 'the escape hatch text must not appear anywhere — there is nothing left to skip');
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
