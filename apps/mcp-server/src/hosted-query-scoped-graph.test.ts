import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { saveAnalysis, loadCompactAnalysisGraph } from './storage';
import { acquirePinnedAnalysis, computeAgentContextScope, loadAgentContextProjection, loadScopedSemanticCollections, loadScopedSourceInputs, scopedSourceInputsFromRows, markNotComputedOnProjection, selectedNodeIdOf, computeChangeRiskScope, computeScopedQueryScope, computeTestLookupScope, loadScopedGraphSection, planScopedQuery, resolveCompactTarget, scopedQueryCapacityOutcome, scopedQueryTarget, scopedSmallSections } from './hosted-query-scoped-graph';
import { assessChangeRisk, findTests, getErrorContracts } from './query';
import { loadCompleteAnalysisFromSections } from './storage';
import { executeHostedProjectQuery, hostedProjectQuerySections } from './hosted-project-query';
import { attachCasProjection, casCollectionTotal } from './cas-projection';
import { loadAnalysisSectionManifest } from './storage';
import { resolveHostedQueryHeapMb } from './hosted-project-query-process';
import { verifyAgentSourceInputs } from './agent-source-input-verification';
import * as crypto from 'node:crypto';

function fixture(): CASOutput {
  const nodes = Array.from({ length: 40 }, (_, index) => ({
    id: `node-${index}`, name: index === 0 ? 'targetFn' : `helper${index}`, type: 'function', level: 1,
    source: { file: index < 5 ? 'src/target.ts' : `src/other${index}.ts`, line: index + 1 }, qualified_name: index === 0 ? 'src/target.ts:targetFn' : undefined,
  }));
  const edges = [
    { id: 'e-1', source: 'node-1', target: 'node-0', type: 'calls' },
    { id: 'e-2', source: 'node-2', target: 'node-0', type: 'calls' },
    { id: 'e-3', source: 'node-0', target: 'node-3', type: 'calls' },
    { id: 'e-4', source: 'node-3', target: 'node-6', type: 'calls' },
    { id: 'e-5', source: 'node-20', target: 'node-21', type: 'calls' },
    { id: 'e-6', source: 'node-30', target: 'node-31', type: 'calls' },
  ];
  return {
    cas_version: '1.11.0', analysis_id: 'scoped', analysis_timestamp: '2026-09-07T00:00:00.000Z',
    system: { name: 'scoped', type: 'service' },
    nodes, edges, method_calls: [], analysis_facts: [], analyzer_contributions: [], progressive_levels: [],
    patterns: [{ id: 'p-1', name: 'Layered Architecture', node_ids: ['node-0'] }],
    layers_ready: {
      complete: true, generated_at: '2026-09-07T00:00:00.000Z',
      layers: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].map(layer => ({ layer, name: layer, status: 'ready', fields: [] })),
    },
  } as unknown as CASOutput;
}

async function withStorage<T>(fn: (project: string) => Promise<T>): Promise<T> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const previousCanonical = process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE;
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-scoped-graph-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-scoped-project-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE = '1';
  try {
    return await fn(project);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH; else process.env.KLAURO_STORAGE_PATH = previous;
    if (previousCanonical === undefined) delete process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE; else process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE = previousCanonical;
    fs.rmSync(storagePath, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

test('scoped query loads only the target neighborhood from the stored graph section', async () => {
  await withStorage(async project => {
    await saveAnalysis(project, fixture(), 'main', { canonicalSegmented: true });
    const graph = await loadCompactAnalysisGraph(project);
    assert.ok(graph, 'compact graph is written for canonical segmented analyses');
    const target = resolveCompactTarget(graph!, 'targetFn');
    assert.equal(target?.id, 'node-0');
    const scope = computeScopedQueryScope(graph!, target!, { callerLimit: 10, calleeLimit: 10 });
    assert.equal(scope.callerCount, 2);
    assert.equal(scope.calleeCount, 1);
    for (const id of ['node-0', 'node-1', 'node-2', 'node-3', 'node-6', 'node-4']) assert.ok(scope.keepIds.has(id), `${id} kept`);
    assert.ok(!scope.keepIds.has('node-20'), 'unrelated component is not kept');
    const pinned = (await acquirePinnedAnalysis(project))!;
    assert.ok(pinned, 'a read lease pins the current generation');
    try {
      const section = await loadScopedGraphSection(pinned, scope.keepIds);
      assert.ok(section);
      assert.equal(section!.scanned.nodes, 40);
      assert.equal(section!.scanned.edges, 6);
      assert.equal(section!.edgesTruncated, false);
      assert.deepEqual(section!.nodes.map(node => node.id).sort(), [...scope.keepIds].sort());
      assert.deepEqual(section!.edges.map(edge => edge.id).sort(), ['e-1', 'e-2', 'e-3', 'e-4']);
      const plan = await planScopedQuery(pinned, 'get_coding_context', { target: 'src/target.ts:targetFn', caller_limit: 2 });
      assert.ok(plan && 'scope' in plan && plan.scope.targetId === 'node-0' && plan.graphNodeCount === 40);
      const missing = await planScopedQuery(pinned, 'get_coding_context', { target: 'noSuchFunction' });
      assert.deepEqual(missing, { targetNotFound: 'noSuchFunction' });
      assert.equal(await planScopedQuery(pinned, 'get_product_map', {}), null);
    } finally {
      await pinned.release();
    }
  });
});

test('scoped query target extraction follows each tool contract', () => {
  assert.equal(scopedQueryTarget('get_coding_context', { target: ' run ' }), 'run');
  assert.equal(scopedQueryTarget('assess_change_risk', { node_id: 'n1' }), 'n1');
  assert.equal(scopedQueryTarget('find_tests', { file_path: 'src/a.ts' }), undefined);
  assert.equal(scopedQueryTarget('get_product_map', {}), undefined);
});

test('coding-context sections follow include instead of loading every projection', () => {
  assert.deepEqual([...hostedProjectQuerySections('get_coding_context', { include: ['patterns'] })], ['graph', 'quality', 'supplemental']);
  assert.deepEqual([...hostedProjectQuerySections('get_coding_context', { include: ['tests', 'patterns'] })], ['graph', 'quality', 'supplemental', 'tests']);
  assert.deepEqual([...hostedProjectQuerySections('get_coding_context', {})], ['graph', 'quality', 'supplemental', 'tests']);
  assert.ok(!hostedProjectQuerySections('get_coding_context', {}).includes('calls'));
  assert.ok(!hostedProjectQuerySections('get_coding_context', {}).includes('comprehension'));
});

test('hosted query heap never exceeds a fraction of the container cgroup', () => {
  const gib = 1024 * 1024 * 1024;
  const inCgroup = { limitBytes: 2 * gib, availableBytes: gib, source: 'cgroup' as const };
  assert.equal(resolveHostedQueryHeapMb({ KLAURO_HOSTED_QUERY_HEAP_MB: '4096' }, 8 * gib, inCgroup), 1228);
  assert.equal(resolveHostedQueryHeapMb({ KLAURO_ANALYSIS_HEAP_MB: '2432' }, 8 * gib, inCgroup), 1228);
  assert.equal(resolveHostedQueryHeapMb({ KLAURO_HOSTED_QUERY_HEAP_MB: '1024' }, 8 * gib, inCgroup), 1024);
  const onHost = { limitBytes: 8 * gib, availableBytes: 4 * gib, source: 'host' as const };
  assert.equal(resolveHostedQueryHeapMb({ KLAURO_HOSTED_QUERY_HEAP_MB: '4096' }, 8 * gib, onHost), 4096);
});

function parityFixture(): CASOutput {
  const nodes: Array<Record<string, unknown>> = [
    { id: 'svc-class', name: 'BillingService', type: 'class', level: 1, source: { file: 'src/billing/billing-service.ts', line: 3 } },
    { id: 'svc-run', name: 'run', type: 'method', level: 1, source: { file: 'src/billing/billing-service.ts', line: 10 } },
    { id: 'svc-test-fn', name: 'run', type: 'function', level: 1, source: { file: 'src/billing/__tests__/billing-service.test.ts', line: 5 } },
    { id: 'file-node', name: 'billing-service.ts', type: 'file', level: 0, source: { file: 'src/billing/billing-service.ts', line: 1 } },
  ];
  for (let index = 0; index < 40; index += 1) {
    nodes.push({ id: `dup-${index}`, name: 'dupName', type: 'function', level: 1, source: { file: `src/dups/mock${index}.test.ts`, line: 1 } });
  }
  nodes.push({ id: 'dup-real', name: 'dupName', type: 'function', level: 1, source: { file: 'src/dups/real.ts', line: 1 } });
  const edges = [
    { id: 'e-a', source: 'svc-run', target: 'dup-real', type: 'calls' },
    { id: 'e-b', source: 'dup-0', target: 'dup-real', type: 'calls' },
  ];
  return {
    cas_version: '1.11.0', analysis_id: 'parity', analysis_timestamp: '2026-09-07T00:00:00.000Z',
    system: { name: 'parity', type: 'service' },
    nodes, edges, method_calls: [], analysis_facts: [], analyzer_contributions: [], progressive_levels: [],
    layers_ready: {
      complete: true, generated_at: '2026-09-07T00:00:00.000Z',
      layers: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].map(layer => ({ layer, name: layer, status: 'ready', fields: [] })),
    },
  } as unknown as CASOutput;
}

test('compact target resolution follows the coding-target contract for paths, stems, tests, and duplicate names', async () => {
  await withStorage(async project => {
    await saveAnalysis(project, parityFixture(), 'main', { canonicalSegmented: true });
    const graph = (await loadCompactAnalysisGraph(project))!;
    assert.equal(resolveCompactTarget(graph, 'src/billing/billing-service.ts')?.id, 'svc-class');
    assert.equal(resolveCompactTarget(graph, 'billing-service')?.id, 'svc-class');
    assert.equal(resolveCompactTarget(graph, 'billing-service.test.ts')?.id, 'svc-test-fn');
    assert.equal(resolveCompactTarget(graph, 'dupName')?.id, 'dup-real');
    assert.equal(resolveCompactTarget(graph, 'dup-7')?.id, 'dup-7');
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
            const riskPlan = await planScopedQuery(pinned, 'assess_change_risk', { node_id: 'svc-run' });
      assert.ok(riskPlan && 'scope' in riskPlan && riskPlan.scope.targetId === 'svc-run', 'risk is scoped by exact id');
    } finally {
      await pinned.release();
    }
  });
});

test('a pinned generation keeps serving its own records when a same-sized replacement lands', async () => {
  await withStorage(async project => {
    await saveAnalysis(project, fixture(), 'main', { canonicalSegmented: true });
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const replacement = fixture();
      replacement.analysis_timestamp = '2026-09-07T00:00:01.000Z';
      replacement.nodes = replacement.nodes.map(node => ({ ...node, id: node.id.replace('node-', 'other-') }));
      replacement.edges = replacement.edges.map(edge => ({ ...edge, source: edge.source.replace('node-', 'other-'), target: edge.target.replace('node-', 'other-') }));
      await saveAnalysis(project, replacement, 'main', { canonicalSegmented: true });
      const fresh = (await acquirePinnedAnalysis(project))!;
      try {
        assert.notEqual(fresh.segmented.directory, pinned.segmented.directory, 'replacement is a new generation');
        const oldPlan = await planScopedQuery(pinned, 'get_coding_context', { target: 'targetFn' });
        assert.ok(oldPlan && 'scope' in oldPlan && oldPlan.scope.targetId === 'node-0');
        const oldSection = await loadScopedGraphSection(pinned, oldPlan.scope.keepIds);
        assert.ok(oldSection && oldSection.nodes.every(node => node.id.startsWith('node-')), 'pinned load reads the pinned generation only');
        assert.equal(oldSection!.scanned.nodes, 40);
        const newPlan = await planScopedQuery(fresh, 'get_coding_context', { target: 'targetFn' });
        assert.ok(newPlan && 'scope' in newPlan && newPlan.scope.targetId === 'other-0');
      } finally {
        await fresh.release();
      }
    } finally {
      await pinned.release();
    }
  });
});

test('change-risk and test lookups scope by exact node id with complete incident edges and the full upstream closure, matching whole-graph answers', async () => {
  await withStorage(async project => {
    const cas = fixture();
    const nodes = (cas as any).nodes as any[];
    const edges = (cas as any).edges as any[];
    for (let depth = 0; depth < 80; depth += 1) {
      nodes.push({ id: `chain-${depth}`, name: `chain${depth}`, type: 'function', level: 1, source: { file: `src/chain${depth}.ts`, line: 1 } });
      edges.push({ id: `ec-${depth}`, source: `chain-${depth}`, target: depth === 0 ? 'node-0' : `chain-${depth - 1}`, type: 'calls' });
    }
    for (let fan = 0; fan < 200; fan += 1) {
      nodes.push({ id: `fan-${fan}`, name: `fan${fan}`, type: 'function', level: 1, source: { file: `src/fan${fan}.ts`, line: 1 } });
      edges.push({ id: `ef-${fan}`, source: 'node-0', target: `fan-${fan}`, type: 'calls' });
    }
    nodes.push({ id: 'ext-http', name: 'httpClient', type: 'function', level: 1, source: { file: 'src/ext.ts', line: 1 } });
    edges.push({ id: 'e-ext', source: 'node-0', target: 'ext-http', type: 'external_call', category: 'external' });
    nodes.push({ id: 'container-0', name: 'TargetClass', type: 'class', level: 2, source: { file: 'src/target.ts', line: 1 } });
    edges.push({ id: 'e-contains', source: 'container-0', target: 'node-0', type: 'contains' });
    (cas as any).test_suites = [{ id: 'suite-1', name: 'target.test', file_path: 'src/target.test.ts', tests: [{ name: 'covers target', targets: ['node-0'] }], coverage: { nodes_tested: ['node-0'] } }];
    (cas as any).mocks = [{ id: 'mock-1', name: 'targetMock', target_node: 'node-0' }];
    (cas as any).fixtures = [{ id: 'fixture-1', name: 'targetFixture', used_by: ['node-0'] }];
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const graph = (await loadCompactAnalysisGraph(project))!;
    const target = graph.nodeById('node-0')!;
    const risk = computeChangeRiskScope(graph, target);
    assert.equal(risk.incomplete, undefined, 'the scope is complete');
    assert.equal(risk.calleeCount, 202, 'fixture callee, 200 fan-out targets and the external call');
    assert.ok(risk.keepIds.has('ext-http') && risk.keepIds.has('fan-199') && risk.keepIds.has('chain-79') && risk.keepIds.has('container-0'), 'late external edge, full fan-out, 80-deep chain and container are all kept');
    assert.equal(risk.upstreamTruncated, false);
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const byName = await planScopedQuery(pinned, 'assess_change_risk', { node_id: 'targetFn' });
      assert.deepEqual(byName, { targetNotFound: 'targetFn' }, 'risk and tests take exact ids, never fuzzy names');
      const full = (await loadCompleteAnalysisFromSections(project))!;
      const riskPlan = await planScopedQuery(pinned, 'assess_change_risk', { node_id: 'node-0' });
      assert.ok(riskPlan && 'scope' in riskPlan);
      const riskSection = (await loadScopedGraphSection(pinned, (riskPlan as { scope: { keepIds: Set<string> } }).scope.keepIds, graph))!;
      assert.equal(riskSection.edgesTruncated, false);
      const scopedRiskCas = { ...full, nodes: riskSection.nodes, edges: riskSection.edges } as CASOutput;
      const scopedRisk = assessChangeRisk(scopedRiskCas, 'node-0');
      const fullRisk = assessChangeRisk(full, 'node-0');
      assert.deepEqual(JSON.parse(JSON.stringify(scopedRisk)), JSON.parse(JSON.stringify(fullRisk)), 'risk is identical, including the external-dependency factor and the 82-node transitive impact');
      assert.equal(fullRisk.transitive_impact?.affected_count, 82);
      assert.ok(JSON.stringify(fullRisk.risk).includes('external'), 'the late external edge influenced the score');
      const testsPlan = await planScopedQuery(pinned, 'find_tests', { node_id: 'node-0' });
      assert.ok(testsPlan && 'scope' in testsPlan && testsPlan.scope.keepIds.has('chain-0') && !testsPlan.scope.keepIds.has('chain-1'), 'test lookup keeps direct callers, not the closure');
      const testsSection = (await loadScopedGraphSection(pinned, (testsPlan as { scope: { keepIds: Set<string> } }).scope.keepIds, graph))!;
      const scopedTestsCas = { ...full, nodes: testsSection.nodes, edges: testsSection.edges } as CASOutput;
      for (const opts of [{ nodeId: 'node-0' }, { nodeId: 'node-0', limit: 1 }, { nodeId: 'node-0', limit: 5, offset: 1 }]) {
        assert.deepEqual(JSON.parse(JSON.stringify(findTests(scopedTestsCas, opts))), JSON.parse(JSON.stringify(findTests(full, opts))), `find_tests parity for ${JSON.stringify(opts)}`);
      }
      assert.equal(findTests(full, { nodeId: 'node-0' }).total_suites, 1);
    } finally {
      await pinned.release();
    }
    assert.deepEqual(scopedSmallSections('assess_change_risk', ['graph', 'calls', 'tests', 'quality']), ['calls', 'tests', 'quality'], 'risk keeps the reachability index section');
    assert.deepEqual(scopedSmallSections('get_coding_context', ['graph', 'calls', 'quality']), ['quality']);
  });
});

test('a target whose incident edges exceed the bounded scope yields an explicit incomplete outcome, never a partial score', async () => {
  await withStorage(async project => {
    const cas = fixture();
    const nodes = (cas as any).nodes as any[];
    const edges = (cas as any).edges as any[];
    for (let caller = 0; caller < 4100; caller += 1) {
      nodes.push({ id: `caller-${caller}`, name: `caller${caller}`, type: 'function', level: 1, source: { file: `src/callers/c${caller}.ts`, line: 1 } });
      edges.push({ id: `ecall-${caller}`, source: `caller-${caller}`, target: 'node-0', type: 'calls' });
    }
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const graph = (await loadCompactAnalysisGraph(project))!;
    const target = graph.nodeById('node-0')!;
    const risk = computeChangeRiskScope(graph, target);
    assert.match(risk.incomplete || '', /direct callers exceed/);
    assert.equal(risk.truncated, true);
    const outcome = scopedQueryCapacityOutcome('assess_change_risk', risk)!;
    assert.equal(outcome.risk, null);
    assert.equal(outcome.incomplete, true);
    assert.match(String(outcome.reason), /nothing was scored/i);
    const tests = computeTestLookupScope(graph, target);
    assert.match(tests.incomplete || '', /direct callers exceed/);
    assert.equal(scopedQueryCapacityOutcome('find_tests', tests)!.suites, null);
    const complete = computeTestLookupScope(graph, graph.nodeById('node-3')!);
    assert.equal(scopedQueryCapacityOutcome('find_tests', complete), undefined, 'a complete scope answers normally');
    assert.match(String(scopedQueryCapacityOutcome('assess_change_risk', complete, true)!.reason), /loader bound/, 'loader truncation of the induced edge set also refuses');
    assert.equal(scopedQueryCapacityOutcome('get_agent_context', risk), undefined, 'agent context reports gaps instead of refusing');
  });
});

test('get_agent_context on the light-plus-scoped projection matches the whole-graph answer', async () => {
  await withStorage(async project => {
    const cas = fixture();
    const nodes = (cas as any).nodes as any[];
    const edges = (cas as any).edges as any[];
    for (const node of nodes) node.description = `${node.name} does work in ${node.source.file}`;
    nodes.push({ id: 'far-1', name: 'farHelper', type: 'function', level: 1, source: { file: 'src/far.ts', line: 3 }, description: 'unrelated helper' });
    edges.push({ id: 'e-far', source: 'far-1', target: 'node-30', type: 'calls' });
    (cas as any).test_suites = [{ id: 'suite-1', name: 'target.test', file_path: 'src/target.test.ts', tests: [{ name: 'covers target', targets: ['node-0'] }], coverage: { nodes_tested: ['node-0'] } }];
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const full = (await loadCompleteAnalysisFromSections(project))!;
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const args = { task: { task_type: 'modify', target: 'targetFn', instructions: 'change the target' } };
      const plan = await planScopedQuery(pinned, 'get_agent_context', args);
      assert.ok(plan && 'scope' in plan && plan.scope.keepIds.has('node-0'));
      const projection = (await loadAgentContextProjection(pinned, graph, (plan as { scope: any }).scope))!;
      assert.equal(projection.nodes.length, full.nodes.length, 'every node is present, light or full');
      assert.equal(projection.edges.length, full.edges.length, 'every edge is present');
      assert.deepEqual(projection.nodes.map(node => node.id), full.nodes.map(node => node.id), 'original node order');
      assert.deepEqual(projection.edges.map(edge => edge.id), full.edges.map(edge => edge.id), 'original edge order');
      assert.ok(projection.lightNodes > 0 && projection.keepIds.has('node-0') && !projection.keepIds.has('far-1'));
      assert.equal(projection.nodes.find(node => node.id === 'far-1')!.description, undefined, 'far nodes are light');
      assert.equal(projection.nodes.find(node => node.id === 'node-0')!.description, 'targetFn does work in src/target.ts', 'kept nodes carry full records');
      const scopedCas = { ...full, nodes: projection.nodes, edges: projection.edges } as CASOutput;
      const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (key, inner) => (key === 'generated_at' || key === 'scoped_context' || key === 'duration_ms' ? undefined : inner)));
      let unboundedScoped: unknown;
      let unboundedWhole: unknown;
      const scoped = strip(await executeHostedProjectQuery({ cas: scopedCas, tool: 'get_agent_context', args, projectPath: project, observeUnbounded: (_tool, value) => { unboundedScoped = strip(value); } }));
      const whole = strip(await executeHostedProjectQuery({ cas: full, tool: 'get_agent_context', args, projectPath: project, observeUnbounded: (_tool, value) => { unboundedWhole = strip(value); } }));
      const failingObserver = await executeHostedProjectQuery({ cas: full, tool: 'get_agent_context', args, projectPath: project, observeUnbounded: () => { throw new Error('observer broke'); } });
      assert.ok(failingObserver && typeof failingObserver === 'object', 'an observer failure never fails the query');
      assert.equal(scoped.selected_node?.id, 'node-0');
      assert.deepEqual(scoped, whole, 'agent context is identical on the projection');
      const deferred = strip(await executeHostedProjectQuery({ cas: scopedCas, tool: 'get_agent_context', args, projectPath: project, deferBound: true }));
      assert.deepEqual(deferred, unboundedScoped, 'deferBound returns the complete pre-bound body for the worker to bound after diagnostics');
      assert.deepEqual(unboundedScoped, unboundedWhole, 'the complete pre-bound context is identical too');
      const marked = JSON.parse(JSON.stringify(scoped));
      assert.deepEqual(markNotComputedOnProjection(marked), ['work_context.coding_context.conventions'], 'heavy-field global scans are marked explicitly on projections');
      assert.equal(marked.work_context.coding_context.conventions.not_computed, 'bounded-projection');
      let preBound: unknown;
      const transformed = strip(await executeHostedProjectQuery({ cas: scopedCas, tool: 'get_agent_context', args, projectPath: project, transformUnbounded: (_tool, value) => { markNotComputedOnProjection(value); return value; }, observeUnbounded: (_tool, value) => { preBound = strip(value); } }));
      assert.equal(transformed.work_context.coding_context.conventions.not_computed, 'bounded-projection', 'the marker is applied before bounding so it survives the response envelope');
      assert.equal((preBound as any).work_context.coding_context.conventions.not_computed, 'bounded-projection');
      assert.ok(JSON.stringify(unboundedWhole).length >= JSON.stringify(whole).length, 'the unbounded dump is the pre-budget value');
      const second = computeAgentContextScope(graph, ['far-1'], []);
      assert.ok(second.keepIds.has('far-1') && second.keepIds.has('node-30'));
      assert.equal(projection.edgeOrder, 'original');
      assert.equal(projection.fullEdgesTruncated, false);
      const manifest = (await loadAnalysisSectionManifest(project))!;
      assert.equal(manifest.collection_totals?.nodes, full.nodes.length, 'the manifest carries exact per-collection totals');
      assert.equal(manifest.collection_totals?.edges, full.edges.length);
      assert.equal(manifest.collection_totals?.test_suites, 1);
      assert.ok((manifest.collection_bytes?.nodes ?? 0) > 1000 && (manifest.collection_bytes?.system ?? 0) > 0, 'and measured bytes per top-level field');
      const projected = attachCasProjection({ ...full, nodes: full.nodes.slice(0, 3), analysis_facts: [] } as CASOutput, { loaded_sections: ['identity', 'graph'], collection_totals: manifest.collection_totals });
      assert.equal(casCollectionTotal(projected, 'nodes'), full.nodes.length, 'totals come from the generation, not the projected array');
      assert.equal(casCollectionTotal(projected, 'analysis_facts'), 0);
      assert.equal(casCollectionTotal(full, 'edges'), full.edges.length, 'without a projection the array length is the total');
      assert.equal(casCollectionTotal(full, 'no_such_field'), undefined);
    } finally {
      await pinned.release();
    }
    const previousStore = process.env.KLAURO_CAS_RECORD_STORE;
    process.env.KLAURO_CAS_RECORD_STORE = '0';
    const noStoreProject = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-scoped-nostore-'));
    try {
      await saveAnalysis(noStoreProject, fixture(), 'main', { canonicalSegmented: true });
      const noStoreGraph = (await loadCompactAnalysisGraph(noStoreProject))!;
      const noStorePinned = (await acquirePinnedAnalysis(noStoreProject))!;
      try {
        const plan = await planScopedQuery(noStorePinned, 'get_agent_context', { task: { target: 'targetFn' } });
        const streamed = (await loadAgentContextProjection(noStorePinned, noStoreGraph, (plan as { scope: any }).scope))!;
        assert.equal(streamed.source, 'stream');
        assert.equal(streamed.edgeOrder, 'original', 'the stream fallback restores original edge order too');
        assert.equal(streamed.edgeOrderReason, undefined);
        const section = (await loadScopedGraphSection(noStorePinned, new Set(['node-0']), noStoreGraph, { edgeOrderMap: true }))!;
        assert.ok(section.edgeOriginalIndexByOrdinal && section.edgeOriginalIndexByOrdinal.length === noStoreGraph.edgeCount);
        assert.equal(new Set(section.edgeOriginalIndexByOrdinal).size, noStoreGraph.edgeCount, 'every compact ordinal maps to a distinct original index');
        const wholeNoStore = (await loadCompleteAnalysisFromSections(noStoreProject))!;
        assert.deepEqual(streamed.edges.map(edge => edge.id), wholeNoStore.edges.map(edge => edge.id));
        assert.deepEqual(streamed.nodes.map(node => node.id), wholeNoStore.nodes.map(node => node.id));
      } finally {
        await noStorePinned.release();
      }
    } finally {
      if (previousStore === undefined) delete process.env.KLAURO_CAS_RECORD_STORE; else process.env.KLAURO_CAS_RECORD_STORE = previousStore;
      fs.rmSync(noStoreProject, { recursive: true, force: true });
    }
    const pinnedAgain = (await acquirePinnedAnalysis(project))!;
    try {
      assert.ok(pinnedAgain);
    } finally {
      await pinnedAgain.release();
    }
  });
});

test('semantic tables serve method calls, change risks and tests for a scope by node, in original order, with exact totals', async () => {
  await withStorage(async project => {
    const cas = fixture();
    (cas as any).method_calls = [
      { id: 'mc-1', caller_node: 'node-1', target_node: 'node-0', call_details: { method_name: 'targetFn', location: { file: 'src/target.ts', line: 2 } } },
      { id: 'mc-2', caller_node: 'node-0', target_node: 'node-3', call_details: { method_name: 'helper3', location: { file: 'src/target.ts', line: 3 } } },
      { id: 'mc-3', caller_node: 'node-20', target_node: 'node-21', call_details: { method_name: 'helper21', location: { file: 'src/other20.ts', line: 1 } } },
      { id: 'mc-4', caller_node: 'node-2', target_node: 'node-0', call_details: { method_name: 'targetFn', location: { file: 'src/target.ts', line: 4 } } },
    ];
    (cas as any).change_risks = [
      { node_id: 'node-30', risk_level: 'low', risk_factors: [], downstream_impact: { direct_callers: [], transitive_callers: [], affected_call_chains: [], affected_entry_points: [] }, test_protection: { has_direct_tests: false, has_integration_tests: false }, stability_context: { recent_churn: false, bug_fix_density: 0 } },
      { node_id: 'node-0', risk_level: 'high', risk_factors: [{ factor: 'fan-in', severity: 'high', details: 'two callers' }], downstream_impact: { direct_callers: ['node-1', 'node-2'], transitive_callers: [], affected_call_chains: [], affected_entry_points: [] }, test_protection: { has_direct_tests: true, has_integration_tests: false }, stability_context: { recent_churn: false, bug_fix_density: 0 } },
    ];
    (cas as any).test_suites = [
      { id: 'suite-far', name: 'far.test', file_path: 'src/far.test.ts', tests: [{ name: 'far', targets: ['node-30'] }], coverage: { nodes_tested: ['node-30'] } },
      { id: 'suite-1', name: 'target.test', file_path: 'src/target.test.ts', tests: [{ name: 'covers target', targets: ['node-0'] }], coverage: { nodes_tested: ['node-0'] } },
    ];
    (cas as any).mocks = [{ id: 'mock-1', name: 'targetMock', target_node: 'node-0' }, { id: 'mock-far', name: 'farMock', target_node: 'node-30' }];
    (cas as any).fixtures = [{ id: 'fixture-1', name: 'targetFixture', used_by: ['node-0', 'node-1'] }, { id: 'fixture-unreferenced', name: 'sharedFixture' }];
    (cas as any).test_suites.push({ id: 'suite-colocated', name: 'target.spec', file_path: 'src/target.spec.ts', tests: [{ name: 'no explicit targets' }] });
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    assert.ok(manifest.semantic_store, 'the generation carries a semantic store');
    assert.deepEqual(Object.keys(manifest.semantic_store!.tables).sort(), ['change_risks', 'fixtures', 'method_calls', 'mocks', 'test_suites']);
    const graph = (await loadCompactAnalysisGraph(project))!;
    const full = (await loadCompleteAnalysisFromSections(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const plan = await planScopedQuery(pinned, 'assess_change_risk', { node_id: 'node-0' });
      assert.ok(plan && 'scope' in plan);
      const keepIds = (plan as { scope: { keepIds: Set<string> } }).scope.keepIds;
      const semantic = (await loadScopedSemanticCollections(pinned, graph, keepIds, ['method_calls', 'change_risks', 'test_suites', 'mocks', 'fixtures']))!;
      assert.deepEqual((semantic.collections.method_calls as any[]).map(call => call.id), ['mc-1', 'mc-2', 'mc-4'], 'calls touching the scope, original order, far call excluded');
      assert.deepEqual(semantic.projected.method_calls, { total: 4, matched: 3, read: 3 });
      assert.deepEqual((semantic.collections.change_risks as any[]).map(risk => risk.node_id), ['node-0']);
      assert.deepEqual((semantic.collections.test_suites as any[]).map(suite => suite.id), ['suite-1']);
      assert.deepEqual((semantic.collections.mocks as any[]).map(mock => mock.id), ['mock-1']);
      assert.deepEqual((semantic.collections.fixtures as any[]).map(fixture => fixture.id), ['fixture-1']);
      assert.equal(semantic.projected.test_suites.total, 3);
      const section = (await loadScopedGraphSection(pinned, keepIds, graph))!;
      const scopedCas = { ...full, nodes: section.nodes, edges: section.edges, method_calls: semantic.collections.method_calls, change_risks: semantic.collections.change_risks, reachability_index: semantic.collections.reachability_index } as unknown as CASOutput;
      const strip = (value: unknown) => JSON.parse(JSON.stringify(value));
      assert.deepEqual(strip(assessChangeRisk(scopedCas, 'node-0')), strip(assessChangeRisk(full, 'node-0')), 'precomputed risk parity on the semantic subset');
      const scopedTests = strip(findTests(scopedCas, { nodeId: 'node-0' }));
      const fullTests = strip(findTests(full, { nodeId: 'node-0' }));
      assert.deepEqual(scopedTests, fullTests, 'targeted tests and related support retain parity across scoped and full storage');
      assert.ok(!fullTests.fixtures.some((fixture: any) => fixture.id === 'fixture-unreferenced'), 'unreferenced fixtures do not pollute targeted test context');
      assert.ok(findTests(full, {}).fixtures.some((fixture: any) => fixture.id === 'fixture-unreferenced'), 'unreferenced fixtures remain available in the complete inventory');
      assert.ok(fullTests.suites.some((suite: any) => suite.id === 'suite-colocated'), 'the full path ranks the co-located suite without explicit coverage');
      assert.equal(semantic.projected.test_suites?.matched, 1, 'the by-node table alone would have missed the co-located suite, which is why it is not applied');
      assert.deepEqual(strip(getErrorContracts(scopedCas, 'node-0', 'both')), strip(getErrorContracts(full, 'node-0', 'both')), 'error contracts parity on scoped method calls');
      const empty = await loadScopedSemanticCollections(pinned, graph, new Set(['node-20']));
      assert.deepEqual((empty!.collections.method_calls as any[]).map(call => call.id), ['mc-3']);
      assert.deepEqual(empty!.collections.change_risks, []);
      assert.deepEqual(Object.keys(empty!.collections).sort(), ['change_risks', 'method_calls'], 'only node-keyed collections are applied by default; suites rank by file co-location and fixtures are returned whole');
    } finally {
      await pinned.release();
    }
  });
});

test('semantic postings keep every reference past 64 and refuse the whole store rather than publish a partial one', async () => {
  await withStorage(async project => {
    const cas = fixture();
    const nodes = (cas as any).nodes as any[];
    for (let index = 40; index < 120; index += 1) nodes.push({ id: `node-${index}`, name: `helper${index}`, type: 'function', level: 1, source: { file: `src/wide${index}.ts`, line: 1 } });
    const covered = Array.from({ length: 80 }, (_, index) => `node-${40 + index}`);
    (cas as any).test_suites = [{ id: 'suite-wide', name: 'wide.test', file_path: 'src/wide.test.ts', tests: [{ name: 'covers many', targets: covered }], coverage: { nodes_tested: covered } }];
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const last = await loadScopedSemanticCollections(pinned, graph, new Set(['node-119']), ['test_suites']);
      assert.deepEqual((last!.collections.test_suites as any[]).map(suite => suite.id), ['suite-wide'], 'the 80th referenced node still finds its suite');
      assert.deepEqual(last!.projected.test_suites, { total: 1, matched: 1, read: 1 });
      assert.equal(pinned.segmented.manifest.semantic_store!.tables.test_suites!.postings, 80);
    } finally {
      await pinned.release();
    }
    const previous = process.env.KLAURO_CAS_SEMANTIC_MAX_POSTINGS;
    process.env.KLAURO_CAS_SEMANTIC_MAX_POSTINGS = '10';
    const tiny = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-semantic-tiny-'));
    try {
      await saveAnalysis(tiny, cas, 'main', { canonicalSegmented: true });
      const manifest = (await loadAnalysisSectionManifest(tiny))!;
      assert.equal(manifest.semantic_store, undefined, 'over budget skips the whole semantic store, no partial descriptor');
      assert.ok(manifest.record_store, 'the record store and canonical save are unaffected');
      const tinyPinned = (await acquirePinnedAnalysis(tiny))!;
      try {
        assert.ok(!fs.readdirSync(tinyPinned.segmented.directory).some(file => file.startsWith('semantic.')), 'no semantic files are left behind');
        assert.equal(await loadScopedSemanticCollections(tinyPinned, (await loadCompactAnalysisGraph(tiny))!, new Set(['node-0'])), null, 'consumers fall back to whole sections');
      } finally {
        await tinyPinned.release();
      }
    } finally {
      if (previous === undefined) delete process.env.KLAURO_CAS_SEMANTIC_MAX_POSTINGS; else process.env.KLAURO_CAS_SEMANTIC_MAX_POSTINGS = previous;
      fs.rmSync(tiny, { recursive: true, force: true });
    }
  });
});

test('selected node id and not-computed markers resolve through raw, bounded-envelope and compact response shapes', () => {
  const raw = { selected_node: { id: 'n-raw' }, work_context: { coding_context: { conventions: { async_style: 'async-await' } } } };
  const enveloped = { truncated: true, has_more: true, data: { selected_node: { id: 'n-env' }, work_context: { coding_context: { conventions: { async_style: 'callbacks' } } } } };
  const compact = { selected_node_id: 'n-compact' };
  assert.equal(selectedNodeIdOf(raw), 'n-raw');
  assert.equal(selectedNodeIdOf(enveloped), 'n-env');
  assert.equal(selectedNodeIdOf(compact), 'n-compact');
  assert.equal(selectedNodeIdOf({ target: { node_id: 'n-target' } }), 'n-target');
  assert.equal(selectedNodeIdOf({}), undefined);
  assert.deepEqual(markNotComputedOnProjection(raw), ['work_context.coding_context.conventions']);
  assert.deepEqual(markNotComputedOnProjection(enveloped), ['work_context.coding_context.conventions'], 'the marker finds the path under a bounded data envelope');
  assert.equal((enveloped.data.work_context.coding_context.conventions as any).not_computed, 'bounded-projection');
  assert.deepEqual(markNotComputedOnProjection(compact), []);
});

function sourceInputFixture(): CASOutput {
  const cas = fixture();
  const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  (cas as any).source_input_root = '/analysis/root';
  (cas as any).source_input_catalog = { status: 'shared' };
  (cas as any).source_input_identities = [
    { path: 'src/target.ts', status: 'captured', representation: 'utf8-text', sha256: sha('export const targetFn = 1;\n'), bytes: 27 },
    { path: 'src/other6.ts', status: 'captured', representation: 'utf8-text', sha256: sha('six\n'), bytes: 4 },
    { path: 'src/target.ts', status: 'conflicting', reason: 'captured-then-unavailable', error_code: 'EIO' },
    { path: 'src/historical.ts', status: 'captured', representation: 'utf8-text', sha256: sha('gone\n'), bytes: 5 },
    { path: 'src/other20.ts', status: 'unavailable', reason: 'unsupported-text-encoding' },
  ];
  (cas as any).analyzer_contributions = [
    { analyzer_id: 'typescript', source_inputs: { version: 2, coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 1, identity_indices: [0, 1] } },
    { analyzer_id: 'no-inputs' },
    { analyzer_id: 'imports', source_inputs: { version: 2, coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 0, identity_indices: [2, 4] } },
    { analyzer_id: 'incremental', source_inputs: { version: 2, coverage: 'unavailable', digest_algorithm: 'sha256', reason: 'incremental-input-identities-not-refreshed', outside_root_reads: 0, identity_indices: [] } },
  ];
  return cas;
}

test('the semantic store serves source input identities by cited path, joined only to current envelopes, and feeds the verifier unchanged', async () => {
  await withStorage(async project => {
    await saveAnalysis(project, sourceInputFixture(), 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    const extras = manifest.semantic_store!.extras!;
    assert.ok(extras.source_inputs, 'the generation carries the source input table');
    assert.equal(extras.source_inputs!.row_count, 4, 'only rows referenced by current envelopes are stored');
    assert.equal(extras.source_inputs!.path_count, 3);
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const nodes = graph.nodeById('node-0') && graph.nodeById('node-6') ? [{ id: 'node-0', source: { file: './src/target.ts' } }, { id: 'node-6', source: { file: 'src\\other6.ts' } }, { id: 'node-9', source: { file: 'src/other9.ts' } }] : [];
      const loaded = await loadScopedSourceInputs(pinned, graph, nodes as any);
      assert.ok(loaded && 'cas' in loaded, `expected a scoped source input view, got ${JSON.stringify(loaded)}`);
      const view = loaded as Exclude<typeof loaded, null | { gap: string }>;
      assert.deepEqual(view.projected, { paths_requested: 3, paths_matched: 2, rows: 3, identities: 3, envelopes: 3, table_paths: 3, table_rows: 4, paths_truncated: false });
      assert.equal(view.cas.source_input_root, '/analysis/root');
      assert.deepEqual(view.cas.source_input_catalog, { status: 'shared' });
      assert.deepEqual(view.cas.source_input_identities.map(identity => [identity.path, identity.status]), [['src/other6.ts', 'captured'], ['src/target.ts', 'captured'], ['src/target.ts', 'conflicting']]);
      assert.ok(!view.cas.source_input_identities.some(identity => identity.path === 'src/historical.ts'), 'an unreferenced historical row never becomes a baseline');
      const envelopes = view.cas.analyzer_contributions;
      assert.deepEqual(envelopes.map(envelope => [envelope.analyzer_id, envelope.source_inputs.coverage, envelope.source_inputs.identity_indices]), [
        ['typescript', 'observed-reads', [0, 1]],
        ['imports', 'observed-reads', [2]],
        ['incremental', 'unavailable', []],
      ]);
      assert.equal(envelopes[0].source_inputs.outside_root_reads, 1);
      assert.equal(envelopes[2].source_inputs.reason, 'incremental-input-identities-not-refreshed');

      fs.mkdirSync(path.join(project, 'src'), { recursive: true });
      fs.writeFileSync(path.join(project, 'src/target.ts'), 'export const targetFn = 1;\n');
      fs.writeFileSync(path.join(project, 'src/other6.ts'), 'SIX\n');
      const verified = verifyAgentSourceInputs(project, ['src/target.ts', 'src/other6.ts', 'src/other9.ts'], envelopes, {}, view.cas.source_input_identities);
      assert.deepEqual(verified.results.map(result => [result.file, result.status, result.reason]), [
        ['src/target.ts', 'unverified', 'conflicting-input-identities'],
        ['src/other6.ts', 'mismatched', undefined],
        ['src/other9.ts', 'unverified', 'analyzed-content-identity-unavailable'],
      ]);
      const onlyTarget = scopedSourceInputsFromRows({ rows: [{ contribution: 0, identity: view.cas.source_input_identities[1] }], root: '/analysis/root', catalog: null, contributions: [{ index: 0, analyzer_id: 'typescript', coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 0 }] });
      const matched = verifyAgentSourceInputs(project, ['src/target.ts'], onlyTarget.analyzer_contributions, {}, onlyTarget.source_input_identities);
      assert.deepEqual(matched.results.map(result => [result.file, result.status]), [['src/target.ts', 'matched']]);
    } finally {
      await pinned.release();
    }
  });
});

test('source input tables are skipped with an explicit reason when the catalog is unnormalized, and absent for generations without identities', async () => {
  await withStorage(async project => {
    const cas = sourceInputFixture();
    (cas as any).source_input_catalog = { status: 'unnormalized', reason: 'invalid-reference' };
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    assert.equal(manifest.semantic_store!.extras!.source_inputs, undefined);
    assert.match(manifest.semantic_store!.extras!.source_inputs_skipped!, /unnormalized \(invalid-reference\)/);
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const loaded = await loadScopedSourceInputs(pinned, graph, [{ id: 'node-0', source: { file: 'src/target.ts' } }] as any);
      assert.ok(loaded && 'gap' in loaded && /unnormalized/.test(loaded.gap));
    } finally {
      await pinned.release();
    }
  });
  await withStorage(async project => {
    const cas = sourceInputFixture();
    (cas as any).analyzer_contributions[0].source_inputs = { version: 1, coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 0, files: [] };
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    assert.match(manifest.semantic_store!.extras!.source_inputs_skipped!, /version 1/);
  });
  await withStorage(async project => {
    await saveAnalysis(project, fixture(), 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    assert.equal(manifest.semantic_store?.extras?.source_inputs, undefined);
    assert.equal(manifest.semantic_store?.extras?.source_inputs_skipped, undefined);
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const loaded = await loadScopedSourceInputs(pinned, graph, [{ id: 'node-0', source: { file: 'src/target.ts' } }] as any);
      assert.ok(loaded && 'gap' in loaded && /no source input table/.test(loaded.gap));
    } finally {
      await pinned.release();
    }
  });
});

test('a malformed path on a current source input reference skips the table explicitly while malformed historical rows are ignored', async () => {
  await withStorage(async project => {
    const cas = sourceInputFixture();
    (cas as any).source_input_identities.push({ path: '../outside/escape.ts', status: 'captured', representation: 'utf8-text', sha256: 'a'.repeat(64), bytes: 1 });
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    let manifest = (await loadAnalysisSectionManifest(project))!;
    assert.ok(manifest.semantic_store!.extras!.source_inputs, 'an unreferenced malformed historical row does not block the table');
    assert.equal(manifest.semantic_store!.extras!.source_inputs!.row_count, 4);
  });
  await withStorage(async project => {
    const cas = sourceInputFixture();
    (cas as any).source_input_identities.push({ path: 'src\\escaped\\path.ts', status: 'captured', representation: 'utf8-text', sha256: 'b'.repeat(64), bytes: 1 });
    (cas as any).analyzer_contributions[2].source_inputs.identity_indices.push(5);
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    assert.equal(manifest.semantic_store!.extras!.source_inputs, undefined);
    assert.match(manifest.semantic_store!.extras!.source_inputs_skipped!, /malformed path/);
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const loaded = await loadScopedSourceInputs(pinned, graph, [{ id: 'node-0', source: { file: 'src/target.ts' } }] as any);
      assert.ok(loaded && 'gap' in loaded && /malformed path/.test(loaded.gap));
    } finally {
      await pinned.release();
    }
  });
});
