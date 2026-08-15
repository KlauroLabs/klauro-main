import * as crypto from 'node:crypto';
import { parse, TSESTree } from '@typescript-eslint/typescript-estree';
























type ParseOptions = Parameters<typeof parse>[1] & Record<string, unknown>;

const MAX_ENTRIES = 4000;
const cache = new Map<string, TSESTree.Program>();
let hits = 0;
let misses = 0;

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
  const existing = cache.get(key);
  if (existing) {
    hits += 1;
    return existing;
  }
  misses += 1;
  const ast = parse(content, options);
  if (cache.size >= MAX_ENTRIES) {

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
