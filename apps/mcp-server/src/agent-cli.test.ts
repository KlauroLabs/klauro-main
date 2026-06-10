import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');

test('command-specific help prints usage without treating --help as a project path', () => {
  const result = spawnSync(tsxBin, ['src/cli.ts', 'agent-work-packet', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /klauro agent-work-packet/);
  assert.doesNotMatch(result.stderr, /Project path does not exist|requires a project path/);
});

test('agent-work-packet CLI emits parseable compact JSON with line windows', () => {
  withFixtureWorkspace(workspace => {
    const result = runCli(workspace, [
      'agent-work-packet',
      workspace.repo,
      '--task-type',
      'modify',
      '--instructions',
      'Update user creation behavior and tests',
      '--json',
      '--compact',
      '--quiet',
      '--refresh',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^>/, 'stdout should be pure JSON, not an npm command banner');

    const packet = JSON.parse(result.stdout);
    assert.ok(packet.file_read_plan.length > 0);
    assert.ok(packet.file_read_plan.some((item: any) => item.line_window?.start >= 1));
    assert.ok(packet.risk_context);
    assert.ok(Array.isArray(packet.risk_context.agent_rules));
    assert.ok(packet.risk_context.agent_rules.some((rule: string) => rule.includes('assess_change_risk')));
  });
});

test('agent-work-packet CLI quiet JSON suppresses analyzer maintenance logs', () => {
  withFixtureWorkspace(workspace => {
    const projectId = storageProjectId(workspace.repo);
    const projectStorage = path.join(workspace.storage, projectId);
    fs.mkdirSync(projectStorage, { recursive: true });
    fs.writeFileSync(
      path.join(projectStorage, 'incremental-state.json'),
      JSON.stringify({ version: 'stale-test-version', files: {}, dependencies: {} }, null, 2),
    );

    const result = runCli(workspace, [
      'agent-work-packet',
      workspace.repo,
      '--task-type',
      'modify',
      '--instructions',
      'Update user creation behavior and tests',
      '--json',
      '--compact',
      '--quiet',
      '--refresh',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Incremental state version mismatch/);
    assert.doesNotMatch(result.stderr, /Incremental state version mismatch/);
    const packet = JSON.parse(result.stdout);
    assert.ok(packet.status);
  });
});

test('agent-work-packet CLI defaults to a bounded packet profile', () => {
  withFixtureWorkspace(workspace => {
    const result = runCli(workspace, [
      'agent-work-packet',
      workspace.repo,
      '--task-type',
      'modify',
      '--instructions',
      'Add audit logging without duplicating existing behavior',
      '--json',
      '--quiet',
      '--refresh',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const packet = JSON.parse(result.stdout);
    assert.match(packet.packet_profile, /small-repo-minimal|token-minimal|ultra-small-repo|micro-repo/);
    assert.notEqual(packet.packet_profile, undefined);
  });
});

test('agent-install CLI emits selected-path routing metadata without placeholder args', () => {
  withFixtureWorkspace(workspace => {
    const result = runCli(workspace, [
      'agent-install',
      workspace.repo,
      '--json',
      '--quiet',
      '--refresh',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    const routedCalls = config.first_calls.filter((call: any) => call.path_source?.includes('selected_path'));

    assert.equal(routedCalls.length, 3);
    assert.doesNotMatch(JSON.stringify(config.first_calls), /<selected_path/);
    assert.ok(fs.existsSync(path.join(workspace.repo, '.klauro', 'agent-defaults.json')));
    assert.match(fs.readFileSync(path.join(workspace.repo, '.klauro', 'agent-defaults.md'), 'utf8'), /Path source:/);
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

function runCli(workspace: { storage: string }, args: string[]) {
  return spawnSync(tsxBin, ['src/cli.ts', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      KLAURO_STORAGE_PATH: workspace.storage,
    },
    encoding: 'utf8',
  });
}

function storageProjectId(repoPath: string): string {
  const name = path.basename(repoPath)
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80) || 'project';
  const hash = createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 12);
  return `${name}-${hash}`;
}
