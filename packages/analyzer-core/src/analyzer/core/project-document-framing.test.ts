import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripProjectDocumentMedia } from './project-document-framing';

describe('stripProjectDocumentMedia', () => {
  it('removes linked and bare Markdown images without retaining their labels', () => {
    const document = [
      '# Example',
      '',
      '[![CI](https://example.test/ci.svg)](https://example.test/build) [![Coverage](https://example.test/coverage.svg)](https://example.test/report)',
      '![Screenshot](https://example.test/screenshot.png)',
      '',
      'People publish articles and discuss them with other readers.',
    ].join('\n');

    const sanitized = stripProjectDocumentMedia(document);

    assert.doesNotMatch(sanitized, /CI|Coverage|Screenshot|ci\.svg|coverage\.svg/);
    assert.match(sanitized, /# Example/);
    assert.match(sanitized, /People publish articles and discuss them with other readers\./);
  });

  it('removes reference-style and HTML images while preserving surrounding product prose', () => {
    const document = [
      '<a href="https://example.test/build"><img alt="Build" src="build.svg"></a>',
      '[![Quality][quality-image]][quality-link]',
      'Authors can publish drafts ![illustration](draft.png) for their readers.',
    ].join('\n');

    assert.equal(stripProjectDocumentMedia(document), [
      '',
      '',
      'Authors can publish drafts  for their readers.',
    ].join('\n'));
  });
});
