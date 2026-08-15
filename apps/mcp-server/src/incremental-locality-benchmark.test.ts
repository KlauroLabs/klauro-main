import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { runIncrementalLocalityBenchmark } from './incremental-locality-benchmark';

test('proves exact locality across symbol, file, package, deployable, and cross-repository edits', { timeout: 30_000 }, async () => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-locality-report-'));
  try {
    const report = await runIncrementalLocalityBenchmark({
      outputPath: path.join(outputRoot, 'report.json'),
      markdownPath: path.join(outputRoot, 'report.md')
    });

    assert.equal(report.status, 'pass');
    assert.equal(report.score, 100);
    assert.equal(report.summary.scope_count, 5);
    assert.equal(report.summary.graph_equivalence_rate, 1);
    assert.ok(report.scopes.every(scope => scope.status === 'pass'));
    assert.ok(report.scopes.every(scope => scope.reuse_ratio > 0));
    assert.deepEqual(report.scopes.map(scope => scope.scope), [
      'single-symbol', 'file', 'package', 'deployable', 'cross-repository'
    ]);
  } finally {
    await fs.remove(outputRoot);
  }
});
