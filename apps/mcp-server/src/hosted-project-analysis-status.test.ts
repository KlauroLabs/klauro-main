import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { SubCasNodeIndex } from './deployable-analysis';
import { buildHostedProjectAnalysisStatus } from './hosted-project-analysis-status';

test('hosted analysis status uses the persisted exact sub-CAS index for a graph-free projection', () => {
  const subCasNodes = {
    promoted: true,
    units: [{
      id: 'cas:api',
      name: 'api',
      root_path: 'apps/api',
      member_root_paths: [],
      tier: 1,
      kind: 'compose-service',
      node_count: 3,
      exclusive_node_count: 2,
      shared_node_count: 1,
      owned_shared_node_count: 1,
      entry_point_count: 1,
      exit_point_count: 0,
      seed_node_count: 1,
      seed_basis: ['root_path'],
      boundary_evidence: ['compose:api'],
    }],
    qualified_unit_count: 2,
    promotion_threshold: 2,
    reason: 'fixture',
    graph_node_count: 6,
    covered_node_count: 5,
    coverage_ratio: 0.8333,
    exclusive_node_count: 4,
    shared_node_count: 1,
    sum_of_unit_node_counts: 6,
    orphan_node_count: 1,
    orphan_node_ids: ['orphan'],
    counts_note: 'fixture',
    duplicate_units_collapsed: [],
    orphan_node_id_duplicate_count: 0,
  } as SubCasNodeIndex;
  const cas = {
    cas_version: '1.11.0',
    analysis_id: 'analysis',
    analysis_timestamp: '2026-08-24T00:00:00.000Z',
    system: { id: 'system', name: 'system', type: 'service', root_path: '.' },
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
  } as unknown as CASOutput;

  const status = buildHostedProjectAnalysisStatus(cas, 'project', 'analysis', subCasNodes);
  assert.deepEqual((status.summary as Record<string, unknown>).sub_cas_nodes, subCasNodes);
  assert.equal(status.status, 'failed');
  assert.equal(status.analysis_error, 'Analysis readiness manifest is missing.');
});

test('an L4-only failure degrades comprehension without failing the structural analysis', () => {
  const cas = {
    cas_version: '1.11.0',
    analysis_id: 'analysis',
    analysis_timestamp: '2026-08-24T00:00:00.000Z',
    system: { id: 'system', name: 'system', type: 'service', root_path: '.' },
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
    layers_ready: {
      complete: false,
      layers: [
        { layer: 'L0', name: 'Inventory', status: 'ready', fields: [] },
        { layer: 'L1', name: 'Structure', status: 'ready', fields: [] },
        { layer: 'L2', name: 'Relationships', status: 'ready', fields: [] },
        { layer: 'L3', name: 'Behavior', status: 'ready', fields: [] },
        { layer: 'L4', name: 'Flows', status: 'error', error: 'comprehension failed', fields: [] },
      ],
    },
  } as unknown as CASOutput;

  const status = buildHostedProjectAnalysisStatus(cas, 'project', 'analysis');
  assert.equal(status.status, 'degraded');
  assert.match(String((status as Record<string, unknown>).comprehension_error ?? ''), /comprehension/i);
  assert.equal('failed_layers' in status, false);
});
