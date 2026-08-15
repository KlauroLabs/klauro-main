import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildCrossCodebaseSystemGraph } from './cross-codebase-analysis';
import { buildIncrementalCrossCodebaseSystemGraph } from './incremental-workspace-analysis';

function cas(id: string, nodeName: string): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: '2026-01-01T00:00:00.000Z',
    analysis_id: id,
    system: {
      id: `system:${id}`,
      name: nodeName,
      type: 'application',
      root_path: `/workspace/${nodeName}`,
      technologies: {}
    },
    nodes: [{ id: `node:${id}`, name: nodeName, type: 'module', source: { file: 'src/index.ts', line: 1 } } as never],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 }
  } as CASOutput;
}

test('reuses the complete workspace graph when every member analysis is unchanged', () => {
  const repositories = [
    { path: '/workspace/api', cas: cas('api-v1', 'api') },
    { path: '/workspace/web', cas: cas('web-v1', 'web') }
  ];
  const first = buildIncrementalCrossCodebaseSystemGraph({
    name: 'workspace', repositories, id: 'workspace', generatedAt: '2026-01-01T00:00:00.000Z'
  });
  const second = buildIncrementalCrossCodebaseSystemGraph({ name: 'workspace', repositories, previous: first });

  assert.equal(second.analysis_id, first.analysis_id);
  assert.equal(second.incremental_locality.strategy, 'unchanged-workspace');
  assert.equal(second.incremental_locality.reuseRatio, 1);
  assert.deepEqual(second.incremental_locality.reusedMembers, ['/workspace/api', '/workspace/web']);
});

test('recomposes cross-repository links while reusing unchanged member analyses', () => {
  const initialRepositories = [
    { path: '/workspace/api', cas: cas('api-v1', 'api') },
    { path: '/workspace/web', cas: cas('web-v1', 'web') }
  ];
  const previous = buildIncrementalCrossCodebaseSystemGraph({
    name: 'workspace', repositories: initialRepositories, id: 'workspace', generatedAt: '2026-01-01T00:00:00.000Z'
  });
  const repositories = [
    { path: '/workspace/api', cas: cas('api-v2', 'api') },
    initialRepositories[1]
  ];
  const incremental = buildIncrementalCrossCodebaseSystemGraph({
    name: 'workspace', repositories, previous, id: 'workspace', generatedAt: '2026-01-02T00:00:00.000Z'
  });
  const cold = buildCrossCodebaseSystemGraph('workspace', repositories, {
    id: 'workspace', generatedAt: '2026-01-02T00:00:00.000Z'
  });

  assert.equal(incremental.incremental_locality.strategy, 'changed-member-recomposition');
  assert.deepEqual(incremental.incremental_locality.changedMembers, ['/workspace/api']);
  assert.deepEqual(incremental.incremental_locality.reusedMembers, ['/workspace/web']);
  assert.equal(incremental.incremental_locality.reuseRatio, 0.5);
  assert.deepEqual({ ...incremental, incremental_locality: undefined }, { ...cold, incremental_locality: undefined });
});

test('detects member changes without relying on an analysis identifier', () => {
  const initial = cas('temporary', 'worker');
  delete (initial as Partial<CASOutput>).analysis_id;
  const previous = buildIncrementalCrossCodebaseSystemGraph({
    name: 'workspace', repositories: [{ path: '/workspace/worker', cas: initial }], id: 'workspace'
  });
  const unchanged = buildIncrementalCrossCodebaseSystemGraph({
    name: 'workspace', repositories: [{ path: '/workspace/worker', cas: initial }], previous, id: 'workspace'
  });
  const changed = structuredClone(initial);
  changed.nodes[0].name = 'updated-worker';
  const recomposed = buildIncrementalCrossCodebaseSystemGraph({
    name: 'workspace', repositories: [{ path: '/workspace/worker', cas: changed }], previous, id: 'workspace'
  });

  assert.equal(unchanged.incremental_locality.strategy, 'unchanged-workspace');
  assert.equal(recomposed.incremental_locality.strategy, 'changed-member-recomposition');
});
