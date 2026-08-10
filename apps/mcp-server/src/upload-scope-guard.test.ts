import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assessUploadScope, confirmUploadScope } from './upload-scope-guard';

/**
 * Task #134 regression coverage. Every fixture here is a mkdtemp'd TEMP
 * directory — never a real project on disk, never `.klaurorc` written into
 * anything but a throwaway temp dir, and nothing here ever reaches the
 * network (assessUploadScope/confirmUploadScope are pure local checks; no
 * upload function is called from this file at all).
 */

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: dir, stdio: 'ignore' });
}

function mkTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('a normal single-repo project (root has its own .git) is always safe, regardless of what is nested under it', async (t) => {
  const root = mkTemp('klauro-scope-single-repo-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initGitRepo(root);

  const assessment = await assessUploadScope(root);
  assert.equal(assessment.safe, true);
  assert.equal(assessment.reason, undefined);
});

test('a root with a project manifest (package.json) but no .git is safe even with nested repos', async (t) => {
  const root = mkTemp('klauro-scope-manifest-root-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }), 'utf8');
  initGitRepo(path.join(root, 'vendor', 'some-dependency'));
  initGitRepo(path.join(root, 'vendor', 'another-dependency'));

  const assessment = await assessUploadScope(root);
  assert.equal(assessment.safe, true, assessment.reason);
});

test('a synthetic multi-repo parent — several nested .git dirs, no root manifest — is refused', async (t) => {
  const root = mkTemp('klauro-scope-multi-repo-parent-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initGitRepo(path.join(root, 'project-a'));
  initGitRepo(path.join(root, 'project-b'));
  initGitRepo(path.join(root, 'project-c'));

  const assessment = await assessUploadScope(root);
  assert.equal(assessment.safe, false);
  assert.ok(assessment.reason, 'an unsafe assessment must explain why');
  assert.match(assessment.reason!, /3 separate projects/);
  assert.match(assessment.reason!, /no Git repository and no project manifest/);
  assert.equal(assessment.nestedRepoCount, 3);
  assert.equal(assessment.rootLooksLikeProject, false);
});

test('exactly one nested repo (e.g. a single vendored dependency) is not enough to trip the guard', async (t) => {
  const root = mkTemp('klauro-scope-one-nested-repo-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initGitRepo(path.join(root, 'only-child'));

  const assessment = await assessUploadScope(root);
  assert.equal(assessment.safe, true, assessment.reason);
});

test('a bound .klaurorc at the root counts as "this is a project" even with several nested repos beneath it', async (t) => {
  const root = mkTemp('klauro-scope-bound-root-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.klaurorc'), JSON.stringify({ version: 1, project: { id: 'prj_explicit' } }), 'utf8');
  initGitRepo(path.join(root, 'project-a'));
  initGitRepo(path.join(root, 'project-b'));

  const assessment = await assessUploadScope(root);
  assert.equal(assessment.safe, true, assessment.reason);
  assert.equal(assessment.rootLooksLikeProject, true);
});

test('confirmUploadScope: --yes bypasses an unsafe assessment without prompting (no stdin read)', async (t) => {
  const root = mkTemp('klauro-scope-yes-override-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initGitRepo(path.join(root, 'project-a'));
  initGitRepo(path.join(root, 'project-b'));

  const assessment = await assessUploadScope(root);
  assert.equal(assessment.safe, false);

  const result = await confirmUploadScope(assessment, { yes: true });
  assert.deepEqual(result, { proceed: true, confirmScope: true });
});

test('confirmUploadScope: a safe assessment never prompts, even with --yes omitted', async (t) => {
  const root = mkTemp('klauro-scope-safe-no-prompt-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initGitRepo(root);

  const assessment = await assessUploadScope(root);
  assert.equal(assessment.safe, true);

  // A non-TTY stdin would hang forever on a real prompt; if this resolves at
  // all (it must, immediately) the safe path never touched stdin.
  const result = await confirmUploadScope(assessment, { yes: false, stdin: process.stdin, stdout: process.stderr });
  assert.deepEqual(result, { proceed: true, confirmScope: false });
});

test('confirmUploadScope: an unsafe assessment on non-TTY stdin (scripted/CI) refuses instead of hanging, with no --yes', async (t) => {
  const root = mkTemp('klauro-scope-noninteractive-refuse-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initGitRepo(path.join(root, 'project-a'));
  initGitRepo(path.join(root, 'project-b'));

  const assessment = await assessUploadScope(root);
  assert.equal(assessment.safe, false);

  // process.stdin in this test runner is not a TTY, so promptLine (used
  // internally) returns '' immediately rather than blocking on real input —
  // this call must resolve promptly with proceed: false, never hang.
  const result = await Promise.race([
    confirmUploadScope(assessment, { yes: false, stdin: process.stdin, stdout: process.stderr }),
    new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 5000)),
  ]);
  assert.notEqual(result, 'timeout', 'confirmUploadScope must never hang waiting on non-TTY stdin');
  assert.deepEqual(result, { proceed: false, confirmScope: false });
});
