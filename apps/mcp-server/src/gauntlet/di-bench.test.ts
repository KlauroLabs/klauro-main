import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runDiGraphBench } from './di-bench';

// Camp-C: dependency-injection graphs. Klauro emits "X injects Y" with container
// semantics; embeddings / scip / stack-graphs / codebase-memory see only imports.
const ROOT = path.resolve(__dirname, '../../fixtures/di-bench');
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`di-bench [${fixture}]: Klauro emits the DI graph the competition cannot`, async () => {
    const r = await runDiGraphBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;

    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must emit the exact injection set, got ${JSON.stringify(klauro.injections)}`);
    assert.equal(klauro.can_answer, true);

    const competitors = r.detail.filter(d => d.arm !== 'klauro');
    assert.ok(competitors.length > 0, 'must compare against real competitors');
    for (const c of competitors) {
      assert.equal(c.f1, 0, `[${fixture}] ${c.arm} has no DI concept`);
      assert.equal(c.can_answer, false);
    }

    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || `[${fixture}] Klauro must win the DI axis`);
    assert.equal(r.verdict.quality_won, true, `[${fixture}] quality win — only Klauro models injection`);
  });
}
