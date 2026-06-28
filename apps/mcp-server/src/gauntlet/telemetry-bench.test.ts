import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runTelemetryCorrelationBench } from './telemetry-bench';

// Camp-C: runtime telemetry ↔ static structure. Klauro fuses a live request to
// the exact static route it exercised; embeddings / scip / stack-graphs /
// codebase-memory are purely static and have NO runtime input at all.
const ROOT = path.resolve(__dirname, '../../fixtures/telemetry-bench');
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`telemetry-bench [${fixture}]: Klauro correlates runtime → static; the competition has no runtime axis`, async () => {
    const r = await runTelemetryCorrelationBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;

    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must correlate every event correctly, got ${klauro.correct}/${klauro.total}`);
    assert.equal(klauro.can_answer, true);

    const competitors = r.detail.filter(d => d.arm !== 'klauro');
    assert.ok(competitors.length > 0, 'must compare against real competitors');
    for (const c of competitors) {
      assert.equal(c.f1, 0, `[${fixture}] ${c.arm} has no runtime correlation`);
      assert.equal(c.can_answer, false);
    }

    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || `[${fixture}] Klauro must win the runtime axis`);
    assert.equal(r.verdict.quality_won, true, `[${fixture}] quality win — only Klauro fuses runtime to static`);
  });
}
