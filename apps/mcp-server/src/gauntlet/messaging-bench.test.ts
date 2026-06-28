import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runMessagingWiringBench } from './messaging-bench';

// Camp-C: message-broker pub/sub topology (who produces/consumes which topic).
// scip / stack-graphs / codebase-memory / embeddings have no topic concept.
const ROOT = path.resolve(__dirname, '../../fixtures/messaging-bench');
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`messaging-bench [${fixture}]: Klauro emits the pub/sub topic wiring nobody else has`, async () => {
    const r = await runMessagingWiringBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must emit the exact produces/consumes set, got ${JSON.stringify(klauro.wiring)}`);
    assert.equal(klauro.can_answer, true);
    for (const c of r.detail.filter(d => d.arm !== 'klauro')) {
      assert.equal(c.f1, 0, `[${fixture}] ${c.arm} has no topic concept`);
      assert.equal(c.can_answer, false);
    }
    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || `[${fixture}] Klauro must win`);
  });
}
