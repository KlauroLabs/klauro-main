import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runComponentTreeBench } from './component-bench';

const ROOT = path.resolve(__dirname, '../../fixtures/component-bench');
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`component-bench [${fixture}]: Klauro emits the render tree the competition cannot`, async () => {
    const r = await runComponentTreeBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must emit the render tree, got ${JSON.stringify(klauro.tree)}`);
    assert.equal(klauro.can_answer, true);
    const competitors = r.detail.filter(d => d.arm !== 'klauro');
    assert.ok(competitors.length > 0);
    for (const c of competitors) {
      assert.equal(c.f1, 0, `[${fixture}] ${c.arm} cannot model a render tree`);
      assert.equal(c.can_answer, false);
    }
    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || 'Klauro must win the component tree');
    assert.equal(r.verdict.quality_won, true, 'emitting the render tree is an outright quality win');
  });
}

test('component-bench: the react-tree fixture exists', () => {
  assert.ok(fixtures.includes('react-tree'), 'react-tree fixture must exist');
});
