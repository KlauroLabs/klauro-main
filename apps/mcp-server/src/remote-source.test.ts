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

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
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

test('repo_facts: single-author git repo carries contributor_count=1 and first/last commit timestamps', async () => {
  await withTempDir(async dir => {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'first commit']);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = 2;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'second commit']);

    const snapshot = await buildSourceSnapshot(dir);
    const repoFacts = snapshot.manifest.repo_facts;
    assert.ok(repoFacts, 'expected manifest.repo_facts to be present for a real git history');
    assert.equal(repoFacts?.contributor_count, 1);
    assert.ok(repoFacts?.first_commit_at, 'expected first_commit_at to be set');
    assert.ok(repoFacts?.last_commit_at, 'expected last_commit_at to be set');
    assert.ok(
      new Date(repoFacts!.first_commit_at!).getTime() <= new Date(repoFacts!.last_commit_at!).getTime(),
      'first_commit_at should not be after last_commit_at'
    );
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
