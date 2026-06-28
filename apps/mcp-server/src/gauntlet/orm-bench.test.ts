import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runOrmRelationsBench } from './orm-bench';

const ROOT = path.resolve(__dirname, '../../fixtures/orm-bench');

const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`orm-bench [${fixture}]: Klauro emits ORM entity relations the competition cannot`, async () => {
    const r = await runOrmRelationsBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;

    // Klauro reads the ORM decorators and emits directional cardinality.
    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must emit the expected relations, got ${JSON.stringify(klauro.relations)}`);
    assert.equal(klauro.can_answer, true);

    // Structural graphs / embeddings have no ORM-relation concept.
    const competitors = r.detail.filter(d => d.arm !== 'klauro');
    assert.ok(competitors.length > 0);
    for (const c of competitors) {
      assert.equal(c.f1, 0, `[${fixture}] ${c.arm} cannot model ORM relations`);
      assert.equal(c.can_answer, false);
    }

    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || 'Klauro must win ORM relations');
    assert.equal(r.verdict.quality_won, true, 'emitting the relation graph is an outright quality win');
  });
}

test('orm-bench: the typeorm-rel fixture exists', () => {
  assert.ok(fixtures.includes('typeorm-rel'), 'typeorm-rel fixture must exist');
});
