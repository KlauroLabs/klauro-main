import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { checkNodeSupportedForNativeBuild, buildAnalysisStatusLine, DEFAULT_MAX_NODE, DEFAULT_MIN_NODE } from './cli';
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
  const run = await runInstallShWithFakeNode('v24.1.0', { manifest: { version: '9.9.9', min_node: 18, max_node: 24 } });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.npmCalled, true);
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
