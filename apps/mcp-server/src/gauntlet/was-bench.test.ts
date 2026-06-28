import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runWasCrossRepoBench } from './was-bench';

// Camp-C / WAS: cross-repo comprehension. Klauro fuses a client fetch in one repo
// to the server route in another; single-repo indexers (scip/stack-graphs/
// embeddings/codebase-memory) cannot see across repos.
const ROOT = path.resolve(__dirname, '../../fixtures/was-bench');
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`was-bench [${fixture}]: Klauro fuses cross-repo links the single-repo competition cannot`, async () => {
    const r = await runWasCrossRepoBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;

    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must emit the exact cross-repo link set, got ${JSON.stringify(klauro.links)}`);
    assert.equal(klauro.can_answer, true);

    const competitors = r.detail.filter(d => d.arm !== 'klauro');
    assert.ok(competitors.length > 0, 'must compare against real competitors');
    for (const c of competitors) {
      assert.equal(c.f1, 0, `[${fixture}] ${c.arm} has no cross-repo fusion`);
      assert.equal(c.can_answer, false);
    }

    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || `[${fixture}] Klauro must win the cross-repo axis`);
    assert.equal(r.verdict.quality_won, true, `[${fixture}] quality win — only Klauro fuses repos`);
  });
}
