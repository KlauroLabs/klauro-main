import { test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { pathToFileURL } from 'url';
import { summarizeAnalysisVersions } from './environment-doctor';
import { MINIMUM_COMPATIBLE_CAS_VERSION, describeAnalysisVersion } from './storage';

type ChecksModule = typeof import('../scripts/environment-checks.mjs');

function loadChecks(): Promise<ChecksModule> {
  const modulePath = path.join(__dirname, '..', 'scripts', 'environment-checks.mjs');
  return import(pathToFileURL(modulePath).href) as Promise<ChecksModule>;
}

test('evaluateNodeVersion passes for the minimum major and above', async () => {
  const checks = await loadChecks();
  assert.strictEqual(checks.evaluateNodeVersion('v20.0.0').status, 'pass');
  assert.strictEqual(checks.evaluateNodeVersion('v22.22.0').status, 'pass');
  assert.strictEqual(checks.evaluateNodeVersion('22.1.0').status, 'pass');
});

test('evaluateNodeVersion fails below the minimum with an actionable fix', async () => {
  const checks = await loadChecks();
  const result = checks.evaluateNodeVersion('v18.19.1');
  assert.strictEqual(result.status, 'fail');
  assert.match(result.fix || '', /Node\.js 20\+/);
});

test('evaluateNodeVersion fails on unparseable versions', async () => {
  const checks = await loadChecks();
  assert.strictEqual(checks.evaluateNodeVersion('not-a-version').status, 'fail');
  assert.strictEqual(checks.evaluateNodeVersion('').status, 'fail');
});

test('evaluateBundleState fails when bundle artifacts are missing', async () => {
  const checks = await loadChecks();
  const result = checks.evaluateBundleState({
    bundleExists: false,
    serverExists: true,
    cliExists: false,
    handshakeExists: false,
    bundleMtimeMs: null,
    newestSourceMtimeMs: 1000,
    packageRoot: '/srv/klauro',
  });
  assert.strictEqual(result.status, 'fail');
  assert.match(result.detail, /dist\/index\.cjs/);
  assert.match(result.detail, /dist\/cli\.cjs/);
  assert.match(result.detail, /dist\/handshake\.json/);
  assert.match(result.fix || '', /npm --prefix \/srv\/klauro run build/);
});

test('evaluateBundleState warns when sources are newer than the bundle', async () => {
  const checks = await loadChecks();
  const result = checks.evaluateBundleState({
    bundleExists: true,
    serverExists: true,
    cliExists: true,
    handshakeExists: true,
    bundleMtimeMs: 1000,
    newestSourceMtimeMs: 1000 + 5 * 60000,
    packageRoot: '/srv/klauro',
  });
  assert.strictEqual(result.status, 'warn');
  assert.match(result.detail, /older than the newest source/);
});

test('evaluateBundleState passes for a complete fresh bundle', async () => {
  const checks = await loadChecks();
  const result = checks.evaluateBundleState({
    bundleExists: true,
    serverExists: true,
    cliExists: true,
    handshakeExists: true,
    bundleMtimeMs: 2000,
    newestSourceMtimeMs: 1000,
    packageRoot: '/srv/klauro',
  });
  assert.strictEqual(result.status, 'pass');
});

test('summarizeAiProviders reports each configured provider', async () => {
  const checks = await loadChecks();
  assert.deepStrictEqual(checks.summarizeAiProviders({}), []);
  const configured = checks.summarizeAiProviders({
    DEEPINFRA_API_KEY: 'deepinfra-test',
    DEEPINFRA_MODEL: 'meta-llama/Meta-Llama-3.3-70B-Instruct',
    OPENAI_API_KEY: 'sk-test',
    ANTHROPIC_API_KEY: 'sk-ant-test',
  } as NodeJS.ProcessEnv);
  assert.strictEqual(configured.length, 3);
  assert.match(configured.join(' '), /deepinfra/);
  assert.match(configured.join(' '), /openai/);
  assert.match(configured.join(' '), /anthropic/);
});

test('evaluateAiProviders passes deterministically with no provider', async () => {
  const checks = await loadChecks();
  const result = checks.evaluateAiProviders({ configured: [] });
  assert.strictEqual(result.status, 'pass');
  assert.match(result.detail, /deterministic/);
});

test('summarizeAiProviders ignores loopback OpenAI-compatible URLs', async () => {
  const checks = await loadChecks();
  const configured = checks.summarizeAiProviders({
    OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
  } as NodeJS.ProcessEnv);
  assert.deepStrictEqual(configured, []);
});

test('evaluateStorageState fails with a fix when the directory is not writable', async () => {
  const checks = await loadChecks();
  const result = checks.evaluateStorageState({
    analysesDir: '/protected/.klauro/analyses',
    created: false,
    writable: false,
    writeError: 'EACCES: permission denied',
  });
  assert.strictEqual(result.status, 'fail');
  assert.match(result.fix || '', /KLAURO_STORAGE_PATH/);
});

test('evaluateStorageState passes and reports usage when writable', async () => {
  const checks = await loadChecks();
  const result = checks.evaluateStorageState({
    analysesDir: '/home/user/.klauro/analyses',
    created: true,
    writable: true,
    usageBytes: 12 * 1024 * 1024,
  });
  assert.strictEqual(result.status, 'pass');
  assert.match(result.detail, /created/);
  assert.match(result.detail, /12\.0 MB/);
});

test('evaluateSizeBudget fails or warns when runtime budgets are exceeded', async () => {
  const checks = await loadChecks();
  const pass = checks.evaluateSizeBudget({
    id: 'product-bundle-footprint',
    label: 'Bundle',
    bytes: 10,
    maxBytes: 20,
  });
  assert.strictEqual(pass.status, 'pass');

  const fail = checks.evaluateSizeBudget({
    id: 'product-bundle-footprint',
    label: 'Bundle',
    bytes: 30,
    maxBytes: 20,
    fix: 'trim bundle',
  });
  assert.strictEqual(fail.status, 'fail');
  assert.match(fail.fix || '', /trim bundle/);

  const warn = checks.evaluateSizeBudget({
    id: 'product-storage-footprint',
    label: 'Storage',
    bytes: 30,
    maxBytes: 20,
    overStatus: 'warn',
  });
  assert.strictEqual(warn.status, 'warn');
});

test('inspectProductFootprint measures dist and install path separately from storage', async () => {
  const checks = await loadChecks();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-footprint-test-'));
  try {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'index.cjs'), 'x'.repeat(10));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'scripts', 'install.mjs'), '');

    const results = checks.inspectProductFootprint({
      packageRoot: root,
      includeStorage: false,
      env: {
        KLAURO_PRODUCT_BUNDLE_MAX_BYTES: '20000',
        KLAURO_PRODUCT_INSTALL_MAX_BYTES: '20000',
      } as NodeJS.ProcessEnv,
    });

    assert.deepStrictEqual(results.map(result => result.id), [
      'product-bundle-footprint',
      'product-install-footprint',
    ]);
    assert.ok(results.every(result => result.status === 'pass'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evaluateZstd severities depend on stored compressed analyses', async () => {
  const checks = await loadChecks();
  assert.strictEqual(checks.evaluateZstd({ zstdAvailable: true, compressedFiles: 10 }).status, 'pass');
  assert.strictEqual(checks.evaluateZstd({ zstdAvailable: false, compressedFiles: 0 }).status, 'warn');
  const blocking = checks.evaluateZstd({ zstdAvailable: false, compressedFiles: 3 });
  assert.strictEqual(blocking.status, 'fail');
  assert.match(blocking.fix || '', /install zstd/i);
});

test('evaluateWatches is informative for zero and multiple server processes', async () => {
  const checks = await loadChecks();
  const none = checks.evaluateWatches([]);
  assert.strictEqual(none.status, 'pass');
  assert.match(none.detail, /no active watch sessions/i);
  const some = checks.evaluateWatches([{ pid: 123, command: 'node dist/index.cjs' }]);
  assert.match(some.detail, /123/);
  assert.match(some.detail, /list_watches/);
});

test('decideBuildAction only builds when dist is incomplete or rebuild is forced', async () => {
  const checks = await loadChecks();
  assert.strictEqual(checks.decideBuildAction({ distComplete: true, rebuildRequested: false }).build, false);
  assert.strictEqual(checks.decideBuildAction({ distComplete: false, rebuildRequested: false }).build, true);
  assert.strictEqual(checks.decideBuildAction({ distComplete: true, rebuildRequested: true }).build, true);
});

test('registration snippets target the bundle path', async () => {
  const checks = await loadChecks();
  const bundle = '/srv/klauro/dist/index.cjs';
  assert.strictEqual(
    checks.claudeRegisterCommand(bundle, 'user'),
    'claude mcp add --scope user klauro -- node /srv/klauro/dist/index.cjs',
  );
  const mcpJson = JSON.parse(checks.mcpJsonSnippet(bundle, '/srv/klauro'));
  assert.deepStrictEqual(mcpJson.mcpServers.klauro.args, [bundle]);
  assert.match(checks.codexInstructions(bundle), /codex mcp add klauro -- node \/srv\/klauro\/dist\/index\.cjs/);
  assert.match(checks.codexInstructions(bundle), /\[mcp_servers\.klauro\]/);
});

test('operating loop snippet is idempotent via the marker', async () => {
  const checks = await loadChecks();
  const snippet = checks.operatingLoopSnippet();
  assert.match(snippet, /resolve_agent_analysis/);
  assert.match(snippet, /validate_behavioral_invariants/);
  assert.strictEqual(checks.shouldAppendOperatingLoop(undefined), true);
  assert.strictEqual(checks.shouldAppendOperatingLoop('# My project'), true);
  assert.strictEqual(checks.shouldAppendOperatingLoop(`# My project\n\n${snippet}`), false);
});

test('operating loop snippet is delimited by begin/end markers', async () => {
  const checks = await loadChecks();
  const snippet = checks.operatingLoopSnippet();
  assert.ok(snippet.startsWith(checks.OPERATING_LOOP_BEGIN_MARKER));
  assert.ok(snippet.endsWith(checks.OPERATING_LOOP_END_MARKER));
});

test('removeOperatingLoop strips a marker-delimited block and keeps the rest', async () => {
  const checks = await loadChecks();
  const snippet = checks.operatingLoopSnippet();
  const result = checks.removeOperatingLoop(`# My project\n\nLocal rules.\n\n${snippet}\n\nMore rules.\n`);
  assert.strictEqual(result.removed, true);
  assert.strictEqual(result.content, '# My project\n\nLocal rules.\n\nMore rules.\n');
});

test('removeOperatingLoop strips the legacy unmarked block', async () => {
  const checks = await loadChecks();
  const legacy = checks.legacyOperatingLoopSnippet();
  assert.strictEqual(legacy.includes(checks.OPERATING_LOOP_BEGIN_MARKER), false);
  const result = checks.removeOperatingLoop(`# My project\n\n${legacy}\n\nMore rules.\n`);
  assert.strictEqual(result.removed, true);
  assert.strictEqual(result.content, '# My project\n\nMore rules.\n');
});

test('removeOperatingLoop returns empty content when the file only held the block', async () => {
  const checks = await loadChecks();
  const result = checks.removeOperatingLoop(`${checks.operatingLoopSnippet()}\n`);
  assert.strictEqual(result.removed, true);
  assert.strictEqual(result.content, '');
});

test('removeOperatingLoop is a no-op without the block', async () => {
  const checks = await loadChecks();
  const result = checks.removeOperatingLoop('# My project\n\nNo Klauro here.\n');
  assert.strictEqual(result.removed, false);
  assert.strictEqual(result.content, '# My project\n\nNo Klauro here.\n');
});

test('formatCheck prints status, detail, and the fix for non-pass results', async () => {
  const checks = await loadChecks();
  const pass = checks.formatCheck({ id: 'node-version', status: 'pass', detail: 'ok', fix: 'unused' });
  assert.strictEqual(pass.includes('fix:'), false);
  const fail = checks.formatCheck({ id: 'bundle', status: 'fail', detail: 'missing', fix: 'npm run build' });
  assert.match(fail, /FAIL bundle: missing/);
  assert.match(fail, /fix: npm run build/);
});

test('summarizeAnalysisVersions passes with no stored analyses', () => {
  const result = summarizeAnalysisVersions([]);
  assert.strictEqual(result.status, 'pass');
  assert.match(result.detail, new RegExp(MINIMUM_COMPATIBLE_CAS_VERSION.replace(/\./g, '\\.')));
});

test('summarizeAnalysisVersions passes when all analyses meet the floor', () => {
  const result = summarizeAnalysisVersions([
    { path: '/repo/a', cas_version: MINIMUM_COMPATIBLE_CAS_VERSION },
    { path: '/repo/b', cas_version: describeAnalysisVersion(undefined).current_version },
  ]);
  assert.strictEqual(result.status, 'pass');
});

test('summarizeAnalysisVersions fails listing analyses below the 1.6.0 floor', () => {
  const result = summarizeAnalysisVersions([
    { path: '/repo/old', cas_version: '1.4.0' },
    { path: '/repo/ok', cas_version: MINIMUM_COMPATIBLE_CAS_VERSION },
  ]);
  assert.strictEqual(result.status, 'fail');
  assert.match(result.detail, /\/repo\/old/);
  assert.match(result.detail, /1\.4\.0/);
  assert.match(result.fix || '', /klauro analyze/);
});

test('summarizeAnalysisVersions warns for index entries that predate version tracking', () => {
  const result = summarizeAnalysisVersions([
    { path: '/repo/legacy', cas_version: undefined },
    { path: '/repo/ok', cas_version: MINIMUM_COMPATIBLE_CAS_VERSION },
  ]);
  assert.strictEqual(result.status, 'warn');
  assert.match(result.detail, /predate version tracking/);
});
