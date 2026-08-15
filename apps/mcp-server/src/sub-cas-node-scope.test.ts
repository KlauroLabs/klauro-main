import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeCasToSubCasNode,
  getCachedDeployableAnalyses,
} from './deployable-analysis';
import * as query from './query';
import { buildCrossCodebaseSystemGraph, type CrossCodebaseInput } from './cross-codebase-analysis';
import type { CASNode, CASEdge, CASEntryPoint, CASOutput, DeployableEvidence } from '../../../packages/analyzer-core/src/types/cas.types';

/**
 * SUB-CAS-NODE PHASE 2 — product-surface wiring tests (docs/cas/SPECIFICATION.md §0.4/§0.8
 * §4, §6). Phase 1 (deployable-analysis.test.ts) proves the slicing primitive
 * in isolation; this file proves the pieces phase 2 wires it INTO:
 *  - get_summary's sub_cas_nodes discovery surface + scoped-vs-rollup counts,
 *  - scope propagating cleanly through query.ts's existing read functions
 *    (search_nodes's contract, via query.searchNodes),
 *  - the unknown-id / non-promoted error paths a caller actually sees,
 *  - the workspace-level CAS's source_sub_cas_node_id linkage (spec §4's three-hop provenance).
 */

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

/** Same promoted shape as deployable-analysis.test.ts's fixture: api + worker
 *  compose services sharing libs/shared, plus 2 declared bin targets which are
 *  units in their own right (ship evidence qualifies them; cardinality does
 *  not gate them) — kept local so this file exercises the product surface
 *  without depending on another test file's internals. */
function buildPromotedCas(analysisId = 'sub-cas-node-scope-promoted'): CASOutput {
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
    analysis_id: analysisId,
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

function buildNonPromotedCas(): CASOutput {
  const nodes: CASNode[] = [node('N1', 'src/app.ts')];
  const deployable_evidence: DeployableEvidence[] = [
    { root_path: '.', name: 'app', tier: 1, kind: 'container', evidence: ['docker:app'] },
  ];
  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'sub-cas-node-scope-non-promoted',
    system: { id: 'sys2', name: 'single-app', type: 'monorepo', root_path: '.' },
    nodes,
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
    deployable_evidence,
  } as unknown as CASOutput;
}

test('scopeCasToSubCasNode: omitted scope returns the same CAS unchanged (existing callers unaffected)', () => {
  const cas = buildPromotedCas();
  assert.equal(scopeCasToSubCasNode(cas, undefined), cas);
});

test('get_summary product surface: promoted CAS exposes sub_cas_nodes; rollup counts cover the whole repo', () => {
  const cas = buildPromotedCas();
  const das = getCachedDeployableAnalyses(cas);
  assert.equal(das.promoted, true);
  assert.equal(das.sub_cas_nodes.units.length, 4);
  assert.deepEqual(das.sub_cas_nodes.units.map(u => u.name).sort(), ['api', 'tool1', 'tool2', 'worker']);
  assert.equal(das.sub_cas_nodes.qualified_unit_count, 4);

  const rollupSummary = query.buildSummary(scopeCasToSubCasNode(cas, undefined));
  assert.equal(rollupSummary.nodes, 6); // all 6 nodes, unscoped rollup
});

test('get_summary product surface: scoped summary reflects the UNIT, not the rollup (counts differ)', () => {
  const cas = buildPromotedCas();
  const das = getCachedDeployableAnalyses(cas);
  const apiUnitId = das.sub_cas_nodes.units.find(u => u.name === 'api')!.id;

  const scopedCas = scopeCasToSubCasNode(cas, { sub_cas_node_id: apiUnitId });
  const scopedSummary = query.buildSummary(scopedCas);

  // api's slice is A1, A2, S1 (3 nodes) — strictly less than the 6-node rollup,
  // and specifically NOT equal to it (the honesty bar the task asked for).
  assert.equal(scopedSummary.nodes, 3);
  assert.notEqual(scopedSummary.nodes, query.buildSummary(cas).nodes);
  assert.equal(scopedSummary.entry_points, 1);
});

test('getCachedDeployableAnalyses: repeat calls on the same analysis_id reuse the cached result (identity-equal)', () => {
  const cas = buildPromotedCas('sub-cas-node-scope-cache-check');
  const first = getCachedDeployableAnalyses(cas);
  const second = getCachedDeployableAnalyses(cas);
  assert.equal(first, second);
  // A structurally-identical-but-distinct CAS object with a different
  // analysis_id must NOT hit the same cache entry.
  const differentAnalysis = { ...cas, analysis_id: 'sub-cas-node-scope-cache-check-2' };
  const third = getCachedDeployableAnalyses(differentAnalysis);
  assert.notEqual(first, third);
});

test('getCachedDeployableAnalyses does not retain results above the configured reference budget', () => {
  const previousBudget = process.env.KLAURO_SUB_CAS_CACHE_REFERENCE_BUDGET;
  process.env.KLAURO_SUB_CAS_CACHE_REFERENCE_BUDGET = '0';
  try {
    const cas = buildPromotedCas('sub-cas-node-scope-uncached-large-result');
    const first = getCachedDeployableAnalyses(cas);
    const second = getCachedDeployableAnalyses(cas);
    assert.notEqual(first, second);
    assert.deepEqual(first.sub_cas_nodes, second.sub_cas_nodes);
  } finally {
    if (previousBudget === undefined) delete process.env.KLAURO_SUB_CAS_CACHE_REFERENCE_BUDGET;
    else process.env.KLAURO_SUB_CAS_CACHE_REFERENCE_BUDGET = previousBudget;
  }
});

test('search_nodes contract: scoped search only returns nodes inside the unit\'s reachability closure', () => {
  const cas = buildPromotedCas();
  const das = getCachedDeployableAnalyses(cas);
  const workerUnitId = das.sub_cas_nodes.units.find(u => u.name === 'worker')!.id;
  const scopedCas = scopeCasToSubCasNode(cas, { sub_cas_node_id: workerUnitId });

  // A broad query that would match every node's type in the whole-repo CAS...
  const rollupHits = query.searchNodes(cas, 'W1');
  const scopedHits = query.searchNodes(scopedCas, 'W1');
  assert.ok(rollupHits.some(h => h.id === 'W1'));
  assert.ok(scopedHits.some(h => h.id === 'W1'));

  // ...but api-exclusive node A2 must never surface from worker's scope, even
  // though it exists in the parent CAS and would be found unscoped.
  const rollupHitsForA2 = query.searchNodes(cas, 'A2');
  const scopedHitsForA2 = query.searchNodes(scopedCas, 'A2');
  assert.ok(rollupHitsForA2.some(h => h.id === 'A2'));
  assert.equal(scopedHitsForA2.length, 0);
});

test('scopeCasToSubCasNode: unknown sub_cas_node_id throws a helpful error naming available units', () => {
  const cas = buildPromotedCas();
  assert.throws(
    () => scopeCasToSubCasNode(cas, { sub_cas_node_id: 'cas:does-not-exist' }),
    (error: Error) => {
      assert.match(error.message, /Unknown scope\.sub_cas_node_id/);
      assert.match(error.message, /api/);
      assert.match(error.message, /worker/);
      return true;
    }
  );
});

test('scopeCasToSubCasNode: non-promoted repo reports WHY (not just an empty list) and a scope param errors gracefully', () => {
  const cas = buildNonPromotedCas();
  const das = getCachedDeployableAnalyses(cas);
  assert.equal(das.promoted, false);
  assert.equal(das.sub_cas_nodes.units.length, 0);
  // Legible: one ship unit found, below the threshold — not "found nothing".
  assert.equal(das.sub_cas_nodes.qualified_unit_count, 1);
  assert.equal(das.sub_cas_nodes.promotion_threshold, 2);
  assert.match(das.sub_cas_nodes.reason, /below the promotion threshold/);

  assert.equal(scopeCasToSubCasNode(cas, undefined), cas);
  assert.throws(
    () => scopeCasToSubCasNode(cas, { sub_cas_node_id: 'cas:anything' }),
    /has not promoted any sub-CAS nodes/
  );
});

test('WAS composition: a promoted member CAS tags its matching WorkspaceDeployable rows with source_sub_cas_node_id', () => {
  const cas = buildPromotedCas('sub-cas-node-scope-workspace-link');
  const repositories: CrossCodebaseInput[] = [
    { path: '/repos/multi-deploy-repo', name: 'multi-deploy-repo', cas },
  ];

  const graph = buildCrossCodebaseSystemGraph('was-das-link-test', repositories);
  const das = getCachedDeployableAnalyses(cas);
  const apiUnitId = das.sub_cas_nodes.units.find(u => u.name === 'api')!.id;
  const workerUnitId = das.sub_cas_nodes.units.find(u => u.name === 'worker')!.id;

  const apiApp = graph.applications.find(app => app.name === 'api');
  const workerApp = graph.applications.find(app => app.name === 'worker');
  assert.ok(apiApp, 'api application should be resolved from the promoted CAS');
  assert.ok(workerApp, 'worker application should be resolved from the promoted CAS');
  assert.equal(apiApp!.source_sub_cas_node_id, apiUnitId);
  assert.equal(workerApp!.source_sub_cas_node_id, workerUnitId);
});

test('WAS composition: a non-promoted member CAS leaves source_sub_cas_node_id absent (silent-to-schema fallback, spec §4)', () => {
  const cas = buildNonPromotedCas();
  const repositories: CrossCodebaseInput[] = [
    { path: '/repos/single-deploy-repo', name: 'single-deploy-repo', cas },
  ];
  const graph = buildCrossCodebaseSystemGraph('was-das-fallback-test', repositories);
  for (const app of graph.applications) {
    assert.equal(app.source_sub_cas_node_id, undefined);
  }
});
