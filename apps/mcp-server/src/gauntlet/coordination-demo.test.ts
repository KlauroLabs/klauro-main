import test from 'node:test';
import assert from 'node:assert/strict';

import { run } from './coordination-demo';

test('coordination-demo: fabric prevents all planted collisions across 4 scenarios', async () => {
  const result = await run();
  const byScenario = new Map(result.scenarios.map((s) => [s.scenario, s]));

  const s1 = byScenario.get(1)!;
  assert.equal(s1.name, 'duplicate-work-prevented');
  assert.equal(s1.verdict, 'duplicate', 'agent B claim_work must resolve to duplicate');
  assert.equal(s1.passed, true);

  const s2 = byScenario.get(2)!;
  assert.equal(s2.name, 'edit-collision-prevented');
  assert.equal(s2.verdict, 'conflict+disjoint-granted');
  assert.equal(s2.passed, true, 'path conflict must be flagged AND disjoint path must be granted');

  const s3 = byScenario.get(3)!;
  assert.equal(s3.name, 'in-flight-contract-drift-warning');
  assert.equal(s3.verdict, 'drift');
  assert.equal(s3.passed, true);

  const s4 = byScenario.get(4)!;
  assert.equal(s4.name, 'change-attribution');
  assert.equal(s4.verdict, 'attributed');
  assert.equal(s4.passed, true);

  assert.equal(result.scenarios.length, 4);
  assert.ok(result.transcript.length > 0, 'transcript must be non-empty for the narrated report');
});

test('coordination-demo: run() is repeatable (isolated temp dir each call)', async () => {
  const first = await run();
  const second = await run();
  assert.equal(first.scenarios.every((s) => s.passed), true);
  assert.equal(second.scenarios.every((s) => s.passed), true);
});
