import test from 'node:test';
import assert from 'node:assert/strict';
import { isIdentifierShapedRepoBasename, isHashOrIdShapedToken } from './util';

// The hash-token-leak class (2026-07 cold-customer audit): production analyze
// calls snapshot sources into dirs named after the project/analysis id, and
// the repository-fallback capability label humanized that basename into
// "Prj J GNMsl Nmy8 Lauen Operations". Identifier-shaped basenames must never
// enter labels.

test('isIdentifierShapedRepoBasename: hosted id prefixes are identifiers', () => {
  // The exact audit fixture.
  assert.equal(isIdentifierShapedRepoBasename('prj_jGNMsl_nmy8Lauen'), true);
  assert.equal(isIdentifierShapedRepoBasename('wsp_ElNLGVFb1yVIaxq_'), true);
  assert.equal(isIdentifierShapedRepoBasename('acct_9f3k29xz1q'), true);
});

test('isIdentifierShapedRepoBasename: hash/uuid-shaped basenames are identifiers', () => {
  assert.equal(isIdentifierShapedRepoBasename('3f8a9c2d-1b4e-4a6f-9c8d-2e5b7a1f0c3d'), true);
  assert.equal(isIdentifierShapedRepoBasename('a94a8fe5ccb19ba61c4c'), true);
  // Hash segment inside a composite name (snapshot-dir style).
  assert.equal(isIdentifierShapedRepoBasename('snapshot-a94a8fe5ccb19ba61c4c'), true);
});

test('isIdentifierShapedRepoBasename: real repo names are NOT identifiers', () => {
  for (const name of ['proof-of-concept', 'truckspy', 'soon-lens', 'my_app', 'personal-ai-assistant', 'zerac-api', 'kadra.ai']) {
    assert.equal(isIdentifierShapedRepoBasename(name), false, `${name} must be kept as a label source`);
  }
  assert.equal(isIdentifierShapedRepoBasename(''), false);
});

test('isHashOrIdShapedToken still rejects the classic shapes (regression pin)', () => {
  assert.equal(isHashOrIdShapedToken('8f3k29xz1q'), true);
  assert.equal(isHashOrIdShapedToken('deadbeefdead'), true);
  assert.equal(isHashOrIdShapedToken('operations'), false);
});
