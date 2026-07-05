import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildSummary, getSystemOverview } from './query';

// Minimal CAS carrying the dynamic sections the runtime opt-out governs:
//  - cas.runtime + cas.runtime_static_links  (getSystemOverview runtime fields)
//  - cas.communication_seams                 (buildSummary communication_seams
//                                              + getSystemOverview system_fit)
function buildCasWithRuntimeAndSeams(): CASOutput {
  return {
    system: { name: 'demo', type: 'service', technologies: { languages: [], frameworks: [], databases: [] } },
    nodes: [],
    edges: [],
    entry_points: [],
    analyzer_contributions: [],
    runtime: { some: 'runtime-metadata', that: 'is environment specific'.repeat(20) } as any,
    runtime_static_links: [
      { id: 'l1', static_id: 's1', telemetry_status: 'observed' },
      { id: 'l2', static_id: 's2', telemetry_status: 'inferred' },
    ] as any,
    communication_seams: {
      inventory: {
        level: 'node',
        counts: { sync: 3, async: 2, passive: 1, total: 6 },
        component_seams: [
          { source: 'A', target: 'B', modalities: { sync: 3 }, total: 3 },
          { source: 'B', target: 'C', modalities: { async: 2, passive: 1 }, total: 3 },
        ],
      },
    } as any,
  } as unknown as CASOutput;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

test('getSystemOverview: default/auto keeps runtime + system_fit (byte-for-byte identical)', () => {
  const cas = buildCasWithRuntimeAndSeams();
  const included = getSystemOverview(cas);
  // Default (no opts) must equal explicit "include everything" opts.
  const explicitIncluded = getSystemOverview(cas, { excludeRuntime: false, excludeSeams: false, excludeTopology: false });
  assert.deepEqual(included, explicitIncluded);
  assert.ok('runtime' in included, 'runtime field present by default');
  assert.ok('runtime_static_links_count' in included, 'runtime_static_links_count present by default');
  assert.equal((included as any).runtime_static_links_count, 2);
});

test('getSystemOverview: excludeRuntime omits runtime fields and shrinks payload', () => {
  const cas = buildCasWithRuntimeAndSeams();
  const included = getSystemOverview(cas);
  const excluded = getSystemOverview(cas, { excludeRuntime: true });

  assert.ok(!('runtime' in excluded), 'runtime field omitted');
  assert.ok(!('runtime_static_links_count' in excluded), 'runtime_static_links_count omitted');
  // an included static section still appears
  assert.equal((excluded as any).name, 'demo');
  assert.ok('capabilities_count' in excluded, 'non-runtime section still present');

  const includedBytes = bytes(included);
  const excludedBytes = bytes(excluded);
  assert.ok(excludedBytes < includedBytes, `excluded (${excludedBytes}B) must be smaller than included (${includedBytes}B)`);
});

test('getSystemOverview: excludeSeams+excludeTopology drops system_fit', () => {
  const cas = buildCasWithRuntimeAndSeams();
  const included = getSystemOverview(cas);
  const excluded = getSystemOverview(cas, { excludeSeams: true, excludeTopology: true });
  // system_fit is only present when the peer's fabric produced it; assert that
  // exclusion never *adds* it and is <= the included size.
  assert.ok(!('system_fit' in excluded), 'system_fit omitted when seams+topology excluded');
  assert.ok(bytes(excluded) <= bytes(included));
});

test('buildSummary: default keeps communication_seams; excludeSeams omits it and shrinks', () => {
  const cas = buildCasWithRuntimeAndSeams();
  const included = buildSummary(cas);
  const explicitIncluded = buildSummary(cas, { excludeSeams: false });
  assert.deepEqual(included, explicitIncluded, 'default == excludeSeams:false (backward compatible)');
  assert.ok('communication_seams' in included, 'communication_seams present by default');

  const excluded = buildSummary(cas, { excludeSeams: true });
  assert.ok(!('communication_seams' in excluded), 'communication_seams omitted');
  // an included section still appears
  assert.equal((excluded as any).name, 'demo');
  assert.ok(bytes(excluded) < bytes(included), 'excluded summary must be smaller');
});
