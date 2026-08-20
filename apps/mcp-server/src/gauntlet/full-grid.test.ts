import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFullGrid, resetFullGridCache } from './full-grid';

test('full grid reports only measured comparisons and has zero covered losses', async () => {
  resetFullGridCache();
  const grid = await buildFullGrid();
  const a = grid.aggregate;

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log('\n================ FULL GRID (honest matrix) ================');
  console.log(
    `cells: ${a.total}  covered: ${a.total - a.uncovered}  uncovered: ${a.uncovered}\n` +
      `won: ${a.won}  ceiling-tied: ${a.ceilingTied}  losses: ${a.losses}\n` +
      `strict win rate (won / covered): ${pct(a.strictWinRate)}\n` +
      `non-loss rate (won+tied / covered): ${pct(a.nonLossRate)}\n` +
      `cell coverage (covered / total): ${pct(a.coverage)}`,
  );
  console.log('---- rows ----');
  console.log(
    `languages: ${grid.rows.languages.covered}/${grid.rows.languages.total} covered\n` +
      `frameworks: ${grid.rows.frameworks.covered}/${grid.rows.frameworks.total} covered\n` +
      `libraries: ${grid.rows.libraries.covered}/${grid.rows.libraries.total} covered`,
  );

  for (const kind of ['language', 'framework', 'library'] as const) {
    const inKind = grid.cells.filter(c => c.rowKind === kind && c.verdict !== 'uncovered');
    const wins = inKind.filter(c => c.verdict === 'win').map(c => `${c.row}[${c.metric}]`);
    const ties = inKind.filter(c => c.verdict === 'ceiling-tie').map(c => `${c.row}[${c.metric}]`);
    console.log(`---- ${kind} covered (${inKind.length}) ----`);
    if (wins.length) console.log(`  win: ${wins.join(', ')}`);
    if (ties.length) console.log(`  ceiling-tie: ${ties.join(', ')}`);
  }

  console.log('---- uncovered (the to-build queue) ----');
  for (const kind of ['language', 'framework', 'library'] as const) {
    const cells = grid.uncoveredList.filter(u => u.rowKind === kind).map(u => `${u.row}[${u.metric}]`);
    if (cells.length) console.log(`  ${kind} (${cells.length} cells): ${cells.join(', ')}`);
  }

  if (a.losses > 0) {
    console.log('---- LOSSES (Klauro bugs — fix, do not hide) ----');
    for (const l of grid.losses) {
      console.log(
        `  LOSS  ${l.rowKind}/${l.row} [${l.metric}]  klauroF1=${l.klauroF1} ` +
          `competitorBestF1=${l.competitorBestF1} arms=${l.armsRan.join(',')}${l.note ? ` (${l.note})` : ''}`,
      );
    }
  }
  console.log('===========================================================\n');

  const lossNames = grid.losses.map(
    l => `${l.rowKind}/${l.row}[${l.metric}] (klauro=${l.klauroF1} vs best=${l.competitorBestF1})`,
  );
  assert.equal(
    a.losses,
    0,
    `Klauro LOST on ${a.losses} cell(s) — these are bugs to fix, not to hide:\n  ${lossNames.join('\n  ')}`,
  );

  const badLangCells = grid.cells.filter(
    c => c.rowKind === 'language' && c.verdict !== 'uncovered' && c.verdict !== 'win' && c.verdict !== 'ceiling-tie',
  );
  assert.equal(
    badLangCells.length,
    0,
    `Covered language who-calls cells must win or ceiling-tie; offenders: ${badLangCells
      .map(c => `${c.row}=${c.verdict}`)
      .join(', ')}`,
  );

  assert.ok(a.coverage > 0 && a.coverage <= 1, `coverage out of range: ${a.coverage}`);
  assert.ok(a.strictWinRate >= 0 && a.strictWinRate <= 1, `strictWinRate out of range: ${a.strictWinRate}`);
  assert.ok(a.nonLossRate >= 0 && a.nonLossRate <= 1, `nonLossRate out of range: ${a.nonLossRate}`);
  assert.ok(a.total - a.uncovered > 0, 'no covered cells — nothing was measured');

  const statsByKind = {
    language: grid.rows.languages,
    framework: grid.rows.frameworks,
    library: grid.rows.libraries,
  };
  for (const kind of ['language', 'framework', 'library'] as const) {
    const cells = grid.cells.filter(cell => cell.rowKind === kind);
    assert.equal(statsByKind[kind].total, new Set(cells.map(cell => cell.row)).size);
    assert.equal(
      statsByKind[kind].covered,
      new Set(cells.filter(cell => cell.verdict !== 'uncovered').map(cell => cell.row)).size,
    );
  }

  const coveredCells = grid.cells.filter(c => c.verdict !== 'uncovered');
  for (const cell of coveredCells) {
    assert.ok(cell.armsRan.length > 0, `${cell.rowKind}/${cell.row}[${cell.metric}] cannot be covered without a measured competitor arm`);
  }
  const structuralCovered = coveredCells.filter(
    cell => cell.rowKind === 'language' && cell.metric === 'structural-retrieval',
  );
  for (const cell of structuralCovered) {
    assert.notEqual(
      cell.verdict,
      'loss',
      `structural-retrieval ${cell.row} must not lose (klauro=${cell.klauroF1} vs embedding=${cell.competitorBestF1})`,
    );
  }

  assert.equal(
    a.won + a.ceilingTied,
    a.total - a.uncovered,
    'covered cells must be exactly the won + ceiling-tied set',
  );
});
