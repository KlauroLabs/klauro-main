import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { ragSearch } from './embeddings-rag';

const FIXTURE = path.resolve(__dirname, '../../fixtures/primitive-bench/callers-ts');

/**
 * The embeddings-RAG arm is the real Cursor/Augment recipe over a LOCAL ollama.
 * We do not mock ollama: when it (and nomic-embed-text) is present the arm must
 * return ranked, scored chunks from the fixture; when absent it must report
 * `available:false` honestly. A skip-guard keeps CI green without ollama — but
 * the assertion is REAL whenever ollama is up, so no win is ever fabricated.
 */
test('ragSearch returns ranked chunks from a real repo (skips without ollama)', async (t) => {
  const r = await ragSearch(FIXTURE, 'functions that call Account.save', 5);

  if (!r.available) {
    t.skip(`ollama/nomic-embed-text not available: ${r.note ?? 'unavailable'}`);
    return;
  }

  // Real ollama present: assert the contract of the retrieval result.
  assert.ok(r.chunks.length > 0, 'should retrieve at least one chunk');
  assert.ok(r.chunks.length <= 5, 'must respect k=5');
  assert.ok(r.ms >= 0, 'should report elapsed ms');

  // Chunks must be well-formed: real file, real text, numeric score.
  for (const c of r.chunks) {
    assert.equal(typeof c.file, 'string');
    assert.ok(c.file.length > 0, 'chunk has a source file');
    assert.ok(c.file.endsWith('.ts'), 'fixture sources are TypeScript');
    assert.equal(typeof c.text, 'string');
    assert.ok(c.text.length > 0, 'chunk has text');
    assert.equal(typeof c.score, 'number');
    assert.ok(Number.isFinite(c.score), 'cosine score is finite');
  }

  // Ranked: descending by cosine similarity.
  for (let i = 1; i < r.chunks.length; i++) {
    assert.ok(
      r.chunks[i - 1].score >= r.chunks[i].score - 1e-9,
      'chunks are ranked by descending score',
    );
  }
});

test('ragSearch respects k', async (t) => {
  const r = await ragSearch(FIXTURE, 'save an account', 2);
  if (!r.available) {
    t.skip('ollama not available');
    return;
  }
  assert.ok(r.chunks.length <= 2, 'returns at most k chunks');
});
