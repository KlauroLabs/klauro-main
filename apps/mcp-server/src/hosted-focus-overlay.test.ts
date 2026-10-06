import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { overlayLocalPathStatus } from './hosted-focus-overlay';

test('paths absent from the analysis are explained from the local git state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-focus-'));
  try {
    const git = (args: string[]) => execFileSync('git', ['-c', 'user.email=t@k.dev', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
    git(['init']);
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(root, 'tracked.ts'), 'export {};\n');
    git(['add', '.']);
    git(['commit', '-m', 'seed']);
    fs.mkdirSync(path.join(root, 'packages', 'harness'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'harness', 'engine.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'ignored.txt'), 'x\n');
    const item = (candidate: string) => ({ path: candidate, status: 'not-in-analysis', node_count: 0, nodes: [], note: 'generic' });
    const result: any = overlayLocalPathStatus({
      focus: { related_paths: [item('tracked.ts'), item('packages/harness'), item('ignored.txt'), item('nope.ts')], gaps: ['target "x": none'] },
    }, root);
    const byPath = Object.fromEntries(result.focus.related_paths.map((entry: any) => [entry.path, entry.local_git_status]));
    assert.deepEqual(byPath, { 'tracked.ts': 'tracked', 'packages/harness': 'untracked', 'ignored.txt': 'ignored', 'nope.ts': 'missing-on-disk' });
    assert.match(result.focus.related_paths[1].note, /Untracked in your git repository/);
    assert.ok(result.focus.gaps.includes('target "x": none'));
    assert.equal(result.focus.gaps.length, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('results without unresolved paths pass through unchanged', () => {
  const result = { focus: { related_paths: [{ path: 'a.ts', status: 'in-analysis' }], gaps: [] } };
  assert.equal(overlayLocalPathStatus(result, '/nowhere'), result);
});
