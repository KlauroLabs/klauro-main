import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  buildCommunicationSeamSummary,
  buildConsistencyFlags,
  buildBundledDeployables,
  buildRuntimeTopologySummary,
  buildSystemFitSummary,
} from './context-fabric';

function baseCas(overrides: Partial<CASOutput> = {}): CASOutput {
  return {
    nodes: [],
    edges: [],
    entry_points: [],
    analyzer_contributions: [],
    ...overrides,
  } as unknown as CASOutput;
}

// --- communication seams -----------------------------------------------------

test('buildCommunicationSeamSummary returns undefined when no seams', () => {
  assert.equal(buildCommunicationSeamSummary(baseCas()), undefined);
});

test('buildCommunicationSeamSummary prefers deployable inventory and summarizes counts + top edges', () => {
  const cas = baseCas({
    communication_seams: {
      seams: [],
      inventory: { level: 'node', counts: { sync: 1, async: 0, passive: 0, total: 1 }, component_seams: [] },
      deployable_inventory: {
        level: 'deployable',
        counts: { sync: 10, async: 3, passive: 2, total: 15 },
        component_seams: [
          { source: 'api', target: 'database', modalities: ['sync'], sync: 8, async: 0, passive: 0, total: 8 },
          { source: 'api', target: 'queue', modalities: ['async'], sync: 0, async: 3, passive: 0, total: 3 },
          { source: 'worker', target: 'cache', modalities: ['passive'], sync: 0, async: 0, passive: 1, total: 1 },
        ],
      },
    } as any,
  });
  const s = buildCommunicationSeamSummary(cas, { maxEdges: 2 })!;
  assert.equal(s.headline, '10 sync / 3 async / 2 passive');
  assert.equal(s.level, 'deployable');
  assert.equal(s.top_edges.length, 2);
  assert.equal(s.top_edges[0].target, 'database'); // highest total first
  assert.equal(s.detail_tool, 'get_communication_seams');
});

test('buildCommunicationSeamSummary falls back to node inventory when deployable inventory empty', () => {
  const cas = baseCas({
    communication_seams: {
      seams: [],
      inventory: { level: 'node', counts: { sync: 4, async: 1, passive: 0, total: 5 }, component_seams: [] },
      deployable_inventory: { level: 'deployable', counts: { sync: 0, async: 0, passive: 0, total: 0 }, component_seams: [] },
    } as any,
  });
  const s = buildCommunicationSeamSummary(cas)!;
  assert.equal(s.level, 'node');
  assert.equal(s.counts.total, 5);
});

// --- consistency / CAP -------------------------------------------------------

test('buildConsistencyFlags returns undefined when only strong stores (not flagged stale)', () => {
  const cas = baseCas({
    consistency_model: {
      passive_seams: [], store_consistency: [],
      counts: { passive_replica: 0, passive_streaming: 0, strong_stores: 5, eventual_stores: 0, tunable_stores: 0 },
    } as any,
  });
  assert.equal(buildConsistencyFlags(cas), undefined);
});

test('buildConsistencyFlags surfaces eventual/replica/streaming staleness flags', () => {
  const cas = baseCas({
    consistency_model: {
      passive_seams: [], store_consistency: [],
      counts: { passive_replica: 2, passive_streaming: 1, strong_stores: 3, eventual_stores: 4, tunable_stores: 1 },
    } as any,
  });
  const c = buildConsistencyFlags(cas)!;
  assert.equal(c.eventual_consistency_present, true);
  assert.ok(c.flags.some(f => /eventual store/.test(f)));
  assert.ok(c.flags.some(f => /replica/.test(f)));
  assert.ok(c.flags.some(f => /streaming/.test(f)));
  assert.equal(c.detail_tool, 'get_product_map');
});

// --- bundled deployables -----------------------------------------------------

test('buildBundledDeployables collapses bundled members and drops base-image / arg noise', () => {
  const cas = baseCas({
    deployable_evidence: [
      { root_path: '.', name: 'client', tier: 1, kind: 'container',
        evidence: [], ships_paths: ['node:22-alpine', 'client-service', 'dumb-init', 'below.'], entrypoint_member: 'client-service' },
      { root_path: 'admin', name: 'admin-api', tier: 1, kind: 'container', evidence: [], ships_paths: ['node:22-alpine'] },
    ] as any,
  });
  const d = buildBundledDeployables(cas)!;
  const client = d.find(x => x.name === 'client')!;
  assert.deepEqual(client.bundles, ['client-service']); // base image + arg noise dropped
  assert.equal(client.entrypoint_member, 'client-service');
  const admin = d.find(x => x.name === 'admin-api')!;
  assert.deepEqual(admin.bundles, []); // only a base image -> shows as un-bundled
});

test('buildBundledDeployables returns undefined when no deployable evidence', () => {
  assert.equal(buildBundledDeployables(baseCas()), undefined);
});

// --- runtime topology --------------------------------------------------------

test('buildRuntimeTopologySummary compacts product_map runtime topology', () => {
  const cas = baseCas({
    product_map: {
      runtime_topology: {
        edge_count: 12,
        deployables: [
          { name: 'api', deploys: ['img'], exposes: ['port:8080'], routes: ['/a', '/b'], channels: [], databases: ['pg'], storage: [], depends_on: ['worker'] },
        ],
      },
    } as any,
  });
  const t = buildRuntimeTopologySummary(cas)!;
  assert.equal(t.edge_count, 12);
  assert.equal(t.deployables[0].name, 'api');
  assert.equal(t.deployables[0].routes_count, 2);
  assert.deepEqual(t.deployables[0].databases, ['pg']);
});

test('buildRuntimeTopologySummary returns undefined without infra topology', () => {
  assert.equal(buildRuntimeTopologySummary(baseCas()), undefined);
});

// --- system fit (get_system_overview) ----------------------------------------

test('buildSystemFitSummary returns undefined when no new layers present', () => {
  const cas = baseCas({ entry_points: [{ type: 'http' }] as any });
  assert.equal(buildSystemFitSummary(cas), undefined);
});

test('buildSystemFitSummary weaves the vertical and names a bundled ship-unit', () => {
  const cas = baseCas({
    entry_points: [{ type: 'http' }, { type: 'cli' }] as any,
    deployable_evidence: [
      { root_path: '.', name: 'client', tier: 1, kind: 'container', evidence: [], ships_paths: ['client-service'], entrypoint_member: 'client-service' },
    ] as any,
    communication_seams: {
      seams: [],
      inventory: { level: 'node', counts: { sync: 2, async: 1, passive: 0, total: 3 }, component_seams: [] },
    } as any,
    consistency_model: {
      passive_seams: [], store_consistency: [],
      counts: { passive_replica: 0, passive_streaming: 0, strong_stores: 0, eventual_stores: 2, tunable_stores: 0 },
    } as any,
  });
  const fit = buildSystemFitSummary(cas)!;
  assert.match(fit.headline, /2 entry point/);
  assert.match(fit.headline, /client bundles client-service/);
  assert.match(fit.headline, /seams 2 sync \/ 1 async \/ 0 passive/);
  assert.match(fit.headline, /eventual-consistency risk present/);
  assert.equal(fit.entry_points.total, 2);
  assert.ok(fit.communication_seams);
  assert.ok(fit.consistency);
  assert.ok(fit.detail_tools.includes('get_product_map'));
});
