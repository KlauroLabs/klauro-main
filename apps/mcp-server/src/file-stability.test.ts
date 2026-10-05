import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASTemporalStability } from '../../../packages/analyzer-core/src/types/cas.types';
import { hotSpotsFromHistory, recentBugsFactor, stabilityFor } from './file-stability';

function entry(path: string, fixes: number, percentile: number, commits = 10): CASTemporalStability {
  return {
    node_id: path,
    stability_score: 0.5,
    stability_class: 'evolving',
    churn_metrics: { commits_30d: 1, commits_90d: commits, unique_authors_30d: 1, lines_changed_30d: 0 },
    quality_signals: {
      bug_fix_rate: fixes / commits,
      refactor_frequency: 'rare',
      has_recent_regression: false,
      bug_fix_commits: fixes,
      bug_fix_percentile: percentile,
      churn_percentile: 50,
    },
    age_context: { file_age_days: 0, is_legacy: false },
  };
}

test('a unit takes the stability of the file that holds it', () => {
  const cas = { temporal_stability: [entry('src/a.ts', 4, 95)] } as unknown as CASOutput;
  assert.equal(stabilityFor(cas, { id: 'src/a.ts#run', source: { file: 'src/a.ts' } } as never)?.node_id, 'src/a.ts');
  assert.equal(stabilityFor(cas, { id: 'src/b.ts#run', source: { file: 'src/b.ts' } } as never), undefined);
});

test('bug fixes are weighed against the repository own files, not a fixed rate', () => {
  assert.equal(recentBugsFactor(entry('a', 4, 95))?.severity, 'high');
  assert.equal(recentBugsFactor(entry('a', 2, 80))?.severity, 'medium');
  assert.equal(recentBugsFactor(entry('a', 1, 99)), undefined);
  assert.equal(recentBugsFactor(entry('a', 5, 40)), undefined);
  assert.match(recentBugsFactor(entry('a', 4, 95))?.details ?? '', /more than 95% of files/);
});

test('hot spots can be ranked from the history the analysis carries', () => {
  const cas = { temporal_stability: [entry('src/a.ts', 4, 95), entry('src/b.ts', 0, 10, 0)] } as unknown as CASOutput;
  assert.deepEqual(hotSpotsFromHistory(cas, 'bug-fix-rate').map(row => row.id), ['src/a.ts']);
  assert.deepEqual(hotSpotsFromHistory(cas, 'churn-lines'), []);
});
