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

    it('writes scoped entries into a per-project subdirectory with the project recorded', async () => {
      setAICacheProjectScope(projectPath);
      const scope = getAICacheProjectScope()!;
      const cache = makeCache(diskDir);
      await cache.set('scoped-key', 'scoped-value');

      const scopedDir = path.join(diskDir, scope);
      const files = fs.readdirSync(scopedDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);
      const entry = JSON.parse(fs.readFileSync(path.join(scopedDir, files[0]), 'utf8'));
      expect(entry.project).toBe(scope);
      expect(fs.readdirSync(diskDir).filter(f => f.endsWith('.json')).length).toBe(0);
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
});
