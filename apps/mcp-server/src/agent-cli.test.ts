import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

test('agent-context CLI emits parseable compact JSON with line windows', () => {
  withFixtureWorkspace(workspace => {
    const result = runCli(workspace, [
      'agent-context',
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

    const context = JSON.parse(result.stdout);
    assert.ok(context.file_read_plan.length > 0);
    assert.ok(context.file_read_plan.some((item: any) => item.line_window?.start >= 1));
    assert.ok(context.risk_context);
    assert.ok(Array.isArray(context.risk_context.agent_rules));
    assert.ok(context.risk_context.agent_rules.some((rule: string) => rule.includes('assess_change_risk')));
  });
});

test('agent-context CLI accepts --task as a natural alias for instructions', () => {
  withFixtureWorkspace(workspace => {
    const result = runCli(workspace, [
      'agent-context',
      workspace.repo,
      '--task-type',
      'modify',
      '--target',
      'users',
      '--task',
      'Update user creation behavior and tests',
      '--json',
      '--compact',
      '--quiet',
      '--refresh',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout);
    assert.match(JSON.stringify(context.task || context), /Update user creation behavior/);
  });
});

test('agent-context CLI quiet JSON suppresses analyzer maintenance logs', () => {
  withFixtureWorkspace(workspace => {
    const projectId = storageProjectId(workspace.repo);
    const projectStorage = path.join(workspace.storage, projectId);
    fs.mkdirSync(projectStorage, { recursive: true });
    fs.writeFileSync(
      path.join(projectStorage, 'incremental-state.json'),
      JSON.stringify({ version: 'stale-test-version', files: {}, dependencies: {} }, null, 2),
    );

    const result = runCli(workspace, [
      'agent-context',
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
    const context = JSON.parse(result.stdout);
    assert.ok(context.status);
  });
});

test('agent-context CLI auto-refreshes stale local analysis before returning agent context', () => {
  withFixtureWorkspace(workspace => {
    const first = runCli(workspace, [
      'agent-context',
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

    assert.equal(first.status, 0, first.stderr);

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    fs.appendFileSync(path.join(workspace.repo, 'app', 'main.py'), '\n# changed after analysis\n');

    const second = runCli(workspace, [
      'agent-context',
      workspace.repo,
      '--task-type',
      'modify',
      '--instructions',
      'Update user creation behavior and tests',
      '--json',
      '--quiet',
    ]);

    assert.equal(second.status, 0, second.stderr);
    const context = JSON.parse(second.stdout);
    assert.equal(context.analysis_freshness?.staleness, 'fresh');
    assert.equal(context.analysis_freshness?.changed_files, 0);
  });
});

test('agent-context CLI defaults to a bounded context profile', () => {
  withFixtureWorkspace(workspace => {
    const result = runCli(workspace, [
      'agent-context',
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
    const context = JSON.parse(result.stdout);
    assert.match(context.context_profile, /small-repo-minimal|token-minimal|ultra-small-repo|micro-repo/);
    assert.notEqual(context.context_profile, undefined);
  });
});

test('agent-context CLI supports capsule-only K15/K5 response profile', () => {
  withFixtureWorkspace(workspace => {
    const result = runCli(workspace, [
      'agent-context',
      workspace.repo,
      '--task-type',
      'modify',
      '--target',
      'audit logging',
      '--response-profile',
      'capsule-only',
      '--json',
      '--quiet',
      '--refresh',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout);
    assert.equal(context.context_profile, 'capsule-only');
    assert.match(context.context_capsule, /^K15m[A-Za-z0-9]* audit logging/m);
    assert.match(context.execution_capsule, /^K5\|m\|/);
    assert.ok(context.estimated_tokens < 500);
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

    assert.equal(routedCalls.length, 4);
    assert.doesNotMatch(JSON.stringify(config.first_calls), /<selected_path/);
    assert.ok(config.first_calls.some((call: any) =>
      call.tool === 'get_agent_context' && call.args.task?.response_profile === 'capsule-only'
    ));
    assert.match(config.prompts.agent_skill, /K15 Context Capsule/);
    assert.match(config.prompts.agent_skill, /read-then-edit/);
    assert.match(config.prompts.agent_skill, /do-not-rebuild/i);
    assert.ok(fs.existsSync(path.join(workspace.repo, '.klauro', 'agent-defaults.json')));
    assert.ok(fs.existsSync(path.join(workspace.repo, '.klauro', 'skills', 'klauro', 'SKILL.md')));
    const markdown = fs.readFileSync(path.join(workspace.repo, '.klauro', 'agent-defaults.md'), 'utf8');
    const skill = fs.readFileSync(path.join(workspace.repo, '.klauro', 'skills', 'klauro', 'SKILL.md'), 'utf8');
    assert.match(markdown, /Path source:/);
    assert.match(markdown, /K15 context capsule/);
    assert.match(markdown, /portable Klauro agent skill/);
    assert.match(skill, /^---\nname: klauro/m);
    assert.match(skill, /K15 Context Capsule/);
    assert.match(skill, /K5 Execution Capsule/);
    assert.match(skill, /G1 Greenfield Capsule/);
    assert.equal(skill, config.prompts.agent_skill);
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
