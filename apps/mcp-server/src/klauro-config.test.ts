import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSourceSnapshot, buildUploadManifest } from './remote-source';
import { assertRemoteAnalyzerAllowed, defaultKlauroConfig, writeDefaultKlauroConfig, type LoadedKlauroConfig } from './klauro-config';

const repoRoot = path.resolve(__dirname, '..');
const tsxBin = fs.existsSync(path.join(repoRoot, 'node_modules', '.bin', 'tsx'))
  ? path.join(repoRoot, 'node_modules', '.bin', 'tsx')
  : path.join(repoRoot, '..', '..', 'node_modules', '.bin', 'tsx');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');

test('upload manifest honors .klaurorc and .klauroignore before remote upload', async () => {
  await withFixtureWorkspace(async workspace => {
    await writeDefaultKlauroConfig(workspace.repo, { force: true, mode: 'remote', serverUrl: 'https://analyzer.example.test' });
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
      '--mode',
      'remote',
      '--server-url',
      'https://analyzer.example.test',
      '--project-id',
      'proj_test',
      '--organization-id',
      'org_test',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });

    assert.equal(init.status, 0, init.stderr);
    const initialized = JSON.parse(init.stdout);
    assert.equal(initialized.config.project.id, 'proj_test');
    assert.equal(initialized.config.project.organizationId, 'org_test');
    assert.ok(fs.existsSync(path.join(workspace.repo, '.klaurorc')));
    assert.ok(fs.existsSync(path.join(workspace.repo, '.klauroignore')));

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
    await writeDefaultKlauroConfig(workspace.repo, { force: true, mode: 'remote' });

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

test('analyzer defaults to the product (hosted) path — no user-facing local/remote mode', () => {
  // One product: analysis goes to the hosted service (heavy work + AI on the VPS),
  // production by default. 'local' in-process is an internal self-host/dev/offline
  // escape only. See docs/KLAURO-PRODUCT-MODEL.md.
  const config = defaultKlauroConfig('/tmp/example-project');
  assert.equal(config.analyzer.mode, 'remote');
  assert.equal(config.analyzer.serverUrl, 'https://mcp.klauro.com');
  assert.deepEqual(Object.keys(config.source).sort(), ['exclude', 'followSymlinks', 'include', 'maxFileBytes', 'roots'].sort());
});

test('remote init defaults to Klauro Cloud without requiring --server-url', () => {
  return withFixtureWorkspace(async workspace => {
    const init = spawnSync(tsxBin, [
      'src/cli.ts',
      'init',
      workspace.repo,
      '--mode',
      'remote',
      '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });

    assert.equal(init.status, 0, init.stderr);
    const initialized = JSON.parse(init.stdout);
    assert.equal(initialized.config.analyzer.mode, 'remote');
    assert.equal(initialized.config.analyzer.serverUrl, 'https://mcp.klauro.com');
  });
});

test('remote analyzer policy is enforced even when analyzer mode is local', () => {
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
