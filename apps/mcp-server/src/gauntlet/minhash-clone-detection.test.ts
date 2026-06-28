import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findNearClones,
  minhashSignature,
  shingles,
  estimatedJaccard,
} from '../../../../packages/analyzer-core/src/analyzer/core/minhash-clone-detection';

// Structural parity with codebase-memory's SIMILAR_TO (MinHash + Jaccard). Two
// near-identical functions (copy-paste with a renamed local) must be flagged; an
// unrelated function must not.

const ORIGINAL = `function persist(account, db) {
  const row = account.toRow();
  db.insert(row);
  return row.id;
}`;

const NEAR_CLONE = `function archive(account, db) {
  const record = account.toRow();
  db.insert(record);
  return record.id;
}`;

const UNRELATED = `function computeColor(value) {
  const hue = (value * 137) % 360;
  return 'hsl(' + hue + ',60%,50%)';
}`;

test('MinHash flags a near-clone and excludes an unrelated function', () => {
  const pairs = findNearClones(
    [
      { id: 'persist', text: ORIGINAL },
      { id: 'archive', text: NEAR_CLONE },
      { id: 'computeColor', text: UNRELATED },
    ],
    { threshold: 0.6 },
  );
  assert.equal(pairs.length, 1, `expected exactly one clone pair, got ${JSON.stringify(pairs)}`);
  assert.deepEqual([pairs[0].a, pairs[0].b].sort(), ['archive', 'persist']);
  assert.ok(pairs[0].similarity >= 0.6, `similarity ${pairs[0].similarity} should clear threshold`);
});

test('identical text has estimated Jaccard 1.0; disjoint has low', () => {
  const a = minhashSignature(shingles(ORIGINAL));
  const b = minhashSignature(shingles(ORIGINAL));
  assert.equal(estimatedJaccard(a, b), 1, 'identical code → Jaccard 1.0');
  const c = minhashSignature(shingles(UNRELATED));
  assert.ok(estimatedJaccard(a, c) < 0.3, 'disjoint code → low Jaccard');
});

test('MinHash clone detection is deterministic', () => {
  const items = [
    { id: 'persist', text: ORIGINAL },
    { id: 'archive', text: NEAR_CLONE },
  ];
  assert.equal(JSON.stringify(findNearClones(items)), JSON.stringify(findNearClones(items)));
});
