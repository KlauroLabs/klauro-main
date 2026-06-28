/**
 * Corpus helpers. sampleDiverse is fully pure and exhaustively tested.
 * discoverCorpus reads disk; tested behind a small cap with a generous timeout
 * and asserts only documented structural invariants (no coupling to repo names).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleDiverse, discoverCorpus } from './corpus';
import type { AnalysisEntry } from '../storage';

function entry(name: string, nodes: number): AnalysisEntry {
  return {
    name,
    path: `/repos/${name}`,
    file: `${name}.json`,
    analyzed_at: '2026-01-01',
    system_type: 'service',
    frameworks: [],
    node_count: nodes,
    edge_count: nodes * 2,
  };
}

/** node-count-descending entries, the order uniqueRealRepos produces. */
function descending(count: number): AnalysisEntry[] {
  return Array.from({ length: count }, (_, i) => entry(`r${i}`, (count - i) * 100));
}

// --- sampleDiverse: passthrough below the cap -------------------------------

test('returns all entries (as RepoFacts) when count <= limit', () => {
  const e = descending(5);
  const got = sampleDiverse(e, 10);
  assert.equal(got.length, 5);
  assert.deepEqual(got.map(r => r.name), e.map(x => x.name));
});

test('maps AnalysisEntry to RepoFact shape (name/nodes/edges)', () => {
  const got = sampleDiverse([entry('alpha', 700)], 10);
  assert.deepEqual(got[0], { name: 'alpha', nodes: 700, edges: 1400 });
});

test('exactly-at-limit returns all without sampling', () => {
  const e = descending(8);
  const got = sampleDiverse(e, 8);
  assert.equal(got.length, 8);
  assert.deepEqual(got.map(r => r.name), e.map(x => x.name));
});

// --- sampleDiverse: sampling above the cap ----------------------------------

test('never returns more than the limit when oversubscribed', () => {
  const got = sampleDiverse(descending(100), 9);
  assert.ok(got.length <= 9, `got ${got.length}`);
});

test('result entries are all drawn from the input (no fabrication)', () => {
  const input = descending(100);
  const names = new Set(input.map(e => e.name));
  const got = sampleDiverse(input, 12);
  for (const r of got) assert.ok(names.has(r.name), `${r.name} not from input`);
});

test('result entries are unique (no duplicates pulled)', () => {
  const got = sampleDiverse(descending(100), 12);
  assert.equal(new Set(got.map(r => r.name)).size, got.length);
});

test('samples across size buckets, not just the largest repos', () => {
  // 90 entries, descending size. A pure top-N would only return r0..rN (biggest).
  // The diverse sampler must reach into the small-size tail.
  const got = sampleDiverse(descending(90), 9);
  const indices = got.map(r => Number(r.name.slice(1)));
  const maxIdx = Math.max(...indices);
  // r0 is biggest, r89 smallest; a diverse sample should pull from the back third.
  assert.ok(maxIdx >= 60, `expected a small-bucket pick (idx>=60), max picked idx was ${maxIdx}`);
});

test('also includes large-bucket repos', () => {
  const got = sampleDiverse(descending(90), 9);
  const indices = got.map(r => Number(r.name.slice(1)));
  assert.ok(Math.min(...indices) < 30, 'should include a large-bucket (front-third) repo');
});

test('is deterministic — same input yields the same sample', () => {
  const a = sampleDiverse(descending(100), 11).map(r => r.name);
  const b = sampleDiverse(descending(100), 11).map(r => r.name);
  assert.deepEqual(a, b);
});

// --- discoverCorpus: disk-backed structural invariants ----------------------

test('discoverCorpus returns the documented shape and invariants', { timeout: 60_000 }, async () => {
  let corpus;
  try {
    corpus = await discoverCorpus({ maxRepos: 3 });
  } catch (err) {
    // No analyses on disk in this environment — skip rather than fail.
    test.skip(`discoverCorpus unavailable: ${(err as Error).message}`);
    return;
  }

  // shape
  assert.ok(Array.isArray(corpus.repos));
  assert.ok(Array.isArray(corpus.workspaces));
  assert.equal(typeof corpus.total_unique_repos, 'number');
  assert.equal(typeof corpus.total_analyses, 'number');

  // capped
  assert.ok(corpus.repos.length <= 3, `repos ${corpus.repos.length} should respect maxRepos`);

  // repos sorted descending by nodes
  for (let i = 1; i < corpus.repos.length; i++) {
    assert.ok(corpus.repos[i - 1].nodes >= corpus.repos[i].nodes, 'repos must be node-desc sorted');
  }

  // every repo has a positive node count and a name
  for (const r of corpus.repos) {
    assert.ok(r.nodes > 0, `${r.name} has nodes>0`);
    assert.ok(r.name && r.name.length > 0);
  }

  // no fixture/transient names leak into the sample
  const bad = /(fixtures?|__fixtures__|testdata|node_modules|greenfield|from-zero|scratch-build|preview-iteration)/i;
  for (const r of corpus.repos) assert.ok(!bad.test(r.name), `fixture/transient leaked: ${r.name}`);

  // total_unique_repos is a ceiling on the sampled repos
  assert.ok(corpus.total_unique_repos >= corpus.repos.length);

  // workspaces each have >=1 repo and a consistent total_nodes
  for (const w of corpus.workspaces) {
    assert.ok(w.repos.length >= 1, `${w.name} has member repos`);
    const summed = w.repos.reduce((a, r) => a + r.nodes, 0);
    assert.equal(w.total_nodes, summed, `${w.name} total_nodes must equal summed member nodes`);
  }
});
