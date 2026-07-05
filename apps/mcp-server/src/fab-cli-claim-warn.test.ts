import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * fab.ts papercut fix (b): `claim` now runs the same overlap scan `check` does
 * and prints an inline WARNING (to stderr) when it claims an already-claimed
 * path — advisory, the claim still succeeds — so an agent that skipped `check`
 * still gets the signal. Also exercises fix (a): a fresh temp KLAURO_COORD_DIR
 * plus an explicit FAB_WS, proving the default no longer keys off the cwd.
 */
const repoRoot = path.resolve(__dirname, '..');
const tsxBin = fs.existsSync(path.join(repoRoot, 'node_modules', '.bin', 'tsx'))
  ? path.join(repoRoot, 'node_modules', '.bin', 'tsx')
  : path.join(repoRoot, '..', '..', 'node_modules', '.bin', 'tsx');

function runFab(coordDir: string, args: string[]) {
  return spawnSync(tsxBin, ['scripts/fab.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, KLAURO_COORD_DIR: coordDir, FAB_WS: 'fab-cli-test' },
  });
}

test('fab.ts claim warns inline when claiming an already-claimed path (advisory, still succeeds)', () => {
  const coordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-fab-cli-'));
  try {
    // Agent A claims src/foo.ts — no prior claim, so no warning.
    const a = runFab(coordDir, ['claim', 'agent-a', 'refactor foo', 'src/foo.ts']);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /claimed .* agent-a/);
    assert.doesNotMatch(a.stderr, /WARNING/);

    // Agent B claims the SAME path WITHOUT calling `check` first — the claim
    // still succeeds (exit 0, stdout confirms) but stderr carries the advisory
    // warning naming agent-a.
    const b = runFab(coordDir, ['claim', 'agent-b', 'also touch foo', 'src/foo.ts']);
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /claimed .* agent-b/, 'claim still succeeds');
    assert.match(b.stderr, /WARNING/, 'inline advisory warning printed');
    assert.match(b.stderr, /agent-a/, 'warning names the conflicting agent');

    // Agent C claiming a DISJOINT path gets no warning.
    const c = runFab(coordDir, ['claim', 'agent-c', 'edit bar', 'src/bar.ts']);
    assert.equal(c.status, 0, c.stderr);
    assert.doesNotMatch(c.stderr, /WARNING/);
  } finally {
    fs.rmSync(coordDir, { recursive: true, force: true });
  }
});
