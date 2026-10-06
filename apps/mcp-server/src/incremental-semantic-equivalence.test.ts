import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runIncrementalValueBenchmark } from './incremental-benchmark';

const packageRoot = path.resolve(__dirname, '..');

test('semantic edits remain incremental and converge to the cold graph across analyzer families', { timeout: 120_000 }, async () => {
  const previousAiSetting = process.env.KLAURO_AI_ENABLED;
  process.env.KLAURO_AI_ENABLED = 'false';
  try {
    const report = await runIncrementalValueBenchmark({
      repos: [
        ['typescript', 'fixtures/analysis-truth/nest-react-prisma'],
        ['cpp', 'fixtures/analysis-truth/c-cpp-basic'],
        ['protobuf', 'fixtures/analysis-truth/proto-basic'],
        ['java', 'fixtures/auth-bench/spring-auth'],
        ['rust', 'fixtures/auth-bench/axum-auth'],
      ].map(([name, relativePath]) => ({ name, path: path.join(packageRoot, relativePath) })),
      maxTargets: 5,
      verifyFull: true,
      keepWorkspaces: false,
      quiet: true,
    });

    assert.equal(report.status, 'pass');
    assert.equal(report.summary.incremental_success_rate, 1);
    assert.equal(report.summary.full_verify_graph_equivalence_rate, 1);
    assert.ok(report.targets.every(target => target.edit.kind === 'semantic-probe'));
    assert.ok(report.targets.every(target => target.full_verify_parity?.graph_equivalent));
  } finally {
    if (previousAiSetting === undefined) delete process.env.KLAURO_AI_ENABLED;
    else process.env.KLAURO_AI_ENABLED = previousAiSetting;
  }
});
