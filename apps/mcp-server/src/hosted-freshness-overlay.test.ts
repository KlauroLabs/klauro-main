import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { overlayLocalFreshness } from './hosted-freshness-overlay';
import { clearFreshnessSummaryCache } from './freshness';

test('hosted freshness measured on the server snapshot is replaced by the local git scan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-overlay-'));
  try {
    fs.writeFileSync(path.join(root, 'index.ts'), 'export const a = 1;\n');
    const git = (args: string[]) => execFileSync('git', ['-c', 'user.email=t@k.dev', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
    git(['init']);
    git(['add', '.']);
    git(['commit', '-m', 'seed']);
    const hosted = {
      path: root,
      analysis_freshness: {
        analyzed_at: new Date(Date.now() + 60_000).toISOString(),
        age: '0m',
        files_changed_since_analysis: { count: 0, examples: [] },
        files_deleted_since_analysis: { count: 0, examples: [] },
        staleness: 'fresh',
        recommendation: 'Analysis is current',
        scan: { method: 'walk', bounded: false, duration_ms: 1, note: 'Non-git directory: bounded mtime walk' },
      },
    };
    clearFreshnessSummaryCache();
    const result = overlayLocalFreshness(hosted, root);
    assert.equal(result.analysis_freshness.scan.method, 'git');
    assert.equal(result.analysis_freshness.scan.note, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('results without a full freshness summary pass through unchanged', () => {
  const compact = { analysis_freshness: { staleness: 'fresh' }, other: [1, 2] };
  assert.deepEqual(overlayLocalFreshness(compact, '/nowhere'), compact);
});
