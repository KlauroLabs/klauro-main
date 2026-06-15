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
