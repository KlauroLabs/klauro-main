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
  const compact = (status.summary as Record<string, any>).sub_cas_nodes;
  assert.equal(compact.units_total, 1);
  assert.deepEqual(compact.units.map((unit: { id: string }) => unit.id), ['cas:api']);
  assert.equal(compact.orphan_node_count, 1);
  assert.equal('orphan_node_ids' in compact, false);
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

function largeReadyCas(): CASOutput {
  const capability = (index: number) => ({
    id: `cap-${index}`,
    name: `Capability ${index}`,
    description: 'A user outcome. '.repeat(20),
    category: 'core',
    criticality: 'high',
    operations: [],
    journeys: Array.from({ length: 40 }, (_, j) => ({ id: `journey-${index}-${j}`, name: `Journey ${index} ${j} `.repeat(4) })),
    entities: ['Order', 'Invoice'],
  });
  return {
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
    entities: Array.from({ length: 200 }, (_, index) => ({ name: `Entity${index}` })),
    capabilities: Array.from({ length: 60 }, (_, index) => capability(index)),
    layers_ready: {
      complete: true,
      layers: ['L0', 'L1', 'L2', 'L3'].map(layer => ({ layer, name: layer, status: 'ready', fields: [] })),
    },
    product_map: {
      identity: { name: 'system', domain: 'orders', description: 'd', unanalyzed_languages: [] },
      capabilities: Array.from({ length: 60 }, (_, index) => ({ ...capability(index), tests_present: true, risk_level: 'low' })),
      journeys: { total: 2400, user_facing: 1000, system: 1300, scheduled: 100, top: [] },
      data: { entities: 200, sensitive: [], exposure_highlights: [] },
      conventions: { paradigms: [], open_deviations: { error: 0, warning: 0, info: 0 } },
      health: { tests: { total: 10, passing: 0, failing: 0 }, implementation: { complete: 0, partial: 0, stubs: 0, not_implemented: 0, deprecated: 0 }, top_risks: [] },
    },
  } as unknown as CASOutput;
}

function largeSubCasNodes(unitCount: number): SubCasNodeIndex {
  return {
    promoted: true,
    units: Array.from({ length: unitCount }, (_, index) => ({
      id: `cas:unit-${index}`, name: `unit-${index}`, root_path: `apps/unit-${index}`, member_root_paths: [], tier: 1, kind: 'compose-service',
      node_count: index, exclusive_node_count: index, shared_node_count: 0, owned_shared_node_count: 0, entry_point_count: 0, exit_point_count: 0,
      seed_node_count: 0, seed_basis: ['root_path'], boundary_evidence: ['compose:' + index],
    })),
    qualified_unit_count: unitCount,
    promotion_threshold: 2,
    reason: 'fixture',
    graph_node_count: 5000,
    covered_node_count: 4000,
    coverage_ratio: 0.8,
    exclusive_node_count: 4000,
    shared_node_count: 0,
    sum_of_unit_node_counts: 4000,
    orphan_node_count: 1000,
    orphan_node_ids: Array.from({ length: 1000 }, (_, index) => `orphan-${index}`),
    counts_note: 'fixture',
    duplicate_units_collapsed: [],
    orphan_node_id_duplicate_count: 0,
  } as unknown as SubCasNodeIndex;
}

test('the hosted analysis status of a large analysis stays compact and names the tools that give detail', () => {
  const status = buildHostedProjectAnalysisStatus(largeReadyCas(), 'project', 'analysis', largeSubCasNodes(60));
  assert.equal(status.status, 'ready');
  assert.ok(Buffer.byteLength(JSON.stringify(status)) < 12_000, `status was ${Buffer.byteLength(JSON.stringify(status))} bytes`);
  assert.equal('product_map' in status, false);
  const overview = status.product_map_overview as Record<string, any>;
  assert.equal(overview.capabilities, 60);
  assert.equal(overview.journeys.total, 2400);
  assert.match(overview.detail, /get_product_map/);
  const summary = status.summary as Record<string, any>;
  assert.equal(summary.database_entities.length, 15);
  assert.equal(summary.database_entities_total, 200);
  assert.equal(summary.sub_cas_nodes.units_total, 60);
  assert.equal(summary.sub_cas_nodes.units_shown, 20);
  assert.equal(summary.sub_cas_nodes.units[0].id, 'cas:unit-59');
});
