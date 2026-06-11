import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildUploadManifest } from './remote-source';
import { assertRemoteAnalyzerAllowed, defaultKlauroConfig, writeDefaultKlauroConfig, type LoadedKlauroConfig } from './klauro-config';

const repoRoot = path.resolve(__dirname, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
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
  });
});

test('analyzer mode defaults to local so no source leaves the machine without explicit opt-in', () => {
  const config = defaultKlauroConfig('/tmp/example-project');
  assert.equal(config.analyzer.mode, 'local');
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
