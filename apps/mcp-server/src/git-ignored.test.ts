import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { gitIgnoredPaths, isGitIgnored } from './git-ignored';

test('what the repository ignores is left out, and what it tracks never is', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-git-ignored-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await fs.outputFile(path.join(root, '.gitignore'), 'build/\n*.log\ntracked.log\n');
    await fs.outputFile(path.join(root, 'src/app.ts'), 'export const app = 1;\n');
    await fs.outputFile(path.join(root, 'build/out.js'), 'compiled\n');
    await fs.outputFile(path.join(root, 'src/debug.log'), 'noise\n');
    await fs.outputFile(path.join(root, 'tracked.log'), 'kept\n');
    execFileSync('git', ['add', '-f', 'tracked.log'], { cwd: root });
    const ignored = await gitIgnoredPaths(root);
    assert.equal(isGitIgnored('build/out.js', ignored), true);
    assert.equal(isGitIgnored('build', ignored), true);
    assert.equal(isGitIgnored('src/debug.log', ignored), true);
    assert.equal(isGitIgnored('src/app.ts', ignored), false);
    assert.equal(isGitIgnored('tracked.log', ignored), false);
  } finally {
    fs.removeSync(root);
  }
});

test('a folder that is not a repository ignores nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-not-a-repo-'));
  try {
    const ignored = await gitIgnoredPaths(root);
    assert.equal(isGitIgnored('anything.ts', ignored), false);
  } finally {
    fs.removeSync(root);
  }
});
