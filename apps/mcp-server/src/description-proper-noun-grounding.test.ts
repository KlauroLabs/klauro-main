import test from 'node:test';
import assert from 'node:assert/strict';
import { unexplainedShortTitleCaseTerms } from './description-proper-noun-grounding';

test('short title-case grounding ignores sentence language while retaining product claims', () => {
  const grounded = new Set(['dawn']);
  const terms = unexplainedShortTitleCaseTerms(
    'Dawn supports storefront browsing. When a user adds a product, Zorp schedules fulfillment.',
    term => grounded.has(term.toLowerCase()),
  );

  assert.deepEqual(terms, ['Zorp']);
});
