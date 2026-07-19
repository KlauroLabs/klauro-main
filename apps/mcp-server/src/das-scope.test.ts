import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeCasToDasUnit,
  getCachedDeployableAnalyses,
  buildDeployableAnalyses,
} from './deployable-analysis';
import * as query from './query';
import { buildCrossCodebaseSystemGraph, type CrossCodebaseInput } from './cross-codebase-analysis';
import type { CASNode, CASEdge, CASEntryPoint, CASOutput, DeployableEvidence } from '../../../packages/analyzer-core/src/types/cas.types';

/**
 * DAS PHASE 2 — product-surface wiring tests (docs/SPEC-DEPLOYABLE-ANALYSIS.md
 * §4, §6). Phase 1 (deployable-analysis.test.ts) proves the slicing primitive
 * in isolation; this file proves the pieces phase 2 wires it INTO:
 *  - get_summary's das_index discovery surface + scoped-vs-rollup counts,
 *  - scope propagating cleanly through query.ts's existing read functions
 *    (search_nodes's contract, via query.searchNodes),
 *  - the unknown-id / non-promoted error paths a caller actually sees,
 *  - WAS's source_das_unit_id linkage (spec §4's three-hop provenance).
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

/** Same 2-unit promoted shape as deployable-analysis.test.ts's fixture (api +
 *  worker compose services sharing libs/shared, plus 2 ungated bins) — kept
 *  local so this file exercises the product surface without depending on
 *  another test file's internals. */
function buildPromotedCas(analysisId = 'das-scope-promoted'): CASOutput {
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
    analysis_id: 'das-scope-non-promoted',
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

test('scopeCasToDasUnit: omitted scope returns the same CAS unchanged (existing callers unaffected)', () => {
  const cas = buildPromotedCas();
  assert.equal(scopeCasToDasUnit(cas, undefined), cas);
});

test('get_summary product surface: promoted CAS exposes das_index; rollup counts cover the whole repo', () => {
  const cas = buildPromotedCas();
  const das = getCachedDeployableAnalyses(cas);
  assert.equal(das.promoted, true);
  assert.equal(das.das_index.units.length, 2);
  assert.deepEqual(das.das_index.units.map(u => u.name).sort(), ['api', 'worker']);

  const rollupSummary = query.buildSummary(scopeCasToDasUnit(cas, undefined));
  assert.equal(rollupSummary.nodes, 6); // all 6 nodes, unscoped rollup
});

test('get_summary product surface: scoped summary reflects the UNIT, not the rollup (counts differ)', () => {
  const cas = buildPromotedCas();
  const das = getCachedDeployableAnalyses(cas);
  const apiUnitId = das.das_index.units.find(u => u.name === 'api')!.id;

  const scopedCas = scopeCasToDasUnit(cas, { das_unit_id: apiUnitId });
  const scopedSummary = query.buildSummary(scopedCas);

  // api's slice is A1, A2, S1 (3 nodes) — strictly less than the 6-node rollup,
  // and specifically NOT equal to it (the honesty bar the task asked for).
  assert.equal(scopedSummary.nodes, 3);
  assert.notEqual(scopedSummary.nodes, query.buildSummary(cas).nodes);
  assert.equal(scopedSummary.entry_points, 1);
});

test('getCachedDeployableAnalyses: repeat calls on the same analysis_id reuse the cached result (identity-equal)', () => {
  const cas = buildPromotedCas('das-scope-cache-check');
  const first = getCachedDeployableAnalyses(cas);
  const second = getCachedDeployableAnalyses(cas);
  assert.equal(first, second);
  // A structurally-identical-but-distinct CAS object with a different
  // analysis_id must NOT hit the same cache entry.
  const differentAnalysis = { ...cas, analysis_id: 'das-scope-cache-check-2' };
  const third = getCachedDeployableAnalyses(differentAnalysis);
  assert.notEqual(first, third);
});

test('search_nodes contract: scoped search only returns nodes inside the unit\'s reachability closure', () => {
  const cas = buildPromotedCas();
  const das = getCachedDeployableAnalyses(cas);
  const workerUnitId = das.das_index.units.find(u => u.name === 'worker')!.id;
  const scopedCas = scopeCasToDasUnit(cas, { das_unit_id: workerUnitId });

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

test('scopeCasToDasUnit: unknown das_unit_id throws a helpful error naming available units', () => {
  const cas = buildPromotedCas();
  assert.throws(
    () => scopeCasToDasUnit(cas, { das_unit_id: 'das:does-not-exist' }),
    (error: Error) => {
      assert.match(error.message, /Unknown scope\.das_unit_id/);
      assert.match(error.message, /api/);
      assert.match(error.message, /worker/);
      return true;
    }
  );
});

test('scopeCasToDasUnit: non-promoted repo has no das_index and a scope param errors gracefully', () => {
  const cas = buildNonPromotedCas();
  const das = getCachedDeployableAnalyses(cas);
  assert.equal(das.promoted, false);
  assert.equal(das.das_index.units.length, 0);

  assert.equal(scopeCasToDasUnit(cas, undefined), cas);
  assert.throws(
    () => scopeCasToDasUnit(cas, { das_unit_id: 'das:anything' }),
    /has not promoted to a Deployable-Analysis Workspace/
  );
});

test('WAS composition: a promoted member CAS tags its matching WorkspaceDeployable rows with source_das_unit_id', () => {
  const cas = buildPromotedCas('das-scope-was-link');
  const repositories: CrossCodebaseInput[] = [
    { path: '/repos/multi-deploy-repo', name: 'multi-deploy-repo', cas },
  ];

  const graph = buildCrossCodebaseSystemGraph('was-das-link-test', repositories);
  const das = getCachedDeployableAnalyses(cas);
  const apiUnitId = das.das_index.units.find(u => u.name === 'api')!.id;
  const workerUnitId = das.das_index.units.find(u => u.name === 'worker')!.id;

  const apiApp = graph.applications.find(app => app.name === 'api');
  const workerApp = graph.applications.find(app => app.name === 'worker');
  assert.ok(apiApp, 'api application should be resolved from the promoted CAS');
  assert.ok(workerApp, 'worker application should be resolved from the promoted CAS');
  assert.equal(apiApp!.source_das_unit_id, apiUnitId);
  assert.equal(workerApp!.source_das_unit_id, workerUnitId);
});

test('WAS composition: a non-promoted member CAS leaves source_das_unit_id absent (silent-to-schema fallback, spec §4)', () => {
  const cas = buildNonPromotedCas();
  const repositories: CrossCodebaseInput[] = [
    { path: '/repos/single-deploy-repo', name: 'single-deploy-repo', cas },
  ];
  const graph = buildCrossCodebaseSystemGraph('was-das-fallback-test', repositories);
  for (const app of graph.applications) {
    assert.equal(app.source_das_unit_id, undefined);
  }
});
