import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { getTestDiscoveryEvidence } from './test-discovery';

test('test discovery ignores fixture tests but includes real source tests with environment filenames', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-test-discovery-'));
  try {
    await fs.outputFile(
      path.join(root, 'src', 'environment-checks.test.ts'),
      [
        "import { test } from 'node:test';",
        "test('checks environment', () => {});",
      ].join('\n')
    );
    await fs.outputFile(
      path.join(root, 'fixtures', 'sample', 'tests', 'ignored.test.ts'),
      "test('fixture smoke', () => {});\n"
    );

    const evidence = await getTestDiscoveryEvidence(root, {
      test_suites: [{
        id: 'suite-env',
        name: 'environment-checks.test',
        file_path: 'src/environment-checks.test.ts',
        test_type: 'unit',
        framework: 'node:test',
        tests: [],
      }],
    } as any);

    assert.equal(evidence.source_test_files, 1);
    assert.equal(evidence.status, 'cas-covered');
    assert.deepEqual(evidence.potential_uncovered_test_files, []);
    assert.equal(evidence.sample_source_test_files[0]?.path, 'src/environment-checks.test.ts');
  } finally {
    await fs.remove(root);
  }
});

test('test discovery matches CAS suites across relative and relocated path prefixes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-test-discovery-paths-'));
  try {
    await fs.outputFile(path.join(root, 'packages', 'api', 'orders.test.ts'), "test('orders', () => {});\n");
    await fs.outputFile(path.join(root, 'packages', 'web', 'checkout.test.ts'), "test('checkout', () => {});\n");

    const evidence = await getTestDiscoveryEvidence(root, {
      test_suites: [
        {
          id: 'orders',
          name: 'orders',
          file_path: '/remote/workspace/packages/api/orders.test.ts',
          test_type: 'unit',
          framework: 'node:test',
          tests: [],
        },
        {
          id: 'checkout',
          name: 'checkout',
          file_path: 'checkout.test.ts',
          test_type: 'unit',
          framework: 'node:test',
          tests: [],
        },
      ],
    } as any);

    assert.equal(evidence.source_test_files, 2);
    assert.equal(evidence.status, 'cas-covered');
    assert.deepEqual(evidence.potential_uncovered_test_files, []);
  } finally {
    await fs.remove(root);
  }
});

test('test discovery trusts source-backed CAS suites without rereading represented files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-test-discovery-cas-'));
  try {
    await fs.outputFile(path.join(root, 'src', 'represented.test.ts'), 'export const generated = true;\n');
    const evidence = await getTestDiscoveryEvidence(root, {
      test_suites: [{
        id: 'represented',
        name: 'represented',
        file_path: 'src/represented.test.ts',
        test_type: 'unit',
        framework: 'node:test',
        tests: [],
      }],
    } as any);

    assert.equal(evidence.source_test_files, 1);
    assert.equal(evidence.status, 'cas-covered');
  } finally {
    await fs.remove(root);
  }
});
