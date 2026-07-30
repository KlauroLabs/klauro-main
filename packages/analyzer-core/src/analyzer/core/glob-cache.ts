/**
 * Run-scoped memoized glob.
 *
 * WHY: ~200-250 glob() calls happen per analysis run — ~100 library/framework
 * analyzers each glob the same file universe independently (in canAnalyze AND
 * analyze), e.g. `glob('**\/*.{ts,tsx,js,jsx}', { cwd, ignore: [~60 patterns] })`.
 * glob re-walks the filesystem and re-runs minimatch over every path on every
 * call; in a CPU profile of a ~1000-file TS repo, minimatch was the single
 * biggest non-idle cost (~1.9s). Within one run the working tree is static, so
 * a given (cwd, pattern, options) result is invariant and can be memoized once.
 *
 * TEST-SAFETY BY CONSTRUCTION: caching is active ONLY between beginGlobRun() and
 * endGlobRun(), which ONLY the orchestrator calls around a single analysis run.
 * Outside a run — every unit test that drives an analyzer directly — cachedGlob
 * falls straight through to the real (in tests: jest-mocked) glob with NO
 * caching, so per-test mock returns are always honored and no state leaks across
 * tests. This is why the cache is keyed to a per-run token, not a module-global
 * Map: an earlier module-global version leaked mocked results across tests.
 *
 * Within a run the cache is correct because the filesystem does not change
 * mid-run; each executeAnalysis gets a fresh token and clears on exit. Results
 * are returned as a COPY (slice) so a caller that sorts/mutates in place cannot
 * corrupt another caller's view. Only string-returning globs use this wrapper;
 * callers using `withFileTypes` (Path objects) stay on direct glob.
 *
 * NO-TOKEN DETERMINISM (byte-stability outside an orchestrator run): async
 * glob's raw emission order is an I/O race regardless of whether a run token
 * is active — see the ORDER IS SORTED note below. Every analyzer's own unit
 * test drives `analyzer.analyze()` directly, with no beginGlobRun/endGlobRun
 * around it, so before this fix the no-token path returned glob's raw order
 * unsorted. Under low I/O contention that race rarely flips, so isolated test
 * runs looked stable; under the contention of a full parallel multi-file
 * suite it flips often enough to make analyzer output (e.g.
 * DoctrineAnalyzer's node/edge/exit-point emission, which is ordered by
 * discovery) intermittently byte-unstable — a real defect, not a flaky test,
 * since output order feeds fingerprinting/caching. The no-token path now
 * sorts too, gated on `isRealGlobModule()` so jest-mocked glob returns (which
 * per-test mocks may intentionally hand back in a specific, non-sorted,
 * meaningful order — see src/__tests__/utils/test-helpers.ts) are left
 * exactly as returned; only the real filesystem walk is sorted.
 */
import { glob as realGlob, Glob, Ignore } from 'glob';

type GlobOptions = Record<string, unknown> & { cwd?: string };

/**
 * SHARED-IGNORE ENHANCEMENT (why cache misses are also fast):
 *
 * Result memoization only dedupes IDENTICAL (pattern, options) calls; a run
 * still pays ~150+ distinct full walks (one per unique pattern/ignore combo),
 * and each walk re-compiles the ~130-pattern ignore set into Minimatch
 * instances and re-runs all of them through minimatch for every visited path
 * — ~14s aggregate on a 76k-node repo. A run-scoped shared ignore removes
 * that cost while glob still performs every walk itself with its own
 * per-call PathScurry, so each caller's result SET and ORDER are exactly
 * what a direct glob() call returns — the byte-stable determinism boundary
 * that disqualified globIterate is never at risk.
 *
 * glob's `ignore` option accepts an IgnoreLike object. We build glob's OWN
 * Ignore class ONCE per (cwd, ignore-set) with the same resolved options
 * glob would pass it (nocase resolved the way glob resolves it, platform
 * default), and wrap it so ignored()/childrenIgnored() verdicts are memoized
 * per path string across walks. Verdicts are pure functions of the path —
 * Ignore only consults p.fullpath()/p.relative(), both fixed for a given
 * (cwd, on-disk path) — so the ~130-minimatch-per-path cost becomes a Map
 * lookup after first sight, across all walks in the run.
 *
 * NOTE — a shared PathScurry (glob's `scurry` option) was measured and
 * REJECTED: with warmed readdir caches the async walker takes sync
 * fast-paths and EMITS RESULTS IN A DIFFERENT ORDER than a cold walk
 * (verified on this repo: same set, different order). Each call keeps its
 * own cold scurry.
 *
 * ORDER IS SORTED WITHIN A RUN (doctrine alignment, measured necessity):
 * async glob's raw emission order is NOT deterministic — back-to-back
 * direct glob() calls with identical arguments return the same set in
 * different orders (measured on real repos, with both small and full
 * ~130-pattern ignore sets). The analysis pipeline only LOOKED stable
 * because the ~130-minimatch-per-path ignore cost kept the walker CPU-bound,
 * which serialized readdir callbacks; removing that cost (this enhancement)
 * exposes the underlying I/O race, and order-sensitive consumers (e.g.
 * React usage_locations) then drift run-to-run — a Camp-B byte-stability
 * violation of the same class as the documented references-edge defect.
 * docs/cas/DETERMINISM-BOUNDARY.md names the intended enforcement: "glob
 * results are sorted before emission". cachedGlob therefore sorts every
 * run-scoped result (hit and miss, enhanced or not) so the order analyzers
 * receive is a deterministic function of the file SET, not of I/O timing.
 * Outside a run (unit tests, mocked glob) results pass through untouched.
 *
 * The enhancement applies ONLY to option shapes the analyzers actually use
 * (cwd/ignore/nodir/absolute/dot, string-array ignore) — anything else falls
 * through to a plain glob call. It is also skipped when the glob module is
 * mocked (jest setup mocks 'glob' with only {glob}), and any error in the
 * enhanced path falls back to the plain call.
 */
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
  /** Shared memoized Ignore per (cwd, ignore-set) key. */
  ignores: Map<string, MemoizedIgnore>;
}

/** Option keys the shared-walk enhancement understands. Calls using any other
 *  key (follow, realpath, nocase, platform, fs, signal, ...) go to plain glob
 *  untouched so their semantics can never drift. */
const ENHANCEABLE_OPTION_KEYS = new Set(['cwd', 'ignore', 'nodir', 'absolute', 'dot']);

function normalizeIgnoreList(ignore: unknown): string[] | null {
  if (ignore === undefined) return [];
  if (typeof ignore === 'string') return [ignore];
  if (Array.isArray(ignore) && ignore.every(x => typeof x === 'string')) return ignore as string[];
  return null;
}

/** glob resolves the walker's nocase from its (platform-selected) PathScurry;
 *  with no nocase/platform/fs overrides that resolution is a per-process
 *  constant. Resolve it once, the exact way glob does. */
let resolvedDefaultNocase: boolean | null = null;
function defaultNocase(): boolean {
  if (resolvedDefaultNocase === null) {
    resolvedDefaultNocase = new Glob('.', {}).scurry.nocase;
  }
  return resolvedDefaultNocase;
}

/** True when this process has the real `glob` package (Glob/Ignore are
 *  classes), false when the jest environment has mocked 'glob' down to
 *  `{ glob: mockFn }` (see src/__tests__/setup.ts). Used to gate every
 *  behavior — shared-ignore enhancement AND no-token sorting — that must
 *  never apply to a mocked return. */
function isRealGlobModule(): boolean {
  return typeof Glob === 'function' && typeof Ignore === 'function';
}

/** Returns options augmented with the run's shared memoized ignore, or null
 *  when this call's options aren't safely enhanceable. */
function enhanceOptions(state: RunState, options: GlobOptions | undefined): GlobOptions | null {
  // Ops kill-switch: disable the shared ignore, keeping only result memoization.
  if (process.env.KLAURO_GLOB_SHARED_IGNORE === 'off') return null;
  // Guard against the jest environment where 'glob' is mocked with {glob} only.
  if (!isRealGlobModule()) return null;
  const opts = options ?? {};
  for (const key of Object.keys(opts)) {
    if (opts[key] === undefined) continue;
    if (!ENHANCEABLE_OPTION_KEYS.has(key)) return null;
  }
  if (opts.cwd !== undefined && typeof opts.cwd !== 'string') return null;
  const ignoreList = normalizeIgnoreList(opts.ignore);
  if (ignoreList === null || ignoreList.length === 0) return null;

  // Key by cwd too: Ignore verdicts depend on p.relative(), which is
  // relative to the call's cwd.
  const nocase = defaultNocase();
  const ignoreKey = `${opts.cwd ?? ''}|${nocase}|${JSON.stringify(ignoreList)}`;
  let memo = state.ignores.get(ignoreKey);
  if (!memo) {
    // glob passes the walker `nocase: this.nocase` (resolved from the scurry)
    // and the raw nobrace/noext/noglobstar (unset here — enforced by the key
    // whitelist above), so this Ignore is constructed with the identical
    // resolved options a direct glob() call would use.
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

/** Begin a run: subsequent cachedGlob calls memoize until endGlobRun. Returns a
 *  token the caller passes to endGlobRun. Nested/concurrent runs are supported —
 *  the most recently begun run is the active one. */
export function beginGlobRun(): symbol {
  const token = Symbol('glob-run');
  runCaches.set(token, { results: new Map(), ignores: new Map() });
  activeToken = token;
  return token;
}

export function endGlobRun(token: symbol): void {
  runCaches.delete(token);
  if (activeToken === token) {
    // Fall back to the most recent still-open run, if any, else off.
    const remaining = [...runCaches.keys()];
    activeToken = remaining.length ? remaining[remaining.length - 1] : null;
  }
}

/** Stable, collision-free key — or null when options aren't safely cacheable
 *  (a function/symbol/nested-object option, or withFileTypes which returns Path
 *  objects rather than strings). */
function keyFor(pattern: string | string[], options: GlobOptions | undefined): string | null {
  const pat = Array.isArray(pattern) ? pattern.join('\u0001') : pattern;
  if (!options) return `${pat}\u0000default`;
  if (options.withFileTypes) return null; // Path objects — not this wrapper's string contract
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
    // See NO-TOKEN DETERMINISM in the header: real-filesystem calls made
    // outside an orchestrator run (every analyzer's own unit test) are just
    // as subject to glob's async I/O-order race as run-scoped calls, so they
    // need the same sort. Jest-mocked returns are left untouched.
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
      // Any failure in the enhanced path (shared ignore) must never change
      // behavior: retry as a plain call. A genuine glob error (e.g. bad
      // pattern) rethrows identically here.
      result = (await realGlob(pattern as string, options as any)) as string[];
    }
  } else {
    result = (await realGlob(pattern as string, options as any)) as string[];
  }
  // Deterministic order within a run: raw async emission order is an I/O
  // race (see header). Sort so the order is a pure function of the set.
  result = [...result].sort();
  state.results.set(key, result);
  return result.slice();
}

// NOTE: only the ASYNC glob is memoized. Sync glob (globSync) stays on the real
// `glob` package — a few callers use `(glob.sync || globSync)` truthiness to
// detect sync-glob availability and fall back to an fs walk, and it is not on the
// hot path (the ~1.9s minimatch cost is the async `**/*.{ts,...}` analyzer globs).

export function getGlobCacheStats(): { hits: number; misses: number; active: boolean } {
  return { hits, misses, active: activeToken !== null };
}
