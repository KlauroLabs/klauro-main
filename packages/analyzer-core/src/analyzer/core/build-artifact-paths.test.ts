import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { THIRD_PARTY_SOURCE_GLOBS, isBuildArtifactDirectoryName } from './build-artifact-paths';

test('recognizes conventional distribution output directories', () => {
  for (const name of ['dist', 'dist-hosted', 'dist_esm', 'dist.browser', 'DIST-CJS']) {
    assert.equal(isBuildArtifactDirectoryName(name), true, name);
  }
});

test('does not classify source directories that merely contain dist', () => {
  for (const name of ['distribution', 'distributed', 'my-dist', 'distance']) {
    assert.equal(isBuildArtifactDirectoryName(name), false, name);
  }
});

test('excludes common first-level and nested third-party source directories', () => {
  const patterns = new Set<string>(THIRD_PARTY_SOURCE_GLOBS);
  for (const directory of ['vendor', 'vendors', 'vendored', 'third_party', 'third-party']) {
    assert.equal(patterns.has(`${directory}/**`), true, directory);
    assert.equal(patterns.has(`**/${directory}/**`), true, directory);
  }
});
