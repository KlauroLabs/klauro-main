import test from 'node:test';
import assert from 'node:assert/strict';
import { listAnalysesFiltered, DEFAULT_LIMIT, MAX_LIMIT } from './analysis-listing';
import type { AnalysisEntry } from './storage';

function entry(over: Partial<AnalysisEntry>): AnalysisEntry {
  return {
    name: over.name || 'repo',
    path: over.path || `/dev/${over.name || 'repo'}`,
    file: over.file || 'cas.json',
    analyzed_at: over.analyzed_at || '2026-01-01T00:00:00.000Z',
    system_type: over.system_type || 'service',
    frameworks: over.frameworks || [],
    node_count: over.node_count ?? 100,
    edge_count: over.edge_count ?? 50,
    cas_version: over.cas_version,
  };
}

function many(n: number): AnalysisEntry[] {
  return Array.from({ length: n }, (_, i) => entry({ name: `repo-${i}`, path: `/dev/repo-${i}`, node_count: i + 1, edge_count: i }));
}

test('defaults: caps page at DEFAULT_LIMIT and reports pagination', () => {
  const res = listAnalysesFiltered(many(120));
  assert.equal(res.total_indexed, 120);
  assert.equal(res.matched, 120);
  assert.equal(res.returned, DEFAULT_LIMIT);
  assert.equal(res.has_more, true);
  assert.equal(res.next_offset, DEFAULT_LIMIT);
});

test('default sort is nodes desc, total + stable', () => {
  const res = listAnalysesFiltered(many(10), { limit: 3 });
  const nodes = (res.analyses as any[]).map(a => a.node_count);
  assert.deepEqual(nodes, [10, 9, 8]);
});

test('limit is clamped to MAX_LIMIT and offset floored at 0', () => {
  const res = listAnalysesFiltered(many(10), { limit: 999999, offset: -5 });
  assert.equal(res.limit, Math.min(MAX_LIMIT, res.limit));
  assert.equal(res.limit, 10 <= MAX_LIMIT ? Math.min(MAX_LIMIT, 999999) : MAX_LIMIT);
  assert.equal(res.offset, 0);
});

test('name filter matches name and path, case-insensitive', () => {
  const data = [entry({ name: 'PostHog', path: '/dev/posthog' }), entry({ name: 'immich', path: '/srv/IMMICH' }), entry({ name: 'other', path: '/x' })];
  assert.equal(listAnalysesFiltered(data, { name: 'hog' }).matched, 1);
  assert.equal(listAnalysesFiltered(data, { name: 'immich' }).matched, 1);
  assert.equal(listAnalysesFiltered(data, { name: '/srv/' }).matched, 1);
});

test('framework + min_nodes filters compose', () => {
  const data = [
    entry({ name: 'a', frameworks: ['Django', 'FastAPI'], node_count: 5000 }),
    entry({ name: 'b', frameworks: ['Express.js'], node_count: 9000 }),
    entry({ name: 'c', frameworks: ['FastAPI'], node_count: 100 }),
  ];
  const res = listAnalysesFiltered(data, { framework: 'fastapi', min_nodes: 1000 });
  assert.equal(res.matched, 1);
  assert.equal((res.analyses[0] as any).name, 'a');
});

test('dedupe_by name keeps the largest per name', () => {
  const data = [
    entry({ name: 'soon', path: '/a', node_count: 100 }),
    entry({ name: 'soon', path: '/b', node_count: 900 }),
    entry({ name: 'soon', path: '/c', node_count: 300 }),
  ];
  const res = listAnalysesFiltered(data, { dedupe_by: 'name' });
  assert.equal(res.matched, 1);
  assert.equal((res.analyses[0] as any).node_count, 900);
});

test('compact projection drops file and caps frameworks; full keeps file', () => {
  const data = [entry({ name: 'a', frameworks: ['1', '2', '3', '4', '5', '6', '7', '8'] })];
  const compact = listAnalysesFiltered(data, {}).analyses[0] as any;
  assert.equal(compact.file, undefined);
  assert.equal(compact.frameworks.length, 6);
  const full = listAnalysesFiltered(data, { compact: false }).analyses[0] as any;
  assert.equal(full.file, 'cas.json');
});

test('empty match yields actionable hint, never throws', () => {
  const res = listAnalysesFiltered(many(5), { name: 'does-not-exist' });
  assert.equal(res.matched, 0);
  assert.equal(res.returned, 0);
  assert.ok(res.hint && /No analyses matched/.test(res.hint));
});

test('paging is exhaustive and non-overlapping', () => {
  const data = many(125);
  const seen = new Set<string>();
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const res = listAnalysesFiltered(data, { limit: 50, offset });
    for (const a of res.analyses as any[]) {
      assert.equal(seen.has(a.name), false, `duplicate ${a.name}`);
      seen.add(a.name);
    }
    if (!res.has_more) break;
    offset = res.next_offset!;
  }
  assert.equal(seen.size, 125);
});
