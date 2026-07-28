// Use `require('fs-extra')` rather than `import * as fs from 'fs-extra'`:
// under some ESM/CJS interop configurations (observed with tsx's runtime
// loader) a namespace import is exposed as a read-only getter-based object,
// which throws when we reassign `.readFile` below. `require()` always
// returns the real, mutable CJS module.exports object — the SAME singleton
// object every analyzer's `import * as fs from 'fs-extra'` resolves to at
// runtime (Node's module cache + TypeScript's `__importStar` interop helper
// binds via a live getter back to that same object when the target's
// properties are writable/configurable, which fs-extra's are — verified:
// mutating this object is visible through every analyzer's own `fs.readFile`
// reference, in both compiled CommonJS output and ts-node/tsx dev runs).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsExtra: { readFile: (path: string, options?: unknown) => Promise<string | Buffer> } = require('fs-extra');
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Analyzer-file-read cache.
 *
 * Measured hotspot (2026-07-06 perf-profile pass): 120+ framework/library
 * analyzers run in parallel (orchestrator.ts `parallelAnalyzers.map`) and
 * every one independently `glob()`s the project directory AND re-reads every
 * matched source file from disk with its own `fs.readFile` call, even though
 * many analyzers scan the exact same file set the TypeScript/JavaScript
 * language analyzer already read moments earlier. On a benchmarked 757-file TS/JS
 * repo this cost 10-18s PER analyzer for ~20 analyzers running over the
 * same files, dwarfing the actual parse/regex work most of them do.
 *
 * Fix: cache file content by (absolute path + encoding) for the lifetime of
 * ONE analysis run, transparently, with zero changes to the 120 analyzer
 * call sites. Every analyzer does `import * as fs from 'fs-extra'; await
 * fs.readFile(path, encoding)` — patching fs-extra's own exported `readFile`
 * (a promise-returning function; fs-extra "universalifies" the callback API)
 * is the single, most direct interception point, one level above any
 * graceful-fs/node-core internals fs-extra happens to use underneath.
 *
 * Safety:
 *  - Read-only patch (only `readFile`, never writes/stat/glob), so it cannot
 *    change what gets written or which files are discovered.
 *  - Scoped to the exact window around the language + framework/library
 *    analyzer phases via `withAnalyzerFileReadCache()`; the original
 *    `readFile` is always restored afterward (try/finally), even on error.
 *  - Per-run cache instance, not a module-level singleton — no risk of
 *    serving stale content across separate `orchestrateAnalysis()` calls.
 *  - Async-context isolation keeps concurrent hosted runs from sharing file
 *    content or derived source-corpus indexes.
 *  - Preserves exact promise-resolution/rejection semantics: a cached hit
 *    resolves with the same content already-successfully read; a miss falls
 *    through to the real `fs.readFile` unchanged (errors propagate exactly
 *    as before, are not cached, and do not change behavior).
 */

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

/** Debug-only counters, gated on KLAURO_DEBUG_FILE_READ_CACHE=1 in orchestrator.ts. */
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
      const key = cacheKey(filePath, normalizeEncoding(options));
      const cached = run.cache.get(key);
      if (cached) {
        run.hits++;
        // Event-loop breather (TASK: read-path starvation during analysis):
        // a cache hit resolves as a pure microtask, so an analyzer's per-file
        // `await fs.readFile(...)` loop over already-cached files never leaves
        // the microtask queue — the whole scan becomes ONE synchronous block
        // (measured ~1.3s in the framework-analyzer phase) that starves every
        // pending HTTP request in the in-process server. A REAL readFile
        // always crosses a macrotask boundary, so inserting an occasional
        // setImmediate hop on hits is strictly closer to unpatched semantics:
        // same content, same ordering per caller, just not microtask-fused.
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
      // Cache the in-flight promise itself (not just the resolved value) so
      // concurrent callers racing for the same not-yet-read file also share
      // one real disk read instead of each issuing their own. On rejection,
      // evict so a transient read failure doesn't permanently poison the key
      // (matches "never changes behavior" — a failed read stays a failure,
      // just not a cached one).
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

/**
 * Runs `fn` with a fresh, run-scoped file-read cache installed so repeated
 * `fs.readFile` calls (via fs-extra, used by every framework/library
 * analyzer) against the same absolute path + encoding return the
 * previously-read content instead of re-reading from disk. Reentrant-safe
 * (nested calls share the outermost cache and only uninstall once the
 * outermost call returns) so it is safe to wrap at a single call site even
 * if something downstream also wraps a narrower scope.
 */
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
    uninstallPatch();
  }
}
