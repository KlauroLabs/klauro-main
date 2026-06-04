import { EmbeddingCache } from '../../analyzer/embedding/embedding-cache';

describe('EmbeddingCache', () => {
  it('returns the vector that was set', () => {
    const cache = new EmbeddingCache();
    const vector = Float32Array.from([1, 2, 3]);
    cache.set('query one', 'model-a', vector);
    expect(cache.get('query one', 'model-a')).toBe(vector);
  });

  it('returns undefined for an unknown query', () => {
    const cache = new EmbeddingCache();
    expect(cache.get('missing', 'model-a')).toBeUndefined();
  });

  it('keys cache entries on both query and model', () => {
    const cache = new EmbeddingCache();
    cache.set('shared', 'model-a', Float32Array.from([1]));
    expect(cache.get('shared', 'model-b')).toBeUndefined();
  });

  it('evicts the least-recently-used entry when capacity is exceeded', () => {
    const cache = new EmbeddingCache(2);
    cache.set('a', 'm', Float32Array.from([1]));
    cache.set('b', 'm', Float32Array.from([2]));
    cache.set('c', 'm', Float32Array.from([3]));

    expect(cache.get('a', 'm')).toBeUndefined();
    expect(cache.get('b', 'm')).toEqual(Float32Array.from([2]));
    expect(cache.get('c', 'm')).toEqual(Float32Array.from([3]));
  });

  it('a get refreshes recency so the entry survives eviction', () => {
    const cache = new EmbeddingCache(2);
    cache.set('a', 'm', Float32Array.from([1]));
    cache.set('b', 'm', Float32Array.from([2]));
    cache.get('a', 'm');
    cache.set('c', 'm', Float32Array.from([3]));

    expect(cache.get('a', 'm')).toEqual(Float32Array.from([1]));
    expect(cache.get('b', 'm')).toBeUndefined();
    expect(cache.get('c', 'm')).toEqual(Float32Array.from([3]));
  });

  it('updating an existing key does not count against capacity', () => {
    const cache = new EmbeddingCache(2);
    cache.set('a', 'm', Float32Array.from([1]));
    cache.set('b', 'm', Float32Array.from([2]));
    cache.set('a', 'm', Float32Array.from([99]));

    expect(cache.get('a', 'm')).toEqual(Float32Array.from([99]));
    expect(cache.get('b', 'm')).toEqual(Float32Array.from([2]));
  });
});
