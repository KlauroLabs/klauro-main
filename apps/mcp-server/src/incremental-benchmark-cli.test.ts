import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { parseIncrementalBenchmarkCli } from './incremental-benchmark-cli';

test('parses hosted incremental benchmark routing and repository targets', () => {
  const parsed = parseIncrementalBenchmarkCli([
    '--repo', 'service=./fixtures/service',
    '--analysis-path', 'klauro-product',
    '--analyzer-server', 'https://analysis.example.test',
    '--max-targets', '3',
    '--concurrency', '2',
  ]);

  assert.deepEqual(parsed.repos, [{ name: 'service', path: path.resolve('./fixtures/service') }]);
  assert.equal(parsed.analysisPath, 'klauro-product');
  assert.equal(parsed.analyzerServerUrl, 'https://analysis.example.test');
  assert.equal(parsed.maxTargets, 3);
  assert.equal(parsed.concurrency, 2);
});

test('rejects missing, invalid, and unknown incremental benchmark options', () => {
  assert.throws(() => parseIncrementalBenchmarkCli(['--repo']), /--repo requires a value/);
  assert.throws(() => parseIncrementalBenchmarkCli(['--analysis-path', 'other']), /Invalid incremental benchmark analysis path/);
  assert.throws(() => parseIncrementalBenchmarkCli(['--max-targets', '0']), /--max-targets must be a positive integer/);
  assert.throws(() => parseIncrementalBenchmarkCli(['--unknown']), /Unknown incremental benchmark option/);
});
