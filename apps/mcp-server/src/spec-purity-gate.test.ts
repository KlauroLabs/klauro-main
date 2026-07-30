import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  collectEvidencePathCorpusNames,
  isExcludedEvidencePath,
  runSpecPurityGate,
  scanContentForViolations,
} from './spec-purity-gate';

async function withTempRepo(build: (root: string) => Promise<void>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-purity-gate-test-'));
  await build(root);
  return root;
}

test('catches a name NOT on the old static BENCHMARK_CORPUS_NAMES list via the shape/context heuristic', () => {
  // "hoggan"/"zerac"/"soon-lens"/etc. were the hand-typed list. "griffintide"
  // was never on it and never will be added by hand — the whole point of the
  // evidence-derived gate is that it still gets caught the first time it
  // shows up in a customer/benchmark-shaped sentence.
  const content = [
    '// A quick note while we were reviewing this path:',
    "// this mirrors a bug we first saw in the customer repo griffintide,",
    '// so keep the fix generic rather than special-cased.',
  ].join('\n');
  const violations = scanContentForViolations('apps/mcp-server/src/some-module.ts', content, new Set());
  assert.ok(
    violations.some(v => v.name === 'griffintide' && v.reason === 'unclassified-name-shape'),
    `expected griffintide to be flagged, got: ${JSON.stringify(violations)}`,
  );
});

test('a name present in the forbidden (evidence) set is caught as a known-corpus-name violation', () => {
  const forbidden = new Set(['zerac-api']);
  const content = "// zerac-api's ingestion path taught us this edge case.";
  const violations = scanContentForViolations('apps/mcp-server/src/foo.ts', content, forbidden);
  assert.ok(violations.some(v => v.name === 'zerac-api' && v.reason === 'known-corpus-name'));
});

test('ordinary product prose with no customer/benchmark framing is not flagged', () => {
  const content = [
    '// The cross-codebase graph links entry points across every deployable',
    '// in a workspace, not just one repo.',
  ].join('\n');
  const violations = scanContentForViolations('apps/mcp-server/src/foo.ts', content, new Set());
  assert.deepEqual(violations, []);
});

test('excluded evidence paths (fixtures/gauntlet/bench/corpus/tests) are recognized', () => {
  assert.ok(isExcludedEvidencePath('apps/mcp-server/src/gauntlet/corpus-sweep.ts'));
  assert.ok(isExcludedEvidencePath('apps/mcp-server/src/agent-idiom-benchmark.test.ts'));
  assert.ok(isExcludedEvidencePath('fixtures/orm-bench/whatever.ts'));
  assert.ok(isExcludedEvidencePath('apps/mcp-server/src/cross-codebase-analysis.test.ts'));
  assert.ok(!isExcludedEvidencePath('apps/mcp-server/src/cross-codebase-analysis.ts'));
});

test('names named inside an excluded evidence path are harvested automatically, not hand-typed', async () => {
  const root = await withTempRepo(async r => {
    await fs.ensureDir(path.join(r, 'apps/mcp-server/src/gauntlet'));
    await fs.writeFile(
      path.join(r, 'apps/mcp-server/src/gauntlet/corpus-sweep.ts'),
      "const LEAD_WORKSPACES = ['~/dev/personal/money', '~/dev/zerac', '~/dev/kadrafleet'];\n" +
        // A compound /tmp/ mock only counts once its first segment is
        // independently confirmed via a real `~/dev/` reference (here,
        // 'zerac') — this is what keeps arbitrary test placeholders like
        // `/tmp/high-fanout` (see the false-positive-precision test below)
        // from being harvested as if they were real repo names.
        "const path = '/tmp/zerac-api';\n",
    );
  });
  const names = await collectEvidencePathCorpusNames(root);
  assert.ok(names.has('zerac'), `expected zerac harvested, got: ${[...names]}`);
  assert.ok(names.has('kadrafleet'), `expected kadrafleet harvested, got: ${[...names]}`);
  assert.ok(names.has('zerac-api'), `expected zerac-api harvested (cross-validated via zerac), got: ${[...names]}`);
  await fs.remove(root);
});

test('an arbitrary /tmp/ mock placeholder with no matching ~/dev/ reference is NOT harvested as a repo name', async () => {
  const root = await withTempRepo(async r => {
    await fs.ensureDir(path.join(r, 'apps/mcp-server/src/gauntlet'));
    await fs.writeFile(
      path.join(r, 'apps/mcp-server/src/gauntlet/some.test.ts'),
      "const system = { root_path: '/tmp/high-fanout' };\n" +
        "gate('machine-analysis:quality', true, 'ok');\n",
    );
  });
  const names = await collectEvidencePathCorpusNames(root);
  assert.ok(!names.has('high-fanout'), `expected high-fanout NOT harvested, got: ${[...names]}`);
  assert.ok(!names.has('quality'), `expected quality NOT harvested (mid-string analysis: label), got: ${[...names]}`);
  await fs.remove(root);
});

test('end-to-end: a client name in gated product source fails the gate; the same name in an excluded evidence path does not', async () => {
  const root = await withTempRepo(async r => {
    await fs.ensureDir(path.join(r, 'apps/mcp-server/src/gauntlet'));
    // Evidence path: legitimately narrates the corpus name (allowed).
    await fs.writeFile(
      path.join(r, 'apps/mcp-server/src/gauntlet/corpus-sweep.ts'),
      "const target = '~/dev/nimbusfreight';\n",
    );
    // Gated product source: the SAME name leaking into a comment (forbidden).
    await fs.writeFile(
      path.join(r, 'apps/mcp-server/src/orchestrator.ts'),
      "// we hit this edge case analyzing the nimbusfreight repo\nexport const x = 1;\n",
    );
  });
  const result = await runSpecPurityGate(root);
  assert.equal(result.ok, false);
  assert.ok(
    result.violations.some(v => v.file === 'apps/mcp-server/src/orchestrator.ts' && v.name === 'nimbusfreight'),
    `expected orchestrator.ts violation, got: ${JSON.stringify(result.violations)}`,
  );
  assert.ok(
    !result.violations.some(v => v.file.includes('gauntlet/corpus-sweep.ts')),
    'the gauntlet evidence file itself must never be gated',
  );
  await fs.remove(root);
});

test('a clean tree with no corpus names anywhere passes', async () => {
  const root = await withTempRepo(async r => {
    await fs.ensureDir(path.join(r, 'apps/mcp-server/src'));
    await fs.writeFile(
      path.join(r, 'apps/mcp-server/src/orchestrator.ts'),
      '// deterministic structural facts, interpreted generically.\nexport const x = 1;\n',
    );
  });
  const result = await runSpecPurityGate(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  await fs.remove(root);
});
