/**
 * FULL-GRID test — the source-of-truth gate for the "Klauro wins 100%" claim.
 *
 * The contract this test enforces, loudly and without softening:
 *   1. ZERO losses. If any covered cell is a loss (a competitor beat Klauro), the
 *      test FAILS and names the cell — that is a Klauro bug, never a reason to
 *      weaken the assertion.
 *   2. Every COVERED language who-calls cell is a win or an honest ceiling-tie.
 *   3. coverage and winRate are reported (printed), so the real gaps are visible.
 *
 * It also PRINTS the honest grid: total / covered / won / ceiling-tied / uncovered
 * / losses + winRate + coverage, plus the uncoveredList grouped by rowKind — the
 * real to-build queue. Low coverage is expected and fine: honesty over optics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFullGrid, resetFullGridCache } from './full-grid';

test('full grid: zero losses, covered language cells win, coverage reported', async () => {
  resetFullGridCache();
  const grid = await buildFullGrid();
  const a = grid.aggregate;

  // --- Print the honest summary ----------------------------------------------
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log('\n================ FULL GRID (honest matrix) ================');
  console.log(
    `cells: ${a.total}  covered: ${a.total - a.uncovered}  uncovered: ${a.uncovered}\n` +
      `won: ${a.won}  ceiling-tied: ${a.ceilingTied}  losses: ${a.losses}\n` +
      `winRate (won+tied / covered): ${pct(a.winRate)}\n` +
      `coverage (covered / total): ${pct(a.coverage)}`,
  );
  console.log('---- rows ----');
  console.log(
    `languages: ${grid.rows.languages.covered}/${grid.rows.languages.total} covered\n` +
      `frameworks: ${grid.rows.frameworks.covered}/${grid.rows.frameworks.total} covered\n` +
      `libraries: ${grid.rows.libraries.covered}/${grid.rows.libraries.total} covered`,
  );

  // Covered wins, by kind, for a quick eyeball of where the proof is solid.
  for (const kind of ['language', 'framework', 'library'] as const) {
    const inKind = grid.cells.filter(c => c.rowKind === kind && c.verdict !== 'uncovered');
    const wins = inKind.filter(c => c.verdict === 'win').map(c => c.row);
    const ties = inKind.filter(c => c.verdict === 'ceiling-tie').map(c => c.row);
    console.log(`---- ${kind} covered (${inKind.length}) ----`);
    if (wins.length) console.log(`  win: ${wins.join(', ')}`);
    if (ties.length) console.log(`  ceiling-tie: ${ties.join(', ')}`);
  }

  // The honest gap surface: uncovered cells grouped by rowKind = the to-build queue.
  console.log('---- uncovered (the to-build queue) ----');
  for (const kind of ['language', 'framework', 'library'] as const) {
    const rows = grid.uncoveredList.filter(u => u.rowKind === kind).map(u => u.row);
    if (rows.length) console.log(`  ${kind} (${rows.length}): ${rows.join(', ')}`);
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

  // --- Assertions (loud, unweakened) -----------------------------------------

  // (1) ZERO losses. Name them if present — this leaves the test RED on a real loss.
  const lossNames = grid.losses.map(
    l => `${l.rowKind}/${l.row}[${l.metric}] (klauro=${l.klauroF1} vs best=${l.competitorBestF1})`,
  );
  assert.equal(
    a.losses,
    0,
    `Klauro LOST on ${a.losses} cell(s) — these are bugs to fix, not to hide:\n  ${lossNames.join('\n  ')}`,
  );

  // (2) Every COVERED language who-calls cell is a win or an honest ceiling-tie.
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

  // (3) coverage / winRate are real numbers in range, and there is genuine coverage.
  assert.ok(a.coverage > 0 && a.coverage <= 1, `coverage out of range: ${a.coverage}`);
  assert.ok(a.winRate >= 0 && a.winRate <= 1, `winRate out of range: ${a.winRate}`);
  assert.ok(a.total - a.uncovered > 0, 'no covered cells — nothing was measured');

  const coveredCells = grid.cells.filter(c => c.verdict !== 'uncovered');
  for (const cell of coveredCells) {
    assert.ok(cell.armsRan.length > 0, `${cell.rowKind}/${cell.row}[${cell.metric}] cannot be covered without a measured competitor arm`);
  }
  const structuralCovered = coveredCells.filter(
    cell => cell.rowKind === 'language' && cell.metric === 'structural-retrieval',
  );
  for (const cell of structuralCovered) {
    assert.equal(
      cell.verdict,
      'win',
      `structural-retrieval ${cell.row} must be a win (klauro=${cell.klauroF1} vs embedding=${cell.competitorBestF1})`,
    );
  }

  // Over the COVERED set, every cell is win or ceiling-tie (since losses === 0 and
  // uncovered is excluded) — the 100%-on-covered invariant the claim rests on.
  assert.equal(
    a.won + a.ceilingTied,
    a.total - a.uncovered,
    'covered cells must be exactly the won + ceiling-tied set',
  );
});
