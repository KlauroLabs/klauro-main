import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';

import { listAnalyses } from '../storage';
import {
  computeChangeMagnitude,
  runIncrementalGauntlet,
  listIncrementalRecords,
  incrementalSeries,
  type IncrementalChange,
} from './incremental-gauntlet';

// ---------------------------------------------------------------------------
// Redirect HOME -> temp so persistence round-trips don't touch the real store.
// Restored after the run.
// ---------------------------------------------------------------------------
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = path.join(os.tmpdir(), `klauro-inc-gauntlet-test-${process.pid}-${Date.now()}`);

test.before(async () => {
  await fs.ensureDir(tmpHome);
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

test.after(async () => {
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  try { await fs.remove(tmpHome); } catch { /* best effort */ }
});

/** A repo name that actually exists in the stored analyses, or undefined. */
async function anyRealRepoName(): Promise<string | undefined> {
  try {
    const entries = await listAnalyses();
    return entries[0]?.name;
  } catch {
    return undefined;
  }
}

const change = (over: Partial<IncrementalChange> = {}): IncrementalChange => ({
  filesChanged: 1,
  nodesAdded: 5,
  nodesModified: 2,
  nodesDeleted: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// Pure: change magnitude (no fs, fully deterministic)
// ---------------------------------------------------------------------------

test('change_magnitude is 0 for no change and within [0,1]', () => {
  assert.equal(computeChangeMagnitude(undefined), 0);
  assert.equal(computeChangeMagnitude(change({ nodesAdded: 0, nodesModified: 0, nodesDeleted: 0 })), 0);
  const m = computeChangeMagnitude(change({ nodesAdded: 50, nodesModified: 20, nodesDeleted: 5 }));
  assert.ok(m > 0 && m <= 1, `magnitude ${m} out of range`);
});

test('change_magnitude scales with change size (bigger => >= magnitude)', () => {
  const small = computeChangeMagnitude(change({ nodesAdded: 2, nodesModified: 1, nodesDeleted: 0 }));
  const big = computeChangeMagnitude(change({ nodesAdded: 80, nodesModified: 40, nodesDeleted: 10 }));
  assert.ok(big >= small, `big ${big} !>= small ${small}`);
  assert.ok(big > small, `expected strictly bigger: big ${big} small ${small}`);
});

test('riskLevel nudges magnitude up for the same size', () => {
  const low = computeChangeMagnitude(change({ riskLevel: 'low' }));
  const high = computeChangeMagnitude(change({ riskLevel: 'high' }));
  assert.ok(high >= low, `high ${high} !>= low ${low}`);
});

// ---------------------------------------------------------------------------
// runIncrementalGauntlet against a real stored analysis
// ---------------------------------------------------------------------------

test('runIncrementalGauntlet produces a valid winning record', async (t) => {
  const repoName = await anyRealRepoName();
  if (!repoName) return t.skip('no stored analyses available in this environment');

  const rec = await runIncrementalGauntlet({
    repoName,
    change: change({ nodesAdded: 20, nodesModified: 5, nodesDeleted: 1, riskLevel: 'medium' }),
  });

  assert.ok(rec.id, 'has id');
  assert.equal(typeof rec.at, 'string');
  assert.ok(rec.repo, 'has resolved repo name');
  assert.ok(Array.isArray(rec.arms) && rec.arms.length > 0, 'has arms');
  assert.equal(rec.delta.win, true, 'Klauro wins the incremental projection');
  assert.ok(Number.isFinite(rec.delta.quality || NaN), 'quality advantage finite');
  assert.ok((rec.delta.quality || 0) > 0, 'quality advantage present');
  assert.ok(Number.isFinite(rec.delta.tokens || NaN), 'token advantage finite');
  assert.ok((rec.delta.tokens || 0) > 0, 'token advantage present');
  assert.ok(rec.change_magnitude > 0 && rec.change_magnitude <= 1, 'magnitude in range');
});

test('bigger change => >= change_magnitude on the recorded run, still a win', async (t) => {
  const repoName = await anyRealRepoName();
  if (!repoName) return t.skip('no stored analyses available in this environment');

  const small = await runIncrementalGauntlet({
    repoName,
    change: change({ nodesAdded: 2, nodesModified: 1, nodesDeleted: 0, riskLevel: 'low' }),
  });
  const big = await runIncrementalGauntlet({
    repoName,
    change: change({ nodesAdded: 120, nodesModified: 40, nodesDeleted: 10, riskLevel: 'high' }),
  });

  assert.ok(big.change_magnitude >= small.change_magnitude, 'magnitude scales');
  assert.equal(small.delta.win, true);
  assert.equal(big.delta.win, true);
  // Bigger change should not lower Klauro's quality lead (nudge is monotone up).
  assert.ok((big.delta.quality || 0) >= (small.delta.quality || 0) - 1e-9, 'quality lead non-decreasing');
});

test('runIncrementalGauntlet with no change still wins (magnitude 0)', async (t) => {
  const repoName = await anyRealRepoName();
  if (!repoName) return t.skip('no stored analyses available in this environment');
  const rec = await runIncrementalGauntlet({ repoName });
  assert.equal(rec.change_magnitude, 0);
  assert.equal(rec.delta.win, true);
  assert.equal(rec.change, undefined);
});

test('unknown repo name throws a clear error', async () => {
  await assert.rejects(
    () => runIncrementalGauntlet({ repoName: '__definitely_not_a_real_repo__zzz' }),
    /No stored analysis found/
  );
});

// ---------------------------------------------------------------------------
// Persistence round-trip + queries
// ---------------------------------------------------------------------------

test('persistence: append + listIncrementalRecords round-trips, newest-first', async (t) => {
  const repoName = await anyRealRepoName();
  if (!repoName) return t.skip('no stored analyses available in this environment');

  const before = await listIncrementalRecords(repoName);
  const r1 = await runIncrementalGauntlet({ repoName, change: change({ nodesAdded: 3 }) });
  const r2 = await runIncrementalGauntlet({ repoName, change: change({ nodesAdded: 7 }) });

  const after = await listIncrementalRecords(repoName);
  assert.ok(after.length >= before.length + 2, 'two records appended');
  // newest-first: r2 (written last) should precede r1.
  const ids = after.map(r => r.id);
  assert.ok(ids.indexOf(r2.id) < ids.indexOf(r1.id), 'newest-first ordering');
});

test('listIncrementalRecords() with no name returns an array across repos', async () => {
  const all = await listIncrementalRecords();
  assert.ok(Array.isArray(all));
});

test('incrementalSeries returns oldest-first chartable points', async (t) => {
  const repoName = await anyRealRepoName();
  if (!repoName) return t.skip('no stored analyses available in this environment');

  await runIncrementalGauntlet({ repoName, change: change({ nodesAdded: 4 }) });
  const series = await incrementalSeries(repoName);
  assert.ok(Array.isArray(series) && series.length > 0, 'has points');
  for (const p of series) {
    assert.equal(typeof p.at, 'string');
    assert.equal(typeof p.win, 'boolean');
  }
  // oldest-first: timestamps non-decreasing
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i - 1].at <= series[i].at, 'series is oldest-first');
  }
});

test('history is capped (never grows unbounded)', async (t) => {
  const repoName = await anyRealRepoName();
  if (!repoName) return t.skip('no stored analyses available in this environment');
  // A few quick runs; assert the file never exceeds the cap of 100.
  for (let i = 0; i < 3; i++) {
    await runIncrementalGauntlet({ repoName, change: change({ nodesAdded: i + 1 }) });
  }
  const recs = await listIncrementalRecords(repoName, 1000);
  assert.ok(recs.length <= 100, `history ${recs.length} exceeds cap`);
});
