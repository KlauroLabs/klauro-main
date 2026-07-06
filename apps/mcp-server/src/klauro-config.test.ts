import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSourceSnapshot, buildUploadManifest } from './remote-source';
import { assertRemoteAnalyzerAllowed, defaultKlauroConfig, writeDefaultKlauroConfig, validateConventions, type LoadedKlauroConfig, type KlauroConventions } from './klauro-config';

const repoRoot = path.resolve(__dirname, '..');
const tsxBin = fs.existsSync(path.join(repoRoot, 'node_modules', '.bin', 'tsx'))
  ? path.join(repoRoot, 'node_modules', '.bin', 'tsx')
  : path.join(repoRoot, '..', '..', 'node_modules', '.bin', 'tsx');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');

/**
 * Hermetic env for spawning `klauro init` in tests: the unified init reuses
 * stored credentials and kicks off hosted analysis/fabric when signed in, so
 * point the credential store at a nonexistent file and scrub every token/URL
 * env var — the test must never touch the developer's real account or a real
 * service.
 */
function signedOutEnv(workspaceDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of [
    'KLAURO_ACCOUNT_TOKEN', 'KLAURO_AUTH_TOKEN', 'KLAURO_ANALYZER_TOKEN',
    'KLAURO_API_URL', 'KLAURO_ANALYZER_URL', 'KLAURO_URL',
    'FAB_REMOTE_URL', 'FAB_REMOTE_TOKEN', 'FAB_WS',
  ]) delete env[key];
  env.KLAURO_AUTH_CONFIG_PATH = path.join(workspaceDir, 'no-such-auth.json');
  return env;
}

test('upload manifest honors .klaurorc and .klauroignore before remote upload', async () => {
  await withFixtureWorkspace(async workspace => {
    await writeDefaultKlauroConfig(workspace.repo, { force: true, serverUrl: 'https://analyzer.example.test' });
    fs.writeFileSync(path.join(workspace.repo, '.env'), 'SECRET=value\n');
    fs.mkdirSync(path.join(workspace.repo, 'private-fixtures'), { recursive: true });
    fs.writeFileSync(path.join(workspace.repo, 'private-fixtures', 'sample.json'), '{"secret":true}\n');

    const manifest = await buildUploadManifest(workspace.repo);
    const included = manifest.included_files.map(file => file.path);

    assert.ok(included.includes('app/main.py'));
    assert.ok(included.includes('requirements.txt'));
    assert.ok(!included.includes('.env'));
    assert.ok(!included.includes('private-fixtures/sample.json'));
    assert.equal(manifest.config_file, path.join(workspace.repo, '.klaurorc'));
    assert.equal(manifest.ignore_file, path.join(workspace.repo, '.klauroignore'));
  });
});

test('customer CLI init and upload-manifest produce parseable onboarding artifacts', () => {
  return withFixtureWorkspace(async workspace => {
    spawnSync('git', ['init'], { cwd: workspace.repo, encoding: 'utf8' });
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/fastapi-sqlalchemy.git'], { cwd: workspace.repo, encoding: 'utf8' });
    const init = spawnSync(tsxBin, [
      'src/cli.ts',
      'init',
      workspace.repo,
      '--server-url',
      'https://analyzer.example.test',
      '--project-id',
      'proj_test',
      '--organization-id',
      'org_test',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: signedOutEnv(workspace.repo) });

    assert.equal(init.status, 0, init.stderr);
    const initialized = JSON.parse(init.stdout);
    assert.equal(initialized.status, 'connected');
    assert.equal(initialized.project.id, 'proj_test');
    assert.ok(Array.isArray(initialized.steps) && initialized.steps.length === 6, 'init reports all six onboarding steps');
    assert.ok(fs.existsSync(path.join(workspace.repo, '.klaurorc')));
    assert.ok(fs.existsSync(path.join(workspace.repo, '.klauroignore')));
    const rc = JSON.parse(fs.readFileSync(path.join(workspace.repo, '.klaurorc'), 'utf8'));
    assert.equal(rc.project.id, 'proj_test');
    assert.equal(rc.project.organizationId, 'org_test');

    const manifest = spawnSync(tsxBin, ['src/cli.ts', 'upload-manifest', workspace.repo, '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(manifest.status, 0, manifest.stderr);
    const parsed = JSON.parse(manifest.stdout);
    assert.ok(parsed.summary.included_files > 0);
    assert.ok(parsed.included_files.some((file: any) => file.path === 'app/main.py'));
    assert.equal(parsed.remote_provider.provider, 'github');
    assert.equal(parsed.remote_provider.owner, 'acme');
    assert.equal(parsed.remote_provider.repository, 'fastapi-sqlalchemy');
    assert.equal(parsed.remote_provider.suggested_connection.type, 'github_app');
    assert.equal(parsed.transfer_recommendation.operation, 'submit_commit_analysis');
    assert.equal(parsed.transfer_recommendation.status, 'active');
  });
});

test('local init with a detected remote submits committed source and suggests provider connection', async () => {
  await withFixtureWorkspace(async workspace => {
    spawnSync('git', ['init'], { cwd: workspace.repo, encoding: 'utf8' });
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/fastapi-sqlalchemy.git'], { cwd: workspace.repo, encoding: 'utf8' });
    await writeDefaultKlauroConfig(workspace.repo, { force: true });

    const manifest = await buildUploadManifest(workspace.repo);
    assert.equal(manifest.transfer_recommendation?.operation, 'submit_commit_analysis');
    assert.equal(manifest.transfer_recommendation?.status, 'active');
    assert.match(manifest.transfer_recommendation?.reason || '', /committed tree/);
    assert.equal(manifest.transfer_recommendation?.next_action, 'Connect acme/fastapi-sqlalchemy through the Klauro GitHub App');
  });
});

test('outer-folder init reports workspace candidates for child repos and Klauro projects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-workspace-test-'));
  try {
    const api = path.join(root, 'api');
    const web = path.join(root, 'web');
    fs.mkdirSync(api, { recursive: true });
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(api, 'package.json'), '{"name":"api"}\n');
    fs.writeFileSync(path.join(web, 'package.json'), '{"name":"web"}\n');
    spawnSync('git', ['init'], { cwd: api, encoding: 'utf8' });
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/api.git'], { cwd: api, encoding: 'utf8' });
    await writeDefaultKlauroConfig(web, { force: true, projectId: 'proj_web', organizationId: 'org_acme' });
    await writeDefaultKlauroConfig(root, { force: true });

    const manifest = await buildUploadManifest(root);
    assert.equal(manifest.workspace_recommendation?.recommended, true);
    assert.equal(manifest.workspace_recommendation?.rule, 'workspace-cannot-contain-workspace');
    assert.deepEqual(
      manifest.workspace_recommendation?.candidates.map(candidate => [candidate.path, candidate.kind]),
      [['api', 'git-repo'], ['web', 'klauro-project']]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dirty-tree manifest is private local working-copy context, not shared project analysis', async () => {
  await withFixtureWorkspace(async workspace => {
    spawnSync('git', ['init'], { cwd: workspace.repo, encoding: 'utf8' });
    await writeDefaultKlauroConfig(workspace.repo, { force: true, projectId: 'proj_test' });
    fs.appendFileSync(path.join(workspace.repo, 'app/main.py'), '\n# local edit\n');

    const manifest = await buildUploadManifest(workspace.repo, 'dirty-tree');
    assert.equal(manifest.transfer_recommendation?.operation, 'prepare_local_working_copy_context');
    assert.match(manifest.transfer_recommendation?.reason || '', /private local working-copy context/);
    assert.equal(manifest.dirty, true);
  });
});

test('shared source snapshot rejects uncommitted git changes', async () => {
  await withFixtureWorkspace(async workspace => {
    spawnSync('git', ['init'], { cwd: workspace.repo, encoding: 'utf8' });
    await writeDefaultKlauroConfig(workspace.repo, { force: true });
    fs.appendFileSync(path.join(workspace.repo, 'app/main.py'), '\n# local edit\n');

    await assert.rejects(
      () => buildSourceSnapshot(workspace.repo),
      /Shared Klauro project analysis runs on committed source/
    );
  });
});

test('source snapshot carries plain (non-manifest-named) config YAML files framework analyzers depend on', async () => {
  // Regression for a route-composition bug: Symfony's config/routes.yaml (resource
  // prefixes) and config/packages/security.yaml (access_control) are plain .yaml
  // files with no registered source extension or manifest basename, so the remote
  // snapshot gate silently dropped them — the server-side analysis then reported
  // only the controller-local route fragment (e.g. "/{id}/api-token") instead of
  // the true composed path ("/api/customer/{id}/api-token"). Direct on-disk
  // analyzer runs never showed this because they read the files straight off disk.
  await withFixtureWorkspace(async workspace => {
    spawnSync('git', ['init'], { cwd: workspace.repo, encoding: 'utf8' });
    fs.mkdirSync(path.join(workspace.repo, 'config', 'packages'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace.repo, 'config', 'routes.yaml'),
      'Customer:\n  resource:\n    path: ../src/Controller/Api/Customer\n  type: attribute\n  prefix: /api/customer\n'
    );
    fs.writeFileSync(
      path.join(workspace.repo, 'config', 'packages', 'security.yaml'),
      'security:\n  access_control:\n    - { path: ^/api/customer/, roles: ROLE_USER }\n'
    );
    spawnSync('git', ['add', '-A'], { cwd: workspace.repo, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'add symfony config'], { cwd: workspace.repo, encoding: 'utf8' });

    const snapshot = await buildSourceSnapshot(workspace.repo);
    const paths = snapshot.files.map(file => file.path);
    assert.ok(paths.includes('config/routes.yaml'), 'config/routes.yaml should be in the snapshot');
    assert.ok(paths.includes('config/packages/security.yaml'), 'config/packages/security.yaml should be in the snapshot');
  });
});

test('analyzer is one product (hosted) — no local/remote mode field at all', () => {
  // One product: analysis goes to the hosted service (heavy work + AI on the VPS),
  // production by default. There is no analyzer.mode. See docs/KLAURO-PRODUCT-MODEL.md.
  const config = defaultKlauroConfig('/tmp/example-project');
  assert.equal((config.analyzer as Record<string, unknown>).mode, undefined);
  assert.equal(config.analyzer.serverUrl, 'https://mcp.klauro.com');
  assert.deepEqual(Object.keys(config.source).sort(), ['exclude', 'followSymlinks', 'include', 'maxFileBytes', 'roots'].sort());
});

test('remote init defaults to Klauro Cloud without requiring --server-url', () => {
  return withFixtureWorkspace(async workspace => {
    const init = spawnSync(tsxBin, [
      'src/cli.ts',
      'init',
      workspace.repo,
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: signedOutEnv(workspace.repo) });

    assert.equal(init.status, 0, init.stderr);
    const initialized = JSON.parse(init.stdout);
    assert.equal(initialized.server_url, 'https://mcp.klauro.com');
    const rc = JSON.parse(fs.readFileSync(path.join(workspace.repo, '.klaurorc'), 'utf8'));
    assert.equal(rc.analyzer.serverUrl, 'https://mcp.klauro.com');
    // Signed out: hosted steps are skipped and the fabric stays LOCAL — a repo
    // is never flipped remote without stored credentials.
    assert.equal(initialized.signed_in, false);
    assert.equal(initialized.fabric, null);
  });
});

test('remote analyzer policy (allowRemoteAnalyzer / allowedAnalyzerHosts) is enforced', () => {
  const config = defaultKlauroConfig('/tmp/example-project');
  config.policy.allowRemoteAnalyzer = false;
  const loaded: LoadedKlauroConfig = { config, ignorePatterns: [] };

  assert.throws(
    () => assertRemoteAnalyzerAllowed(loaded, 'https://analyzer.example.test'),
    /allowRemoteAnalyzer=false/
  );

  config.policy.allowRemoteAnalyzer = true;
  config.policy.allowedAnalyzerHosts = ['https://allowed.example.test'];
  assert.throws(
    () => assertRemoteAnalyzerAllowed(loaded, 'https://analyzer.example.test'),
    /allowedAnalyzerHosts/
  );
  assert.doesNotThrow(() => assertRemoteAnalyzerAllowed(loaded, 'https://allowed.example.test'));
});

test('validateConventions accepts well-formed conventions of every kind', () => {
  const conventions: KlauroConventions = {
    routes: [
      { decorator: '@Endpoint', path_arg: 0, method_arg: 1 },
      { kind: 'call', call: 'app.register', method_arg: 0, path_arg: 1, handler_arg: 2 },
    ],
    entry_points: [{ files: 'src/jobs/**/*.ts', export_matches: '^run', kind: 'cli' }],
    entities: [{ name_suffix: 'Aggregate' }],
    di_bindings: [{ call: 'provide', token_arg: 0, impl_arg: 1 }],
    roles: [{ name_suffix: 'UseCase', role: 'use-case' }],
    flows: [{ name: 'Checkout', steps: ['CheckoutController.validate', 'CheckoutController.charge'] }],
  };
  const result = validateConventions(conventions);
  assert.deepEqual(result.errors, []);
});

test('validateConventions rejects malformed conventions with field-specific errors, not a crash', () => {
  const badRoute = validateConventions({ routes: [{} as any] });
  assert.ok(badRoute.errors.some(e => e.includes('conventions.routes[0]') && e.includes('decorator')));

  const badEntryPoint = validateConventions({ entry_points: [{ files: '', export_matches: '(', kind: 'cli' } as any] });
  assert.ok(badEntryPoint.errors.some(e => e.includes('"files"')));
  assert.ok(badEntryPoint.errors.some(e => e.includes('not a valid regular expression')));

  const badEntity = validateConventions({ entities: [{} as any] });
  assert.ok(badEntity.errors.some(e => e.includes('conventions.entities[0]')));

  const badDiBinding = validateConventions({ di_bindings: [{ call: 'provide' } as any] });
  assert.ok(badDiBinding.errors.some(e => e.includes('token_arg')));
  assert.ok(badDiBinding.errors.some(e => e.includes('impl_arg')));

  const badRole = validateConventions({ roles: [{ role: 'x' } as any] });
  assert.ok(badRole.errors.some(e => e.includes('name_suffix') || e.includes('name_regex')));

  const badFlow = validateConventions({ flows: [{ name: 'Empty', steps: [] }] });
  assert.ok(badFlow.errors.some(e => e.includes('non-empty array')));
});

test('validateConventions warns (does not error) on a decorator missing the leading @', () => {
  const result = validateConventions({ routes: [{ decorator: 'Endpoint', path_arg: 0 }] });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some(w => w.includes('leading @')));
});

test('validateConventions with no conventions section returns no errors/warnings', () => {
  const result = validateConventions(undefined);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

async function withFixtureWorkspace(run: (workspace: { root: string; repo: string }) => void | Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-config-test-'));
  const repo = path.join(root, 'repo');
  fs.cpSync(fixturePath, repo, { recursive: true });
  try {
    await run({ root, repo });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
