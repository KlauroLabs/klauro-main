/**
 * Consumer parity proof (Workstream C, docs/SPEC-MATHEMATICAL-INTELLIGENCE.md):
 * the reachability-index fast path and the traversal fallback in
 * query.ts getAffectedSet / assessChangeRisk must return IDENTICAL answers on
 * the same CAS — the index is a speedup, never a semantic change. The
 * fallback runs whenever an (older) CAS carries no persisted index.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getAffectedSet, assessChangeRisk } from './query';
import { buildReachabilityIndexFromCas, buildReachabilityIndex, callEdgePairs } from '../../../packages/analyzer-core/src/analyzer/core/reachability-index';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

/** Deterministic PRNG (mulberry32) so the random fixture is replayable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A realistic-shaped fixture CAS: functions wired by 'calls' edges (with
 * cycles), a couple of resolved method_calls, plus non-call edges ('contains',
 * 'references') that the affected-set semantics must IGNORE.
 */
function makeFixtureCas(withIndex: boolean): CASOutput {
  const rand = rng(20260720);
  const n = 400;
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `fn:${i}`,
    name: `fn${i}`,
    type: 'function',
    source: { file: `src/f${i % 40}.ts` },
  }));
  const edges: Array<{ source: string; target: string; type: string }> = [];
  // Random call edges (cyclic by construction at this density).
  for (let k = 0; k < 1100; k++) {
    const s = Math.floor(rand() * n);
    const t = Math.floor(rand() * n);
    if (s !== t) edges.push({ source: `fn:${s}`, target: `fn:${t}`, type: 'calls' });
  }
  // Guaranteed cycle so the SCC path is exercised.
  edges.push({ source: 'fn:1', target: 'fn:2', type: 'calls' });
  edges.push({ source: 'fn:2', target: 'fn:3', type: 'calls' });
  edges.push({ source: 'fn:3', target: 'fn:1', type: 'calls' });
  // Non-call edges that must NOT count as reachability.
  for (let k = 0; k < 300; k++) {
    const s = Math.floor(rand() * n);
    const t = Math.floor(rand() * n);
    if (s !== t) edges.push({ source: `fn:${s}`, target: `fn:${t}`, type: k % 2 === 0 ? 'contains' : 'references' });
  }
  // 'invokes' edges (dispatch/registration calls some analyzers emit instead
  // of a literal 'calls' edge) — these DO count as reachability, and the
  // index/traversal parity proof below must hold with them present.
  for (let k = 0; k < 150; k++) {
    const s = Math.floor(rand() * n);
    const t = Math.floor(rand() * n);
    if (s !== t) edges.push({ source: `fn:${s}`, target: `fn:${t}`, type: 'invokes' });
  }
  const method_calls = Array.from({ length: 60 }, (_, k) => ({
    caller_node: `fn:${Math.floor(rand() * n)}`,
    target_node: `fn:${Math.floor(rand() * n)}`,
    call_details: { method_name: `m${k}` },
  })) as unknown as CASOutput['method_calls'];

  const cas = {
    cas_version: '1.0',
    analysis_timestamp: 'fixed',
    analysis_id: 'parity-fixture',
    system: { name: 'parity-fixture' },
    nodes,
    edges,
    method_calls,
    analyzer_contributions: [],
    progressive_levels: {},
  } as unknown as CASOutput;

  if (withIndex) {
    cas.reachability_index = buildReachabilityIndexFromCas({
      nodes,
      edges,
      method_calls: cas.method_calls as Array<{ caller_node?: string; target_node?: string }>,
    });
  }
  return cas;
}

test('getAffectedSet: index answer == traversal answer for every direction (parity proof)', () => {
  const withIndex = makeFixtureCas(true);
  const withoutIndex = makeFixtureCas(false);
  assert.ok(withIndex.reachability_index, 'fixture must carry a persisted index');

  const rand = rng(999);
  for (let q = 0; q < 60; q++) {
    const seedCount = 1 + Math.floor(rand() * 3);
    const seeds = Array.from({ length: seedCount }, () => `fn:${Math.floor(rand() * 400)}`);
    for (const direction of ['upstream', 'downstream', 'both'] as const) {
      const fast = getAffectedSet(withIndex, seeds, { direction });
      const slow = getAffectedSet(withoutIndex, seeds, { direction });
      assert.equal(fast.method, 'reachability_index');
      assert.equal(slow.method, 'traversal');
      assert.deepEqual(fast.affected, slow.affected, `direction=${direction} seeds=${seeds.join(',')}`);
      assert.equal(fast.truncated, slow.truncated);
    }
  }
});

/**
 * Task #100 compatibility proof: an analysis STORED BEFORE 'invokes' was
 * added to the persisted index's closure carries a `reachability_index` with
 * no `includes_invokes_edges` flag (it predates the field entirely — plain
 * JSON, so the field is simply absent, not `false`). getAffectedSet must NOT
 * trust that stale index just because it's present: doing so would silently
 * hand back the pre-fix (narrower) answer forever, even though a fresh
 * traversal — or a re-analysis — would report more. It must fall back to
 * traversal, which reports the SAME (wider, invokes-inclusive) answer as a
 * fresh index would.
 */
test('getAffectedSet: a pre-task#100 stored index (no includes_invokes_edges) is not trusted — falls back and still finds invokes-reached nodes', () => {
  const cas = makeFixtureCas(false); // has 'invokes' edges in cas.edges, no index yet
  // Simulate the OLD persisted shape: built over the OLD edge set (calls +
  // method_calls only), no includes_invokes_edges flag — exactly what
  // buildReachabilityIndexFromCas used to emit before this fix.
  const staleIndex = buildReachabilityIndex(
    cas.nodes.map(n => n.id),
    callEdgePairs({ nodes: cas.nodes, edges: cas.edges, method_calls: cas.method_calls as any })
  );
  assert.equal((staleIndex as any).includes_invokes_edges, undefined, 'fixture must reproduce the pre-fix shape');
  const staleCas: CASOutput = { ...cas, reachability_index: staleIndex };

  const freshIndexCas = makeFixtureCas(true); // current buildReachabilityIndexFromCas: flag is true
  assert.equal(freshIndexCas.reachability_index?.includes_invokes_edges, true);

  const rand = rng(555);
  for (let q = 0; q < 30; q++) {
    const seeds = [`fn:${Math.floor(rand() * 400)}`];
    for (const direction of ['upstream', 'downstream', 'both'] as const) {
      const withStaleIndex = getAffectedSet(staleCas, seeds, { direction });
      const withFreshIndex = getAffectedSet(freshIndexCas, seeds, { direction });
      // The stale index must be REJECTED (traversal fallback used instead),
      // and that fallback must agree with what the current, up-to-date index
      // reports — never a narrower answer.
      assert.equal(withStaleIndex.method, 'traversal', 'a pre-fix stored index must not be reused');
      assert.equal(withFreshIndex.method, 'reachability_index');
      assert.deepEqual(withStaleIndex.affected, withFreshIndex.affected, `direction=${direction} seed=${seeds[0]}`);
    }
  }
});

test('getAffectedSet: node absent from the call graph affects nothing (both paths)', () => {
  const withIndex = makeFixtureCas(true);
  const withoutIndex = makeFixtureCas(false);
  // A node id that exists nowhere.
  for (const cas of [withIndex, withoutIndex]) {
    const r = getAffectedSet(cas, ['fn:does-not-exist'], { direction: 'upstream' });
    assert.deepEqual(r.affected, []);
    assert.equal(r.truncated, false);
  }
});

test('assessChangeRisk: transitive_impact identical with and without the index', () => {
  const withIndex = makeFixtureCas(true);
  const withoutIndex = makeFixtureCas(false);
  const rand = rng(4242);
  for (let q = 0; q < 20; q++) {
    const nodeId = `fn:${Math.floor(rand() * 400)}`;
    const fast = assessChangeRisk(withIndex, nodeId) as { transitive_impact?: { affected_count: number; affected_sample: unknown[]; method: string } };
    const slow = assessChangeRisk(withoutIndex, nodeId) as { transitive_impact?: { affected_count: number; affected_sample: unknown[]; method: string } };
    assert.ok(fast.transitive_impact, 'transitive_impact present on index path');
    assert.ok(slow.transitive_impact, 'transitive_impact present on traversal path');
    assert.equal(fast.transitive_impact!.method, 'reachability_index');
    assert.equal(slow.transitive_impact!.method, 'traversal');
    assert.equal(fast.transitive_impact!.affected_count, slow.transitive_impact!.affected_count, nodeId);
    assert.deepEqual(fast.transitive_impact!.affected_sample, slow.transitive_impact!.affected_sample, nodeId);
  }
});

test('getAffectedSet: maxNodes bounds the result and flags truncation on both paths', () => {
  const withIndex = makeFixtureCas(true);
  const withoutIndex = makeFixtureCas(false);
  // fn:1 is in the guaranteed cycle — its upstream closure is large.
  for (const cas of [withIndex, withoutIndex]) {
    const full = getAffectedSet(cas, ['fn:1'], { direction: 'upstream' });
    if (full.affected.length > 5) {
      const capped = getAffectedSet(cas, ['fn:1'], { direction: 'upstream', maxNodes: 5 });
      assert.ok(capped.affected.length <= 5);
      assert.equal(capped.truncated, true);
    }
  }
});
