import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { getAnalysis } from './analyzer';
import { saveAnalysis } from './storage';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

// Regression test for the getAnalysis hot-path cache defect (same class as
// ef4e29a's loadCorrelationCas fix): getAnalysis used to call loadAnalysis
// without { preferCache: true }, so the hottest MCP read path always paid a
// full disk read + decompress + JSON.parse even when nothing had changed on
// disk since the last call. With preferCache wired through, a repeat
// getAnalysis() call for an unchanged file must return the exact in-memory
// object the mtime/size-fingerprinted cache is holding — not a freshly
// deserialized copy — so we assert reference identity across two calls.

async function withStoragePath<T>(fn: (storagePath: string) => Promise<T>): Promise<T> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-get-analysis-cache-test-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  try {
    return await fn(storagePath);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previous;
    await fs.remove(storagePath);
  }
}

function makeCas(name: string): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: '2026-07-01T00:00:00.000Z',
    analysis_id: `id-${name}`,
    system: { name, type: 'library' } as any,
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: {} as any,
  } as CASOutput;
}

test('getAnalysis hits the mtime/size fingerprint cache on repeat calls (same object identity)', async () => {
  await withStoragePath(async () => {
    const projectPath = '/tmp/klauro-get-analysis-cache-fixture';
    await saveAnalysis(projectPath, makeCas('fixture'));

    const first = await getAnalysis(projectPath);
    const second = await getAnalysis(projectPath);

    // Cache hit: identical in-memory object, not a fresh deserialize.
    assert.equal(first, second);
    assert.equal(first.system.name, 'fixture');
  });
});

test('getAnalysis still reflects a re-save (fingerprint invalidation still holds)', async () => {
  await withStoragePath(async () => {
    const projectPath = '/tmp/klauro-get-analysis-cache-fixture-2';
    await saveAnalysis(projectPath, makeCas('v1'));
    const first = await getAnalysis(projectPath);
    assert.equal(first.system.name, 'v1');

    // Simulate a subsequent save (new content, new mtime/size) — the cache
    // must not serve the stale v1 object back.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveAnalysis(projectPath, makeCas('v2'));
    const second = await getAnalysis(projectPath);
    assert.equal(second.system.name, 'v2');
    assert.notEqual(first, second);
  });
});
