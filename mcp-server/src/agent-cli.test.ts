import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const fixturePath = path.join(repoRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');

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
    assert.ok(fs.existsSync(path.join(workspace.repo, '.unravl', 'agent-defaults.json')));
    assert.match(fs.readFileSync(path.join(workspace.repo, '.unravl', 'agent-defaults.md'), 'utf8'), /Path source:/);
  });
});

function withFixtureWorkspace(run: (workspace: { root: string; repo: string; storage: string }) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unravl-agent-cli-test-'));
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
      UNRAVL_STORAGE_PATH: workspace.storage,
    },
    encoding: 'utf8',
  });
}
