











const fsExtra: { readFile: (path: string, options?: unknown) => Promise<string | Buffer> } = require('fs-extra');
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';





































import { yieldToEventLoop, ANALYSIS_YIELD_BUDGET_MS } from './event-loop-yield';
import { AnalyzerSourceCorpus, captureSourceCorpusFile, withSourceCorpus, type SourceCorpusStats } from './source-corpus';

interface ReadCacheRun {
  cache: Map<string, Promise<string | Buffer>>;
  corpus: AnalyzerSourceCorpus;
  hits: number;
  misses: number;
  lastHitYieldAt: number;
}

const readCacheStorage = new AsyncLocalStorage<ReadCacheRun>();
const analyzerReadScopeStorage = new AsyncLocalStorage<Set<string>>();
let patchDepth = 0;
let originalReadFile: typeof fsExtra.readFile | null = null;
let lastDebugStats = { hits: 0, misses: 0 };
let lastSourceCorpusStats: SourceCorpusStats = {
  files: 0,
  derivedEntries: 0,
  entryHits: 0,
  importIndexes: 0,
  lineIndexes: 0,
  lineArrays: 0,
  jsonParses: 0,
  lineLookups: 0,
  linePrefixCharactersAvoided: 0,
};


export function getDebugCacheStats(): { hits: number; misses: number } {
  const run = readCacheStorage.getStore();
  return run ? { hits: run.hits, misses: run.misses } : lastDebugStats;
}

export function getSourceCorpusStats(): SourceCorpusStats {
  return readCacheStorage.getStore()?.corpus.stats() ?? lastSourceCorpusStats;
}

function normalizeEncoding(options: unknown): string {
  if (typeof options === 'string') return options;
  if (options && typeof options === 'object' && 'encoding' in (options as Record<string, unknown>)) {
    const enc = (options as Record<string, unknown>).encoding;
    return typeof enc === 'string' ? enc : 'buffer';
  }
  return 'buffer';
}

function cacheKey(filePath: string, encoding: string): string {
  return `${encoding}\u0000${filePath}`;
}

function installPatch(): void {
  if (patchDepth === 0) {
    originalReadFile = fsExtra.readFile;
    const original = originalReadFile;
    fsExtra.readFile = function patchedReadFile(filePath: string, options?: unknown) {
      const run = readCacheStorage.getStore();
      if (typeof filePath !== 'string' || !run) {
        return original.call(fsExtra, filePath, options);
      }
      analyzerReadScopeStorage.getStore()?.add(path.resolve(filePath));
      const key = cacheKey(filePath, normalizeEncoding(options));
      const cached = run.cache.get(key);
      if (cached) {
        run.hits++;









        if (Date.now() - run.lastHitYieldAt >= ANALYSIS_YIELD_BUDGET_MS) {
          run.lastHitYieldAt = Date.now();
          return cached.then(async value => {
            await yieldToEventLoop();
            return value;
          });
        }
        return cached;
      }
      run.misses++;
      const promise = original.call(fsExtra, filePath, options).then(value => {
        if (typeof value === 'string') captureSourceCorpusFile(filePath, value);
        return value;
      });
      const cache = run.cache;






      promise.catch(() => {
        if (cache.get(key) === promise) cache.delete(key);
      });
      cache.set(key, promise);
      return promise;
    };
  }
  patchDepth++;
}

function uninstallPatch(): void {
  patchDepth--;
  if (patchDepth <= 0 && originalReadFile) {
    fsExtra.readFile = originalReadFile;
    originalReadFile = null;
    patchDepth = 0;
  }
}










export async function withAnalyzerFileReadTracking<T>(fn: () => Promise<T>): Promise<{ result: T; files: string[] }> {
  const files = new Set<string>();
  const result = await analyzerReadScopeStorage.run(files, fn);
  return { result, files: [...files].sort() };
}

export async function withAnalyzerFileReadCache<T>(fn: () => Promise<T>): Promise<T> {
  if (readCacheStorage.getStore()) return fn();
  const run: ReadCacheRun = {
    cache: new Map(),
    corpus: new AnalyzerSourceCorpus(),
    hits: 0,
    misses: 0,
    lastHitYieldAt: 0,
  };
  installPatch();
  try {
    return await readCacheStorage.run(run, () => withSourceCorpus(run.corpus, fn));
  } finally {
    lastDebugStats = { hits: run.hits, misses: run.misses };
    lastSourceCorpusStats = run.corpus.stats();
    run.cache.clear();
    run.corpus.clear();
    uninstallPatch();
  }
}
