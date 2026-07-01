import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCampsReport, resetCampsReportCache } from './camps-bench';

// The Camps report is measured live from the real engine. These assertions hold
// regardless of which competitor tools are installed: skip-guarded arms are
// reported available:false, never faked; and for every Camp-B arm that actually
// ran, Klauro must tie-at-ceiling or win — NEVER lose.

test('buildCampsReport: campC has real route wins, breadth is populated, campB never loses', async () => {
  resetCampsReportCache();
  const report = await buildCampsReport('2026-06-28T00:00:00Z');

  // ---- Camp C: out-of-category route wins ----
  assert.ok(report.campC.rows.length > 0, 'campC must have at least one framework route win');
  for (const r of report.campC.rows) {
    assert.equal(r.klauroF1, 1, `${r.framework}: Klauro must emit the exact route set (F1 1.0)`);
    assert.ok(r.routes > 0, `${r.framework}: must surface at least one route`);
    assert.equal(r.outOfCategoryWin, true, `${r.framework}: must be an out-of-category win`);
  }
  // ---- Breadth: supported-language count ----
  assert.ok(report.breadth.supportedLanguageCount >= 150,
    `breadth must be >= 150, got ${report.breadth.supportedLanguageCount}`);
  assert.equal(report.breadth.languages.length, report.breadth.supportedLanguageCount);

  // ---- Camp B: every arm that RAN must be a ceiling tie or a win, never a loss ----
  assert.ok(report.campB.rows.length > 0, 'campB must enumerate the structural tools');
  for (const r of report.campB.rows) {
    if (!r.available) continue; // skip-guard absent tools
    assert.ok(
      r.klauroF1 >= r.competitorF1,
      `Camp B ${r.tool}: Klauro F1 ${r.klauroF1} must be >= competitor ${r.competitorF1} (tie or win, never loss)`,
    );
  }

  // ---- Camp A: when available, Klauro out-qualities every embedding model ----
  if (report.campA.available) {
    for (const a of report.campA.arms) {
      assert.ok(a.klauroOutQualities, `Camp A ${a.arm}: Klauro must out-quality the embedding model`);
    }
  }

  // ---- Camp A · top languages: ≥40 covered; Klauro never loses to embeddings ----
  assert.ok(report.campALangs.aggregate.languages >= 40,
    `campALangs must cover >= 40 top languages, got ${report.campALangs.aggregate.languages}`);
  for (const p of report.campALangs.perLanguage) {
    if (!p.available) continue; // ollama-absent rows are Klauro-only, honest
    assert.ok(p.klauroF1 >= p.embeddingF1,
      `Camp A ${p.lang}: Klauro F1 ${p.klauroF1} must be >= embedding ${p.embeddingF1} (never a loss)`);
  }

  // Depth, WAS, full-grid, and telemetry overlays have dedicated tests. This
  // aggregate intentionally stays scoped to Camps A/B/C plus breadth so it is not
  // a second full-gauntlet recomputation.
});

test('buildCampsReport: cached result is stable across calls', async () => {
  const a = await buildCampsReport('2026-06-28T00:00:00Z');
  const b = await buildCampsReport('2026-06-28T00:00:00Z');
  assert.equal(a.campC.rows.length, b.campC.rows.length);
  assert.equal(a.breadth.supportedLanguageCount, b.breadth.supportedLanguageCount);
});
