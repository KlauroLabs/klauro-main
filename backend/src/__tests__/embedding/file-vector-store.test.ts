jest.unmock('fs-extra');
jest.unmock('fs');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { FileVectorStore } from '../../analyzer/embedding/file-vector-store';
import type { NodeEmbeddingRecord, VectorStoreMeta } from '../../analyzer/embedding/types';

const ANALYSIS_ID = 'analysis-test';

function record(
  nodeId: string,
  vector: number[],
  docHash = `${nodeId}-hash`,
): NodeEmbeddingRecord {
  return {
    nodeId,
    analysisId: ANALYSIS_ID,
    vector: Float32Array.from(vector),
    embeddingDocHash: docHash,
    model: 'test-model',
    documentVersion: '1.0',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('FileVectorStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unravl-fvs-'));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  it('upsert then query returns nodes ranked by cosine similarity', async () => {
    const store = new FileVectorStore(dir);
    await store.upsert(ANALYSIS_ID, [
      record('a', [1, 0, 0]),
      record('b', [0, 1, 0]),
      record('c', [0.9, 0.1, 0]),
    ]);

    const results = await store.query(ANALYSIS_ID, Float32Array.from([1, 0, 0]), 3);
    expect(results.map(r => r.nodeId)).toEqual(['a', 'c', 'b']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it('round-trips a quantized vector within a small epsilon', async () => {
    const store = new FileVectorStore(dir);
    const original = [0.5, -0.25, 1.0, -1.0, 0.123, 0.876];
    await store.upsert(ANALYSIS_ID, [record('q', original)]);

    const results = await store.query(ANALYSIS_ID, Float32Array.from(original), 1);
    expect(results[0].nodeId).toBe('q');
    expect(results[0].score).toBeCloseTo(1, 4);
  });

  it('listHashes returns the nodeId to docHash map', async () => {
    const store = new FileVectorStore(dir);
    await store.upsert(ANALYSIS_ID, [
      record('a', [1, 0, 0], 'hash-a'),
      record('b', [0, 1, 0], 'hash-b'),
    ]);
    const hashes = await store.listHashes(ANALYSIS_ID);
    expect(hashes.get('a')).toBe('hash-a');
    expect(hashes.get('b')).toBe('hash-b');
    expect(hashes.size).toBe(2);
  });

  it('upsert updates the docHash and vector of an existing node', async () => {
    const store = new FileVectorStore(dir);
    await store.upsert(ANALYSIS_ID, [record('a', [1, 0, 0], 'hash-old')]);
    await store.upsert(ANALYSIS_ID, [record('a', [0, 1, 0], 'hash-new')]);

    const hashes = await store.listHashes(ANALYSIS_ID);
    expect(hashes.get('a')).toBe('hash-new');
    expect(hashes.size).toBe(1);

    const results = await store.query(ANALYSIS_ID, Float32Array.from([0, 1, 0]), 1);
    expect(results[0].score).toBeCloseTo(1, 4);
  });

  it('deleteNodes removes vectors', async () => {
    const store = new FileVectorStore(dir);
    await store.upsert(ANALYSIS_ID, [
      record('a', [1, 0, 0]),
      record('b', [0, 1, 0]),
      record('c', [0, 0, 1]),
    ]);
    await store.deleteNodes(ANALYSIS_ID, ['b']);

    const hashes = await store.listHashes(ANALYSIS_ID);
    expect([...hashes.keys()].sort()).toEqual(['a', 'c']);

    const results = await store.query(ANALYSIS_ID, Float32Array.from([0, 1, 0]), 5);
    expect(results.map(r => r.nodeId)).not.toContain('b');
  });

  it('preserves remaining vectors correctly after a delete', async () => {
    const store = new FileVectorStore(dir);
    await store.upsert(ANALYSIS_ID, [
      record('a', [1, 0, 0]),
      record('b', [0, 1, 0]),
      record('c', [0, 0, 1]),
    ]);
    await store.deleteNodes(ANALYSIS_ID, ['a']);

    const resB = await store.query(ANALYSIS_ID, Float32Array.from([0, 1, 0]), 1);
    expect(resB[0].nodeId).toBe('b');
    expect(resB[0].score).toBeCloseTo(1, 4);
    const resC = await store.query(ANALYSIS_ID, Float32Array.from([0, 0, 1]), 1);
    expect(resC[0].nodeId).toBe('c');
    expect(resC[0].score).toBeCloseTo(1, 4);
  });

  it('round-trips getMeta and putMeta', async () => {
    const store = new FileVectorStore(dir);
    await store.upsert(ANALYSIS_ID, [record('a', [1, 0, 0])]);
    expect(await store.getMeta(ANALYSIS_ID)).toBeNull();

    const meta: VectorStoreMeta = {
      casVersion: '1.10.0',
      analysisId: ANALYSIS_ID,
      casContentHash: 'content-hash',
      model: 'test-model',
      dimensions: 3,
      documentVersion: '1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await store.putMeta(ANALYSIS_ID, meta);
    expect(await store.getMeta(ANALYSIS_ID)).toEqual(meta);
  });

  it('reloads persisted data from disk in a new instance', async () => {
    const writer = new FileVectorStore(dir);
    await writer.upsert(ANALYSIS_ID, [
      record('a', [1, 0, 0], 'hash-a'),
      record('b', [0, 1, 0], 'hash-b'),
    ]);

    const reader = new FileVectorStore(dir);
    const hashes = await reader.listHashes(ANALYSIS_ID);
    expect(hashes.get('a')).toBe('hash-a');
    expect(hashes.get('b')).toBe('hash-b');

    const results = await reader.query(ANALYSIS_ID, Float32Array.from([1, 0, 0]), 2);
    expect(results[0].nodeId).toBe('a');
    expect(results[0].score).toBeCloseTo(1, 4);

    const stats = await reader.stats(ANALYSIS_ID);
    expect(stats.count).toBe(2);
    expect(stats.dimensions).toBe(3);
    expect(stats.model).toBe('test-model');
  });
});
