import * as crypto from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { parse, TSESTree } from '@typescript-eslint/typescript-estree';
























type ParseOptions = Parameters<typeof parse>[1] & Record<string, unknown>;

const MAX_ENTRIES = 4000;
const ESTIMATED_AST_BYTES_PER_SOURCE_BYTE = 64;
const HARD_MAX_STRONG_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_STRONG_CACHE_BYTES = Math.max(
  2 * 1024 * 1024,
  Math.min(HARD_MAX_STRONG_CACHE_BYTES, Math.floor(getHeapStatistics().heap_size_limit / 128)),
);
interface WeakReference<T extends object> {
  deref(): T | undefined;
}
const WeakReferenceConstructor = (globalThis as typeof globalThis & {
  WeakRef: new <T extends object>(value: T) => WeakReference<T>;
}).WeakRef;
const cache = new Map<string, WeakReference<TSESTree.Program>>();
const strongCache = new Map<string, { program: TSESTree.Program; estimatedBytes: number }>();
let strongCacheBytes = 0;
let hits = 0;
let misses = 0;

function retainRecent(key: string, program: TSESTree.Program, sourceBytes: number): void {
  const estimatedBytes = sourceBytes * ESTIMATED_AST_BYTES_PER_SOURCE_BYTE;
  const previous = strongCache.get(key);
  if (previous) strongCacheBytes -= previous.estimatedBytes;
  strongCache.delete(key);
  if (estimatedBytes > MAX_STRONG_CACHE_BYTES) return;

  strongCache.set(key, { program, estimatedBytes });
  strongCacheBytes += estimatedBytes;
  while (strongCacheBytes > MAX_STRONG_CACHE_BYTES) {
    const oldestKey = strongCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = strongCache.get(oldestKey)!;
    strongCache.delete(oldestKey);
    strongCacheBytes -= oldest.estimatedBytes;
  }
}

function optionsSignature(options: ParseOptions | undefined): string {
  if (!options) return 'default';

  const o = options as Record<string, unknown>;
  return [
    o.jsx ? 'jsx' : 'nojsx',
    o.loc === false ? 'noloc' : 'loc',
    o.range ? 'range' : 'norange',
    o.comment ? 'comment' : 'nocomment',
    o.tokens ? 'tokens' : 'notokens',
  ].join(':');
}

export function cachedEstreeParse(content: string, options?: ParseOptions): TSESTree.Program {
  const key = `${crypto.createHash('sha1').update(content).digest('hex')}|${optionsSignature(options)}`;
  const sourceBytes = Buffer.byteLength(content);
  const existing = strongCache.get(key)?.program || cache.get(key)?.deref();
  if (existing) {
    retainRecent(key, existing, sourceBytes);
    hits += 1;
    return existing;
  }
  cache.delete(key);
  misses += 1;
  const ast = parse(content, options);
  if (cache.size >= MAX_ENTRIES) {

    let toDrop = Math.floor(MAX_ENTRIES / 4);
    for (const k of cache.keys()) {
      cache.delete(k);
      const retained = strongCache.get(k);
      if (retained) {
        strongCache.delete(k);
        strongCacheBytes -= retained.estimatedBytes;
      }
      if (--toDrop <= 0) break;
    }
  }
  cache.set(key, new WeakReferenceConstructor(ast));
  retainRecent(key, ast, sourceBytes);
  return ast;
}

export function getEstreeParseCacheStats(): { hits: number; misses: number; size: number } {
  return { hits, misses, size: cache.size };
}

export function getEstreeParseCacheRetention(): { estimatedBytes: number; limitBytes: number } {
  return { estimatedBytes: strongCacheBytes, limitBytes: MAX_STRONG_CACHE_BYTES };
}

export function clearEstreeParseCache(): void {
  cache.clear();
  strongCache.clear();
  strongCacheBytes = 0;
  hits = 0;
  misses = 0;
}

export async function withEstreeParseCacheLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } finally {
    clearEstreeParseCache();
  }
}
