import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runRouteAuthBench } from './auth-bench';

const ROOT = path.resolve(__dirname, '../../fixtures/auth-bench');
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`auth-bench [${fixture}]: Klauro names the protected routes the competition cannot`, async () => {
    const r = await runRouteAuthBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, `[${fixture}] protected routes, got ${JSON.stringify(klauro.protected_routes)}`);
    assert.equal(klauro.can_answer, true);
    const competitors = r.detail.filter(d => d.arm !== 'klauro');
    assert.ok(competitors.length > 0);
    for (const c of competitors) {
      assert.equal(c.f1, 0, `[${fixture}] ${c.arm} has no auth concept`);
      assert.equal(c.can_answer, false);
    }
    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary);
    assert.equal(r.verdict.quality_won, true);
  });
}
