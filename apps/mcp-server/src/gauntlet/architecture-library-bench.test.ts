import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runArchitectureLibraryBench } from './architecture-library-bench';

const ROOT = path.resolve(__dirname, '../../fixtures/architecture-library-bench');
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(name => fs.existsSync(path.join(ROOT, name, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`architecture-library-bench [${fixture}]: Klauro names architecture-shaping library boundaries`, async () => {
    const result = await runArchitectureLibraryBench(path.join(ROOT, fixture));
    const klauro = result.detail.find(item => item.arm === 'klauro')!;
    assert.ok(klauro.f1 >= 0.99, `[${fixture}] Klauro F1 ${klauro.f1} < 0.99`);
    assert.equal(result.verdict.klauro_wins, true, result.verdict.violation?.summary || `[${fixture}] Klauro must win`);
    assert.ok(klauro.guidance_count >= klauro.categories.length, `[${fixture}] each category should carry agent guidance`);
  });
}
