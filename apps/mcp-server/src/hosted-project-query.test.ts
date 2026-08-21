import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { executeHostedProjectQuery, hostedProjectQuerySections, HOSTED_PROJECT_QUERY_TOOL_NAMES } from './hosted-project-query';
import { getProductMap, searchNodes } from './query';

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

test('hosted project query exposes only the explicit read-only allowlist', () => {
  assert.deepEqual([...HOSTED_PROJECT_QUERY_TOOL_NAMES].sort(), [
    'assess_change_risk', 'find_tests', 'get_agent_context', 'get_agent_start_context',
    'get_agent_tool_plan', 'get_behavioral_invariants', 'get_codebase_idioms',
    'get_coding_context', 'get_module_health', 'get_product_map', 'get_user_journeys', 'run_answer_pack', 'search_nodes',
    'validate_behavioral_invariants', 'validate_codebase_idioms',
  ]);
});

test('hosted query tools load only the CAS sections they consume', () => {
  assert.deepEqual(hostedProjectQuerySections('search_nodes'), ['graph']);
  assert.deepEqual(hostedProjectQuerySections('get_product_map'), [
    'facts', 'comprehension', 'runtime', 'quality', 'supplemental',
  ]);
  assert.deepEqual(hostedProjectQuerySections('get_agent_start_context'), [
    'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental',
  ]);
  assert.deepEqual(hostedProjectQuerySections('find_tests'), ['graph', 'calls', 'tests']);
  assert.deepEqual(hostedProjectQuerySections('assess_change_risk'), ['graph', 'calls', 'tests', 'quality']);
  assert.equal(hostedProjectQuerySections('get_product_map').includes('graph'), false);
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
