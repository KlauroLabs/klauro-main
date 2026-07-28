import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSourceSnapshot } from './remote-source';

/**
 * Coverage for repo_facts (contributor_count/first_commit_at/last_commit_at)
 * client-side derivation — apps/mcp-server/src/remote-source.ts deriveRepoFacts,
 * wired into buildManifest() and reachable through every SourceManifest-producing
 * entry point (buildSourceSnapshot, buildHeadSourceSnapshot,
 * buildWorkingTreeChangeContext). Additive/honest contract: present only when a
 * real git history exists, absent (not a fabricated zero) otherwise.
 */

function git(cwd: string, args: string[], env?: Record<string, string>): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function commitAt(dir: string, isoDate: string, message: string): void {
  git(dir, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate });
}

function initGitRepo(dir: string): void {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'Test Author']);
}

function withTempDir(run: (dir: string) => void | Promise<void>): void | Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-repo-facts-test-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const result = run(dir);
  if (result && typeof (result as Promise<void>).then === 'function') {
    return (result as Promise<void>).then(cleanup, error => {
      cleanup();
      throw error;
    });
  }
  cleanup();
  return result;
}

test('repo_facts: single-author git repo carries contributor_count=1 and distinct first/last commit timestamps', async () => {
  await withTempDir(async dir => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n');
    git(dir, ['add', '.']);
    commitAt(dir, '2019-03-14T00:00:00-06:00', 'first commit');
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 2;\n');
    git(dir, ['add', '.']);
    commitAt(dir, '2026-07-01T00:00:00-06:00', 'second commit');

    const snapshot = await buildSourceSnapshot(dir);
    const repoFacts = snapshot.manifest.repo_facts;
    assert.ok(repoFacts, 'expected manifest.repo_facts to be present for a real git history');
    assert.equal(repoFacts?.contributor_count, 1);
    assert.equal(repoFacts?.first_commit_at, '2019-03-14T00:00:00-06:00');
    assert.equal(repoFacts?.last_commit_at, '2026-07-01T00:00:00-06:00');
  });
});

/**
 * Regression test for the actual production defect (fresh self-analysis,
 * 2026-07-21T14:52Z): `git log --reverse -1` truncates git's default
 * newest-first traversal to one entry BEFORE `--reverse` runs, so it silently
 * returned HEAD — identical to the `last_commit_at` query — collapsing
 * first_commit_at === last_commit_at onto the upload/analysis time for every
 * multi-commit repo. A weaker assertion (`first_commit_at <= last_commit_at`)
 * would have passed under the bug; this asserts strict inequality across a
 * longer, more realistic commit history to make sure the fix (root commit via
 * `git rev-list --max-parents=0`) actually reaches back to the true oldest
 * commit rather than any other recent one.
 */
test('repo_facts: first_commit_at is strictly earlier than last_commit_at across a longer history (catches the git --reverse -1 truncation bug)', async () => {
  await withTempDir(async dir => {
    initGitRepo(dir);
    const dates = [
      '2018-01-05T00:00:00-06:00',
      '2020-06-15T00:00:00-06:00',
      '2022-11-30T00:00:00-06:00',
      '2026-07-20T00:00:00-06:00',
    ];
    for (const [index, date] of dates.entries()) {
      fs.writeFileSync(path.join(dir, 'index.ts'), `export const a = ${index};\n`);
      git(dir, ['add', '.']);
      commitAt(dir, date, `commit ${index}`);
    }

    const snapshot = await buildSourceSnapshot(dir);
    const repoFacts = snapshot.manifest.repo_facts;
    assert.ok(repoFacts?.first_commit_at, 'expected first_commit_at to be set');
    assert.ok(repoFacts?.last_commit_at, 'expected last_commit_at to be set');
    assert.equal(repoFacts?.first_commit_at, dates[0], 'first_commit_at must be the true root commit, not just any recent one');
    assert.equal(repoFacts?.last_commit_at, dates[dates.length - 1]);
    assert.ok(
      new Date(repoFacts!.first_commit_at!).getTime() < new Date(repoFacts!.last_commit_at!).getTime(),
      'first_commit_at must be strictly before last_commit_at for a real multi-commit, multi-date history'
    );
  });
});

/**
 * Defense-in-depth regression test: a repo with more than one commit whose
 * derived first/last timestamps nonetheless collapse onto each other is
 * exactly the observable shape of the bug above (and would be the shape of a
 * genuinely fabricated single synthetic upload-time commit standing in for
 * real history) — deriveRepoFacts should treat that combination as
 * unreliable and omit the timestamps rather than ship a pair that reads as
 * real but isn't. contributor_count (independently derived) is unaffected.
 */
test('repo_facts: synthetic-looking collapsed timestamps (>1 commit, but first_commit_at === last_commit_at) are rejected, not shipped', async () => {
  await withTempDir(async dir => {
    initGitRepo(dir);
    const sameInstant = '2026-07-21T03:13:45-06:00';
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n');
    git(dir, ['add', '.']);
    commitAt(dir, sameInstant, 'first commit');
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 2;\n');
    git(dir, ['add', '.']);
    commitAt(dir, sameInstant, 'second commit');
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 3;\n');
    git(dir, ['add', '.']);
    commitAt(dir, sameInstant, 'third commit');

    const snapshot = await buildSourceSnapshot(dir);
    const repoFacts = snapshot.manifest.repo_facts;
    assert.ok(repoFacts, 'contributor_count should still be present');
    assert.equal(repoFacts?.contributor_count, 1);
    assert.equal(repoFacts?.first_commit_at, undefined, 'must not ship a synthetic-looking collapsed first_commit_at for a >1-commit history');
    assert.equal(repoFacts?.last_commit_at, undefined, 'must not ship a synthetic-looking collapsed last_commit_at for a >1-commit history');
  });
});

/**
 * A genuinely single-commit repo is the one legitimate case where
 * first_commit_at === last_commit_at — the defensive rejection above must
 * not misfire here, since commitCount === 1 (not "> 1").
 */
test('repo_facts: a real single-commit repo still carries equal first_commit_at/last_commit_at (not rejected)', async () => {
  await withTempDir(async dir => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n');
    git(dir, ['add', '.']);
    commitAt(dir, '2026-07-21T03:13:45-06:00', 'only commit');

    const snapshot = await buildSourceSnapshot(dir);
    const repoFacts = snapshot.manifest.repo_facts;
    assert.equal(repoFacts?.contributor_count, 1);
    assert.equal(repoFacts?.first_commit_at, '2026-07-21T03:13:45-06:00');
    assert.equal(repoFacts?.last_commit_at, '2026-07-21T03:13:45-06:00');
  });
});

test('repo_facts: contributor_count reflects distinct commit authors', async () => {
  await withTempDir(async dir => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'first commit']);

    git(dir, ['config', 'user.email', 'second@example.test']);
    git(dir, ['config', 'user.name', 'Second Author']);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 2;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'second commit']);

    const snapshot = await buildSourceSnapshot(dir);
    assert.equal(snapshot.manifest.repo_facts?.contributor_count, 2);
  });
});

test('repo_facts: absent (not a fabricated zero) for a non-git working tree', async () => {
  await withTempDir(async dir => {
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n');

    const snapshot = await buildSourceSnapshot(dir);
    assert.equal(snapshot.manifest.repo_facts, undefined);
  });
});

test('repo_facts: absent for a git repo with no commits yet (working-tree-only)', async () => {
  await withTempDir(async dir => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n');

    const snapshot = await buildSourceSnapshot(dir);
    assert.equal(snapshot.manifest.repo_facts, undefined);
  });
});
