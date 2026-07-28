import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDebugCacheStats, getSourceCorpusStats, withAnalyzerFileReadCache } from './analyzer-file-read-cache';

test('one outer cache shares reads across nested detection and execution scopes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'analyzer-read-cache-'));
  const file = path.join(root, 'source.ts');
  await fs.writeFile(file, 'export const value = 1;\n');

  try {
    await withAnalyzerFileReadCache(async () => {
      await withAnalyzerFileReadCache(async () => {
        assert.equal(await fs.readFile(file, 'utf8'), 'export const value = 1;\n');
      });
      await withAnalyzerFileReadCache(async () => {
        assert.equal(await fs.readFile(file, 'utf8'), 'export const value = 1;\n');
      });
    });

    assert.deepEqual(getDebugCacheStats(), { hits: 1, misses: 1 });
    assert.deepEqual(getSourceCorpusStats(), {
      files: 1,
      derivedEntries: 1,
      entryHits: 0,
      importIndexes: 0,
      lineIndexes: 0,
      lineArrays: 0,
      jsonParses: 0,
      lineLookups: 0,
      linePrefixCharactersAvoided: 0,
    });

    await withAnalyzerFileReadCache(async () => {
      assert.equal(await fs.readFile(file, 'utf8'), 'export const value = 1;\n');
    });
    assert.deepEqual(getDebugCacheStats(), { hits: 0, misses: 1 });
  } finally {
    await fs.remove(root);
  }
});

test('concurrent hosted runs keep independent read caches and corpora', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'analyzer-read-cache-concurrent-'));
  const left = path.join(root, 'left.ts');
  const right = path.join(root, 'right.ts');
  await fs.writeFile(left, 'export const left = 1;\n');
  await fs.writeFile(right, 'export const right = 2;\n');

  try {
    const results = await Promise.all([left, right].map(file => withAnalyzerFileReadCache(async () => {
      await fs.readFile(file, 'utf8');
      await new Promise(resolve => setImmediate(resolve));
      await fs.readFile(file, 'utf8');
      return {
        cache: getDebugCacheStats(),
        corpus: getSourceCorpusStats(),
      };
    })));

    for (const result of results) {
      assert.deepEqual(result.cache, { hits: 1, misses: 1 });
      assert.equal(result.corpus.files, 1);
      assert.equal(result.corpus.derivedEntries, 1);
    }
  } finally {
    await fs.remove(root);
  }
});
