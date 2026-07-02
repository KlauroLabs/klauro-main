import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runArchitecturalConsistencyBench } from './architectural-consistency-bench';

const ROOT = path.resolve(__dirname, '../../fixtures/architectural-consistency-bench');
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`architectural-consistency-bench [${fixture}]: flags the planted layering violation, stays silent on decoys`, { timeout: 60000 }, async () => {
    const r = await runArchitecturalConsistencyBench(path.join(ROOT, fixture));
    assert.equal(
      r.found_violation_files.length > 0,
      true,
      `[${fixture}] expected to flag the planted violation, got: ${JSON.stringify(r.detail, null, 2).slice(0, 1000)}`,
    );
    assert.equal(r.f1, 1, `[${fixture}] expected F1=1, got ${r.f1}. detail: ${JSON.stringify(r.detail).slice(0, 1000)}`);
    assert.equal(
      r.silent_on_decoys,
      true,
      `[${fixture}] should stay silent on consistent decoy controllers, but flagged: ${JSON.stringify(r.flagged_clean_files)}`,
    );
    assert.equal(r.is_cohesive, false, `[${fixture}] is_cohesive should be false when a violation is planted`);
  });
}
