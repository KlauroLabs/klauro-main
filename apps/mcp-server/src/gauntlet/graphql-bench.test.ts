import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runGraphqlWiringBench } from './graphql-bench';

const ROOT = path.resolve(__dirname, '../../fixtures/graphql-bench');
const fixtures = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json'))) : [];

for (const fixture of fixtures) {
  test(`graphql-bench [${fixture}]: Klauro wires schema fields to resolvers; competition cannot`, async () => {
    const r = await runGraphqlWiringBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must wire all fields, got ${JSON.stringify(klauro.fields)}`);
    for (const c of r.detail.filter(d => d.arm !== 'klauro')) {
      assert.equal(c.f1, 0, `${c.arm} cannot wire fields to resolvers`);
    }
    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || 'Klauro must win graphql wiring');
    assert.equal(r.verdict.quality_won, true);
  });
}
test('graphql-bench: the apollo-svc fixture exists', () => { assert.ok(fixtures.includes('apollo-svc')); });
