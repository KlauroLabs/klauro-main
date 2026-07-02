import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runSecurityFactsBench } from './security-facts-bench';

const ROOT = path.resolve(__dirname, '../../fixtures/security-facts');

// Every fixture under fixtures/security-facts/* with a truth.json is one
// out-of-category gate: Klauro must reach F1 1.0 on the security-fact set the
// SoliditySecurityAnalyzer emits, and no structural-only competitor can even
// attempt this task category (no security-fact abstraction to query).
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  const truth = fs.readJsonSync(path.join(ROOT, fixture, 'truth.json'));
  const pending = !!truth.pending;

  test(`security-facts-bench [${fixture}]: Klauro emits the exact security-fact set; structural tools cannot answer`, async (t) => {
    const r = await runSecurityFactsBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    const competitor = r.arms.find(a => a.arm_id === 'structural-grep')!;

    if (pending) {
      console.error(`KNOWN GAP [${fixture}] klauro F1 ${klauro.f1.toFixed(2)} — ${truth.note || 'analyzer needs deepening'}`);
      t.skip(`KNOWN GAP: Klauro F1 ${klauro.f1.toFixed(2)} does not yet win — ${truth.note || ''}`);
      return;
    }

    assert.equal(
      klauro.f1, 1,
      `[${fixture}] Klauro should be F1 1.0 on the security-fact set, got ${klauro.f1} facts=${JSON.stringify(klauro.facts)}`
    );
    // The out-of-category win: no structural-only arm can even attempt this.
    assert.equal(competitor.attempted, false, `[${fixture}] structural competitor must be marked can_answer:false`);
    assert.equal(r.verdict.klauro_wins, true, `[${fixture}] ${r.verdict.violation?.summary || 'Klauro must win'}`);

    const klauroArm = r.arms.find(a => a.arm_id === 'klauro')!;
    assert.equal(klauroArm.metrics.quality, 100, `[${fixture}] Klauro quality must be 100`);
  });
}

test('security-facts-bench: at least the erc20-ownable fixture exists', () => {
  assert.ok(fixtures.includes('erc20-ownable'), 'erc20-ownable fixture must exist');
});
