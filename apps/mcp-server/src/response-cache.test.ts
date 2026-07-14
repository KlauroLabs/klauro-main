import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseCache, responseCacheKey } from './response-cache';

test('responseCacheKey: distinct keys per endpoint, project, analysis, version, and params', () => {
  const base = { endpoint: 'conceptual', projectId: 'p1', analysisId: 'a1', version: 'v1' };
  const k = responseCacheKey(base);
  assert.notEqual(k, responseCacheKey({ ...base, endpoint: 'semantic-coverage' }));
  assert.notEqual(k, responseCacheKey({ ...base, projectId: 'p2' }));
  assert.notEqual(k, responseCacheKey({ ...base, analysisId: 'a2' }));
  assert.notEqual(k, responseCacheKey({ ...base, version: 'v2' }));
  // target/include keying: each (target, include) combination is its own entry.
  assert.notEqual(
    responseCacheKey({ ...base, params: { target: 'flows', include: undefined } }),
    responseCacheKey({ ...base, params: { target: undefined, include: undefined } }),
  );
  assert.notEqual(
    responseCacheKey({ ...base, params: { target: undefined, include: 'full' } }),
    responseCacheKey({ ...base, params: { target: undefined, include: undefined } }),
  );
  // Param order must not matter (deterministic key).
  assert.equal(
    responseCacheKey({ ...base, params: { target: 't', include: 'full' } }),
    responseCacheKey({ ...base, params: { include: 'full', target: 't' } }),
  );
});

test('ResponseCache: miss then hit returns the exact stored string', () => {
  const cache = new ResponseCache(8);
  const key = responseCacheKey({ endpoint: 'conceptual', projectId: 'p', analysisId: 'a', version: '1:1' });
  assert.equal(cache.get(key), undefined, 'first access is a miss');
  const body = JSON.stringify({ status: 'ready', flows: [{ id: 'f1' }] });
  cache.set(key, body);
  assert.equal(cache.get(key), body, 'hit returns the byte-identical serialized body');
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 1);
});

test('ResponseCache: a new analysis version misses (invalidation-by-key on reanalyze)', () => {
  const cache = new ResponseCache(8);
  const parts = { endpoint: 'conceptual', projectId: 'p', analysisId: 'a' };
  // analysis_id is STABLE across reanalyses in remote-analyzer-service; the
  // version fingerprint (analysis file mtime:size) is what changes when a
  // reanalyze saveAnalysis rewrites the stored CAS.
  const before = responseCacheKey({ ...parts, version: '1000:50' });
  const after = responseCacheKey({ ...parts, version: '2000:60' });
  cache.set(before, '{"status":"ready","rev":1}');
  assert.equal(cache.get(after), undefined, 'reanalyzed CAS must never be served the old body');
  assert.equal(cache.get(before), '{"status":"ready","rev":1}', 'old key still addressable until evicted');
});

test('ResponseCache: LRU bound evicts the least recently used entry', () => {
  const cache = new ResponseCache(3);
  cache.set('k1', 'v1');
  cache.set('k2', 'v2');
  cache.set('k3', 'v3');
  // Touch k1 so k2 becomes the least recently used.
  assert.equal(cache.get('k1'), 'v1');
  cache.set('k4', 'v4');
  assert.equal(cache.size, 3, 'bound holds');
  assert.equal(cache.get('k2'), undefined, 'least recently used entry evicted');
  assert.equal(cache.get('k1'), 'v1');
  assert.equal(cache.get('k3'), 'v3');
  assert.equal(cache.get('k4'), 'v4');
});

test('ResponseCache: re-set of an existing key updates value and recency without growing', () => {
  const cache = new ResponseCache(2);
  cache.set('a', '1');
  cache.set('b', '2');
  cache.set('a', '1-updated');
  assert.equal(cache.size, 2);
  cache.set('c', '3');
  assert.equal(cache.get('b'), undefined, 'b was least recent after a was re-set');
  assert.equal(cache.get('a'), '1-updated');
});

test('ResponseCache: rejects a non-positive bound', () => {
  assert.throws(() => new ResponseCache(0));
  assert.throws(() => new ResponseCache(-1));
  assert.throws(() => new ResponseCache(1.5));
});
