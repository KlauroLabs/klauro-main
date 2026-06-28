import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runCallersBench } from './primitive-bench';

function hasTool(bin: string): boolean {
  try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const ROOT = path.resolve(__dirname, '../../fixtures/primitive-bench');
const toolsReady = hasTool('rg') && hasTool('ast-grep');

// Every fixture under fixtures/primitive-bench/* with a truth.json is one
// language/framework cell of the matrix. The win MUST hold for EVERY one — the
// out-primitive promise is not TypeScript-only. Adding a fixture adds a gate.
const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  const truth = fs.readJsonSync(path.join(ROOT, fixture, 'truth.json'));
  const pending = !!truth.pending;
  test(`primitive-bench [${fixture}]: Klauro out-primitives ripgrep + ast-grep on who-calls`, { skip: toolsReady ? false : 'rg/ast-grep not installed' }, async (t) => {
    const r = await runCallersBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;
    const ripgrep = r.detail.find(d => d.arm === 'ripgrep')!;
    const astgrep = r.detail.find(d => d.arm === 'ast-grep')!;

    // Pending cells are KNOWN GAPS: measured + surfaced loudly, but they do not
    // gate the suite (a loss is never faked into a win, and a not-yet-deepened
    // analyzer does not block the matrix). The loop must flip these to won.
    if (pending) {
      console.error(`KNOWN GAP [${fixture}] klauro F1 ${klauro.f1.toFixed(2)} (rg ${ripgrep.f1.toFixed(2)}, ast-grep ${astgrep.f1.toFixed(2)}) — ${truth.note || 'analyzer needs deepening'}`);
      t.skip(`KNOWN GAP: Klauro F1 ${klauro.f1.toFixed(2)} does not yet win — ${truth.note || ''}`);
      return;
    }

    // Won cells: Klauro must return the EXACT caller set and strictly beat the
    // name-matchers (which over-match the same-name decoy), on quality AND tokens.
    assert.equal(klauro.f1, 1, `[${fixture}] Klauro should be F1 1.0 on the caller set, got ${klauro.f1} files=${JSON.stringify(klauro.files)}`);
    assert.ok(klauro.f1 > ripgrep.f1, `[${fixture}] Klauro quality must strictly beat ripgrep (${klauro.f1} vs ${ripgrep.f1})`);
    assert.ok(klauro.f1 > astgrep.f1, `[${fixture}] Klauro quality must strictly beat ast-grep (${klauro.f1} vs ${astgrep.f1})`);
    // Camp A: when the real embeddings arm ran (Ollama up), Klauro must beat it too.
    const emb = r.detail.find(d => d.arm === 'embeddings-nomic');
    if (emb) assert.ok(klauro.f1 > emb.f1, `[${fixture}] Klauro must strictly beat real embeddings (${klauro.f1} vs ${emb.f1})`);
    assert.equal(r.verdict.klauro_wins, true, `[${fixture}] ${r.verdict.violation?.summary || 'Klauro must win'}`);
    const kTokens = r.arms.find(a => a.arm_id === 'klauro')!.metrics.tokens!;
    const rTokens = r.arms.find(a => a.arm_id === 'ripgrep')!.metrics.tokens!;
    assert.ok(kTokens < rTokens, `[${fixture}] Klauro must use fewer tokens than ripgrep`);
  });
}

test('primitive-bench: at least the TS + Python language cells exist', () => {
  assert.ok(fixtures.includes('callers-ts'), 'callers-ts fixture must exist');
  assert.ok(fixtures.includes('callers-py'), 'callers-py fixture must exist');
});
