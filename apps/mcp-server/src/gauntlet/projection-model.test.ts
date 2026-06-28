/**
 * Projection-model coverage: projectArm grounds metrics in real repo node counts.
 * Asserts the documented modeling rules, not specific magic numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectArm, type RepoFact } from './projection-model';

function repo(name: string, nodes: number, edges = 0): RepoFact {
  return { name, nodes, edges };
}

const SMALL = [repo('s', 100)];
const MED = [repo('m', 2000)];
const BIG = [repo('b', 20000)];

// --- unknown group / arm / empty --------------------------------------------

test('unknown scenario group => undefined', () => {
  assert.equal(projectArm('nope', 'klauro', MED), undefined);
});

test('unknown arm in a known group => undefined', () => {
  assert.equal(projectArm('single-repo', 'no-such-arm', MED), undefined);
});

test('arm not modeled for this group => undefined (ctags has no incremental row)', () => {
  assert.equal(projectArm('incremental', 'ctags', MED), undefined);
});

test('empty repo list => undefined', () => {
  assert.equal(projectArm('single-repo', 'klauro', []), undefined);
});

// --- quality comes from the calibration table -------------------------------

test('quality is the per-group calibration value, size-independent', () => {
  const a = projectArm('single-repo', 'klauro', SMALL)!;
  const b = projectArm('single-repo', 'klauro', BIG)!;
  assert.equal(a.quality, b.quality, 'quality does not depend on repo size');
  assert.equal(a.quality, 84, 'single-repo klauro calibration quality');
});

test('quality differs by group for the same arm', () => {
  const single = projectArm('single-repo', 'no-tools', MED)!.quality;
  const cross = projectArm('cross-repo', 'no-tools', MED)!.quality;
  assert.notEqual(single, cross);
  assert.ok(cross! < single!, 'unaided quality degrades as scope grows to cross-repo');
});

// --- tokens scale monotonically with node count -----------------------------

test('no-tools tokens increase monotonically with repo nodes', () => {
  const t1 = projectArm('single-repo', 'no-tools', SMALL)!.tokens!;
  const t2 = projectArm('single-repo', 'no-tools', MED)!.tokens!;
  const t3 = projectArm('single-repo', 'no-tools', BIG)!.tokens!;
  assert.ok(t1 < t2 && t2 < t3, `expected ${t1} < ${t2} < ${t3}`);
});

test('time_ms increases monotonically with repo nodes', () => {
  const a = projectArm('single-repo', 'no-tools', SMALL)!.time_ms!;
  const b = projectArm('single-repo', 'no-tools', MED)!.time_ms!;
  const c = projectArm('single-repo', 'no-tools', BIG)!.time_ms!;
  assert.ok(a < b && b < c);
});

// --- klauro strictly cheaper than no-tools ----------------------------------

test('klauro reads far fewer tokens than no-tools (same group + repo)', () => {
  const kl = projectArm('single-repo', 'klauro', BIG)!.tokens!;
  const nt = projectArm('single-repo', 'no-tools', BIG)!.tokens!;
  assert.ok(kl < nt, `klauro ${kl} should be < no-tools ${nt}`);
  // read_fraction 0.16 vs 1.0 => well under half
  assert.ok(kl < nt * 0.5);
});

test('klauro is faster than no-tools (same group + repo)', () => {
  const kl = projectArm('single-repo', 'klauro', BIG)!.time_ms!;
  const nt = projectArm('single-repo', 'no-tools', BIG)!.time_ms!;
  assert.ok(kl < nt);
});

test('klauro quality strictly beats no-tools in every modeled group', () => {
  for (const group of ['single-repo', 'workspace', 'cross-repo', 'incremental']) {
    const kl = projectArm(group, 'klauro', MED)!;
    const nt = projectArm(group, 'no-tools', MED)!;
    assert.ok(kl.quality! > nt.quality!, `${group}: klauro ${kl.quality} should beat no-tools ${nt.quality}`);
  }
});

test('indexer arms sit between no-tools and klauro on token cost', () => {
  const nt = projectArm('single-repo', 'no-tools', BIG)!.tokens!;
  const kl = projectArm('single-repo', 'klauro', BIG)!.tokens!;
  const ctags = projectArm('single-repo', 'ctags', BIG)!.tokens!;
  assert.ok(kl < ctags && ctags < nt, `expected klauro ${kl} < ctags ${ctags} < no-tools ${nt}`);
});

// --- multi-repo SUMs, single-repo AVERAGEs ----------------------------------

test('workspace group SUMS member nodes (more repos => more baseline tokens)', () => {
  const one = projectArm('workspace', 'no-tools', [repo('a', 5000)])!.tokens!;
  const three = projectArm('workspace', 'no-tools', [repo('a', 5000), repo('b', 5000), repo('c', 5000)])!.tokens!;
  // summed basis 15000 vs 5000 => roughly 3x the baseline tokens
  assert.ok(three > one * 2.5, `summed workspace ${three} should dwarf single ${one}`);
});

test('cross-repo group also SUMS member nodes', () => {
  const one = projectArm('cross-repo', 'no-tools', [repo('a', 4000)])!.tokens!;
  const two = projectArm('cross-repo', 'no-tools', [repo('a', 4000), repo('b', 4000)])!.tokens!;
  assert.ok(two > one * 1.8);
});

test('single-repo group AVERAGES member nodes (sample mean, not sum)', () => {
  const solo = projectArm('single-repo', 'no-tools', [repo('a', 6000)])!.tokens!;
  const trio = projectArm('single-repo', 'no-tools', [repo('a', 6000), repo('b', 6000), repo('c', 6000)])!.tokens!;
  // mean of three equal repos == one repo => identical tokens
  assert.equal(trio, solo, 'averaging equal repos leaves the basis unchanged');
});

test('single-repo averaging: basis is the mean of differing repos', () => {
  // mean of 1000 and 3000 is 2000 => matches a single 2000-node repo
  const mixed = projectArm('single-repo', 'no-tools', [repo('a', 1000), repo('b', 3000)])!.tokens!;
  const equiv = projectArm('single-repo', 'no-tools', [repo('x', 2000)])!.tokens!;
  assert.equal(mixed, equiv);
});

// --- floors respected --------------------------------------------------------

test('tiny repo still gets the floored baseline (tokens floor 12000)', () => {
  // 10 nodes * 120 = 1200, floored to 12000; no-tools pays the full baseline.
  const tiny = projectArm('single-repo', 'no-tools', [repo('t', 10)])!.tokens!;
  assert.equal(tiny, 12_000);
});

test('tiny repo time floored to the 45000ms baseline for no-tools', () => {
  const tiny = projectArm('single-repo', 'no-tools', [repo('t', 10)])!.time_ms!;
  assert.equal(tiny, 45_000);
});

// --- token_source label ------------------------------------------------------

test("token_source is always 'estimated-work' for projected metrics", () => {
  for (const arm of ['no-tools', 'klauro', 'ctags']) {
    assert.equal(projectArm('single-repo', arm, MED)!.token_source, 'estimated-work');
  }
});
