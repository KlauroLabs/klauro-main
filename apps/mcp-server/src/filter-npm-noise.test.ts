import test from 'node:test';
import assert from 'node:assert/strict';
import { filterNpmNoise } from './cli';

test('filterNpmNoise strips routine npm deprecation/funding noise', () => {
  const raw = [
    'npm warn deprecated inflight@1.0.6: This module is not supported',
    'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
    'npm notice',
    'npm notice New minor version of npm available! 10.1.0 -> 10.5.0',
    '3 packages are looking for funding',
    '  run `npm fund` for details',
    'added 42 packages in 3s',
    '',
  ].join('\n');

  const filtered = filterNpmNoise(raw);
  assert.doesNotMatch(filtered, /npm warn deprecated/);
  assert.doesNotMatch(filtered, /npm notice/);
  assert.doesNotMatch(filtered, /looking for funding/);
  assert.doesNotMatch(filtered, /npm fund/);
});

test('filterNpmNoise never hides real errors', () => {
  const raw = [
    'npm warn deprecated some-pkg@1.0.0: deprecated',
    'npm ERR! code ENOTFOUND',
    'npm ERR! network request to https://example.test failed',
  ].join('\n');

  const filtered = filterNpmNoise(raw);
  assert.match(filtered, /npm ERR! code ENOTFOUND/);
  assert.match(filtered, /npm ERR! network request/);
});

test('filterNpmNoise on an all-noise input returns an empty/trimmed string', () => {
  const raw = [
    'npm warn deprecated a@1: x',
    'npm notice new version',
    '1 package is looking for funding',
  ].join('\n');
  assert.equal(filterNpmNoise(raw), '');
});
