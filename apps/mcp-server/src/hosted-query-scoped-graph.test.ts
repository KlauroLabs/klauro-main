import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { saveAnalysis, loadCompactAnalysisGraph } from './storage';
import { acquirePinnedAnalysis, computeChangeRiskScope, computeScopedQueryScope, loadScopedGraphSection, planScopedQuery, resolveCompactTarget, scopedQueryTarget, scopedSmallSections } from './hosted-query-scoped-graph';
import { assessChangeRisk, findTests } from './query';
import { loadCompleteAnalysisFromSections } from './storage';
import { hostedProjectQuerySections } from './hosted-project-query';
import { resolveHostedQueryHeapMb } from './hosted-project-query-process';

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

test('change-risk and test lookups scope by exact node id with the full upstream closure, and match the whole-graph answers', async () => {
  await withStorage(async project => {
    const cas = fixture();
    (cas as any).edges.push({ id: 'e-7', source: 'node-7', target: 'node-1', type: 'calls' }, { id: 'e-8', source: 'node-8', target: 'node-7', type: 'calls' }, { id: 'e-9', source: 'node-9', target: 'node-8', type: 'calls' });
    await saveAnalysis(project, cas, 'main', { canonicalSegmented: true });
    const graph = (await loadCompactAnalysisGraph(project))!;
    const target = graph.nodeById('node-0')!;
    const risk = computeChangeRiskScope(graph, target);
    for (const id of ['node-1', 'node-2', 'node-7', 'node-8', 'node-9']) assert.ok(risk.keepIds.has(id), `${id} is in the upstream closure`);
    assert.equal(risk.upstreamNodes, 6, 'target plus five transitive callers');
    assert.equal(risk.upstreamTruncated, false);
    assert.ok(!risk.keepIds.has('node-20'));
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const byName = await planScopedQuery(pinned, 'assess_change_risk', { node_id: 'targetFn' });
      assert.deepEqual(byName, { targetNotFound: 'targetFn' }, 'risk and tests take exact ids, never fuzzy names');
      const plan = await planScopedQuery(pinned, 'assess_change_risk', { node_id: 'node-0' });
      assert.ok(plan && 'scope' in plan && plan.scope.keepIds.has('node-9'));
      const testsPlan = await planScopedQuery(pinned, 'find_tests', { node_id: 'node-0' });
      assert.ok(testsPlan && 'scope' in testsPlan && testsPlan.scope.keepIds.has('node-1') && !testsPlan.scope.keepIds.has('node-9'), 'test lookup keeps the neighborhood only');
      const section = (await loadScopedGraphSection(pinned, (plan as { scope: { keepIds: Set<string> } }).scope.keepIds, graph))!;
      const full = (await loadCompleteAnalysisFromSections(project))!;
      const scopedCas = { ...full, nodes: section.nodes, edges: section.edges } as CASOutput;
      const scopedRisk = assessChangeRisk(scopedCas, 'node-0');
      const fullRisk = assessChangeRisk(full, 'node-0');
      assert.deepEqual(scopedRisk.transitive_impact, fullRisk.transitive_impact, 'transitive impact is identical on the scoped graph');
      assert.deepEqual(JSON.parse(JSON.stringify(scopedRisk)), JSON.parse(JSON.stringify(fullRisk)));
      assert.deepEqual(findTests(scopedCas, { nodeId: 'node-0' }), findTests(full, { nodeId: 'node-0' }));
    } finally {
      await pinned.release();
    }
    assert.deepEqual(scopedSmallSections('assess_change_risk', ['graph', 'calls', 'tests', 'quality']), ['calls', 'tests', 'quality'], 'risk keeps the reachability index section');
    assert.deepEqual(scopedSmallSections('get_coding_context', ['graph', 'calls', 'quality']), ['quality']);
  });
});
