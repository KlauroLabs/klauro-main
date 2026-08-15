








































import { glob as realGlob, Glob, Ignore } from 'glob';

type GlobOptions = Record<string, unknown> & { cwd?: string };



















































class MemoizedIgnore {
  private readonly ignoredMemo = new Map<string, boolean>();
  private readonly childrenMemo = new Map<string, boolean>();
  constructor(private readonly inner: Ignore) {}
  ignored(p: Parameters<Ignore['ignored']>[0]): boolean {
    const key = p.fullpath();
    const hit = this.ignoredMemo.get(key);
    if (hit !== undefined) return hit;
    const verdict = this.inner.ignored(p);
    this.ignoredMemo.set(key, verdict);
    return verdict;
  }
  childrenIgnored(p: Parameters<Ignore['childrenIgnored']>[0]): boolean {
    const key = p.fullpath();
    const hit = this.childrenMemo.get(key);
    if (hit !== undefined) return hit;
    const verdict = this.inner.childrenIgnored(p);
    this.childrenMemo.set(key, verdict);
    return verdict;
  }
}

interface RunState {
  results: Map<string, string[]>;

  ignores: Map<string, MemoizedIgnore>;
}




const ENHANCEABLE_OPTION_KEYS = new Set(['cwd', 'ignore', 'nodir', 'absolute', 'dot']);

function normalizeIgnoreList(ignore: unknown): string[] | null {
  if (ignore === undefined) return [];
  if (typeof ignore === 'string') return [ignore];
  if (Array.isArray(ignore) && ignore.every(x => typeof x === 'string')) return ignore as string[];
  return null;
}




let resolvedDefaultNocase: boolean | null = null;
function defaultNocase(): boolean {
  if (resolvedDefaultNocase === null) {
    resolvedDefaultNocase = new Glob('.', {}).scurry.nocase;
  }
  return resolvedDefaultNocase;
}






function isRealGlobModule(): boolean {
  return typeof Glob === 'function' && typeof Ignore === 'function';
}



function enhanceOptions(state: RunState, options: GlobOptions | undefined): GlobOptions | null {

  if (process.env.KLAURO_GLOB_SHARED_IGNORE === 'off') return null;

  if (!isRealGlobModule()) return null;
  const opts = options ?? {};
  for (const key of Object.keys(opts)) {
    if (opts[key] === undefined) continue;
    if (!ENHANCEABLE_OPTION_KEYS.has(key)) return null;
  }
  if (opts.cwd !== undefined && typeof opts.cwd !== 'string') return null;
  const ignoreList = normalizeIgnoreList(opts.ignore);
  if (ignoreList === null || ignoreList.length === 0) return null;



  const nocase = defaultNocase();
  const ignoreKey = `${opts.cwd ?? ''}|${nocase}|${JSON.stringify(ignoreList)}`;
  let memo = state.ignores.get(ignoreKey);
  if (!memo) {




    memo = new MemoizedIgnore(
      new Ignore(ignoreList, { nocase, platform: process.platform } as ConstructorParameters<typeof Ignore>[1])
    );
    state.ignores.set(ignoreKey, memo);
  }
  return { ...opts, ignore: memo };
}

let activeToken: symbol | null = null;
const runCaches = new Map<symbol, RunState>();
let hits = 0;
let misses = 0;




export function beginGlobRun(): symbol {
  const token = Symbol('glob-run');
  runCaches.set(token, { results: new Map(), ignores: new Map() });
  activeToken = token;
  return token;
}

export function endGlobRun(token: symbol): void {
  runCaches.delete(token);
  if (activeToken === token) {

    const remaining = [...runCaches.keys()];
    activeToken = remaining.length ? remaining[remaining.length - 1] : null;
  }
}




function keyFor(pattern: string | string[], options: GlobOptions | undefined): string | null {
  const pat = Array.isArray(pattern) ? pattern.join('\u0001') : pattern;
  if (!options) return `${pat}\u0000default`;
  if (options.withFileTypes) return null;
  const parts: string[] = [];
  for (const k of Object.keys(options).sort()) {
    const v = (options as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (typeof v === 'function' || typeof v === 'symbol') return null;
    if (Array.isArray(v)) {
      if (v.some(x => typeof x === 'function' || typeof x === 'symbol' || (x && typeof x === 'object'))) return null;
      parts.push(`${k}=[${v.join('\u0001')}]`);
    } else if (v && typeof v === 'object') {
      return null;
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return `${pat}\u0000${parts.join('\u0002')}`;
}

export async function cachedGlob(pattern: string | string[], options?: GlobOptions): Promise<string[]> {
  const token = activeToken;
  if (token === null) {
    const result = (await realGlob(pattern as string, options as any)) as string[];




    return isRealGlobModule() ? [...result].sort() : result;
  }
  const key = keyFor(pattern, options);
  if (key === null) {
    const result = (await realGlob(pattern as string, options as any)) as string[];
    return isRealGlobModule() ? [...result].sort() : result;
  }
  const state = runCaches.get(token)!;
  const existing = state.results.get(key);
  if (existing) { hits += 1; return existing.slice(); }
  misses += 1;
  let result: string[];
  const enhanced = enhanceOptions(state, options);
  if (enhanced) {
    try {
      result = (await realGlob(pattern as string, enhanced as any)) as string[];
    } catch {



      result = (await realGlob(pattern as string, options as any)) as string[];
    }
  } else {
    result = (await realGlob(pattern as string, options as any)) as string[];
  }


  result = [...result].sort();
  state.results.set(key, result);
  return result.slice();
}






export function getGlobCacheStats(): { hits: number; misses: number; active: boolean } {
  return { hits, misses, active: activeToken !== null };
}
