import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCampCComprehensionReport, buildDimension, summarizeCampCComprehension } from './camp-c-comprehension';


const failingDimensionSpec = {
  key: 'orm', label: 'ORM evidence', description: 'Fixture execution evidence',
  campABCannot: 'Relationship evidence', fixtureDir: 'orm-bench',
  run: async (_dir: string): Promise<never> => { throw new Error('Analysis was not started: capacity exhausted'); },
};

test('comprehension evidence retains every failed attempt when no fixture completed', async () => {
  const dimension = await buildDimension(failingDimensionSpec);
  assert.ok(dimension.attemptedFixtures > 0);
  assert.equal(dimension.fixtures, 0);
  assert.equal(dimension.failedFixtures, dimension.attemptedFixtures);
  assert.equal(dimension.allWin, false);
  assert.match(dimension.note || '', /capacity exhausted/);
});

test('comprehension evidence treats missing results and missing fixtures as unproven', async () => {
  const missingResults = await buildDimension({
    ...failingDimensionSpec,
    run: async (dir: string) => ({ fixture: dir, arms: [], verdict: { klauro_wins: true }, detail: [] }),
  });
  assert.ok(missingResults.attemptedFixtures > 0);
  assert.equal(missingResults.failedFixtures, missingResults.attemptedFixtures);
  assert.equal(missingResults.allWin, false);
  assert.match(missingResults.note || '', /missing Klauro result/);

  const absent = await buildDimension({ ...failingDimensionSpec, fixtureDir: '__missing_comprehension_fixtures__' });
  assert.equal(absent.attemptedFixtures, 0);
  assert.equal(absent.failedFixtures, 0);
  assert.equal(absent.allWin, false);
});

test('comprehension evidence cannot hide a failed dimension behind successful dimensions', async () => {
  const failed = await buildDimension(failingDimensionSpec);
  const passed = {
    ...failed, key: 'routes', fixtures: 2, attemptedFixtures: 2, failedFixtures: 0,
    meanKlauroF1: 1, meanTokenSaving: 0.5, allWin: true, note: undefined,
  };
  const partial = summarizeCampCComprehension([passed, failed], [], 'unavailable');
  assert.equal(partial.aggregate.headToHead.dimensions, 1);
  assert.equal(partial.aggregate.headToHead.meanKlauroF1, 1);
  assert.equal(partial.aggregate.headToHead.allWin, false);
  assert.equal(partial.aggregate.allWin, false);
  assert.equal(partial.dimensions[1].failedFixtures, failed.attemptedFixtures);
  assert.equal(summarizeCampCComprehension([], [], 'unavailable').aggregate.allWin, false);
  assert.equal(summarizeCampCComprehension([passed], [], 'unavailable').aggregate.allWin, true);
  assert.equal(summarizeCampCComprehension([{ ...passed, attemptedFixtures: 3 }], [], 'unavailable').aggregate.allWin, false);
});
test('camp-c-comprehension: full Camp-C surface in two honest modes', async () => {
  const report = await buildCampCComprehensionReport();

  const h2h = report.dimensions.filter(d => d.mode === 'head-to-head' && d.fixtures > 0);
  const emission = report.dimensions.filter(d => d.mode === 'emission-coverage' && d.emitted > 0);

  // Print a measured dimension summary for evidence.
  // eslint-disable-next-line no-console
  console.log('\nCamp-C MODE 1 — head-to-head (Klauro F1 vs best competitor):');
  for (const d of report.dimensions.filter(x => x.mode === 'head-to-head')) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${d.key.padEnd(11)} fixtures=${String(d.fixtures).padStart(2)}  ` +
        `meanF1=${d.meanKlauroF1.toFixed(3)}  tokenSaving=${(d.meanTokenSaving * 100).toFixed(1)}%  allWin=${d.allWin}` +
        (d.note ? `  (${d.note})` : ''),
    );
  }
  // eslint-disable-next-line no-console
  console.log(`\nCamp-C MODE 2 — emission-coverage (fixture: ${report.emissionFixture}):`);
  for (const d of report.dimensions.filter(x => x.mode === 'emission-coverage')) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${d.key.padEnd(12)} emitted=${String(d.emitted).padStart(3)}  ` +
        `examples=[${d.examples.slice(0, 3).join(', ')}]` +
        (d.note ? `  (${d.note})` : ''),
    );
  }
  const a = report.aggregate;
  // eslint-disable-next-line no-console
  console.log(
    `\n  AGGREGATE  totalDims=${a.dimensions}` +
      `  | head-to-head: dims=${a.headToHead.dimensions} fixtures=${a.headToHead.totalFixtures} ` +
      `meanF1=${a.headToHead.meanKlauroF1.toFixed(3)} tokenSaving=${(a.headToHead.meanTokenSaving * 100).toFixed(1)}% allWin=${a.headToHead.allWin}` +
      `  | emission: dims=${a.emissionCoverage.dimensions} totalEmitted=${a.emissionCoverage.totalEmitted}\n`,
  );

  // ----- MODE 1: ≥9 head-to-head dims tie-or-win, never a loss -----
  assert.ok(
    h2h.length >= 9,
    `expected ≥9 populated head-to-head dimensions, got ${h2h.length}`,
  );
  for (const d of h2h) {
    assert.ok(d.fixtures >= 1, `[${d.key}] head-to-head dimension must have ≥1 fixture`);
    assert.ok(
      d.meanKlauroF1 >= 0.9,
      `[${d.key}] Klauro mean F1 must be ≥ 0.9, got ${d.meanKlauroF1.toFixed(3)}`,
    );
    assert.equal(d.outOfCategory, true, `[${d.key}] must be out-of-category`);
    assert.ok(d.campABCannot.length > 0, `[${d.key}] must state what Camp A/B cannot answer`);
    // Klauro wins or ceiling-ties every fixture — never a loss.
    assert.equal(d.allWin, true, `[${d.key}] Klauro must win/ceiling-tie every fixture`);
  }
  assert.equal(report.aggregate.headToHead.allWin, true, 'Klauro must win every head-to-head Camp-C dimension');
  assert.equal(report.aggregate.allWin, true, 'aggregate.allWin must be true (no Camp-C loss)');

  // ----- MODE 2: ≥6 emission-coverage dims with emitted > 0 -----
  assert.ok(
    emission.length >= 6,
    `expected ≥6 emission-coverage dimensions with emitted>0, got ${emission.length}`,
  );
  for (const d of emission) {
    assert.ok(d.emitted > 0, `[${d.key}] emission dimension must emit ≥1 fact`);
    assert.equal(d.outOfCategory, true, `[${d.key}] emission dim must be out-of-category`);
    assert.ok(d.campABCannot.length > 0, `[${d.key}] must state what Camp A/B cannot produce`);
  }
});
