import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { projectCasForCrossRepositoryAnalysis, visionReportTimestamps } from './vision-gauntlet';

test('vision gauntlet reports use the canonical freshness timestamp while preserving compatibility', () => {
  const generatedAt = '2026-08-18T22:00:00.000Z';

  assert.deepEqual(visionReportTimestamps(generatedAt), {
    generated_at: generatedAt,
    generatedAt,
  });
});

test('vision gauntlet releases nodes that cannot contribute to cross-repository analysis', () => {
  const cas = {
    cas_version: '1.0.0',
    analysis_id: 'analysis',
    analysis_timestamp: new Date(0).toISOString(),
    system: { id: 'system', name: 'system', type: 'application', root_path: '/repo' },
    nodes: [
      { id: 'handler', name: 'handler', type: 'function', source: { file: 'src/handler.ts', line: 1 } },
      { id: 'unused', name: 'unused', type: 'function', source: { file: 'src/unused.ts', line: 1 } },
      { id: 'contract', name: 'Order', type: 'interface', source: { file: 'src/order.ts', line: 1 } },
      { id: 'import', name: 'Vendor\\Package\\Client', type: 'use', source: { file: 'src/client.php', line: 1 } },
    ],
    edges: [{ id: 'edge', source: 'handler', target: 'unused', type: 'calls' }],
    entry_points: [{ id: 'entry', name: '/orders', type: 'http', source_node: 'handler' }],
    exit_points: [],
    entities: [],
  } as unknown as CASOutput;

  const projected = projectCasForCrossRepositoryAnalysis(cas);

  assert.deepEqual(projected.nodes.map(node => node.id), ['handler', 'contract', 'import']);
  assert.deepEqual(projected.edges, []);
  assert.equal(projected.entry_points?.[0], cas.entry_points?.[0]);
  assert.notEqual(projected.nodes, cas.nodes);
});
