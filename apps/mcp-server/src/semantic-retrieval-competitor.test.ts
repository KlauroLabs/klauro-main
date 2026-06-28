import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import type { EmbeddingProvider } from '../../../packages/analyzer-core/src/analyzer/embedding/types';
import {
  cosineSim,
  rankNodesByText,
  rawCodeCompetitorRanking,
  descriptionText,
} from './semantic-retrieval-competitor';

// A deterministic bag-of-words embedder over a fixed vocabulary. Cosine of two
// texts rises with shared vocabulary — exactly the property real semantic
// embedders approximate, but with zero network and zero randomness. Both arms
// get THIS SAME provider, so any ranking difference is the embedded text alone.
const VOCAB = [
  'charge',
  'customer',
  'card',
  'payment',
  'refund',
  'invoice',
  'compute',
  'value',
  'helper',
  'process',
];

function makeBagOfWordsProvider(): EmbeddingProvider {
  return {
    id: 'local',
    model: 'fake-bow',
    dimensions: VOCAB.length,
    maxBatch: 64,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(text => {
        const lower = text.toLowerCase();
        const vec = new Float32Array(VOCAB.length);
        VOCAB.forEach((word, i) => {
          const matches = lower.split(word).length - 1;
          vec[i] = matches;
        });
        return vec;
      });
    },
  };
}

function node(id: string, opts: { raw: string; description: string }): CASNode {
  return {
    id,
    name: id,
    type: 'function',
    description: opts.description,
    source: { file: 'svc.ts', line: 1, end_line: 5, raw: opts.raw },
  } as CASNode;
}

// The crux fixture: the RIGHT answer's CODE is cryptic (no query words), but its
// DESCRIPTION names the intent. A decoy's CODE happens to share query words. This
// is the everyday case embeddings-over-raw-code lose: business intent lives in
// names/comments the code itself doesn't spell out.
function fixtureCas(): CASOutput {
  return {
    nodes: [
      // Target: charges a card, but the code is generic plumbing.
      node('fn_target', {
        raw: 'async function f(g, h) { const r = await g.submit(h); return r.ok; }',
        description: 'Charge a customer credit card and capture the payment',
      }),
      // Decoy: unrelated, but its code literally mentions "customer" and "card".
      node('fn_decoy', {
        raw: 'function renderCustomerCard(customer) { return `<div>card for ${customer}</div>`; }',
        description: 'Render a UI card showing customer profile details',
      }),
      // Filler.
      node('fn_filler', {
        raw: 'function computeValue(a, b) { return a + b; }',
        description: 'Compute a helper value',
      }),
    ],
  } as CASOutput;
}

test('cosineSim handles Float32Array and zero vectors without NaN', () => {
  assert.equal(cosineSim(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
  assert.equal(cosineSim(new Float32Array([0, 0]), new Float32Array([1, 1])), 0);
  assert.ok(Math.abs(cosineSim([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9);
});

test('Camp A raw-code embeddings get pulled to the lexical decoy, not the real answer', async () => {
  const cas = fixtureCas();
  const provider = makeBagOfWordsProvider();
  const ranked = await rawCodeCompetitorRanking(cas, '/tmp/none', 'charge a customer card', provider, {
    topK: 3,
  });
  // The decoy's RAW CODE shares "customer"/"card" with the query, so Camp A ranks
  // it above the function that actually charges the card. This is the failure mode.
  assert.equal(ranked[0], 'fn_decoy');
  assert.notEqual(ranked[0], 'fn_target');
});

test('Klauro descriptions surface the real answer with the SAME model — comprehension, not embedder', async () => {
  const cas = fixtureCas();
  const provider = makeBagOfWordsProvider();
  const ranked = await rankNodesByText(
    cas,
    '/tmp/none',
    'charge a customer card',
    provider,
    descriptionText,
    { topK: 3 },
  );
  // Identical provider, identical scoring — only the embedded text changed (the
  // enriched description instead of raw code). The right node now ranks #1.
  assert.equal(ranked[0], 'fn_target');
});

test('the win is attributable to the description: identical model, ranking flips with the text', async () => {
  const cas = fixtureCas();
  const provider = makeBagOfWordsProvider();
  const query = 'charge a customer card';
  const campA = await rawCodeCompetitorRanking(cas, '/tmp/none', query, provider, { topK: 3 });
  const klauro = await rankNodesByText(cas, '/tmp/none', query, provider, descriptionText, {
    topK: 3,
  });
  const campARank = campA.indexOf('fn_target');
  const klauroRank = klauro.indexOf('fn_target');
  // Klauro ranks the true answer strictly higher (smaller index) than Camp A,
  // with the embedder held fixed. That delta is the comprehension layer.
  assert.ok(
    klauroRank >= 0 && (campARank < 0 || klauroRank < campARank),
    `klauro rank ${klauroRank} should beat campA rank ${campARank}`,
  );
});
