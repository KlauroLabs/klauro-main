import test from 'node:test';
import assert from 'node:assert/strict';

import { runIntentMergeDemo } from './intent-merge-demo';

test('intent-merge demo: composes orthogonal edits, surfaces the conceptual conflict, dedupes duplicate work', async () => {
  const report = await runIntentMergeDemo();

  assert.equal(report.scenarios.length, 4);
  for (const s of report.scenarios) {
    assert.equal(s.matches_expectation, true, `scenario "${s.scenario}" did not land in the expected bucket`);
  }

  const orthogonal = report.scenarios.find((s) => s.expected_bucket === 'auto_mergeable' && s.scenario.includes('retry + logging'))!;
  assert.equal(orthogonal.plan.summary.auto, 1);
  assert.equal(orthogonal.plan.summary.conflicts, 0);
  const orthogonalEntry = orthogonal.plan.auto_mergeable[0];
  assert.deepEqual([...orthogonalEntry.agents].sort(), ['agent-logging', 'agent-retry']);

  const conflictScenario = report.scenarios.find((s) => s.expected_bucket === 'needs_resolution')!;
  assert.equal(conflictScenario.plan.summary.conflicts, 1);
  assert.equal(conflictScenario.plan.needs_resolution[0].conflict.kind, 'contract-divergence');
  assert.equal(conflictScenario.plan.needs_resolution[0].conflict.passes_textual_merge, true);

  const dupScenario = report.scenarios.find((s) => s.expected_bucket === 'duplicate_work')!;
  // Both symbol_ids in the duplicated "add retryBilling" pair surface as
  // duplicate_work (one per agent's distinct symbol_id for the same logical
  // work) — informative, not a bug: the fleet did the same thing twice under
  // two different ids.
  assert.equal(dupScenario.plan.summary.duplicates, 2);
  assert.equal(dupScenario.plan.summary.auto, 0);

  const disjointScenario = report.scenarios.find((s) => s.scenario.startsWith('disjoint edits'))!;
  assert.equal(disjointScenario.plan.summary.auto, 2);
  assert.equal(disjointScenario.plan.summary.conflicts, 0);
  assert.equal(disjointScenario.plan.summary.duplicates, 0);

  assert.match(report.summary, /^\d+ symbols: \d+ auto-merged by intent, \d+ conflicts surfaced \(git would have silently merged them\), \d+ duplicates deduped\.$/);
});
