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

  // ---- Camp C · full comprehension (C1–C11): head-to-head never loses; emission dims emit ----
  const h2h = report.campCFull.dimensions.filter(d => d.mode === 'head-to-head');
  const emi = report.campCFull.dimensions.filter(d => d.mode === 'emission-coverage');
  assert.ok(h2h.length >= 9, `campCFull must have >= 9 head-to-head dims, got ${h2h.length}`);
  assert.ok(emi.filter(d => d.emitted > 0).length >= 6,
    `campCFull must have >= 6 emission-coverage dims with facts, got ${emi.filter(d => d.emitted > 0).length}`);
  assert.equal(report.campCFull.aggregate.headToHead.allWin, true,
    'every Camp C head-to-head dimension must win or ceiling-tie — never a loss');
  for (const d of h2h) {
    assert.ok(d.meanKlauroF1 >= 0.9, `campCFull ${d.key}: mean Klauro F1 ${d.meanKlauroF1} must be >= 0.9`);
  }

  // ---- WAS (cross-repo, first-class): repos crossed + the defining cross-repo seam emits ----
  assert.ok(report.campWAS.aggregate.reposCrossed >= 2,
    `WAS must cross >= 2 repos, got ${report.campWAS.aggregate.reposCrossed}`);
  const wEmitting = report.campWAS.dimensions.filter(d => d.emitted > 0);
  assert.ok(wEmitting.length >= 6, `WAS must emit on >= 6 of W1–W8, got ${wEmitting.length}`);
  const seamOrFlow = report.campWAS.dimensions.find(d => (d.group === 'W2' || d.group === 'W3') && d.emitted > 0);
  assert.ok(seamOrFlow, 'WAS must emit the defining cross-repo fact (W2 integration seams or W3 data flow)');

  // ---- Camp B structural vs the real codebase-memory binary: 0 losses, token win ----
  if (report.campBStructural.available) {
    const bs = report.campBStructural.aggregate;
    assert.equal(bs.losses, 0, `Camp B structural must have 0 losses vs codebase-memory, got ${bs.losses}`);
    assert.ok(bs.languages >= 60, `Camp B structural must measure >= 60 languages, got ${bs.languages}`);
    assert.ok(bs.meanKlauroTokens < bs.meanCbmTokens,
      `Klauro mean tokens ${bs.meanKlauroTokens} must be < codebase-memory ${bs.meanCbmTokens}`);
  }

  // ---- Camp C routes vs the real codebase-memory binary: 0 losses, Klauro >= cbm ----
  if (report.campCRoutesVsCbm.available) {
    const cr = report.campCRoutesVsCbm.aggregate;
    assert.equal(cr.losses, 0, `Camp C routes must have 0 losses vs codebase-memory, got ${cr.losses}`);
    assert.ok(cr.meanKlauroF1 >= cr.meanCbmF1,
      `Klauro mean route F1 ${cr.meanKlauroF1} must be >= codebase-memory ${cr.meanCbmF1}`);
  }

  // ---- DEPTH-1 taint/data-flow (source→sink) vs the real codebase-memory binary ----
  if (report.depthTaint.available) {
    const dt = report.depthTaint.aggregate;
    assert.equal(dt.losses, 0, `DEPTH-1 taint must have 0 losses vs codebase-memory, got ${dt.losses}`);
    assert.ok(dt.meanKlauroF1 >= dt.meanCbmF1,
      `Klauro mean taint F1 ${dt.meanKlauroF1} must be >= codebase-memory ${dt.meanCbmF1}`);
  }

  // ---- DEPTH-4 interface→impl dispatch vs the real codebase-memory binary (LSP head-to-head) ----
  if (report.depthDispatch.available) {
    const dd = report.depthDispatch.aggregate;
    assert.equal(dd.losses, 0, `DEPTH-4 dispatch must have 0 losses vs codebase-memory LSP, got ${dd.losses}`);
    assert.ok(dd.meanKlauroF1 >= dd.meanCbmF1,
      `Klauro mean dispatch F1 ${dd.meanKlauroF1} must be >= codebase-memory ${dd.meanCbmF1}`);
  }

  // ---- DEPTH-2 cross-repo contract drift + DEPTH-3 behavioral diff vs codebase-memory ----
  if (report.depthContractDrift.available) {
    const cd = report.depthContractDrift.aggregate;
    assert.equal(cd.losses, 0, `DEPTH-2 contract drift must have 0 losses, got ${cd.losses}`);
    assert.ok(cd.meanKlauroF1 >= cd.meanCbmF1, `Klauro contract-drift F1 ${cd.meanKlauroF1} >= cbm ${cd.meanCbmF1}`);
  }
  if (report.depthBehavioralDiff.available) {
    const bd = report.depthBehavioralDiff.aggregate;
    assert.equal(bd.losses, 0, `DEPTH-3 behavioral diff must have 0 losses, got ${bd.losses}`);
    assert.ok(bd.meanKlauroF1 >= bd.meanCbmF1, `Klauro behavioral-diff F1 ${bd.meanKlauroF1} >= cbm ${bd.meanCbmF1}`);
  }

  // ---- Telemetry overlay ("how it's running") vs cbm — verdict is correlation F1, not tokens ----
  const to = report.telemetryOverlay;
  assert.equal(to.losses, 0, `Telemetry overlay must have 0 losses (correlation), got ${to.losses}: ${to.lossNames.join(', ')}`);
  if (to.cases > 0) {
    assert.ok(to.meanKlauroF1 >= to.meanCbmF1,
      `Klauro runtime→static correlation F1 ${to.meanKlauroF1} must be >= codebase-memory ${to.meanCbmF1}`);
  }
});

test('buildCampsReport: cached result is stable across calls', async () => {
  const a = await buildCampsReport('2026-06-28T00:00:00Z');
  const b = await buildCampsReport('2026-06-28T00:00:00Z');
  assert.equal(a.campC.rows.length, b.campC.rows.length);
  assert.equal(a.breadth.supportedLanguageCount, b.breadth.supportedLanguageCount);
});
