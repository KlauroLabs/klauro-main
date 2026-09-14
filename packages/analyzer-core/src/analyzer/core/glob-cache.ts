








































import { glob as realGlob, globSync as realGlobSync, Glob, Ignore } from 'glob';

type GlobOptions = Record<string, unknown> & { cwd?: string };



















































const DIRECTORY_SUBTREE_ANYWHERE = /^\*\*\/([^/]+)\/\*\*$/;
const DIRECTORY_SUBTREE_ROOTED = /^([^/]+)\/\*\*$/;
const GLOB_METACHARACTERS = /[*?[\]{}!+@()|]/;
const REGEXP_LITERALS = /[.+^${}()|\\]/g;

function nameGlobToRegexSource(name: string): string | null {
  let source = '';
  for (let index = 0; index < name.length; index += 1) {
    const character = name[index];
    if (character === '*') { source += '[^/]*'; continue; }
    if (character === '?') { source += '[^/]'; continue; }
    if (character === '[') {
      const close = name.indexOf(']', index + 1);
      if (close === -1) return null;
      source += name.slice(index, close + 1);
      index = close;
      continue;
    }
    if (/[{}!+@()|]/.test(character)) return null;
    source += character.replace(REGEXP_LITERALS, '\\$&');
  }
  return source;
}

interface CompiledSubtreeIgnore {
  names: Set<string>;
  namePattern: RegExp | null;
  residue: string[];
}

function compileSubtreeIgnores(list: readonly string[], nocase: boolean): CompiledSubtreeIgnore {
  const anywhere = new Set<string>();
  for (const entry of list) {
    const match = DIRECTORY_SUBTREE_ANYWHERE.exec(entry);
    if (match) anywhere.add(match[1]);
  }
  const names = new Set<string>();
  const sources: string[] = [];
  const residue: string[] = [];
  for (const entry of list) {
    const anywhereMatch = DIRECTORY_SUBTREE_ANYWHERE.exec(entry);
    if (anywhereMatch) {
      const name = anywhereMatch[1];
      if (!GLOB_METACHARACTERS.test(name)) {
        names.add(nocase ? name.toLowerCase() : name);
        continue;
      }
      const source = nameGlobToRegexSource(name);
      if (source !== null) { sources.push(source); continue; }
      residue.push(entry);
      continue;
    }
    const rootedMatch = DIRECTORY_SUBTREE_ROOTED.exec(entry);
    if (rootedMatch && anywhere.has(rootedMatch[1])) continue;
    residue.push(entry);
  }
  const namePattern = sources.length
    ? new RegExp(`^(?:${sources.join('|')})$`, nocase ? 'i' : '')
    : null;
  return { names, namePattern, residue };
}

class MemoizedIgnore {
  private readonly ignoredMemo = new Map<string, boolean>();
  private readonly childrenMemo = new Map<string, boolean>();
  constructor(
    private readonly inner: Ignore | null,
    private readonly compiled: CompiledSubtreeIgnore,
    private readonly nocase: boolean
  ) {}

  private segmentsOf(p: { relativePosix?: () => string; relative?: () => string }): string[] {
    const raw = typeof p.relativePosix === 'function'
      ? p.relativePosix()
      : (typeof p.relative === 'function' ? p.relative().replace(/\\/g, '/') : '');
    return raw.length === 0 ? [] : raw.split('/');
  }

  private segmentIgnored(segment: string): boolean {
    if (this.compiled.names.has(this.nocase ? segment.toLowerCase() : segment)) return true;
    return this.compiled.namePattern !== null && this.compiled.namePattern.test(segment);
  }

  private anyAncestorIgnored(segments: readonly string[], includeLast: boolean): boolean {
    const limit = includeLast ? segments.length : segments.length - 1;
    for (let index = 0; index < limit; index += 1) {
      if (this.segmentIgnored(segments[index])) return true;
    }
    return false;
  }

  ignored(p: Parameters<Ignore['ignored']>[0]): boolean {
    const key = p.fullpath();
    const hit = this.ignoredMemo.get(key);
    if (hit !== undefined) return hit;
    const verdict = this.anyAncestorIgnored(this.segmentsOf(p), true)
      || (this.inner !== null && this.inner.ignored(p));
    this.ignoredMemo.set(key, verdict);
    return verdict;
  }

  childrenIgnored(p: Parameters<Ignore['childrenIgnored']>[0]): boolean {
    const key = p.fullpath();
    const hit = this.childrenMemo.get(key);
    if (hit !== undefined) return hit;
    const verdict = this.anyAncestorIgnored(this.segmentsOf(p), true)
      || (this.inner !== null && this.inner.childrenIgnored(p));
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




    const compiled = process.env.KLAURO_GLOB_FAST_IGNORE === 'off'
      ? { names: new Set<string>(), namePattern: null, residue: [...ignoreList] }
      : compileSubtreeIgnores(ignoreList, nocase);
    const inner = compiled.residue.length > 0
      ? new Ignore(compiled.residue, { nocase, platform: process.platform } as ConstructorParameters<typeof Ignore>[1])
      : null;
    memo = new MemoizedIgnore(inner, compiled, nocase);
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






export function cachedGlobSync(pattern: string | string[], options?: GlobOptions): string[] {
  const token = activeToken;
  if (token === null || typeof realGlobSync !== 'function') {
    return realGlobSync(pattern as string, options as never) as string[];
  }
  const key = keyFor(pattern, options);
  if (key === null) return realGlobSync(pattern as string, options as never) as string[];
  const state = runCaches.get(token)!;
  const existing = state.results.get(`sync\u0003${key}`);
  if (existing) { hits += 1; return existing.slice(); }
  misses += 1;
  const enhanced = enhanceOptions(state, options);
  let result: string[];
  try {
    result = realGlobSync(pattern as string, (enhanced ?? options) as never) as string[];
  } catch {
    result = realGlobSync(pattern as string, options as never) as string[];
  }
  state.results.set(`sync\u0003${key}`, result);
  return result.slice();
}

export function safeGlobSync(pattern: string | string[], options?: GlobOptions): string[] {
  try {
    return cachedGlobSync(pattern, options);
  } catch {
    return [];
  }
}

export function getGlobCacheStats(): { hits: number; misses: number; active: boolean } {
  return { hits, misses, active: activeToken !== null };
}
