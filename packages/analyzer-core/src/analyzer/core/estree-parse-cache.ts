import * as crypto from 'node:crypto';
import { parse, TSESTree } from '@typescript-eslint/typescript-estree';

/**
 * Shared, content-hash-keyed cache for @typescript-eslint/typescript-estree
 * parses.
 *
 * WHY: estree is the slowest parser in the stack, and the SAME source files
 * get re-parsed by multiple consumers in one analysis run — the language
 * phase's AST path plus each framework analyzer that walks ESTree (react,
 * angular, nestjs, express, vue). Measured on soon-lens (757 files) that
 * re-parsing was a large share of the 13s framework phase. Caching by
 * (content hash + parse-option signature) makes the parse happen at most once
 * per distinct file content, no matter how many analyzers consume it.
 *
 * Consumers import it aliased so call sites stay untouched:
 *   import { cachedEstreeParse as parse } from '../../core/estree-parse-cache';
 *
 * CONTRACT: the returned Program is SHARED — consumers must treat the AST as
 * read-only (every existing consumer only walks it; none mutate). Keying by
 * content hash means identical content parses identically, so cross-run reuse
 * is also correct; a size cap bounds memory.
 */

// Loose on purpose: some existing call sites pass extra fields (e.g.
// ecmaVersion) that estree tolerates at runtime; keep them compiling.
type ParseOptions = Parameters<typeof parse>[1] & Record<string, unknown>;

const MAX_ENTRIES = 4000;
const cache = new Map<string, TSESTree.Program>();
let hits = 0;
let misses = 0;

function optionsSignature(options: ParseOptions | undefined): string {
  if (!options) return 'default';
  // The fields that actually change parse OUTPUT shape across our consumers.
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
  const existing = cache.get(key);
  if (existing) {
    hits += 1;
    return existing;
  }
  misses += 1;
  const ast = parse(content, options);
  if (cache.size >= MAX_ENTRIES) {
    // Simple FIFO eviction: drop the oldest ~25% to amortize.
    let toDrop = Math.floor(MAX_ENTRIES / 4);
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--toDrop <= 0) break;
    }
  }
  cache.set(key, ast);
  return ast;
}

export function getEstreeParseCacheStats(): { hits: number; misses: number; size: number } {
  return { hits, misses, size: cache.size };
}

export function clearEstreeParseCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}
