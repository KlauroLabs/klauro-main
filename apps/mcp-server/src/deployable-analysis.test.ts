import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldPromote,
  tierQualifiedShipUnits,
  sliceDeployableAnalysis,
  buildDeployableAnalyses,
  materializeDeployableCasTree,
  resolveSubCasNodeScope,
  scopeCasToSubCasNode,
} from './deployable-analysis';
import type { CASNode, CASEdge, CASEntryPoint, CASOutput, DeployableEvidence } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildReachabilityIndexFromCas, buildReachabilityIndex, callEdgePairs } from '../../../packages/analyzer-core/src/analyzer/core/reachability-index';
import { materializeNodeUnderstandingContracts } from '../../../packages/analyzer-core/src/analyzer/core/flow-concepts';
import { validateUnderstandingContractIntegrity } from '../../../packages/analyzer-core/src/analyzer/core/understanding-contract-integrity';

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
 * their own entry point, a libs/shared utility both call into, 2 declared bin
 * targets, and two rows with NO ship artifact of their own (a server-entry and
 * a package identity) that must never become units.
 */
function buildFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node('A1', 'apps/api/handler.ts'),
    node('A2', 'apps/api/other.ts'),
    node('W1', 'apps/worker/worker.ts'),
    node('S1', 'libs/shared/util.ts'),
    node('B1', 'bin/tool1/index.ts'),
    node('B2', 'bin/tool2/index.ts'),
    node('X1', 'scripts/adhoc.ts'),
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
    { root_path: 'bin/tool1', name: 'tool1', tier: 2, kind: 'bin', evidence: ['package.json bin["tool1"] = "index.ts" (bin/tool1/package.json)'] },
    { root_path: 'bin/tool2', name: 'tool2', tier: 2, kind: 'bin', evidence: ['package.json bin["tool2"] = "index.ts" (bin/tool2/package.json)'] },
    { root_path: 'scripts', name: 'scripts', tier: 2, kind: 'server-entry', evidence: ['HTTP entry point: GET /x (scripts/adhoc.ts:3)'] },
    { root_path: '.', name: 'the-monorepo', tier: 3, kind: 'package', evidence: ['package.json name: the-monorepo'] },
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

test('tierQualifiedShipUnits: qualification is ship evidence, not cardinality', () => {
  const cas = buildFixtureCas();
  const qualified = tierQualifiedShipUnits(cas.deployable_evidence);
  // 2 compose services + 2 declared bin targets. The server-entry (a route
  // handler, not a build target) and the package identity never qualify.
  assert.deepEqual(qualified.map(q => q.name).sort(), ['api', 'tool1', 'tool2', 'worker']);
});

test('tierQualifiedShipUnits: a script with no ship artifact yields no unit', () => {
  const evidence: DeployableEvidence[] = [
    { root_path: 'services/api', name: 'api', tier: 1, kind: 'container', evidence: ['docker:api'] },
    { root_path: 'scripts', name: 'scripts', tier: 2, kind: 'server-entry', evidence: ['HTTP entry point: GET /health (scripts/dev.ts:9)'] },
    { root_path: '.', name: 'repo', tier: 3, kind: 'package', evidence: ['package.json name: repo'] },
    { root_path: 'docker', name: 'builder', tier: 3, kind: 'build-image', evidence: ['build-infra: excluded from ship-unit tier (builds for api)'] },
  ];
  const qualified = tierQualifiedShipUnits(evidence);
  assert.deepEqual(qualified.map(q => q.name), ['api']);
});

test('tierQualifiedShipUnits: a multi-binary workspace yields one unit per binary (gate flipped)', () => {
  const evidence: DeployableEvidence[] = [
    {
      root_path: '.', name: 'installer', tier: 1, kind: 'installer',
      evidence: ['installer:bundle'], ships_paths: ['bin0', 'bin1'], entrypoint_member: 'bin0',
    },
    ...Array.from({ length: 8 }, (_, i) => ({
      root_path: `bin/bin${i}`, name: `bin${i}`, tier: 2 as const, kind: 'bin' as const,
      evidence: [`src/main.rs present, no [[bin]] override (bin/bin${i}/src/main.rs)`],
    })),
  ];
  // bin0/bin1 are named in the installer's ships_paths, so the evidence-gated
  // bundling pass has already made them MEMBERS of that ship unit.
  const withBundling = evidence.map(e =>
    (e.name === 'bin0' || e.name === 'bin1') ? { ...e, bundled_into: 'installer' } : e);
  const qualified = tierQualifiedShipUnits(withBundling);
  // 1 installer + the 6 binaries it does NOT bundle. Under the old cardinality
  // gate every one of those 6 was rejected for existing alongside the others.
  assert.deepEqual(
    qualified.map(q => q.name).sort(),
    ['bin2', 'bin3', 'bin4', 'bin5', 'bin6', 'bin7', 'installer'],
  );
});

test('tierQualifiedShipUnits: one binary declared twice by the same toolchain is one unit', () => {
  const evidence: DeployableEvidence[] = [
    { root_path: '.', name: 'version', tier: 2, kind: 'bin', evidence: ['Cargo.toml [[bin]] name = "version" (Cargo.toml)'] },
    { root_path: 'src', name: 'version', tier: 2, kind: 'bin', evidence: ['src/bin entry: src/bin/version.rs'] },
    { root_path: 'crates/agent', name: 'agent', tier: 2, kind: 'bin', evidence: ['src/main.rs present, no [[bin]] override (crates/agent/src/main.rs)'] },
  ];
  const qualified = tierQualifiedShipUnits(evidence);
  assert.deepEqual(qualified.map(q => q.name).sort(), ['agent', 'version']);
  // The survivor is the row that names a concrete entry file.
  assert.equal(qualified.find(q => q.name === 'version')!.root_path, 'src');
});

test('tierQualifiedShipUnits: 4 independent Dockerfile services => count 4, microservices monorepo promotes (spec §8)', () => {
  const evidence: DeployableEvidence[] = ['a', 'b', 'c', 'd'].map(name => ({
    root_path: `services/${name}`, name, tier: 1, kind: 'container', evidence: [`docker:${name}`],
  }));
  assert.equal(tierQualifiedShipUnits(evidence).length, 4);
  assert.equal(shouldPromote({ deployable_evidence: evidence }), true);
});

test('shouldPromote: single-deployable CAS never promotes, and says so in numbers', () => {
  const evidence: DeployableEvidence[] = [
    { root_path: '.', name: 'app', tier: 1, kind: 'container', evidence: ['docker:app'] },
  ];
  assert.equal(shouldPromote({ deployable_evidence: evidence }), false);

  const cas = { deployable_evidence: evidence, nodes: [node('N1', 'src/main.ts')] } as unknown as CASOutput;
  const result = buildDeployableAnalyses(cas);
  assert.equal(result.promoted, false);
  assert.equal(result.units.length, 0);
  assert.equal(result.sub_cas_nodes.units.length, 0);
  // "1 found, not promoted" must be distinguishable from "found nothing".
  assert.equal(result.sub_cas_nodes.qualified_unit_count, 1);
  assert.equal(result.sub_cas_nodes.promotion_threshold, 2);
  assert.match(result.sub_cas_nodes.reason, /1 tier-qualified ship unit found \(app\)/);
  assert.equal(result.sub_cas_nodes.graph_node_count, 1);

  const noEvidence = { deployable_evidence: [], nodes: [] } as unknown as CASOutput;
  const empty = buildDeployableAnalyses(noEvidence);
  assert.equal(empty.sub_cas_nodes.qualified_unit_count, 0);
  assert.match(empty.sub_cas_nodes.reason, /No tier-qualified ship unit found/);
});

test('file-expanded child nodes retain transitive behavioral evidence without importing unrelated code', () => {
  const cas = buildFixtureCas();
  cas.nodes.push(
    node('S2', 'libs/shared/util.ts'),
    node('C1', 'libs/client/client.ts'),
    node('C2', 'libs/client/client.ts'),
    node('D1', 'libs/decoder/decode.ts'),
  );
  cas.edges.push(callEdge('S2', 'C1'), callEdge('C2', 'D1'), callEdge('D1', 'S2'));
  materializeNodeUnderstandingContracts(cas);
  assert.deepEqual(validateUnderstandingContractIntegrity(cas), []);
  const original = JSON.stringify(cas);
  for (const persisted of [false, true]) {
    const input = persisted ? { ...cas, reachability_index: buildReachabilityIndexFromCas(cas) } : cas;
    const child = sliceDeployableAnalysis(input, cas.deployable_evidence![0]).slice;
    assert.deepEqual(child.nodes.map(n => n.id).sort(), ['A1', 'A2', 'C1', 'C2', 'D1', 'S1', 'S2']);
    assert.deepEqual(child.edges, cas.edges.filter(e => !['W1'].includes(e.source)));
    assert.deepEqual(validateUnderstandingContractIntegrity(child), []);
    for (const n of child.nodes) assert.deepEqual(n.contract, cas.nodes.find(parent => parent.id === n.id)!.contract);
  }
  assert.equal(JSON.stringify(cas), original);
});

test('child closure retains call evidence targeting exit records outside the node collection', () => {
  const cas = buildFixtureCas();
  cas.nodes.push(node('S2', 'libs/shared/util.ts'));
  cas.exit_points = [{ id: 'exit-S2', source_node: 'S2', type: 'sdk', name: 'invoke', target: { sdk: 'dependency' } }];
  cas.edges.push(callEdge('S2', 'exit-S2'));
  materializeNodeUnderstandingContracts(cas);
  const child = sliceDeployableAnalysis(cas, cas.deployable_evidence![0]).slice;
  assert.ok(!cas.nodes.some(n => n.id === 'exit-S2'));
  assert.ok(child.edges.some(e => e.target === 'exit-S2'));
  assert.deepEqual(child.exit_points, cas.exit_points);
  assert.deepEqual(child.nodes.find(n => n.id === 'S2')!.contract, cas.nodes.find(n => n.id === 'S2')!.contract);
  assert.deepEqual(validateUnderstandingContractIntegrity(child), []);
});

test('child closure preserves every behavioral edge kind used by node contracts', () => {
  for (const type of ['delegates_to', 'branches_to', 'continues_to'] as const) {
    const cas = buildFixtureCas();
    cas.nodes.push(node('TARGET', 'libs/behavior/target.ts'));
    cas.edges.push({ ...callEdge('S1', 'TARGET'), type });
    materializeNodeUnderstandingContracts(cas);
    cas.reachability_index = buildReachabilityIndexFromCas(cas);
    const child = sliceDeployableAnalysis(cas, cas.deployable_evidence![0]).slice;
    assert.ok(child.nodes.some(n => n.id === 'TARGET'), type);
    assert.deepEqual(validateUnderstandingContractIntegrity(child), [], type);
    assert.ok(!child.nodes.some(n => n.id === 'W1'));
  }
});

test('slices carry their reachability closure, shared code is tagged and counted honestly', () => {
  const cas = buildFixtureCas();
  const result = buildDeployableAnalyses(cas);

  assert.equal(result.promoted, true);
  assert.equal(result.units.length, 4);

  const apiUnit = result.units.find(u => u.unit_name === 'api')!;
  const workerUnit = result.units.find(u => u.unit_name === 'worker')!;
  const tool1Unit = result.units.find(u => u.unit_name === 'tool1')!;

  const apiNodeIds = apiUnit.slice.nodes.map(n => n.id).sort();
  const workerNodeIds = workerUnit.slice.nodes.map(n => n.id).sort();

  // api's slice: its own nodes + the shared util it calls. worker's: its own +
  // the shared util. Neither ever contains the other's exclusive code.
  assert.deepEqual(apiNodeIds, ['A1', 'A2', 'S1']);
  assert.deepEqual(workerNodeIds, ['S1', 'W1']);
  // Each declared bin target is now its own unit instead of an orphan.
  assert.deepEqual(tool1Unit.slice.nodes.map(n => n.id), ['B1']);

  // Shared-code attribution (spec §2.2): S1 is reached by both units, with
  // exactly one canonical owner.
  const apiS1Meta = apiUnit.slice.nodes.find(n => n.id === 'S1')!.metadata as any;
  const workerS1Meta = workerUnit.slice.nodes.find(n => n.id === 'S1')!.metadata as any;
  const owners = [apiS1Meta?.attribution, workerS1Meta?.attribution];
  assert.equal(owners.filter(a => a === 'owned').length, 1);
  assert.equal(owners.filter(a => a === 'shared').length, 1);

  // Entry points scoped by closure membership — no cross-contamination.
  assert.deepEqual(apiUnit.slice.entry_points!.map(e => e.id), ['ep_api']);
  assert.deepEqual(workerUnit.slice.entry_points!.map(e => e.id), ['ep_worker']);

  // Honest coverage accounting: exclusive + shared + orphan === the graph, the
  // union is reported, and the sum of unit counts is allowed to exceed it by
  // exactly the shared multiplicity (S1 counted in 2 units).
  const idx = result.sub_cas_nodes;
  assert.equal(idx.graph_node_count, 7);
  assert.equal(idx.covered_node_count, 6);          // X1 (the script) is in no unit
  assert.equal(idx.orphan_node_count, 1);
  assert.deepEqual(idx.orphan_node_ids, ['X1']);
  assert.equal(idx.exclusive_node_count + idx.shared_node_count + idx.orphan_node_count, idx.graph_node_count);
  assert.equal(idx.shared_node_count, 1);
  assert.equal(idx.sum_of_unit_node_counts, 7);     // 3 + 2 + 1 + 1 = covered + 1 shared reuse
  assert.ok(idx.sum_of_unit_node_counts > idx.covered_node_count);
  assert.equal(idx.coverage_ratio, Math.round((6 / 7) * 10000) / 10000);

  // exclusive + owned-shared summed over units reconstructs the union exactly.
  const reconstructed = idx.units.reduce((sum, u) => sum + u.exclusive_node_count + u.owned_shared_node_count, 0);
  assert.equal(reconstructed, idx.covered_node_count);

  // Per-unit node_count matches the slice, and the seed basis cites evidence.
  const apiIndexEntry = idx.units.find(u => u.name === 'api')!;
  assert.equal(apiIndexEntry.node_count, apiUnit.slice.nodes.length);
  assert.deepEqual(apiIndexEntry.seed_basis, ['root:apps/api']);
  const tool1IndexEntry = idx.units.find(u => u.name === 'tool1')!;
  assert.equal(tool1IndexEntry.exclusive_node_count, 1);
  assert.equal(tool1IndexEntry.shared_node_count, 0);
});

test('deployable child CAS projects deep intelligence layers without sibling leakage', () => {
  const cas = buildFixtureCas();
  Object.assign(cas, {
    call_chains: [
      { id: 'chain-api', chain_type: 'entry-to-exit', entry_point: { node_id: 'A1', method_name: 'A1' }, call_path: [{ call_id: 'c1', node_id: 'A2', method_name: 'A2', depth: 1 }], characteristics: {}, risk_analysis: {} },
      { id: 'chain-worker', chain_type: 'entry-to-exit', entry_point: { node_id: 'W1', method_name: 'W1' }, call_path: [], characteristics: {}, risk_analysis: {} },
    ],
    behavioral_invariants: [
      { id: 'inv-api', name: 'api invariant', invariant_type: 'business-rule', description: '', scope: { node_ids: ['A1'] }, enforcement: [{ source: 'code', mechanism: 'A1', confidence: 'enforced', node_id: 'A1' }], evidence: [{ source: 'node', id: 'A1' }], confidence: 'high' },
      { id: 'inv-worker', name: 'worker invariant', invariant_type: 'business-rule', description: '', scope: { node_ids: ['W1'] }, enforcement: [{ source: 'code', mechanism: 'W1', confidence: 'enforced', node_id: 'W1' }], evidence: [{ source: 'node', id: 'W1' }], confidence: 'high' },
    ],
    behavioral_invariant_summary: { total: 2, by_type: { 'business-rule': 2 }, by_confidence: { high: 2 }, enforced: 2, inferred: 0, missing: 0, gaps: [] },
    security_boundaries: [
      { id: 'boundary-api', name: 'api auth', boundary_type: 'authentication', enforcement_points: [{ node_id: 'A1', mechanism: 'guard', confidence: 'enforced' }], trust_transition: { from_trust_level: 'untrusted', to_trust_level: 'trusted' }, sensitive_operations: ['api write'] },
      { id: 'boundary-worker', name: 'worker auth', boundary_type: 'authentication', enforcement_points: [{ node_id: 'W1', mechanism: 'guard', confidence: 'enforced' }], trust_transition: { from_trust_level: 'untrusted', to_trust_level: 'trusted' }, sensitive_operations: ['worker write'] },
    ],
    flow_coverage: [
      { call_chain_id: 'chain-api', coverage_status: 'fully-covered', tested_segments: [{ node_id: 'A1', test_ids: ['test-api'], assertion_count: 1 }], untested_segments: [], test_quality: { has_unit_tests: true, has_integration_tests: false, has_e2e_tests: false, uses_mocks: false } },
      { call_chain_id: 'chain-worker', coverage_status: 'not-covered', tested_segments: [], untested_segments: [{ node_id: 'W1', importance: 'high', reason: 'missing' }], test_quality: { has_unit_tests: false, has_integration_tests: false, has_e2e_tests: false, uses_mocks: false } },
    ],
    test_gaps: [
      { gap_type: 'untested-branch', location: { node_id: 'A2' }, severity: 'medium', recommendation: 'cover api branch' },
      { gap_type: 'untested-flow', location: { node_id: 'W1' }, severity: 'high', recommendation: 'cover worker' },
    ],
    idiom_violations: [
      { id: 'idiom-api', idiom_id: 'idiom', category: 'error-handling', severity: 'warning', file: 'apps/api/handler.ts', node_id: 'A1', description: '', recommendation: '' },
      { id: 'idiom-worker', idiom_id: 'idiom', category: 'error-handling', severity: 'warning', file: 'apps/worker/worker.ts', node_id: 'W1', description: '', recommendation: '' },
    ],
    change_risks: [
      { node_id: 'A1', risk_level: 'high', risk_factors: [], downstream_impact: { direct_callers: [], transitive_callers: [], affected_call_chains: ['chain-api'], affected_entry_points: ['ep_api'] }, test_protection: { has_direct_tests: true, has_integration_tests: false }, stability_context: { recent_churn: false, commit_count_30d: 0, bug_fix_density: 0 } },
      { node_id: 'W1', risk_level: 'low', risk_factors: [], downstream_impact: { direct_callers: [], transitive_callers: [], affected_call_chains: ['chain-worker'], affected_entry_points: ['ep_worker'] }, test_protection: { has_direct_tests: false, has_integration_tests: false }, stability_context: { recent_churn: false, commit_count_30d: 0, bug_fix_density: 0 } },
    ],
    temporal_stability: [
      { node_id: 'A1', stability_score: 1, stability_class: 'stable', churn_metrics: { commits_30d: 0, commits_90d: 0, unique_authors_30d: 0, lines_changed_30d: 0 }, quality_signals: { bug_fix_rate: 0, refactor_frequency: 'rare', has_recent_regression: false }, age_context: { file_age_days: 1, is_legacy: false } },
      { node_id: 'W1', stability_score: 1, stability_class: 'stable', churn_metrics: { commits_30d: 0, commits_90d: 0, unique_authors_30d: 0, lines_changed_30d: 0 }, quality_signals: { bug_fix_rate: 0, refactor_frequency: 'rare', has_recent_regression: false }, age_context: { file_age_days: 1, is_legacy: false } },
    ],
    test_suites: [
      { id: 'suite-api', name: 'api', file_path: 'tests/api.test.ts', test_type: 'unit', framework: 'node:test', tests: [{ id: 'test-api', name: 'api', test_type: 'unit', targets: ['A1'], status: { skipped: false, focused: false, flaky: false } }] },
      { id: 'suite-worker', name: 'worker', file_path: 'tests/worker.test.ts', test_type: 'unit', framework: 'node:test', tests: [{ id: 'test-worker', name: 'worker', test_type: 'unit', targets: ['W1'], status: { skipped: false, focused: false, flaky: false } }] },
    ],
  });

  const api = buildDeployableAnalyses(cas).units.find(unit => unit.unit_name === 'api')!.slice;
  assert.deepEqual(api.behavioral_invariants?.map(item => item.id), ['inv-api']);
  assert.equal(api.behavioral_invariant_summary?.total, 1);
  assert.deepEqual(api.security_boundaries?.map(item => item.id), ['boundary-api']);
  assert.deepEqual(api.flow_coverage?.map(item => item.call_chain_id), ['chain-api']);
  assert.deepEqual(api.test_gaps?.map(item => item.recommendation), ['cover api branch']);
  assert.deepEqual(api.idiom_violations?.map(item => item.id), ['idiom-api']);
  assert.deepEqual(api.change_risks?.map(item => item.node_id), ['A1']);
  assert.deepEqual(api.temporal_stability?.map(item => item.node_id), ['A1']);
  assert.deepEqual(api.test_suites?.map(item => item.id), ['suite-api']);
  assert.ok(api.terminality?.nodes.every(item => item.id !== 'W1'));
});

test('materializes deployables as conformant child CAS objects with stable parent links', () => {
  const tree = materializeDeployableCasTree(buildFixtureCas());
  assert.equal(tree.id, 'cas:sys1');
  assert.equal(tree.parent_id, null);
  assert.equal(tree.composition_mode, 'derived');
  assert.equal(tree.children?.length, 4);
  for (const child of tree.children || []) {
    assert.match(child.id || '', /^cas:/);
    assert.equal(child.parent_id, tree.id);
    assert.equal(child.composition_mode, undefined);
    assert.equal(child.children, undefined);
    assert.ok(Array.isArray(child.nodes));
    assert.ok(Array.isArray(child.edges));
    assert.ok(Array.isArray(child.analyzer_contributions));
    assert.ok(child.progressive_levels);
    assert.equal(scopeCasToSubCasNode(tree, { sub_cas_node_id: child.id! }), child);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(tree)), tree);
});

/**
 * Task #100 (docs/SPEC-MATHEMATICAL-INTELLIGENCE.md): the persisted
 * `cas.reachability_index` now includes 'invokes' edges, so sub-CAS-node slicing reuses it
 * (ReachabilityIndex.from) instead of always rebuilding its own. Proves two
 * things at once: (1) a unit's closure still follows an 'invokes' dispatch
 * edge the same way it always followed 'calls' (no regression), and (2) the
 * slice produced when the CAS carries a persisted index is byte-identical to
 * the slice produced when it doesn't (the rebuild fallback path) — the reuse
 * is a speedup, never a semantic change.
 */
test('sub-CAS closure follows invokes edges via the persisted index, and reuse equals rebuild', () => {
  const cas = buildFixtureCas();
  // A1 -invokes-> a dispatch-only node (no literal 'calls' edge) that must
  // still land inside api's slice, exactly like S1 does via 'calls'.
  const dispatched = node('D1', 'apps/api/dispatched-handler.ts');
  cas.nodes = [...cas.nodes, dispatched];
  cas.edges = [...cas.edges, { id: 'edge_A1_D1', source: 'A1', target: 'D1', type: 'invokes' } as CASEdge];

  const withoutIndex = buildDeployableAnalyses(cas);
  const apiWithout = withoutIndex.units.find(u => u.unit_name === 'api')!;
  assert.ok(
    apiWithout.slice.nodes.some(n => n.id === 'D1'),
    'invokes-dispatched node must be in the closure (rebuild path)'
  );

  const casWithIndex: CASOutput = {
    ...cas,
    reachability_index: buildReachabilityIndexFromCas({ nodes: cas.nodes, edges: cas.edges, method_calls: [] }),
  };
  const withIndex = buildDeployableAnalyses(casWithIndex);
  const apiWith = withIndex.units.find(u => u.unit_name === 'api')!;
  assert.ok(
    apiWith.slice.nodes.some(n => n.id === 'D1'),
    'invokes-dispatched node must be in the closure (reused persisted-index path)'
  );

  // Reuse produces the exact same slice as rebuild — node sets, entry points,
  // and the sub_cas_nodes summary all match.
  assert.deepEqual(
    apiWith.slice.nodes.map(n => n.id).sort(),
    apiWithout.slice.nodes.map(n => n.id).sort()
  );
  assert.deepEqual(withIndex.sub_cas_nodes, withoutIndex.sub_cas_nodes);
});

/**
 * Task #100 compatibility proof: a CAS stored BEFORE 'invokes' was added to
 * the persisted index's closure carries a `reachability_index` with no
 * `includes_invokes_edges` flag. Before this fix, sub-CAS-node slicing ignored the persisted
 * index entirely and always rebuilt its own (invokes-inclusive) one, so such
 * an analysis already got the wider closure. Reuse-when-present must not
 * regress that: a stale, flag-less index must be rejected and rebuilt, never
 * trusted just because `cas.reachability_index` is truthy.
 */
test('a stored index without invokes-edge coverage is not trusted', () => {
  const cas = buildFixtureCas();
  const dispatched = node('D1', 'apps/api/dispatched-handler.ts');
  cas.nodes = [...cas.nodes, dispatched];
  cas.edges = [...cas.edges, { id: 'edge_A1_D1', source: 'A1', target: 'D1', type: 'invokes' } as CASEdge];

  // The OLD persisted shape: built over the OLD edge set (calls + method_calls
  // only, via callEdgePairs), no includes_invokes_edges flag — exactly what
  // buildReachabilityIndexFromCas used to emit before this fix.
  const staleIndex = buildReachabilityIndex(
    cas.nodes.map(n => n.id),
    callEdgePairs({ nodes: cas.nodes, edges: cas.edges, method_calls: [] })
  );
  assert.equal((staleIndex as any).includes_invokes_edges, undefined, 'fixture must reproduce the pre-fix shape');

  const staleCas: CASOutput = { ...cas, reachability_index: staleIndex };
  const result = buildDeployableAnalyses(staleCas);
  const apiUnit = result.units.find(u => u.unit_name === 'api')!;
  assert.ok(
    apiUnit.slice.nodes.some(n => n.id === 'D1'),
    'a stale pre-fix index must be rejected, not silently narrow the closure'
  );
});

test('a monorepo with app dirs covers >90% of nodes', () => {
  const nodes: CASNode[] = [
    ...Array.from({ length: 20 }, (_, i) => node(`api${i}`, 'apps/api/src/a.ts')),
    ...Array.from({ length: 20 }, (_, i) => node(`web${i}`, 'apps/web/src/w.ts')),
    ...Array.from({ length: 10 }, (_, i) => node(`lib${i}`, 'packages/shared/src/s.ts')),
  ];
  const edges: CASEdge[] = [
    ...Array.from({ length: 10 }, (_, i) => callEdge('api0', `lib${i}`)),
    ...Array.from({ length: 10 }, (_, i) => callEdge('web0', `lib${i}`)),
  ];
  const cas = {
    cas_version: '1.0.0',
    analysis_id: 'monorepo',
    system: { id: 's', name: 'monorepo', type: 'monorepo', root_path: '.' },
    nodes,
    edges,
    entry_points: [],
    exit_points: [],
    deployable_evidence: [
      { root_path: 'apps/api', name: 'api', tier: 1, kind: 'container', evidence: ['docker:api'] },
      { root_path: 'apps/web', name: 'web', tier: 1, kind: 'container', evidence: ['docker:web'] },
    ],
  } as unknown as CASOutput;

  const { sub_cas_nodes } = buildDeployableAnalyses(cas);
  assert.ok(sub_cas_nodes.coverage_ratio > 0.9, `coverage ${sub_cas_nodes.coverage_ratio} must exceed 0.9`);
  assert.equal(sub_cas_nodes.orphan_node_count, 0);
  assert.equal(sub_cas_nodes.shared_node_count, 10);
});

test('a repo-root ship declaration does not blanket-match the whole repo', () => {
  // Both compose services have root_path '.', the normal shape for a
  // `build: .` context; each ships one bin whose crate dir is the real root.
  const nodes: CASNode[] = [
    node('AG1', 'bin/agent/src/main.rs'),
    node('AG2', 'bin/agent/src/lib.rs'),
    node('CO1', 'bin/coordinator/src/main.rs'),
    node('OT1', 'tools/unrelated/x.rs'),
  ];
  const cas = {
    cas_version: '1.0.0',
    analysis_id: 'root-context',
    system: { id: 's', name: 'workspace', type: 'monorepo', root_path: '.' },
    nodes,
    edges: [],
    entry_points: [],
    exit_points: [],
    deployable_evidence: [
      { root_path: '.', name: 'agent', tier: 1, kind: 'compose-service', evidence: ['compose service: agent'], ships_paths: ['agent'] },
      { root_path: '.', name: 'coordinator', tier: 1, kind: 'compose-service', evidence: ['compose service: coordinator'], ships_paths: ['coordinator'] },
      { root_path: 'bin/agent', name: 'agent', tier: 2, kind: 'bin', bundled_into: 'agent', evidence: ['src/main.rs present, no [[bin]] override (bin/agent/src/main.rs)'] },
      { root_path: 'bin/coordinator', name: 'coordinator', tier: 2, kind: 'bin', bundled_into: 'coordinator', evidence: ['src/main.rs present, no [[bin]] override (bin/coordinator/src/main.rs)'] },
    ],
  } as unknown as CASOutput;

  const { units, sub_cas_nodes } = buildDeployableAnalyses(cas);
  assert.equal(units.length, 2);
  const agent = units.find(u => u.unit_name === 'agent')!;
  const coordinator = units.find(u => u.unit_name === 'coordinator')!;
  // Each unit gets the crate its ship evidence actually names — never the repo.
  // The unrelated tools/ tree belongs to neither and stays an honest orphan.
  assert.deepEqual(agent.slice.nodes.map(n => n.id).sort(), ['AG1', 'AG2']);
  assert.deepEqual(coordinator.slice.nodes.map(n => n.id), ['CO1']);
  assert.equal(sub_cas_nodes.shared_node_count, 0);
  assert.equal(sub_cas_nodes.orphan_node_count, 1); // tools/unrelated, honestly reported
  assert.deepEqual(sub_cas_nodes.orphan_node_ids, ['OT1']);
});

test('sibling build targets in one directory are told apart by their own entry files', () => {
  // A crate whose src/bin/ holds two targets: the shared `src` root cannot
  // discriminate between them, so each is seeded by its own entry file only.
  const nodes: CASNode[] = [
    node('SP1', 'crates/host/src/bin/spike.rs'),
    node('HO1', 'crates/host/src/bin/host.rs'),
    node('LIB', 'crates/host/src/lib.rs'),
  ];
  const cas = {
    cas_version: '1.0.0',
    analysis_id: 'siblings',
    system: { id: 's', name: 'workspace', type: 'monorepo', root_path: '.' },
    nodes,
    edges: [callEdge('HO1', 'LIB')],
    entry_points: [],
    exit_points: [],
    deployable_evidence: [
      { root_path: 'crates/host/src', name: 'spike', tier: 2, kind: 'bin', evidence: ['Cargo target spike'], entry_files: ['crates/host/src/bin/spike.rs'] },
      { root_path: 'crates/host/src', name: 'host', tier: 2, kind: 'bin', evidence: ['Cargo target host'], entry_files: ['crates/host/src/bin/host.rs'] },
    ],
  } as unknown as CASOutput;

  const { units } = buildDeployableAnalyses(cas);
  const spike = units.find(u => u.unit_name === 'spike')!;
  const host = units.find(u => u.unit_name === 'host')!;
  assert.deepEqual(spike.slice.nodes.map(n => n.id), ['SP1']);
  // host also carries the lib it calls — file-complete, and not spike's code.
  assert.deepEqual(host.slice.nodes.map(n => n.id).sort(), ['HO1', 'LIB']);
});

test("a slice's comprehension payload excludes other units' flows and resolves its own related_flows", () => {
  const cas = buildFixtureCas();
  (cas as any).capabilities = [
    {
      id: 'cap_api', name: 'Api', description: '', category: 'core',
      operations: [
        { entry_point_id: 'ep_api', entry_point_type: 'http', action: 'read' },
        { entry_point_id: 'ep_worker', entry_point_type: 'http', action: 'read' },
      ],
      related_entities: [], related_domains: [], criticality: 'high', criticality_factors: [],
      related_flows: [
        { flow_id: 'flow::ep_api', role: 'primary', rationale: '' },
        { flow_id: 'flow::ep_worker', role: 'primary', rationale: '' },
      ],
    },
  ];
  (cas as any).flow_graph = {
    capability_candidates: [
      {
        id: 'cap_api', name: 'Api', description: '', entry_points: ['ep_api', 'ep_worker'],
        entry_point_summary: { types: ['http'], count: 2, primary_type: 'http' },
        operations: [], operation_patterns: [], services_used: [], exit_points: [], call_chain_ids: [],
        complexity_profile: { avg_depth: 0, max_depth: 0, has_external_calls: false, has_database_calls: false, has_async_calls: false, branching_factor: 0 },
        classification: 'primary', criticality: 'high',
        signals: { domain_concept_score: 0, centrality_score: 0, coverage_score: 0, complexity_score: 0, total_score: 0 },
        depends_on: [], depended_by: [],
      },
    ],
    flows: [
      { flow_id: 'flow::ep_api', name: 'api flow', intent: '', entry_point: 'ep_api', capability_ids: ['cap_api'], step_count: 1 },
      { flow_id: 'flow::ep_worker', name: 'worker flow', intent: '', entry_point: 'ep_worker', capability_ids: ['cap_api'], step_count: 1 },
    ],
    dependencies: [],
    topology: { root_capabilities: [], leaf_capabilities: [], critical_path: [], max_depth: 0 },
    primary_flow: { core_capability_id: 'cap_api', value_chain: [], supporting_capabilities: [], infrastructure_capabilities: [] },
    layers: [],
    system_insights: { detected_patterns: [], primary_entry_type: 'http', data_flow_type: '' },
  };
  (cas as any).flows = [
    { flow_id: 'flow::ep_api', name: 'api flow', intent: '', entry_point: 'ep_api', capability_id: 'cap_api', capability_relationships: [{ capability_id: 'cap_api', role: 'primary', rationale: '' }], entities: [], contract: { input: [], logic: '', side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] }, steps: [] },
    { flow_id: 'flow::ep_worker', name: 'worker flow', intent: '', entry_point: 'ep_worker', capability_id: 'cap_api', capability_relationships: [{ capability_id: 'cap_api', role: 'primary', rationale: '' }], entities: [], contract: { input: [], logic: '', side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] }, steps: [] },
  ];

  const { units } = buildDeployableAnalyses(cas);
  const apiUnit = units.find(u => u.unit_name === 'api')!;

  // Only the flow rooted in THIS unit's entry point — sharing a capability with
  // the worker's flow is not containment.
  assert.deepEqual(apiUnit.slice.flows!.map(f => f.flow_id), ['flow::ep_api']);
  assert.deepEqual(apiUnit.slice.flow_graph!.capability_candidates[0].entry_points, ['ep_api']);
  // related_flows resolve to flows present IN this slice.
  const related = (apiUnit.slice.capabilities as any[])[0].related_flows.map((r: any) => r.flow_id);
  assert.deepEqual(related, ['flow::ep_api']);
  const sliceFlowIds = new Set(apiUnit.slice.flows!.map(f => f.flow_id));
  for (const flowId of related) assert.ok(sliceFlowIds.has(flowId), `${flowId} must resolve in the slice`);
  // Operations are narrowed to this unit's own entry points too.
  assert.deepEqual((apiUnit.slice.capabilities as any[])[0].operations.map((o: any) => o.entry_point_id), ['ep_api']);
});

test('resolveSubCasNodeScope: looks up a unit by id, undefined for unknown/non-promoted', () => {
  const cas = buildFixtureCas();
  const { units } = buildDeployableAnalyses(cas);
  const apiId = units.find(u => u.unit_name === 'api')!.sub_cas_node_id;

  const resolved = resolveSubCasNodeScope(cas, apiId);
  assert.ok(resolved);
  assert.equal(resolved!.unit_name, 'api');

  assert.equal(resolveSubCasNodeScope(cas, 'cas:nonexistent'), undefined);

  const singleDeployableCas = {
    ...cas,
    deployable_evidence: [{ root_path: '.', name: 'app', tier: 1, kind: 'container', evidence: [] }],
  } as CASOutput;
  assert.equal(resolveSubCasNodeScope(singleDeployableCas, apiId), undefined);
});

test('sliceDeployableAnalysis: single-unit call still produces a CASOutput-shaped slice (no new object model)', () => {
  const cas = buildFixtureCas();
  cas.dependencies = { manager: 'npm', packages: [{ name: 'dependency', version: '1.0.0', direct: true }] };
  cas.external_services = [{ id: 'external', name: 'external', type: 'api' }];
  cas.configuration = { environment_variables: [], config_files: [] } as any;
  cas.runtime = { platform: 'node', version: '22' } as any;
  const apiEvidence = cas.deployable_evidence!.find(e => e.name === 'api')!;
  const slice = sliceDeployableAnalysis(cas, apiEvidence);

  assert.equal(slice.unit_name, 'api');
  assert.equal(slice.root_path, 'apps/api');
  assert.equal(slice.slice.id, slice.sub_cas_node_id);
  assert.equal(slice.slice.parent_id, 'cas:sys1');
  assert.equal(slice.slice.analysis_id, `test-analysis:${slice.sub_cas_node_id}`);
  assert.ok(Array.isArray(slice.slice.nodes));
  assert.ok(Array.isArray(slice.slice.edges));
  assert.ok(Array.isArray(slice.slice.entry_points));
  assert.equal(slice.slice.system.name, 'api');
  assert.equal(slice.slice.system.root_path, 'apps/api');
  assert.equal(slice.slice.dependencies, cas.dependencies);
  assert.equal(slice.slice.external_services, cas.external_services);
  assert.equal(slice.slice.configuration, cas.configuration);
  assert.equal(slice.slice.runtime, cas.runtime);
});

test('materialization preserves authoritative recursive children instead of replacing them with derived deployables', () => {
  const cas = buildFixtureCas();
  const child: CASOutput = {
    cas_version: cas.cas_version,
    id: 'authoritative-child',
    parent_id: 'cas:sys1',
    label: 'authoritative child',
    analysis_timestamp: cas.analysis_timestamp,
    analysis_id: 'authoritative-child-analysis',
    system: { id: 'child-system', name: 'child', type: 'service', root_path: 'apps/child' },
    nodes: [node('C1', 'apps/child/index.ts')],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
  };
  cas.id = 'cas:sys1';
  cas.children = [child];
  cas.composition_mode = 'composed';

  const tree = materializeDeployableCasTree(cas);

  assert.equal(tree.composition_mode, 'composed');
  assert.equal(tree.children?.length, 1);
  assert.equal(tree.children?.[0].id, 'authoritative-child');
  assert.deepEqual(tree.children?.[0].nodes, child.nodes);
});

// ---------------------------------------------------------------------------
// 2026-08-10 regression: collapseDuplicateClosureUnits over-collapsed a real
// multi-service repo into one unit named after the packaging tool
// ---------------------------------------------------------------------------

/**
 * A ten-service-shaped microservices monorepo fixture: 3 real first-party
 * Spring-Cloud-style services (each its own directory, its own files, its
 * own entry point) plus 2 third-party monitoring services (grafana-server,
 * prometheus-server) declared the way a docker-compose `image: grafana/grafana`
 * row is — a Tier-1 compose-service evidence row with NO first-party source
 * of its own, root_path '.', and evidence lines that never resolve to a
 * concrete file. This is exactly the shape v1.0.138 broke on: two services
 * with no first-party closure of their own.
 */
function buildMicroservicesFixtureCas(): CASOutput {
  const nodes: CASNode[] = [
    node('AS1', 'admin-server/src/main/java/Admin.java'),
    node('AS2', 'admin-server/src/main/java/AdminOther.java'),
    node('AG1', 'api-gateway/src/main/java/Gateway.java'),
    node('AG2', 'api-gateway/src/main/java/GatewayOther.java'),
    node('CS1', 'customers-service/src/main/java/Customers.java'),
    node('CS2', 'customers-service/src/main/java/CustomersOther.java'),
  ];
  const edges: CASEdge[] = [];
  const entry_points: CASEntryPoint[] = [
    entryPoint('ep_admin', 'admin-server/src/main/java/Admin.java', 'AS1'),
    entryPoint('ep_gateway', 'api-gateway/src/main/java/Gateway.java', 'AG1'),
    entryPoint('ep_customers', 'customers-service/src/main/java/Customers.java', 'CS1'),
  ];
  const deployable_evidence: DeployableEvidence[] = [
    { root_path: 'admin-server', name: 'admin-server', tier: 1, kind: 'compose-service', evidence: ['Compose service: admin-server (docker-compose.yml)'] },
    { root_path: 'api-gateway', name: 'api-gateway', tier: 1, kind: 'compose-service', evidence: ['Compose service: api-gateway (docker-compose.yml)'] },
    { root_path: 'customers-service', name: 'customers-service', tier: 1, kind: 'compose-service', evidence: ['Compose service: customers-service (docker-compose.yml)'] },
    // Third-party images: no first-party source directory, so their evidence
    // never resolves an entry file or a concrete root of their own.
    { root_path: '.', name: 'grafana-server', tier: 1, kind: 'compose-service', evidence: ['Compose service: grafana-server (docker-compose.yml)', 'image: grafana/grafana'] },
    { root_path: '.', name: 'prometheus-server', tier: 1, kind: 'compose-service', evidence: ['Compose service: prometheus-server (docker-compose.yml)', 'image: prom/prometheus'] },
  ];

  return {
    cas_version: '1.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'test-analysis-microservices',
    system: { id: 'sys2', name: 'petclinic-like', type: 'monorepo', root_path: '.' },
    nodes,
    edges,
    entry_points,
    exit_points: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
    deployable_evidence,
  } as unknown as CASOutput;
}

test('REGRESSION collapseDuplicateClosureUnits: a third-party image service with no first-party closure never absorbs or is absorbed by a named sibling', () => {
  const cas = buildMicroservicesFixtureCas();
  const { promoted, units, sub_cas_nodes } = buildDeployableAnalyses(cas);

  // All 5 evidence rows are real, distinct ship declarations. None of them
  // duplicate each other's artifact, so none should be collapsed.
  assert.deepEqual(sub_cas_nodes.duplicate_units_collapsed, []);
  assert.equal(sub_cas_nodes.qualified_unit_count, 5);
  assert.equal(promoted, true);
  assert.deepEqual(
    units.map(u => u.unit_name).sort(),
    ['admin-server', 'api-gateway', 'customers-service', 'grafana-server', 'prometheus-server'],
  );

  // The invariant the previous lane's own postmortem flags as the tell:
  // a real slice covers something. grafana-server's blanket-fallback closure
  // is a courtesy (never claimed as evidence of identity), not zero, but the
  // named first-party services must each keep their OWN exclusive nodes.
  const admin = units.find(u => u.unit_name === 'admin-server')!;
  assert.deepEqual(admin.slice.nodes.map(n => n.id).sort(), ['AS1', 'AS2']);
  const gateway = units.find(u => u.unit_name === 'api-gateway')!;
  assert.deepEqual(gateway.slice.nodes.map(n => n.id).sort(), ['AG1', 'AG2']);
});

test('REGRESSION collapseDuplicateClosureUnits: two universal-closure image rows do not merge with each other either (no discriminating evidence on either side)', () => {
  const cas = buildMicroservicesFixtureCas();
  const { sub_cas_nodes } = buildDeployableAnalyses(cas);
  assert.equal(
    sub_cas_nodes.duplicate_units_collapsed.some(d => d.dropped_name === 'grafana-server' || d.dropped_name === 'prometheus-server'),
    false,
  );
});

test('collapseDuplicateClosureUnits: a near-empty closure is not admissible evidence of duplication (min closure size)', () => {
  const cas = buildMicroservicesFixtureCas();
  // A sixth row whose concrete root resolves to a directory with no CAS
  // nodes at all (a config-only folder, e.g. docker/otel-collector holding
  // just a YAML file) — its closure is a legitimately empty/near-empty set,
  // not evidence that it IS admin-server just because admin-server's own
  // small closure would trivially "contain" it.
  const evidence = [
    ...cas.deployable_evidence!,
    { root_path: 'docker/otel-collector', name: 'otel-collector', tier: 1, kind: 'compose-service' as const, evidence: ['Compose service: otel-collector (docker-compose.yml)'] },
  ];
  const withEmptyRow = { ...cas, deployable_evidence: evidence } as CASOutput;
  const { sub_cas_nodes, units } = buildDeployableAnalyses(withEmptyRow);
  assert.deepEqual(sub_cas_nodes.duplicate_units_collapsed, []);
  assert.equal(units.length, 6);
});

test('collapseDuplicateClosureUnits: a collapse whose survivor would be a bare tooling noun is refused outright', () => {
  const cas = buildMicroservicesFixtureCas();
  // Two evidence rows describing the SAME real artifact (admin-server) — one
  // named for the service, one a generic top-level row literally named
  // "docker" that happens to share admin-server's exact root and files
  // (e.g. a duplicate Tier-1 row from an unmerged override manifest). Real
  // duplication, but the survivor-naming guard must still refuse to let the
  // bare-tooling-noun row be the one that survives.
  const dockerDupe: DeployableEvidence = {
    root_path: 'admin-server', name: 'docker', tier: 1, kind: 'compose-service',
    evidence: ['Compose service: admin-server (docker-compose.yml)', 'Compose service: admin-server (docker-compose.override.yml)'],
  };
  const withDupe = { ...cas, deployable_evidence: [...cas.deployable_evidence!, dockerDupe] } as CASOutput;
  const { sub_cas_nodes } = buildDeployableAnalyses(withDupe);
  assert.equal(sub_cas_nodes.duplicate_units_collapsed.some(d => d.kept_name === 'docker'), false);
});

test('collapseDuplicateClosureUnits still collapses a genuine same-artifact duplicate (triple-counting fix preserved)', () => {
  const cas = buildFixtureCas();
  // 'api' declared twice under two evidence rows resolving the identical
  // closure (a compose row and a container row the evidence layer failed to
  // join) — both rows carry real, discriminating evidence (their own entry
  // files), so the overlap here IS trustworthy.
  const apiTwin: DeployableEvidence = {
    root_path: 'apps/api', name: 'api-container-twin', tier: 1, kind: 'container',
    evidence: ['Dockerfile ENTRYPOINT (apps/api/Dockerfile)', 'entry: apps/api/handler.ts'],
  };
  const withTwin = {
    ...cas,
    deployable_evidence: [...cas.deployable_evidence!, apiTwin],
  } as CASOutput;
  const { sub_cas_nodes, units, promoted } = buildDeployableAnalyses(withTwin);
  assert.equal(promoted, true);
  // 5 qualified rows in (api, worker, tool1, tool2, api-container-twin) minus
  // the one genuine duplicate collapsed away.
  assert.equal(sub_cas_nodes.qualified_unit_count, 4);
  assert.equal(units.length, 4);
  assert.equal(sub_cas_nodes.duplicate_units_collapsed.length, 1);
  const collapsed = sub_cas_nodes.duplicate_units_collapsed[0];
  assert.deepEqual([collapsed.dropped_name, collapsed.kept_name].sort(), ['api', 'api-container-twin'].sort());
  assert.equal(sub_cas_nodes.graph_node_count, 7);
});
