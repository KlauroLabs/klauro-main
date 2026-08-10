import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AICache, aiCacheProjectScope, getAICacheProjectScope, setAICacheProjectScope } from '../../ai/ai-cache';

/**
 * Builds an AICache whose disk tier is redirected to an isolated temp
 * directory so tests never touch the real ~/.klauro/ai-cache.
 */
function makeCache(diskDir: string): AICache {
  const cache = new AICache();
  const anyCache = cache as any;
  anyCache.diskCacheDir = diskDir;
  anyCache.diskCacheEnabled = true;
  fs.mkdirSync(diskDir, { recursive: true });
  return cache;
}

describe('AICache', () => {
  let diskDir: string;

  beforeEach(() => {
    diskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cache-test-'));
  });

  afterEach(async () => {
    try {
      fs.rmSync(diskDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns a stored value within the same instance', async () => {
    const cache = makeCache(diskDir);
    await cache.set('k1', 'hello');
    expect(await cache.get('k1')).toBe('hello');
    await cache.close();
  });

  it('uses the hosted persistent cache path from KLAURO_AI_CACHE_PATH', async () => {
    const previous = process.env.KLAURO_AI_CACHE_PATH;
    process.env.KLAURO_AI_CACHE_PATH = diskDir;
    try {
      const cache = new AICache();
      await cache.set('hosted-key', 'persisted');
      expect((cache as any).diskCacheDir).toBe(diskDir);
      expect(fs.readdirSync(diskDir).some(file => file.endsWith('.json'))).toBe(true);
      await cache.close();
    } finally {
      if (previous === undefined) delete process.env.KLAURO_AI_CACHE_PATH;
      else process.env.KLAURO_AI_CACHE_PATH = previous;
    }
  });

  it('returns null for an unknown key', async () => {
    const cache = makeCache(diskDir);
    expect(await cache.get('does-not-exist')).toBeNull();
    await cache.close();
  });

  it('persists values to disk across separate instances', async () => {
    const writer = makeCache(diskDir);
    await writer.set('shared-key', { description: 'a persisted description' });
    await writer.close();

    // A brand new instance (fresh in-memory cache) must still find it.
    const reader = makeCache(diskDir);
    const value = await reader.get<{ description: string }>('shared-key');
    expect(value).toEqual({ description: 'a persisted description' });
    await reader.close();
  });

  it('writes one disk file per cached key', async () => {
    const cache = makeCache(diskDir);
    await cache.set('alpha', 1);
    await cache.set('beta', 2);
    const files = fs.readdirSync(diskDir).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(2);
    await cache.close();
  });

  describe('project scope association', () => {
    const projectPath = '/tmp/klauro-test-projects/alpha';

    afterEach(() => {
      setAICacheProjectScope(undefined);
    });

    it('derives a stable slug from the project path', () => {
      const scope = aiCacheProjectScope(projectPath);
      expect(scope).toMatch(/^alpha-[0-9a-f]{12}$/);
      expect(aiCacheProjectScope(projectPath)).toBe(scope);
      expect(aiCacheProjectScope('/tmp/klauro-test-projects/beta')).not.toBe(scope);
    });

    it('writes a scoped per-project copy AND a global content-addressed copy', async () => {
      setAICacheProjectScope(projectPath);
      const scope = getAICacheProjectScope()!;
      const cache = makeCache(diskDir);
      await cache.set('scoped-key', 'scoped-value');

      // The scoped copy lives in the per-project subdir with the project recorded
      // (kept for per-project deletion granularity).
      const scopedDir = path.join(diskDir, scope);
      const scopedFiles = fs.readdirSync(scopedDir).filter(f => f.endsWith('.json'));
      expect(scopedFiles.length).toBe(1);
      const entry = JSON.parse(fs.readFileSync(path.join(scopedDir, scopedFiles[0]), 'utf8'));
      expect(entry.project).toBe(scope);

      // A global, content-addressed copy is ALSO written at the root, so an
      // identical AI request in any other project/path reuses it (huge perf win:
      // repeated fixtures + cold re-analysis become cache hits). Same content key,
      // same valid answer — cross-project isolation is preserved because the key
      // is content-only (see cross-project-description-isolation.test.ts).
      const rootFiles = fs.readdirSync(diskDir).filter(f => f.endsWith('.json'));
      expect(rootFiles.length).toBe(1);
      await cache.close();
    });

    it('reads scoped entries back across instances and falls back to legacy root entries', async () => {
      // Legacy entry written with no scope.
      const legacyWriter = makeCache(diskDir);
      await legacyWriter.set('legacy-key', 'legacy-value');
      await legacyWriter.close();

      setAICacheProjectScope(projectPath);
      const scopedWriter = makeCache(diskDir);
      await scopedWriter.set('scoped-key', 'scoped-value');
      await scopedWriter.close();

      const reader = makeCache(diskDir);
      expect(await reader.get('scoped-key')).toBe('scoped-value');
      expect(await reader.get('legacy-key')).toBe('legacy-value');
      await reader.close();
    });

    it('returns to unscoped root writes after the scope is cleared', async () => {
      setAICacheProjectScope(projectPath);
      setAICacheProjectScope(undefined);
      const cache = makeCache(diskDir);
      await cache.set('global-key', 'global-value');
      expect(fs.readdirSync(diskDir).filter(f => f.endsWith('.json')).length).toBe(1);
      await cache.close();
    });
  });

  it('treats an expired disk entry as a miss', async () => {
    const cache = makeCache(diskDir);
    await cache.set('soon', 'value', 1); // 1 second TTL
    // Hand-expire the entry by rewriting its timestamp far into the past.
    const file = fs.readdirSync(diskDir).find(f => f.endsWith('.json'))!;
    const full = path.join(diskDir, file);
    const entry = JSON.parse(fs.readFileSync(full, 'utf8'));
    entry.timestamp = Date.now() - 10_000;
    entry.ttl = 1;
    fs.writeFileSync(full, JSON.stringify(entry));

    const fresh = makeCache(diskDir);
    expect(await fresh.get('soon')).toBeNull();
    await fresh.close();
    await cache.close();
  });

  // task #132: `klauro analyze --force` must bypass the AI response cache,
  // not just the server's snapshot-reuse gate — otherwise a "forced" re-run
  // still silently serves stale AI-generated descriptions/capability names.
  // KLAURO_FORCE_AI_REFRESH is how the per-job analysis worker communicates
  // that to this process-wide singleton cache (see ai-cache.ts's
  // isBypassActive doc and apps/mcp-server/src/analysis-worker.ts's
  // applyEnvSnapshot, which sets/clears it per job).
  describe('KLAURO_FORCE_AI_REFRESH bypass', () => {
    const ENV_KEY = 'KLAURO_FORCE_AI_REFRESH';
    let previousEnv: string | undefined;

    beforeEach(() => {
      previousEnv = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (previousEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previousEnv;
    });

    it('serves a normal cache hit when the bypass flag is unset', async () => {
      delete process.env[ENV_KEY];
      const cache = makeCache(diskDir);
      await cache.set('force-flag-key', 'cached-value');
      expect(await cache.get('force-flag-key')).toBe('cached-value');
      await cache.close();
    });

    it('forces a miss for an existing entry when KLAURO_FORCE_AI_REFRESH=1, without deleting it', async () => {
      const cache = makeCache(diskDir);
      await cache.set('force-flag-key', 'cached-value');

      process.env[ENV_KEY] = '1';
      expect(await cache.get('force-flag-key')).toBeNull();

      // The bypass is a per-read override, not a cache invalidation — once
      // the flag clears (the next job that isn't --force), the entry is
      // still there for a normal cache hit.
      delete process.env[ENV_KEY];
      expect(await cache.get('force-flag-key')).toBe('cached-value');
      await cache.close();
    });

    it('a bypassed read followed by set() overwrites the stale entry with the fresh value', async () => {
      const cache = makeCache(diskDir);
      await cache.set('force-flag-key', 'stale-value');

      process.env[ENV_KEY] = '1';
      expect(await cache.get('force-flag-key')).toBeNull();
      await cache.set('force-flag-key', 'fresh-value');

      delete process.env[ENV_KEY];
      expect(await cache.get('force-flag-key')).toBe('fresh-value');
      await cache.close();
    });
  });
});
