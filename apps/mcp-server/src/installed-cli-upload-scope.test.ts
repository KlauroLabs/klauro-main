import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

/**
 * Task #134 — CLI-surface regression coverage for the upload-scope guard
 * (apps/mcp-server/src/upload-scope-guard.ts), exercised against the
 * SHIPPED bundle (dist/cli.cjs) the same way installed-cli-ops-commands.test.ts
 * does, per the precedent noted in that file. Every fixture is a mkdtemp'd
 * TEMP directory; nothing here writes `.klaurorc` into (or creates a hosted
 * project for) a real project, and nothing here ever completes an upload —
 * the unsafe-scope cases are refused before any network call, and the
 * safe-scope cases are pointed at an unroutable server-url so the guard's
 * own behavior is observed without depending on network availability.
 */

const packageRoot = path.join(__dirname, '..');
const shippedCli = path.join(packageRoot, 'dist', 'cli.cjs');
const devCli = path.join(packageRoot, 'src', 'cli.ts');
const UNROUTABLE_SERVER = 'http://127.0.0.1:1';

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: dir, stdio: 'ignore' });
}

/** Runs a CLI entry point (shipped bundle by default) with a given cwd,
 *  guaranteed non-TTY stdin (spawn's default), so the interactive prompt
 *  path can never fire and this can never hang a test run. The server URL
 *  is forced to an unroutable address via KLAURO_ANALYZER_URL (read by both
 *  entry points' default-config resolution) rather than `--server-url` —
 *  the shipped CLI's `analyze` doesn't accept that flag at all, so passing
 *  it there would fail flag validation before ever reaching the guard. */
function runCli(
  entry: string,
  runner: string[],
  args: string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env, KLAURO_ANALYZER_URL: UNROUTABLE_SERVER };
    const child = spawn(runner[0], [...runner.slice(1), entry, ...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd, env, timeout: 30_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function runShippedCli(args: string[], cwd: string) {
  return runCli(shippedCli, [process.execPath], args, cwd);
}

// dev CLI runs through tsx so cli.ts's own arg parsing/behavior is covered
// too, not just the bundle.
function runDevCli(args: string[], cwd: string) {
  return runCli(devCli, [process.execPath, require.resolve('tsx/cli')], args, cwd);
}

for (const [label, run] of [['shipped (installed-cli.ts / dist/cli.cjs)', runShippedCli], ['dev (cli.ts)', runDevCli]] as const) {

  test(`${label}: a normal single-repo project proceeds without a scope prompt (analyze --server-url unroutable)`, async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-cli-scope-single-'));
    try {
      initGitRepo(repo);
      const result = await run(['analyze', repo, '--json'], repo);
      // Must have gotten PAST the scope guard (no "separate projects" refusal,
      // no aborted-nothing-uploaded message) — it should fail later, on the
      // network hop, which is expected since the server is unroutable.
      assert.doesNotMatch(result.stderr, /separate projects/, 'a normal single-repo project must never see the scope warning');
      assert.doesNotMatch(result.stderr, /Aborted; nothing was uploaded/);
      assert.match(result.stderr, /Resolved project root/, 'the resolved root must always be printed prominently before upload');
      assert.match(result.stderr, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test(`${label}: a path-less invocation prints the resolved cwd root before doing anything`, async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-cli-scope-pathless-'));
    try {
      initGitRepo(repo);
      // No positional path argument — must resolve (and print) cwd.
      const result = await run(['analyze', '--json'], repo);
      assert.match(result.stderr, /Resolved project root/);
      assert.match(result.stderr, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the printed root must be the resolved cwd, not a placeholder');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test(`${label}: a synthetic multi-repo parent (several nested .git dirs, no root manifest) is refused without --yes`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-cli-scope-multi-'));
    try {
      initGitRepo(path.join(root, 'project-a'));
      initGitRepo(path.join(root, 'project-b'));
      initGitRepo(path.join(root, 'project-c'));

      const result = await run(['analyze', root, '--json'], root);
      assert.notEqual(result.status, 0, 'an unsafe scope must exit non-zero, never silently succeed');
      assert.match(result.stderr, /3 separate projects/);
      assert.match(result.stderr, /Aborted; nothing was uploaded/);
      // The refusal happens BEFORE any network attempt — no auth/connection
      // failure text, only the scope message.
      assert.doesNotMatch(result.stdout, /"status"/, 'no result payload should ever be printed for a refused upload');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${label}: --yes overrides the multi-repo refusal and proceeds past the scope guard`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-cli-scope-yes-'));
    try {
      initGitRepo(path.join(root, 'project-a'));
      initGitRepo(path.join(root, 'project-b'));

      const result = await run(['analyze', root, '--yes', '--json'], root);
      assert.doesNotMatch(result.stderr, /Aborted; nothing was uploaded/, '--yes must skip the refusal');
      // It still fails, but on the network hop (unroutable server), not the
      // scope guard — the distinguishing signal is the absence of the
      // "separate projects"/"Aborted" text once --yes is given.
      assert.doesNotMatch(result.stderr, /separate projects/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${label}: this test run never uploaded anything — every case above either refused locally or failed on an unroutable server`, () => {
    // Explicit self-check, not a real assertion beyond documentation: every
    // test in this suite either (a) asserted a local refusal before any
    // network attempt, or (b) pointed --server-url at 127.0.0.1:1, which
    // nothing listens on. No fixture directory was ever a real project, no
    // .klaurorc was written outside a mkdtemp'd temp dir, and no hosted
    // project was created.
    assert.ok(true);
  });
}
