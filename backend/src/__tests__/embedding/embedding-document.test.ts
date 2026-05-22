import { composeEmbeddingDocument } from '../../analyzer/embedding/embedding-document';
import type { CASNode } from '../../types/cas.types';

function makeNode(overrides: Partial<CASNode> = {}): CASNode {
  return {
    id: 'node-1',
    name: 'computeTotal',
    type: 'function',
    qualified_name: 'cart.computeTotal',
    tags: ['pricing'],
    signature: {
      parameters: [{ name: 'items', type: 'Item[]' }],
      return_type: 'number',
    },
    documentation: { raw: 'Computes the cart total.' } as CASNode['documentation'],
    source: { raw: 'function computeTotal(items) { return 0; }' },
    implementation: { body_hash: 'hash-aaa' },
    ...overrides,
  } as CASNode;
}

describe('composeEmbeddingDocument', () => {
  const options = { maxDocumentChars: 4000 };

  it('produces an identical docHash for the same node (determinism)', () => {
    const a = composeEmbeddingDocument(makeNode(), undefined, options);
    const b = composeEmbeddingDocument(makeNode(), undefined, options);
    expect(a.docHash).toBe(b.docHash);
    expect(a.text).toBe(b.text);
    expect(a.docHash).toHaveLength(16);
  });

  it('changes docHash when implementation.body_hash changes', () => {
    const base = composeEmbeddingDocument(makeNode(), undefined, options);
    const changed = composeEmbeddingDocument(
      makeNode({ implementation: { body_hash: 'hash-bbb' } }),
      undefined,
      options,
    );
    expect(changed.text).toBe(base.text);
    expect(changed.docHash).not.toBe(base.docHash);
  });

  it('treats missing and present body_hash as different documents', () => {
    const withHash = composeEmbeddingDocument(makeNode(), undefined, options);
    const withoutHash = composeEmbeddingDocument(
      makeNode({ implementation: undefined }),
      undefined,
      options,
    );
    expect(withoutHash.docHash).not.toBe(withHash.docHash);
  });

  it('truncates the document text to maxDocumentChars', () => {
    const longSource = 'x'.repeat(10000);
    const node = makeNode({ source: { raw: longSource } });
    const doc = composeEmbeddingDocument(node, undefined, { maxDocumentChars: 200 });
    expect(doc.text.length).toBe(200);
  });

  it('does not truncate documents already within the limit', () => {
    const doc = composeEmbeddingDocument(makeNode(), undefined, { maxDocumentChars: 4000 });
    expect(doc.text.length).toBeLessThanOrEqual(4000);
    expect(doc.text).toContain('computeTotal');
  });
});
