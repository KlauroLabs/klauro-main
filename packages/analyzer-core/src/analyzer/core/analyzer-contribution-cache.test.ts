import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CASContribution } from '../../types/cas.types';
import {
  PersistentAnalyzerContributionCache,
  stableAnalyzerCacheIdentity,
  type AnalyzerContributionCacheInput,
} from './analyzer-contribution-cache';

function input(overrides: Partial<AnalyzerContributionCacheInput> = {}): AnalyzerContributionCacheInput {
  return {
    sourceIdentity: 'src/orders.ts',
    sourceContentHash: 'sha256:source-v1',
    analyzer: {
      id: 'framework-nestjs',
      version: '3.2.1',
      type: 'framework',
      implementationFingerprint: 'parser-stage-v7',
    },
    relevantConfig: {
      includeTests: false,
      filters: ['apps/api/**'],
      routePattern: /Controller$/i,
    },
    semanticPackIdentity: [
      { id: 'nestjs-routes', version: '2', contentHash: 'pack-a' },
      { id: 'cqrs', version: '1', contentHash: 'pack-b' },
    ],
    ...overrides,
  };
}

function contribution(): CASContribution {
  return {
    nodes: [
      { id: 'node-b', name: 'Second', type: 'service' },
      { id: 'node-a', name: 'First', type: 'controller' },
    ],
    edges: [{ id: 'edge-z', source: 'node-a', target: 'node-b', type: 'calls' }],
    entry_points: [],
    exit_points: [],
    analyzer_metadata: {
      analyzer_id: 'framework-nestjs',
      analyzer_name: 'NestJS',
      version: '3.2.1',
      contribution_type: 'framework',
      nodes_contributed: 2,
      edges_contributed: 1,
      contributed_entry_points: 0,
      contributed_exit_points: 0,
      capabilities: [],
    },
  };
}

async function withCache(
  run: (cache: PersistentAnalyzerContributionCache, root: string) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-contribution-cache-'));
  try {
    await run(new PersistentAnalyzerContributionCache({ rootPath: root }), root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('persists and restores contribution JSON without reordering graph facts', async () => {
  await withCache(async (cache, root) => {
    const original = contribution();
    assert.equal(await cache.put(input(), original), true);
    const secondProcess = new PersistentAnalyzerContributionCache({ rootPath: root });
    const lookup = await secondProcess.get(input());
    assert.equal(lookup.evidence.status, 'hit');
    assert.equal(lookup.evidence.persisted, true);
    assert.equal(JSON.stringify(lookup.contribution), JSON.stringify(original));
    assert.deepEqual(lookup.contribution?.nodes?.map(node => node.id), ['node-b', 'node-a']);
  });
});

test('canonical configuration identity ignores object key insertion order but preserves array order', () => {
  assert.equal(
    stableAnalyzerCacheIdentity({ b: 2, a: { y: /x/i, x: 1 } }),
    stableAnalyzerCacheIdentity({ a: { x: 1, y: /x/i }, b: 2 })
  );
  assert.notEqual(stableAnalyzerCacheIdentity(['a', 'b']), stableAnalyzerCacheIdentity(['b', 'a']));
  const circular = new Set<unknown>();
  circular.add(circular);
  assert.throws(() => stableAnalyzerCacheIdentity(circular), /circular/);
});

test('reports every key dimension that invalidated the prior family entry', async () => {
  await withCache(async cache => {
    await cache.put(input(), contribution());
    const changed = input({
      sourceContentHash: 'sha256:source-v2',
      analyzer: {
        id: 'framework-nestjs',
        version: '4.0.0',
        type: 'library',
        implementationFingerprint: 'parser-stage-v8',
      },
      relevantConfig: { includeTests: true },
      semanticPackIdentity: [{ id: 'nestjs-routes', version: '3', contentHash: 'pack-c' }],
    });
    const lookup = await cache.get(changed);
    assert.equal(lookup.evidence.status, 'invalidated');
    assert.deepEqual(new Set(lookup.evidence.invalidationReasons), new Set([
      'source-content-changed',
      'analyzer-version-changed',
      'analyzer-type-changed',
      'analyzer-implementation-changed',
      'relevant-config-changed',
      'semantic-pack-changed',
    ]));
    assert.equal(cache.getStats().invalidations, 1);
  });
});

test('schema changes invalidate entries without trusting stale payloads', async () => {
  await withCache(async (cache, root) => {
    await cache.put(input(), contribution());
    const nextSchema = new PersistentAnalyzerContributionCache({ rootPath: root, schemaVersion: '2' });
    const lookup = await nextSchema.get(input());
    assert.equal(lookup.evidence.status, 'invalidated');
    assert.deepEqual(lookup.evidence.invalidationReasons, ['cache-schema-changed']);
  });
});

test('a missing family is an observable cold miss', async () => {
  await withCache(async cache => {
    const lookup = await cache.get(input());
    assert.equal(lookup.evidence.status, 'miss');
    assert.deepEqual(lookup.evidence.invalidationReasons, ['cold']);
    assert.deepEqual(cache.getStats(), {
      hits: 0,
      misses: 1,
      invalidations: 0,
      corruptions: 0,
      writes: 0,
      coalesced: 0,
    });
  });
});

test('corrupt entries are rejected, removed, and reported', async () => {
  await withCache(async cache => {
    await cache.put(input(), contribution());
    const descriptor = cache.describe(input());
    const files: string[] = [];
    const collect = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(file);
        else files.push(file);
      }
    };
    const root = (cache as unknown as { rootPath: string }).rootPath;
    await collect(root);
    const entryPath = files.find(file => file.endsWith(`${descriptor.key}.json`));
    assert.ok(entryPath);
    await fs.writeFile(entryPath, '{broken');
    const lookup = await cache.get(input());
    assert.equal(lookup.evidence.status, 'invalidated');
    assert.deepEqual(lookup.evidence.invalidationReasons, ['corrupt-entry']);
    await assert.rejects(fs.stat(entryPath), { code: 'ENOENT' });
    assert.equal(cache.getStats().corruptions, 1);
  });
});

test('concurrent identical misses compute once and expose coalescing evidence', async () => {
  await withCache(async cache => {
    let computations = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const compute = async () => {
      computations++;
      await gate;
      return contribution();
    };
    const first = cache.getOrCompute(input(), compute);
    const second = cache.getOrCompute(input(), compute);
    await new Promise(resolve => setImmediate(resolve));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(computations, 1);
    assert.deepEqual(new Set([a.evidence.status, b.evidence.status]), new Set(['miss', 'coalesced']));
    assert.equal(cache.getStats().coalesced, 1);
  });
});

test('disabled cache computes without persistence', async () => {
  const cache = new PersistentAnalyzerContributionCache();
  const result = await cache.getOrCompute(input(), async () => contribution());
  assert.equal(result.evidence.status, 'disabled');
  assert.equal(result.evidence.persisted, false);
  assert.ok(result.contribution);
});
