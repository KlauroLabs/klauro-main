import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCampLanguageParsersAvailable, buildCampALangsReport, _resetCampALangsCache } from './camp-a-langs-bench';
import { TOP_LANGS } from './camp-a-langs';

test('camp-a-langs rejects a missing promised parser before scoring', () => {
  assert.throws(
    () => assertCampLanguageParsersAvailable(['typescript', 'fortran'], language => language !== 'fortran'),
    /Required structural parsers unavailable: fortran; refusing to score missing parser artifacts as semantic misses/
  );
});

// The per-language Camp A (embeddings-RAG) vs Klauro head-to-head. Klauro answers
// "which function calls `helper`?" structurally via extractStructure (real AST
// walk over the 167-grammar breadth engine); the embedding arm (Ollama, when
// present) answers by cosine similarity and is pulled off the answer by the
// same-name decoy. Klauro must never lose.

test('camp-a-langs reports structural coverage and only claims comparisons when embeddings run', async () => {
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

  const ran = report.perLanguage.filter(r => r.available);
  for (const r of ran) {
    assert.ok(
      r.klauroF1 + 1e-9 >= r.embeddingF1,
      `Klauro lost to ${r.embeddingModel} on ${r.lang}: klauroF1=${r.klauroF1} < embeddingF1=${r.embeddingF1}`,
    );
    assert.notEqual(r.verdict, 'loss', `${r.lang} must not be a loss`);
  }

  if (report.available) {
    assert.equal(report.aggregate.losses, 0);
    assert.equal(report.aggregate.nonLossRate, 1);
    assert.ok(report.aggregate.strictWinRate !== null && report.aggregate.strictWinRate >= 0 && report.aggregate.strictWinRate <= 1);
    assert.ok(ran.length > 0, 'embedding arm reported available but no language ran');
  } else {
    assert.equal(ran.length, 0, 'no embedding model should run when ollama is absent');
    assert.equal(report.aggregate.comparedLanguages, 0);
    assert.equal(report.aggregate.wins, 0);
    assert.equal(report.aggregate.ceilingTies, 0);
    assert.equal(report.aggregate.losses, 0);
    assert.equal(report.aggregate.strictWinRate, null);
    assert.equal(report.aggregate.nonLossRate, null);
    assert.equal(report.aggregate.meanEmbeddingF1, null);
    assert.ok(report.perLanguage.every(r => !r.available && r.verdict === 'unmeasured'));
    const klauroCovered = report.perLanguage.filter(r => r.klauroF1 >= 1).length;
    assert.ok(klauroCovered >= 40, `Klauro-only coverage must be >=40, got ${klauroCovered}`);
  }

  const a = report.aggregate;
  console.log(
    `\nCAMP-A-LANGS SUMMARY: ${a.languages} languages, ` +
    `compared ${a.comparedLanguages}, ` +
    `strict win rate ${a.strictWinRate === null ? 'N/A' : `${(a.strictWinRate * 100).toFixed(0)}%`}, ` +
    `non-loss rate ${a.nonLossRate === null ? 'N/A' : `${(a.nonLossRate * 100).toFixed(0)}%`}, ` +
    `meanKlauroF1 ${a.meanKlauroF1.toFixed(3)}, ` +
    `meanEmbeddingF1 ${a.meanEmbeddingF1 === null ? 'N/A' : a.meanEmbeddingF1.toFixed(3)} ` +
    `(embeddings ${report.available ? 'ran' : 'unavailable — Klauro-only'})`,
  );
});
