import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const tsxBin = fs.existsSync(path.join(repoRoot, 'node_modules', '.bin', 'tsx'))
  ? path.join(repoRoot, 'node_modules', '.bin', 'tsx')
  : path.join(repoRoot, '..', '..', 'node_modules', '.bin', 'tsx');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');

test('command-specific help prints usage without treating --help as a project path', () => {
  const result = spawnSync(tsxBin, ['src/cli.ts', 'agent-context', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /klauro agent-context/);
  assert.doesNotMatch(result.stderr, /Project path does not exist|requires a project path/);
});

test('agent-context requires a Klauro account and never falls back to local analysis', () => {
  withFixtureWorkspace(workspace => {
    const result = runCli(workspace, [
      'agent-context',
      workspace.repo,
      '--task-type',
      'modify',
      '--instructions',
      'Update user creation behavior and tests',
      '--json',
      '--quiet',
      '--refresh',
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Klauro account required|No queryable analysis is available/);
    assert.match(result.stderr, /klauro login/);
    assert.equal(fs.readdirSync(workspace.storage).length, 0, 'account failure must not create a local analysis');
  });
});

test('legacy local-analysis flags cannot bypass the account boundary', () => {
  withFixtureWorkspace(workspace => {
    const result = runCli(workspace, ['agent-context', workspace.repo, '--json', '--quiet'], {
      KLAURO_ALLOW_LOCAL_ANALYSIS: '1',
      KLAURO_FORCE_LOCAL_ANALYSIS: '1',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Klauro account required|No queryable analysis is available/);
    assert.equal(fs.readdirSync(workspace.storage).length, 0);
  });
});

function withFixtureWorkspace(run: (workspace: { root: string; repo: string; storage: string }) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-agent-cli-test-'));
  const repo = path.join(root, 'repo');
  const storage = path.join(root, 'storage');
  try {
    fs.cpSync(fixturePath, repo, { recursive: true });
    fs.mkdirSync(storage, { recursive: true });
    run({ root, repo, storage });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCli(
  workspace: { storage: string },
  args: string[],
  overrides: Record<string, string> = {},
) {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.KLAURO_ACCOUNT_TOKEN;
  delete env.KLAURO_TOKEN;
  delete env.KLAURO_API_KEY;
  return spawnSync(tsxBin, ['src/cli.ts', ...args], {
    cwd: repoRoot,
    env: {
      ...env,
      KLAURO_STORAGE_PATH: workspace.storage,
      HOME: path.dirname(workspace.storage),
      ...overrides,
    },
    encoding: 'utf8',
  });
}
