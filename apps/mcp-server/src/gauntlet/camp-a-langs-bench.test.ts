import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCampALangsReport, _resetCampALangsCache } from './camp-a-langs-bench';
import { TOP_LANGS } from './camp-a-langs';

// The per-language Camp A (embeddings-RAG) vs Klauro head-to-head. Klauro answers
// "which function calls `helper`?" structurally via extractStructure (real AST
// walk over the 167-grammar breadth engine); the embedding arm (Ollama, when
// present) answers by cosine similarity and is pulled off the answer by the
// same-name decoy. Klauro must never lose.

test('camp-a-langs: covers >=40 top languages, Klauro structural F1 is high, and never loses to embeddings', async () => {
  _resetCampALangsCache();
  const report = await buildCampALangsReport();

  // --- Coverage: aim 50, floor 40. Report the real count. ---
  const n = report.aggregate.languages;
  assert.equal(n, TOP_LANGS.length, 'report must cover every corpus language');
  assert.ok(n >= 40, `expected >=40 languages covered, got ${n}`);

  // --- Klauro structural resolution must be REAL and correct per language. ---
  // Every corpus language has a spec + grammar, so extractStructure must resolve
  // the exact caller (F1 = 1). A language that does not resolve is a corpus/engine
  // bug to FIX, never a faked truth — surface it here.
  const klauroMisses = report.perLanguage.filter(r => r.klauroF1 < 1);
  assert.equal(
    klauroMisses.length, 0,
    `Klauro must resolve the caller structurally for every language; misses: ${JSON.stringify(klauroMisses.map(r => `${r.lang}=${r.klauroF1}`))}`,
  );
  assert.ok(report.aggregate.meanKlauroF1 >= 0.9, `mean Klauro F1 must be >=0.9, got ${report.aggregate.meanKlauroF1}`);

  // --- The win: for every language where the embedding arm ran, klauroF1 >= embeddingF1. ---
  const ran = report.perLanguage.filter(r => r.embeddingModel !== '');
  for (const r of ran) {
    assert.ok(
      r.klauroF1 >= r.embeddingF1,
      `Klauro lost to ${r.embeddingModel} on ${r.lang}: klauroF1=${r.klauroF1} < embeddingF1=${r.embeddingF1}`,
    );
    assert.ok(r.klauroWins, `klauroWins must be true for ${r.lang}`);
  }

  if (report.available) {
    // Ollama present: the head-to-head ran for real. Win-rate must be a clean sweep.
    assert.equal(report.aggregate.klauroWinRate, 1, `Klauro must win every language it was compared on; got win-rate ${report.aggregate.klauroWinRate}`);
    assert.ok(ran.length > 0, 'embedding arm reported available but no language ran');
  } else {
    // Ollama absent: honest skip — assert Klauro-only coverage instead.
    assert.equal(ran.length, 0, 'no embedding model should run when ollama is absent');
    assert.equal(report.aggregate.comparedLanguages, 0);
    assert.equal(report.aggregate.klauroWinRate, null);
    assert.equal(report.aggregate.meanEmbeddingF1, null);
    assert.ok(report.perLanguage.every(r => !r.available && !r.klauroWins));
    const klauroCovered = report.perLanguage.filter(r => r.klauroF1 >= 1).length;
    assert.ok(klauroCovered >= 40, `Klauro-only coverage must be >=40, got ${klauroCovered}`);
  }

  // --- Printed summary line (the deliverable evidence). ---
  const a = report.aggregate;
  // eslint-disable-next-line no-console
  console.log(
    `\nCAMP-A-LANGS SUMMARY: ${a.languages} languages, ` +
    `compared ${a.comparedLanguages}, ` +
    `Klauro win-rate ${a.klauroWinRate === null ? 'N/A' : `${(a.klauroWinRate * 100).toFixed(0)}%`}, ` +
    `meanKlauroF1 ${a.meanKlauroF1.toFixed(3)}, ` +
    `meanEmbeddingF1 ${a.meanEmbeddingF1 === null ? 'N/A' : a.meanEmbeddingF1.toFixed(3)} ` +
    `(embeddings ${report.available ? 'ran' : 'unavailable — Klauro-only'})`,
  );
});
