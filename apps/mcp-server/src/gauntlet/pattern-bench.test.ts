import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runPatternFactsBench } from './pattern-bench';

const ROOT = path.resolve(__dirname, '../../fixtures/pattern-bench');

const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`pattern-bench [${fixture}]: Klauro NAMES the pattern; structural graphs only describe topology`, async () => {
    const r = await runPatternFactsBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;

    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must name the expected pattern(s), got ${JSON.stringify(klauro.patterns)}`);
    assert.equal(klauro.can_answer, true);

    const competitors = r.detail.filter(d => d.arm !== 'klauro');
    assert.ok(competitors.length > 0);
    for (const c of competitors) {
      assert.equal(c.f1, 0, `[${fixture}] ${c.arm} cannot name a design pattern`);
      assert.equal(c.can_answer, false);
    }

    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || 'Klauro must win pattern naming');
    assert.equal(r.verdict.quality_won, true, 'naming the pattern is an outright quality win');
  });
}

test('pattern-bench: the layered-di fixture exists', () => {
  assert.ok(fixtures.includes('layered-di'), 'layered-di fixture must exist');
});
