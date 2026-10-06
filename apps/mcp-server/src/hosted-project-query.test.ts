import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { executeHostedProjectQuery, hostedProjectQuerySections, HOSTED_PROJECT_QUERY_SCHEMAS, HOSTED_PROJECT_QUERY_TOOL_NAMES } from './hosted-project-query';
import * as analysisMastery from './analysis-mastery';
import { getProductMap, searchNodes } from './query';
import { HOSTED_SEARCH_NODES_SCHEMA } from './hosted-project-query-schema';

function cas(): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_id: 'analysis-fixture',
    analysis_timestamp: '2026-01-01T00:00:00.000Z',
    system: {
      id: 'orders', name: 'Orders', type: 'service', root_path: '/customer/orders',
      technologies: { languages: [{ name: 'TypeScript' }], frameworks: [], databases: [], external_services: [] },
    } as any,
    nodes: [
      { id: 'orders-service', name: 'OrdersService', type: 'service', source: { file: 'src/orders.service.ts', line: 4 } },
    ],
    edges: [],
    analyzer_contributions: [],
    entry_points: [],
    exit_points: [],
  } as unknown as CASOutput;
}

function withoutGeneratedAt(value: unknown): unknown {
  const result = value as Record<string, unknown>;
  return { ...result, generated_at: '<generated>' };
}

test('hosted project query exposes only the explicit read-only allowlist', () => {
  assert.deepEqual([...HOSTED_PROJECT_QUERY_TOOL_NAMES].sort(), [
    'assess_change_risk', 'evaluate_agent_readiness', 'evaluate_agent_task_proof', 'evaluate_analysis_truth',
    'find_tests', 'get_agent_context', 'get_agent_start_context', 'get_agent_tool_plan',
    'get_behavioral_invariants', 'get_codebase_idioms', 'get_coding_context', 'get_flow_graph', 'get_framework_depth_report', 'get_module_health', 'get_product_map', 'get_runtime_instrumentation_plan', 'get_runtime_static_links',
    'get_semantic_map', 'get_user_journeys', 'run_answer_pack', 'search_nodes',
    'validate_behavioral_invariants', 'validate_codebase_idioms',
  ]);
});

test('hosted search schema bounds character and UTF-8 byte amplification', () => {
  assert.equal(HOSTED_SEARCH_NODES_SCHEMA.safeParse({ query: 'a'.repeat(1025) }).success, false);
  assert.equal(HOSTED_SEARCH_NODES_SCHEMA.safeParse({ query: '\u{1f600}'.repeat(1024) }).success, false);
  assert.equal(HOSTED_SEARCH_NODES_SCHEMA.safeParse({ query: 'valid search' }).success, true);
});

test('hosted query tools load only the CAS sections they consume', () => {
  assert.deepEqual(hostedProjectQuerySections('search_nodes'), []);
  assert.deepEqual(hostedProjectQuerySections('get_product_map'), [
    'graph', 'calls', 'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental',
  ]);
  assert.deepEqual(hostedProjectQuerySections('get_agent_start_context'), [
    'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental',
  ]);
  assert.deepEqual(hostedProjectQuerySections('get_agent_context', { task: { task_type: 'orient' } }), [
    'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental',
  ]);
  assert.deepEqual(hostedProjectQuerySections('find_tests'), ['tests']);
  assert.deepEqual(hostedProjectQuerySections('find_tests', { node_id: 'node' }), ['graph', 'tests']);
  assert.deepEqual(hostedProjectQuerySections('assess_change_risk'), ['graph', 'calls', 'tests', 'quality']);
  assert.deepEqual(hostedProjectQuerySections('run_answer_pack'), [
    'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental',
  ]);
  assert.deepEqual(hostedProjectQuerySections('run_answer_pack', { section: 'security' }), ['graph', 'quality']);
  assert.deepEqual(hostedProjectQuerySections('run_answer_pack', { section: 'external-boundaries' }), ['supplemental']);
  assert.deepEqual(hostedProjectQuerySections('evaluate_analysis_truth'), ['graph', 'calls', 'facts', 'runtime', 'supplemental']);
  assert.deepEqual(hostedProjectQuerySections('get_semantic_map'), ['graph', 'calls', 'facts', 'supplemental']);
  assert.deepEqual(hostedProjectQuerySections('get_framework_depth_report'), ['graph', 'facts', 'runtime', 'supplemental']);
  assert.deepEqual(hostedProjectQuerySections('get_runtime_instrumentation_plan'), ['graph', 'runtime']);
  assert.deepEqual(hostedProjectQuerySections('evaluate_agent_task_proof'), [
    'graph', 'calls', 'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental',
  ]);
  assert.deepEqual(hostedProjectQuerySections('get_user_journeys'), [
    'graph', 'calls', 'comprehension', 'tests', 'quality', 'supplemental',
  ]);
  assert.equal(hostedProjectQuerySections('get_agent_start_context').includes('calls'), false);
});

test('hosted validation accepts explicit evidence but rejects working-tree controls', async () => {
  const result = await executeHostedProjectQuery({
    cas: cas(), tool: 'validate_behavioral_invariants',
    args: { files: ['src/orders.service.ts'], diff_text: 'diff --git a/src/orders.service.ts b/src/orders.service.ts' },
    projectPath: '/hosted/orders',
  }) as any;
  assert.deepEqual(result.changed_files, ['src/orders.service.ts']);
  await assert.rejects(
    executeHostedProjectQuery({
      cas: cas(), tool: 'validate_behavioral_invariants',
      args: { files: [], diff_text: '', include_working_tree: true }, projectPath: '/hosted/orders',
    }),
    /unrecognized_key/
  );
});

test('hosted idiom validation never reads a path-shaped project name', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'klauro-hosted-query-'));
  const hostilePath = path.join(directory, 'unsafe-service.ts');
  writeFileSync(hostilePath, 'class Unsafe {}\n');
  const fixture = cas() as any;
  fixture.codebase_idioms = [{
    id: 'service-naming', category: 'naming', name: 'Service naming', confidence: 1, prevalence: 1,
    evidence: [], positive_examples: [], affected_scopes: { files: [hostilePath] },
    agent_guidance: { do: [], avoid: [], validation: [] }, deviations: [],
  }];
  const result = await executeHostedProjectQuery({
    cas: fixture, tool: 'validate_codebase_idioms',
    args: { files: [hostilePath], diff_text: `diff --git a/${hostilePath} b/${hostilePath}\n--- a/${hostilePath}\n+++ b/${hostilePath}\n+class UnsafeService {}` },
    projectPath: '/',
  }) as any;
  assert.deepEqual(result.changed_files, [hostilePath]);
  assert.equal(result.violations.some((item: any) => String(item.description).includes('Unsafe does not match')), false);
});

test('hosted project query rejects unknown tools and project/path injection', async () => {
  await assert.rejects(
    executeHostedProjectQuery({ cas: cas(), tool: 'analyze_codebase', args: {}, projectPath: '/hosted/orders' }),
    /Unsupported hosted query tool/
  );
  await assert.rejects(
    executeHostedProjectQuery({ cas: cas(), tool: 'get_product_map', args: { path: '/other', project_id: 'prj_other' }, projectPath: '/hosted/orders' }),
    /unrecognized_key/
  );
});

test('hosted query results match the canonical pure query functions', async () => {
  const fixture = cas();
  assert.deepEqual(
    await executeHostedProjectQuery({ cas: fixture, tool: 'search_nodes', args: { query: 'OrdersService' }, projectPath: '/hosted/orders' }),
    searchNodes(fixture, 'OrdersService', {})
  );
  assert.deepEqual(
    await executeHostedProjectQuery({ cas: fixture, tool: 'get_product_map', args: {}, projectPath: '/hosted/orders' }),
    getProductMap(fixture)
  );
});

test('hosted analysis-mastery queries preserve their complete contracts', async () => {
  const fixture = cas();
  const expectation = {
    name: 'orders-truth', languages: ['TypeScript'], libraries: ['missing-library'],
    method_calls: [{ caller: 'OrdersService', method: 'placeOrder' }],
    exit_points: [{ type: 'api', target: 'billing' }], minimums: { nodes: 1, edges: 0 },
  };
  assert.deepEqual(
    withoutGeneratedAt(
    await executeHostedProjectQuery({ cas: fixture, tool: 'evaluate_analysis_truth', args: { expectation }, projectPath: '/hosted/orders' }),
    ),
    withoutGeneratedAt(analysisMastery.evaluateAnalysisTruth(fixture, expectation)),
  );
  assert.deepEqual(
    withoutGeneratedAt(
    await executeHostedProjectQuery({ cas: fixture, tool: 'get_semantic_map', args: { target: 'Orders', limit: 10 }, projectPath: '/hosted/orders' }),
    ),
    withoutGeneratedAt(analysisMastery.getSemanticMap(fixture, { target: 'Orders', limit: 10 })),
  );
  assert.deepEqual(
    withoutGeneratedAt(
    await executeHostedProjectQuery({ cas: fixture, tool: 'get_framework_depth_report', args: {}, projectPath: '/hosted/orders' }),
    ),
    withoutGeneratedAt(analysisMastery.getFrameworkDepthReport(fixture)),
  );
  assert.deepEqual(
    withoutGeneratedAt(
    await executeHostedProjectQuery({ cas: fixture, tool: 'get_runtime_instrumentation_plan', args: { limit: 20 }, projectPath: '/hosted/orders' }),
    ),
    withoutGeneratedAt(analysisMastery.getRuntimeInstrumentationPlan(fixture, { limit: 20 })),
  );
});

test('hosted agent mastery evaluates targetless orientation without inventing an edit target', async () => {
  const fixture = cas();
  const result = await executeHostedProjectQuery({
    cas: fixture, tool: 'evaluate_agent_task_proof', args: { tasks: [{ task_type: 'orient' }] }, projectPath: '/hosted/orders',
  }) as any;
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].selected_node, null);
  assert.equal(result.tasks[0].checks.some((check: any) => check.id === 'orientation-context'), true);

  const readiness = await executeHostedProjectQuery({
    cas: fixture, tool: 'evaluate_agent_readiness', args: {}, projectPath: '/hosted/orders',
  }) as any;
  assert.equal(readiness.path, '/hosted/orders');
  assert.equal(typeof readiness.score, 'number');
});

test('hosted broad orientation is bounded and never becomes an internal edit target', async () => {
  const fixture = cas();
  fixture.nodes.push({
    id: 'internal-benchmark',
    name: 'runMachineInFlightBenchmarkProduct',
    type: 'function',
    source: { file: 'src/machine-gauntlet.ts', line: 100 },
  } as any);
  for (let index = 0; index < 30; index += 1) {
    fixture.edges.push({ id: `benchmark-edge-${index}`, source: 'internal-benchmark', target: 'orders-service', type: 'calls' } as any);
  }

  const result = await executeHostedProjectQuery({
    cas: fixture,
    tool: 'get_agent_context',
    args: { task: { task_type: 'orient', instructions: 'Understand the product architecture, capabilities, and major journeys.' } },
    projectPath: '/hosted/orders',
  }) as any;

  assert.equal(result.context_profile, 'read-only-orientation');
  assert.equal(result.target_resolution.selected_node_id, null);
  assert.equal(result.selected_node, null);
  assert.equal(result.work_context, undefined);
  assert.equal(result.execution_brief, undefined);
  assert.equal(result.validation_plan, undefined);
  assert.equal(result.file_read_plan, undefined);
  assert.ok(JSON.stringify(result).length < 12_000);
});

test('hosted answer packs return a bounded digest and expose every section by id', async () => {
  const fixture = cas();
  const digest = await executeHostedProjectQuery({
    cas: fixture, tool: 'run_answer_pack', args: {}, projectPath: '/hosted/orders',
  }) as any;
  assert.equal(digest.pack, 'mastery');
  assert.equal(digest.answers.length <= digest.sections.length, true);
  assert.deepEqual(digest.sections.map((section: any) => section.id), [
    'overview', 'entry-points', 'representative-flow', 'change-impact', 'data', 'tests',
    'external-boundaries', 'security', 'runtime-readiness',
  ]);
  assert.deepEqual(digest.answers.map((answer: any) => answer.id), [
    'entry-points', 'data', 'tests', 'external-boundaries', 'runtime-readiness',
  ]);
  assert.equal(digest.size_scope, 'computed-sections');
  assert.equal(digest.full_size_bytes, undefined);
  assert.ok(digest.computed_size_bytes > 0);
  assert.ok(digest.gaps.some((gap: string) => gap.startsWith('overview: not computed')));
  assert.equal(digest.sections.find((section: any) => section.id === 'security').included, false);

  const security = await executeHostedProjectQuery({
    cas: fixture, tool: 'run_answer_pack', args: { section: 'security' }, projectPath: '/hosted/orders',
  }) as any;
  assert.equal(security.pack, 'mastery');
  assert.equal(security.section.id, 'security');
  assert.equal(security.answers, undefined);
});

test('hosted node search applies the exact repository-relative file filter before limiting results', async () => {
  const fixture = cas();
  fixture.nodes.push({
    id: 'orders-service-test',
    name: 'OrdersService',
    type: 'service',
    source: { file: 'test/orders.service.ts', line: 4 },
  } as any);
  const result = await executeHostedProjectQuery({
    cas: fixture,
    tool: 'search_nodes',
    args: { query: 'OrdersService', file: './src/orders.service.ts', limit: 1 },
    projectPath: '/hosted/orders',
  }) as Array<{ id: string; file: string }>;
  assert.deepEqual(result, [{
    id: 'orders-service',
    name: 'OrdersService',
    type: 'service',
    qualified_name: undefined,
    category: undefined,
    level: undefined,
    level_name: undefined,
    file: 'src/orders.service.ts',
    line: 4,
    description: undefined,
    tags: undefined,
  }]);
});

test('find_tests accepts an optional suite_id and still rejects unknown keys', () => {
  const schema = HOSTED_PROJECT_QUERY_SCHEMAS.find_tests;
  assert.deepEqual(schema.parse({ suite_id: 'suite-1', limit: 5, offset: 2 }), { suite_id: 'suite-1', limit: 5, offset: 2 });
  assert.deepEqual(schema.parse({}), {});
  assert.equal(schema.safeParse({ suite_id: 42 }).success, false);
  assert.equal(schema.safeParse({ suite: 'suite-1' }).success, false);
});

test('start context loads the graph only when the task names a target or related paths', () => {
  assert.equal(hostedProjectQuerySections('get_agent_start_context').includes('graph'), false);
  assert.equal(hostedProjectQuerySections('get_agent_start_context', { task: { target: 'edit designs' } }).includes('graph'), true);
  assert.equal(hostedProjectQuerySections('get_agent_start_context', { task: { related_paths: ['a.ts'] } }).includes('graph'), true);
});
