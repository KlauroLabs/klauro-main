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

// Monorepo-specific assertions beyond the generic file-level F1 check above:
// per-scope norm inference must find a real deviation local to apps/api even
// though apps/marketing-site uses a totally different (also internally
// consistent) layering style, and the pure high-fan-in utility decoy must
// never appear in principle_violations regardless of its call count.
const monorepoFixture = 'monorepo-per-scope';
if (fixtures.includes(monorepoFixture)) {
  test(`architectural-consistency-bench [${monorepoFixture}]: per-scope detection is scope-local, pure utility stays silent`, { timeout: 60000 }, async () => {
    const r: any = await runArchitecturalConsistencyBench(path.join(ROOT, monorepoFixture));
    const detail = r.detail;

    const perScopeConflict = (detail.conflicts || []).find((c: any) => c.id === 'per-scope-layering:apps/api');
    assert.ok(
      perScopeConflict,
      `expected a per-scope-layering:apps/api conflict (no global norm required), got conflicts: ${JSON.stringify(detail.conflicts)}`,
    );

    const allConflictFiles = (detail.conflicts || []).flatMap((c: any) =>
      (c.competing || []).flatMap((comp: any) => comp.files || [])
    );
    const allViolationFiles = (detail.principle_violations || []).map((v: any) => v.file);
    const marketingSiteMentioned = [...allConflictFiles, ...allViolationFiles].some((f: string) =>
      f.includes('marketing-site')
    );
    assert.equal(
      marketingSiteMentioned,
      false,
      `apps/marketing-site has its own internally-consistent (direct-repository) local norm and must never be flagged just for differing from apps/api's style, but found: ${JSON.stringify({ allConflictFiles, allViolationFiles })}`,
    );

    const idUtilsFlaggedAsCoupling = (detail.principle_violations || []).some(
      (v: any) => v.principle === 'coupling' && v.file.includes('id-utils.ts')
    );
    assert.equal(
      idUtilsFlaggedAsCoupling,
      false,
      'packages/shared/src/id-utils.ts (generateId/sanitizeId) is pure/stateless and must never be flagged as a coupling hotspot',
    );
  });
}
