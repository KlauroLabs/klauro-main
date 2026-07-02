import test from 'node:test';
import assert from 'node:assert/strict';

import { runConceptualConflictDemo } from './conceptual-conflict-demo';

test('conceptual-conflict demo: 4 conceptual conflicts caught, zero false positives on the control', async () => {
  const report = await runConceptualConflictDemo();

  assert.equal(report.scenarios.length, 5);

  const byScenario = new Map(report.scenarios.map((s) => [s.expected_conflict_kind, s]));

  const contractScenarios = report.scenarios.filter((s) => s.expected_conflict_kind === 'contract-divergence');
  assert.equal(contractScenarios.length, 2); // (a) nullability + (b) return-type
  for (const s of contractScenarios) {
    assert.equal(s.conflicts_found, 1);
    assert.equal(s.passes_textual_merge_all, true);
  }

  const structural = byScenario.get('structural-divergence')!;
  assert.equal(structural.conflicts_found, 1);
  assert.equal(structural.passes_textual_merge_all, true);

  const duplicate = byScenario.get('duplicate-work')!;
  assert.equal(duplicate.conflicts_found, 1);
  assert.equal(duplicate.passes_textual_merge_all, true);

  const control = byScenario.get(null)!;
  assert.equal(control.conflicts_found, 0);

  assert.equal(report.total_conceptual_conflicts_caught, 4);
  assert.equal(report.summary, '4 conceptual conflicts caught that textual merge would have passed.');
});
