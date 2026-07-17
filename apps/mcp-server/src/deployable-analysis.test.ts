import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldPromote,
  tierQualifiedShipUnits,
  sliceDeployableAnalysis,
  buildDeployableAnalyses,
  resolveDasScope,
} from './deployable-analysis';
import type { CASNode, CASEdge, CASEntryPoint, CASOutput, DeployableEvidence } from '../../../packages/analyzer-core/src/types/cas.types';

function node(id: string, file: string): CASNode {
  return { id, name: id, type: 'function', source: { file, line: 1 } } as CASNode;
}

function callEdge(source: string, target: string): CASEdge {
  return { id: `edge_${source}_${target}`, source, target, type: 'calls' };
}

function entryPoint(id: string, file: string, handlerNodeId: string): CASEntryPoint {
  return {
    id,
    source_node: handlerNodeId,
    type: 'http',
    name: id,
    handler: { node_id: handlerNodeId, method_name: handlerNodeId, file },
  } as CASEntryPoint;
}

/**
 * Synthetic multi-deployable fixture: 2 compose units (api, worker) each with
 * their own entry point, a libs/shared utility both call into, and 2 bin
 * candidates with no Tier-1 reference (must fail the shipped-gate and not
 * count toward promotion, per spec §8's "8 runnable binaries / 1 bundle"
 * acceptance example, scaled down).
 */
function buildFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node('A1', 'apps/api/handler.ts'),
    node('A2', 'apps/api/other.ts'),
    node('W1', 'apps/worker/worker.ts'),
    node('S1', 'libs/shared/util.ts'),
    node('B1', 'bin/tool1/index.ts'),
    node('B2', 'bin/tool2/index.ts'),
  ];
  const edges: CASEdge[] = [
    callEdge('A1', 'A2'),
    callEdge('A1', 'S1'),
    callEdge('W1', 'S1'),
  ];
  const entry_points: CASEntryPoint[] = [
    entryPoint('ep_api', 'apps/api/handler.ts', 'A1'),
    entryPoint('ep_worker', 'apps/worker/worker.ts', 'W1'),
  ];
  const deployable_evidence: DeployableEvidence[] = [
    { root_path: 'apps/api', name: 'api', tier: 1, kind: 'compose-service', evidence: ['compose:api'] },
    { root_path: 'apps/worker', name: 'worker', tier: 1, kind: 'compose-service', evidence: ['compose:worker'] },
    { root_path: 'bin/tool1', name: 'tool1', tier: 2, kind: 'bin', evidence: ['bin:tool1'] },
    { root_path: 'bin/tool2', name: 'tool2', tier: 2, kind: 'bin', evidence: ['bin:tool2'] },
  ];

  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test-analysis',
    system: { id: 'sys1', name: 'test-system', type: 'monorepo', root_path: '.' },
    nodes,
    edges,
    entry_points,
    exit_points: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
    deployable_evidence,
  } as unknown as CASOutput;
}

test('tierQualifiedShipUnits: 2 self-anchored compose services + ungated bins => count 2', () => {
  const cas = buildFixtureCas();
  const qualified = tierQualifiedShipUnits(cas.deployable_evidence);
  assert.equal(qualified.length, 2);
  assert.deepEqual(qualified.map(q => q.name).sort(), ['api', 'worker']);
});

test('tierQualifiedShipUnits: multi-binary workspace with installer bundling => count 1 (spec §8)', () => {
  const evidence: DeployableEvidence[] = [
    {
      root_path: '.', name: 'installer', tier: 1, kind: 'installer',
      evidence: ['installer:bundle'], ships_paths: ['bin1', 'bin2'], entrypoint_member: 'bin1',
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      root_path: `bin/bin${i}`, name: `bin${i}`, tier: 2 as const, kind: 'bin' as const, evidence: [`bin:bin${i}`],
    })),
  ];
  // Simulate the evidence-gated bundling pass (deployable-evidence.ts's
  // resolveEvidenceBundling) that would already have run over this evidence
  // before it ever reaches DAS: bin0/bin1 are named in the installer's
  // ships_paths and get bundled_into set; the other 6 are not referenced.
  const withBundling = evidence.map(e =>
    (e.name === 'bin0' || e.name === 'bin1') ? { ...e, bundled_into: 'installer' } : e);
  const qualified = tierQualifiedShipUnits(withBundling);
  assert.equal(qualified.length, 1);
  assert.equal(qualified[0].name, 'installer');
});

test('tierQualifiedShipUnits: 4 independent Dockerfile services => count 4, microservices monorepo promotes (spec §8)', () => {
  const evidence: DeployableEvidence[] = ['a', 'b', 'c', 'd'].map(name => ({
    root_path: `services/${name}`, name, tier: 1, kind: 'container', evidence: [`docker:${name}`],
  }));
  assert.equal(tierQualifiedShipUnits(evidence).length, 4);
  assert.equal(shouldPromote({ deployable_evidence: evidence }), true);
});

test('shouldPromote: single-deployable CAS never promotes (spec §7 terminal state)', () => {
  const evidence: DeployableEvidence[] = [
    { root_path: '.', name: 'app', tier: 1, kind: 'container', evidence: ['docker:app'] },
  ];
  assert.equal(shouldPromote({ deployable_evidence: evidence }), false);

  const cas = { deployable_evidence: evidence } as CASOutput;
  const result = buildDeployableAnalyses(cas);
  assert.equal(result.promoted, false);
  assert.equal(result.units.length, 0);
  assert.equal(result.das_index.units.length, 0);
});

test('shouldPromote: repo with internal modules/ but one Dockerfile does not promote regardless of folder count', () => {
  // modules/ split is not deployable_evidence at all (Tier-4 folder-only
  // signal is never emitted into deployable_evidence — see cas.types.ts's
  // DeployableEvidence.tier: 1|2|3), so this is simply a 1-row evidence list.
  const evidence: DeployableEvidence[] = [
    { root_path: '.', name: 'app', tier: 1, kind: 'container', evidence: ['docker:app'] },
  ];
  assert.equal(shouldPromote({ deployable_evidence: evidence }), false);
});

test('sliceDeployableAnalysis + buildDeployableAnalyses: slices carry only reachable nodes, shared code tagged, bins are honest orphans', () => {
  const cas = buildFixtureCas();
  const result = buildDeployableAnalyses(cas);

  assert.equal(result.promoted, true);
  assert.equal(result.units.length, 2);
  assert.equal(result.das_index.units.length, 2);

  const apiUnit = result.units.find(u => u.das_unit_name === 'api')!;
  const workerUnit = result.units.find(u => u.das_unit_name === 'worker')!;
  assert.ok(apiUnit && workerUnit);

  const apiNodeIds = apiUnit.slice.nodes.map(n => n.id).sort();
  const workerNodeIds = workerUnit.slice.nodes.map(n => n.id).sort();

  // api's slice: its own handler + its own other.ts node + the shared util it reaches.
  assert.deepEqual(apiNodeIds, ['A1', 'A2', 'S1']);
  // worker's slice: its own handler + the shared util it reaches. Never A2 (api-exclusive).
  assert.deepEqual(workerNodeIds, ['S1', 'W1']);
  assert.ok(!workerNodeIds.includes('A2'));
  assert.ok(!apiNodeIds.includes('W1'));

  // Shared-code attribution (spec §2.2): S1 is reached by both units. Exactly
  // one canonical owner (declaration order tie-break since neither unit's own
  // root directly contains libs/shared).
  const apiS1 = apiUnit.slice.nodes.find(n => n.id === 'S1')!;
  const workerS1 = workerUnit.slice.nodes.find(n => n.id === 'S1')!;
  const apiS1Meta = apiS1.metadata as any;
  const workerS1Meta = workerS1.metadata as any;
  const owners = [apiS1Meta?.attribution, workerS1Meta?.attribution];
  assert.ok(owners.includes('owned'));
  assert.ok(owners.includes('shared'));
  // Exactly one owner, never zero and never both/double-owned.
  assert.equal(owners.filter(a => a === 'owned').length, 1);
  const nonOwnerSlice = apiS1Meta?.attribution === 'shared' ? apiS1 : workerS1;
  const ownerSlice = apiS1Meta?.attribution === 'owned' ? apiUnit : workerUnit;
  assert.equal((nonOwnerSlice.metadata as any).canonical_owner_das_unit_id, ownerSlice.das_unit_id);

  // Entry points scoped honestly per unit — no cross-contamination.
  assert.deepEqual(apiUnit.slice.entry_points!.map(e => e.id), ['ep_api']);
  assert.deepEqual(workerUnit.slice.entry_points!.map(e => e.id), ['ep_worker']);

  // The 2 bin nodes are unreachable from either unit's closure — reported as
  // orphans, not silently dropped and not fabricated into either slice.
  assert.equal(result.das_index.orphan_node_count, 2);
  assert.deepEqual(result.das_index.orphan_node_ids.sort(), ['B1', 'B2']);
  assert.ok(!apiNodeIds.includes('B1') && !workerNodeIds.includes('B1'));

  // das_index counts are honest (node_count matches the actual slice length).
  const apiIndexEntry = result.das_index.units.find(u => u.name === 'api')!;
  assert.equal(apiIndexEntry.node_count, apiUnit.slice.nodes.length);
});

test('resolveDasScope: looks up a unit by id, undefined for unknown/non-promoted', () => {
  const cas = buildFixtureCas();
  const { units } = buildDeployableAnalyses(cas);
  const apiId = units.find(u => u.das_unit_name === 'api')!.das_unit_id;

  const resolved = resolveDasScope(cas, apiId);
  assert.ok(resolved);
  assert.equal(resolved!.das_unit_name, 'api');

  assert.equal(resolveDasScope(cas, 'das:nonexistent'), undefined);

  const singleDeployableCas = {
    ...cas,
    deployable_evidence: [{ root_path: '.', name: 'app', tier: 1, kind: 'container', evidence: [] }],
  } as CASOutput;
  assert.equal(resolveDasScope(singleDeployableCas, apiId), undefined);
});

test('sliceDeployableAnalysis: single-unit call still produces a CASOutput-shaped slice (no new object model)', () => {
  const cas = buildFixtureCas();
  const apiEvidence = cas.deployable_evidence!.find(e => e.name === 'api')!;
  const slice = sliceDeployableAnalysis(cas, apiEvidence);

  assert.equal(slice.das_unit_name, 'api');
  assert.equal(slice.root_path, 'apps/api');
  // Same field names a repo-level CASOutput carries — no parallel schema.
  assert.ok(Array.isArray(slice.slice.nodes));
  assert.ok(Array.isArray(slice.slice.edges));
  assert.ok(Array.isArray(slice.slice.entry_points));
  assert.equal(slice.slice.system, cas.system);
});
