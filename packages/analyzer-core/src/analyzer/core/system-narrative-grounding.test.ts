import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { systemNarrativeGroundingFailure } from './system-narrative-grounding';

describe('systemNarrativeGroundingFailure', () => {
  it('rejects unsupported absence claims in otherwise concrete product prose', () => {
    assert.deepEqual(systemNarrativeGroundingFailure(
      'A reader deletes a comment without leaving a trace.',
      ['delete comment'],
    ), {
      reason: 'unsupported-system-absence-claim',
      offendingTerms: ['without leaving a trace'],
    });
  });

  it('rejects unsupported temporal and permanence guarantees', () => {
    assert.equal(systemNarrativeGroundingFailure(
      'A reader deletes a comment and the system removes it immediately.',
      ['delete comment'],
    )?.reason, 'unsupported-system-operational-claim');
    assert.equal(systemNarrativeGroundingFailure(
      'An author permanently removes an article.',
      ['delete article'],
    )?.reason, 'unsupported-system-operational-claim');
  });

  it('accepts an operational qualifier only when first-party evidence states it', () => {
    assert.equal(systemNarrativeGroundingFailure(
      'A reader deletes a comment and the system removes it immediately.',
      ['comments are removed immediately'],
    ), undefined);
  });

  it('does not reject ordinary grounded deletion language', () => {
    assert.equal(systemNarrativeGroundingFailure('A reader can delete a comment.', ['delete comment']), undefined);
  });
});
