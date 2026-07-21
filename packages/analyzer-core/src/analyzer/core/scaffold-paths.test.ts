import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  SCAFFOLD_DIR_NAMES,
  SCAFFOLD_GLOBS,
  isScaffoldDirName,
  pathHasScaffoldSegment,
  isTestFileName,
  isScaffoldOrTestPath,
} from './scaffold-paths';

test('SCAFFOLD_DIR_NAMES covers every known self-analysis scaffold convention', () => {
  for (const name of ['fixtures', '__fixtures__', 'testdata', 'cas-tests', '__tests__']) {
    assert.ok(SCAFFOLD_DIR_NAMES.includes(name), `expected ${name} in SCAFFOLD_DIR_NAMES`);
  }
});

test('SCAFFOLD_GLOBS emits both root-relative and **-anchored forms for every name', () => {
  for (const name of SCAFFOLD_DIR_NAMES) {
    assert.ok(SCAFFOLD_GLOBS.includes(`${name}/**`), `missing root-relative glob for ${name}`);
    assert.ok(SCAFFOLD_GLOBS.includes(`**/${name}/**`), `missing **-anchored glob for ${name}`);
  }
});

test('isScaffoldDirName true only for scaffold conventions, not real source dirs', () => {
  assert.equal(isScaffoldDirName('fixtures'), true);
  assert.equal(isScaffoldDirName('__tests__'), true);
  assert.equal(isScaffoldDirName('src'), false);
  assert.equal(isScaffoldDirName('samples'), false); // deliberately NOT a scaffold name (JVM package-dir safety)
});

test('pathHasScaffoldSegment detects a fixture/test directory anywhere in the path', () => {
  assert.equal(pathHasScaffoldSegment('apps/mcp-server/fixtures/deployable-detection/helm-service/Chart.yaml'), true);
  assert.equal(pathHasScaffoldSegment('apps/mcp-server/fixtures/component-bench/compose-tree/App.kt'), true);
  assert.equal(pathHasScaffoldSegment('src/__tests__/helpers/setup.ts'), true);
  assert.equal(pathHasScaffoldSegment('packages/analyzer-core/src/analyzer/core/orchestrator.ts'), false);
  // Windows-style separators must normalize the same way.
  assert.equal(pathHasScaffoldSegment('apps\\mcp-server\\fixtures\\thing.yaml'), true);
});

test('isTestFileName catches co-located test-naming conventions across ecosystems', () => {
  assert.equal(isTestFileName('foo.test.ts'), true);
  assert.equal(isTestFileName('foo.spec.tsx'), true);
  assert.equal(isTestFileName('test_foo.py'), true);
  assert.equal(isTestFileName('foo_test.go'), true);
  assert.equal(isTestFileName('foo_test.rb'), true);
  assert.equal(isTestFileName('foo.ts'), false);
  assert.equal(isTestFileName('index.ts'), false);
});

test('isScaffoldOrTestPath is the union of directory-based and filename-based exclusion', () => {
  assert.equal(isScaffoldOrTestPath('apps/mcp-server/fixtures/anything.ts'), true);
  assert.equal(isScaffoldOrTestPath('packages/analyzer-core/src/foo.test.ts'), true);
  assert.equal(isScaffoldOrTestPath('packages/analyzer-core/src/foo.ts'), false);
});
