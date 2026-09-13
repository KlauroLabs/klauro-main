import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { projectRelativeFile, pathsReferToSameFile, resetProjectRelativePathCache } from './project-relative-path';

// Test suite matching compares file paths that arrive from different places:
// absolute paths from the filesystem walk, project-relative paths from
// analyzers, and Windows-style paths from stored evidence. pathsReferToSameFile
// is the comparison, and it is called once per (test file, existing suite)
// pair, so the normalisation behind it is memoised. These tests pin the
// comparison; memoisation must not change any answer.

const project = path.resolve('/tmp/example-project');

test('absolute paths inside the project become project-relative', () => {
  resetProjectRelativePathCache();
  assert.equal(projectRelativeFile(project, path.join(project, 'src/a.ts')), 'src/a.ts');
});

test('absolute paths outside the project keep their own shape', () => {
  resetProjectRelativePathCache();
  const outside = path.resolve('/tmp/somewhere-else/b.ts');
  assert.equal(projectRelativeFile(project, outside), outside.replace(/\\/g, '/'));
});

test('backslashes and a leading dot-slash normalise away', () => {
  resetProjectRelativePathCache();
  assert.equal(projectRelativeFile(project, 'src\\nested\\c.ts'), 'src/nested/c.ts');
  assert.equal(projectRelativeFile(project, './src/d.ts'), 'src/d.ts');
});

test('the same file expressed three ways compares equal', () => {
  resetProjectRelativePathCache();
  const absolute = path.join(project, 'src/a.ts');
  assert.ok(pathsReferToSameFile(project, absolute, 'src/a.ts'));
  assert.ok(pathsReferToSameFile(project, './src/a.ts', 'src\\a.ts'));
  assert.ok(pathsReferToSameFile(project, absolute, './src/a.ts'));
});

test('a suffix relation counts as the same file, which is the documented behaviour', () => {
  // A suite recorded as "a.ts" matches a node recorded as "src/a.ts". This is
  // deliberately loose and is relied on by test-suite deduplication.
  resetProjectRelativePathCache();
  assert.ok(pathsReferToSameFile(project, 'src/a.ts', 'a.ts'));
  assert.ok(pathsReferToSameFile(project, 'a.ts', 'src/a.ts'));
});

test('different files do not compare equal, and a partial name is not a suffix', () => {
  resetProjectRelativePathCache();
  assert.ok(!pathsReferToSameFile(project, 'src/a.ts', 'src/b.ts'));
  assert.ok(!pathsReferToSameFile(project, 'src/formatter.ts', 'matter.ts'));
  assert.ok(!pathsReferToSameFile(project, 'src/a.ts', ''));
  assert.ok(!pathsReferToSameFile(project, undefined, 'src/a.ts'));
});

test('memoisation returns the same answer as a cold cache', () => {
  const inputs = [
    path.join(project, 'src/a.ts'),
    'src/a.ts',
    './src/a.ts',
    'src\\a.ts',
    path.resolve('/tmp/elsewhere/a.ts')
  ];
  resetProjectRelativePathCache();
  const cold = inputs.map(value => projectRelativeFile(project, value));
  const warm = inputs.map(value => projectRelativeFile(project, value));
  assert.deepEqual(warm, cold);
  resetProjectRelativePathCache();
  assert.deepEqual(inputs.map(value => projectRelativeFile(project, value)), cold);
});

test('the same file name under two different projects does not collide in the cache', () => {
  resetProjectRelativePathCache();
  const other = path.resolve('/tmp/other-project');
  const file = path.join(project, 'src/a.ts');
  assert.equal(projectRelativeFile(project, file), 'src/a.ts');
  assert.equal(projectRelativeFile(other, file), file.replace(/\\/g, '/'));
});
