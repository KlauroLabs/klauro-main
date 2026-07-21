import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateCoChange, parseNameOnlyLog, lookupCoChangeProbability } from './co-change-index';
import type { CoChangeIndex } from './co-change-index';

// ---------------------------------------------------------------------------
// Synthetic history fixture
// ---------------------------------------------------------------------------
//
// a.ts and b.ts co-change in 8 of a.ts's 10 commits (strong, frequent
// coupling — e.g. a parallel-language twin or a route + its handler).
// c.ts changes in every commit (a hot, ubiquitous file — e.g. a logger import)
// so it correlates with everything numerically but should be suppressed by
// the lift filter once a proper baseline is accounted for.
// d.ts and e.ts co-change exactly twice — below the support floor, must be
// dropped as noise regardless of how "clean" the ratio looks.
// One bulk commit touches 60 files and must be excluded entirely.

function buildFixture(): string[][] {
  const commits: string[][] = [];

  // 10 commits touching a.ts; 8 of them also touch b.ts and c.ts.
  for (let i = 0; i < 10; i++) {
    const files = ['a.ts'];
    if (i < 8) files.push('b.ts');
    files.push('c.ts'); // c.ts also rides along on every one of these.
    commits.push(files);
  }

  // c.ts additionally changes alone in many unrelated commits, so its
  // baseline P(c changes) is high — this is what should suppress lift for
  // (a -> c) despite raw support looking identical to (a -> b).
  for (let i = 0; i < 30; i++) {
    commits.push(['c.ts', `unrelated-${i}.ts`]);
  }

  // d.ts / e.ts: support below the minSupport=3 floor.
  commits.push(['d.ts', 'e.ts']);
  commits.push(['d.ts', 'e.ts']);

  // One bulk-edit commit (over maxFilesPerCommit=50) — must be excluded.
  const bulk = Array.from({ length: 60 }, (_, i) => `bulk-${i}.ts`);
  commits.push(bulk);

  return commits;
}

test('aggregation correctness: strong frequent pair survives with the expected probability/lift shape', () => {
  const index = aggregateCoChange(buildFixture(), { minSupport: 3, minLift: 2, topK: 10, laplaceAlpha: 1 });

  assert.ok(index['a.ts'], 'a.ts should have surviving partners');
  const bPartner = index['a.ts'].find((p) => p.file === 'b.ts');
  assert.ok(bPartner, 'b.ts should survive as a partner of a.ts');
  assert.equal(bPartner!.support, 8);
  // probability = (8 + 1) / (10 + 1) = 9/11
  assert.ok(Math.abs(bPartner!.probability - 9 / 11) < 1e-9);
  assert.ok(bPartner!.lift > 2, 'a strong, infrequent-elsewhere partner should clear the lift floor');
});

test('threshold behavior: a ubiquitous co-occurring file is suppressed by the lift floor', () => {
  const index = aggregateCoChange(buildFixture(), { minSupport: 3, minLift: 2, topK: 10, laplaceAlpha: 1 });
  const aPartners = index['a.ts'] ?? [];
  const cPartner = aPartners.find((p) => p.file === 'c.ts');
  assert.equal(cPartner, undefined, 'c.ts changes so often that it carries no real lift for a.ts');
});

test('threshold behavior: support below minSupport is dropped even with a clean ratio', () => {
  const index = aggregateCoChange(buildFixture(), { minSupport: 3, minLift: 2, topK: 10, laplaceAlpha: 1 });
  assert.equal(index['d.ts'], undefined, 'd.ts/e.ts co-change only twice — below the support floor');
});

test('threshold behavior: raising minSupport/minLift only shrinks the surviving set (monotonic)', () => {
  const loose = aggregateCoChange(buildFixture(), { minSupport: 1, minLift: 0.5, topK: 10 });
  const strict = aggregateCoChange(buildFixture(), { minSupport: 5, minLift: 5, topK: 10 });
  const looseCount = Object.values(loose).reduce((n, ps) => n + ps.length, 0);
  const strictCount = Object.values(strict).reduce((n, ps) => n + ps.length, 0);
  assert.ok(strictCount <= looseCount, 'stricter thresholds must never surface more pairs');
});

test('bulk-edit commits (over maxFilesPerCommit) are excluded from aggregation entirely', () => {
  const index = aggregateCoChange(buildFixture(), { minSupport: 1, minLift: 0, topK: 10, maxFilesPerCommit: 50 });
  // None of the bulk-*.ts files should appear anywhere in the index — as a
  // key or as anyone's partner — since that whole commit was dropped.
  const allFiles = new Set<string>();
  for (const [file, partners] of Object.entries(index)) {
    allFiles.add(file);
    for (const p of partners) allFiles.add(p.file);
  }
  for (const f of allFiles) {
    assert.ok(!f.startsWith('bulk-'), `bulk commit file ${f} leaked into the index`);
  }
});

test('determinism: identical input produces identical output on repeated runs', () => {
  const fixture = buildFixture();
  const first = aggregateCoChange(fixture, { minSupport: 2, minLift: 1, topK: 5 });
  const second = aggregateCoChange(fixture, { minSupport: 2, minLift: 1, topK: 5 });
  assert.deepEqual(first, second);
});

test('determinism: commit order does not affect the result (order-independent counting)', () => {
  const fixture = buildFixture();
  const shuffled = [...fixture].reverse();
  const a = aggregateCoChange(fixture, { minSupport: 2, minLift: 1, topK: 5 });
  const b = aggregateCoChange(shuffled, { minSupport: 2, minLift: 1, topK: 5 });
  assert.deepEqual(a, b);
});

test('top-K truncation is applied and stated, never a silent unbounded list', () => {
  // Build a file with 12 distinct qualifying partners, ask for topK=3.
  const commits: string[][] = [];
  for (let i = 0; i < 12; i++) {
    // Each partner co-changes with "hub.ts" exactly 4 times (above support
    // floor of 3), each in its own otherwise-small commit set so lift is high.
    for (let rep = 0; rep < 4; rep++) {
      commits.push(['hub.ts', `partner-${i}.ts`]);
    }
  }
  const index = aggregateCoChange(commits, { minSupport: 3, minLift: 1, topK: 3 });
  assert.ok(index['hub.ts']);
  assert.equal(index['hub.ts'].length, 3, 'topK must truncate to exactly the configured cap');

  // And confirm the same run with a higher cap keeps more (proves truncation
  // is real, not a coincidental result of the filters).
  const wider = aggregateCoChange(commits, { minSupport: 3, minLift: 1, topK: 20 });
  assert.equal(wider['hub.ts'].length, 12);
});

test('top-K keeps the highest-probability partners first (deterministic tie-break by file name)', () => {
  const commits: string[][] = [];
  // partner-a and partner-b co-change with hub.ts the same number of times
  // (tie on probability/support/lift) — tie-break must be file name asc.
  for (let i = 0; i < 5; i++) {
    commits.push(['hub.ts', 'partner-b.ts']);
    commits.push(['hub.ts', 'partner-a.ts']);
  }
  const index = aggregateCoChange(commits, { minSupport: 3, minLift: 0, topK: 1 });
  assert.equal(index['hub.ts'][0].file, 'partner-a.ts');
});

test('parseNameOnlyLog: pure parser reconstructs per-commit file sets from git --name-only output', () => {
  const output = [
    '1111111111111111111111111111111111111111',
    'src/a.ts',
    'src/b.ts',
    '',
    '2222222222222222222222222222222222222222',
    'src/c.ts',
    '',
  ].join('\n');
  const commits = parseNameOnlyLog(output);
  assert.deepEqual(commits, [
    ['src/a.ts', 'src/b.ts'],
    ['src/c.ts'],
  ]);
});

test('parseNameOnlyLog: a commit touching zero files (empty merge) yields an empty array, not a crash', () => {
  const output = [
    '1111111111111111111111111111111111111111',
    '',
    '2222222222222222222222222222222222222222',
    'src/only.ts',
    '',
  ].join('\n');
  const commits = parseNameOnlyLog(output);
  assert.deepEqual(commits, [[], ['src/only.ts']]);
});

test('lookupCoChangeProbability checks both directions and takes the max', () => {
  const index: CoChangeIndex = {
    'a.ts': [{ file: 'b.ts', probability: 0.9, support: 8, lift: 5 }],
    'b.ts': [{ file: 'a.ts', probability: 0.3, support: 8, lift: 2 }],
  };
  const found = lookupCoChangeProbability(index, 'b.ts', 'a.ts');
  assert.ok(found);
  assert.equal(found!.probability, 0.9, 'should prefer the higher-probability direction regardless of query order');
});

test('lookupCoChangeProbability returns undefined for an unrelated pair', () => {
  const index: CoChangeIndex = {
    'a.ts': [{ file: 'b.ts', probability: 0.9, support: 8, lift: 5 }],
  };
  assert.equal(lookupCoChangeProbability(index, 'a.ts', 'z.ts'), undefined);
});
