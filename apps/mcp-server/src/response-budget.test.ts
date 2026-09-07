import { strict as assert } from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as nodePath from 'path';
import { test } from 'node:test';
import {
  RESPONSE_BUDGET_BYTES,
  boundToolPayload,
  boundToolText,
  serializeToolResponse,
  type BoundedEnvelope,
} from './response-budget';
import { buildAnswerPackDigest, describeAnswerPackCatalog, runAnswerPack, type AnswerPackResult } from './product';
import { getTestSummary } from './query';
import { createServer } from './server';
import { listAnalyses } from './storage';

const SIZE_SLACK_BYTES = 1024;

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}


test('bounded agent responses never turn commands or capsules into truncated executable text', () => {
  const command = 'npm test -- ' + Array.from({ length: 1000 }, (_, index) => "'tests/behavior-" + index + ".test.ts'").join(' ');
  const capsule = 'K5|d|behavior\nT|' + command;
  const cases = [
    { payload: { validation_plan: { commands: [{ command }] } }, read: (value: any) => value.validation_plan?.commands?.[0]?.command, expected: command },
    { payload: { execution_brief: { validate: [command] } }, read: (value: any) => value.execution_brief?.validate?.[0], expected: command },
    { payload: { execution_brief: { capsule } }, read: (value: any) => value.execution_brief?.capsule, expected: capsule },
    { payload: { execution_capsule: capsule }, read: (value: any) => value.execution_capsule, expected: capsule },
    { payload: { context_capsule: capsule }, read: (value: any) => value.context_capsule, expected: capsule },
  ];
  for (const item of cases) {
    const bounded = boundToolPayload(item.payload, { tool: 'get_agent_context', budgetBytes: 4000 }) as BoundedEnvelope;
    const returned = item.read(bounded.data);
    assert.ok(returned === undefined || returned === item.expected, 'execution instructions must be whole or withheld');
    assert.equal(bounded.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4000);
  }
});

test('bounded agent responses preserve fitting executable instructions while trimming prose', () => {
  const command = 'npm test -- ' + Array.from({ length: 20 }, (_, index) => "'tests/behavior-" + index + ".test.ts'").join(' ');
  const capsule = 'K5|d|behavior\nT|' + command;
  const payload = { report: 'context '.repeat(12000), validation_plan: { commands: [{ command }] }, execution_brief: { validate: [command], capsule } };
  const bounded = boundToolPayload(payload, { tool: 'get_agent_context' }) as BoundedEnvelope;
  const returned = bounded.data as typeof payload;
  assert.equal(returned.validation_plan.commands[0].command, command);
  assert.equal(returned.execution_brief.validate[0], command);
  assert.equal(returned.execution_brief.capsule, capsule);
  assert.equal(payload.report.length, 96000);
});

test('serializeToolResponse keeps top-level keys on separate lines and stays parseable', () => {
  const data = { first: { nested: [1, 2, 3] }, second: 'value', third: 42 };
  const text = serializeToolResponse(data);
  const lines = text.split('\n');
  assert.equal(lines[0], '{');
  assert.ok(lines.some(line => line.startsWith('"first":')));
  assert.ok(lines.some(line => line.startsWith('"second":')));
  assert.ok(lines.some(line => line.startsWith('"third":')));
  assert.deepEqual(JSON.parse(text), data);

  const arrayText = serializeToolResponse([{ a: 1 }, { b: 2 }]);
  assert.equal(arrayText.split('\n')[0], '[');
  assert.deepEqual(JSON.parse(arrayText), [{ a: 1 }, { b: 2 }]);
});

test('boundToolPayload passes small payloads through unchanged', () => {
  const data = { items: [1, 2, 3], note: 'small' };
  assert.equal(boundToolPayload(data, { tool: 'get_summary' }), data);
});

test('boundToolPayload truncates oversized arrays with envelope metadata under the budget', () => {
  const data = {
    total: 5000,
    items: Array.from({ length: 5000 }, (_, index) => ({ id: `node-${index}`, name: `element-number-${index}`, kind: 'function' })),
  };
  const bounded = boundToolPayload(data, { tool: 'search_nodes', parameterNames: ['path', 'query', 'limit', 'offset'] }) as BoundedEnvelope;
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.has_more, true);
  assert.ok(bounded.full_size_bytes > RESPONSE_BUDGET_BYTES);
  assert.equal(bounded.budget_bytes, RESPONSE_BUDGET_BYTES);
  assert.ok(bounded.truncated_paths.length > 0);
  const itemsTrim = bounded.truncated_paths.find(entry => entry.path === 'items');
  assert.ok(itemsTrim, 'items array should be reported as truncated');
  assert.equal(itemsTrim!.total, 5000);
  assert.ok(itemsTrim!.returned < 5000);
  assert.equal((bounded.data as { items: unknown[] }).items.length, itemsTrim!.returned);
  assert.ok(bounded.continuation.some(line => line.includes("'search_nodes'")));
  assert.ok(bounded.continuation.some(line => line.includes('limit')));
  assert.ok(byteLength(serializeToolResponse(bounded)) <= RESPONSE_BUDGET_BYTES + SIZE_SLACK_BYTES);
});

test('continuation recognizes named catalog and flow pagination parameters', () => {
  const data = { values: Array.from({ length: 200 }, (_, index) => ({ index, value: 'x'.repeat(500) })) };
  const bounded = boundToolPayload(data, {
    tool: 'get_conceptual_analysis',
    parameterNames: ['path', 'max_flows', 'flow_offset', 'catalog_limit', 'catalog_offset'],
  }) as BoundedEnvelope;
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.continuation.some(line => line.includes('flow_offset') && line.includes('catalog_offset')));
});

test('boundToolPayload truncates oversized nested strings', () => {
  const data = { report: { body: 'x'.repeat(120_000) }, status: 'ok' };
  const bounded = boundToolPayload(data, { tool: 'get_agent_doctor' }) as BoundedEnvelope;
  assert.equal(bounded.truncated, true);
  const stringTrim = bounded.truncated_paths.find(entry => entry.kind === 'string');
  assert.ok(stringTrim);
  assert.equal(stringTrim!.total, 120_000);
  assert.ok(stringTrim!.returned < 120_000);
  const body = (bounded.data as { report: { body: string } }).report.body;
  assert.ok(body.endsWith('...[truncated]'));
  assert.equal((bounded.data as { status: string }).status, 'ok');
  assert.ok(byteLength(serializeToolResponse(bounded)) <= RESPONSE_BUDGET_BYTES + SIZE_SLACK_BYTES);
});

test('boundToolPayload mentions the gateway when the tool is gateway-routed', () => {
  const data = { items: Array.from({ length: 3000 }, (_, index) => ({ id: index, label: `row-${index}` })) };
  const bounded = boundToolPayload(data, { tool: 'get_security_overview', viaGateway: true }) as BoundedEnvelope;
  assert.ok(bounded.continuation.some(line => line.includes("klauro_query { tool: 'get_security_overview'")));
});

test('boundToolText truncates oversized non-JSON text with continuation notice', () => {
  const text = 'line\n'.repeat(40_000);
  const bounded = boundToolText(text, { tool: 'get_product_map' });
  assert.ok(byteLength(bounded) <= RESPONSE_BUDGET_BYTES + SIZE_SLACK_BYTES);
  assert.ok(bounded.includes('truncated: full response is'));
  assert.ok(bounded.includes("'get_product_map'"));
  assert.equal(boundToolText('short', { tool: 'get_product_map' }), 'short');
});

test('buildAnswerPackDigest withholds oversized sections and reports per-section sizes', () => {
  const result: AnswerPackResult = {
    pack: 'mastery',
    path: '/tmp/example',
    generated_at: new Date().toISOString(),
    gaps: [],
    answers: [
      { id: 'overview', question: 'q1', answer: { note: 'small' }, evidence: [], confidence: 0.9, follow_up_tools: [] },
      { id: 'security', question: 'q2', answer: { blob: 'y'.repeat(300_000) }, evidence: [], confidence: 0.9, follow_up_tools: [] },
      { id: 'data', question: 'q3', answer: { blob: 'z'.repeat(300_000) }, evidence: [], confidence: 0.9, follow_up_tools: [] },
    ],
  };
  const digest = buildAnswerPackDigest(result);
  assert.equal(digest.truncated, true);
  assert.equal(digest.sections.length, 3);
  for (const section of digest.sections) {
    assert.ok(section.size_bytes > 0);
  }
  const overview = digest.sections.find(section => section.id === 'overview');
  assert.equal(overview!.included, true);
  const security = digest.sections.find(section => section.id === 'security');
  assert.equal(security!.included, false);
  assert.deepEqual(security!.fetch_with, { tool: 'run_answer_pack', args: { path: '/tmp/example', pack: 'mastery', section: 'security' } });
  assert.deepEqual(digest.answers.map(answer => answer.id), ['overview']);
  assert.ok(digest.continuation.includes('run_answer_pack'));
  assert.equal(digest.full_size_bytes, digest.computed_size_bytes);
});

test('buildAnswerPackDigest includes everything when the pack is small', () => {
  const result: AnswerPackResult = {
    pack: 'mastery',
    path: '/tmp/example',
    generated_at: new Date().toISOString(),
    gaps: [],
    answers: [
      { id: 'overview', question: 'q1', answer: { note: 'small' }, evidence: [], confidence: 0.9, follow_up_tools: [] },
    ],
  };
  const digest = buildAnswerPackDigest(result);
  assert.equal(digest.truncated, false);
  assert.equal(digest.answers.length, 1);
  assert.equal(digest.sections[0].included, true);
});

test('runAnswerPack lists available packs and their sections when the pack is unknown', () => {
  const result = runAnswerPack({} as any, '/tmp/example', 'security');
  assert.equal(result.pack, 'security');
  assert.equal(result.answers.length, 0);
  assert.equal(result.gaps.length, 1);
  assert.ok(result.gaps[0].startsWith('Unknown answer pack: security.'));
  assert.ok(result.gaps[0].includes("Available packs: 'mastery'"));
  assert.ok(result.gaps[0].includes('sections: overview, entry-points'));
  assert.ok(result.gaps[0].includes('security'));
  assert.ok(result.gaps[0].includes("Retry with pack: 'mastery'"));
  assert.ok(describeAnswerPackCatalog().includes("'mastery' (sections: overview, entry-points, representative-flow, change-impact, data, tests, external-boundaries, security, runtime-readiness)"));
});

test('runAnswerPack treats a complete absence of external boundaries as a confident finding', () => {
  const result = runAnswerPack({
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-local-app',
    system: {
      id: 'local-app',
      name: 'Local App',
      type: 'application',
      root_path: '/tmp/local-app',
      technologies: { languages: [{ name: 'Dart' }], frameworks: [], databases: [], external_services: [] },
    },
    nodes: [{ id: 'local-screen', name: 'LocalScreen', type: 'class', source: { file: 'lib/main.dart', line: 1 } }],
    edges: [],
    analyzer_contributions: [],
    entry_points: [],
    exit_points: [],
    external_services: [],
  } as any, '/tmp/local-app');

  const externalBoundaries = result.answers.find(answer => answer.id === 'external-boundaries');
  assert.equal(externalBoundaries?.confidence, 0.85);
  assert.ok(!result.gaps.some(gap => gap.startsWith('external-boundaries:')));
  assert.equal(externalBoundaries?.evidence[0]?.label, 'CAS reports no external boundaries');
});

test('runAnswerPack prefers a materialized behavioral flow over a shallow call chain', () => {
  const result = runAnswerPack({
    cas_version: '3.0.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-todos',
    system: {
      id: 'todos',
      name: 'Todos',
      type: 'application',
      root_path: '/tmp/example',
      technologies: { languages: [{ name: 'Rust' }], frameworks: [], databases: [], external_services: [] },
    },
    analyzer_contributions: [],
    nodes: [
      { id: 'handler', name: 'createTodo', type: 'function', source: { file: 'src/main.rs', line: 10 } },
      { id: 'uuid', name: 'new_v4', type: 'function', source: { file: 'src/main.rs', line: 12 } },
    ],
    edges: [],
    entry_points: [{ id: 'post-todos', name: 'POST /todos', type: 'http', handler: { node_id: 'handler', file: 'src/main.rs', line: 10 } }],
    exit_points: [],
    call_chains: [{
      id: 'shallow-chain',
      entry_point: { entry_point_id: 'post-todos' },
      chain_type: 'synchronous',
      nodes: [{ node_id: 'handler' }, { node_id: 'uuid' }],
    }],
    flows: [{
      flow_id: 'create-todo-flow',
      name: 'Create Todo',
      intent: 'Create a todo',
      entry_point: 'post-todos',
      entities: ['Todo'],
      contract: {
        input: ['CreateTodo'],
        logic: 'createTodo',
        side_effects: { state_changes: ['Todo created'], external_integrations: [] },
        output: ['Todo'],
        constraints: [],
      },
      steps: [{
        step_id: 'create-step',
        order: 1,
        name: 'Create Todo',
        description: 'Creates the requested todo.',
        description_source: 'deterministic-label',
        contract: {
          input: ['CreateTodo'],
          logic: 'createTodo',
          side_effects: { state_changes: ['Todo created'], external_integrations: [] },
          output: ['Todo'],
          constraints: [],
        },
        functions: [{ function_id: 'handler' }],
        entities: ['Todo'],
      }],
    }],
  } as any, '/tmp/example');

  const representative = result.answers.find(answer => answer.id === 'representative-flow');
  assert.equal((representative?.answer.flow as any)?.flow_id, 'create-todo-flow');
  assert.deepEqual((representative?.answer.flow as any)?.contract.side_effects.state_changes, ['Todo created']);
  assert.ok(representative?.evidence.some(item => item.id === 'create-todo-flow'));
});

test('getTestSummary aggregates gap statistics server-side and pages the highest-severity gaps', () => {
  const cas = {
    test_summary: { total_tests: 5 },
    test_gaps: [
      ...Array.from({ length: 30 }, (_, index) => ({
        gap_type: 'untested-flow',
        severity: 'medium',
        location: {},
        recommendation: `cover flow ${index}`,
      })),
      { gap_type: 'untested-branch', severity: 'critical', location: {}, recommendation: 'cover the critical branch' },
      { gap_type: 'mock-only', severity: 'high', location: {}, recommendation: 'replace the mock-only coverage' },
    ],
    test_coverage: {
      summary: { total_coverage: 12 },
      by_level: { unit: { coverage: 12 } },
      by_component: {
        billing: { coverage: 1, untested_nodes: ['a', 'b'] },
        users: { coverage: 90, untested_nodes: [] },
      },
      test_relationships: [{ test_id: 't1' }],
    },
  } as any;

  const summary = getTestSummary(cas);
  assert.equal(summary.gap_summary.total, 32);
  assert.equal(summary.gap_summary.matching, 32);
  assert.equal(summary.gap_summary.returned, 25);
  assert.equal(summary.test_gaps.length, 25);
  assert.equal(summary.test_gaps[0].severity, 'critical');
  assert.equal(summary.test_gaps[1].severity, 'high');
  assert.equal(summary.gap_summary.by_severity.medium, 30);
  assert.equal(summary.gap_summary.by_severity.critical, 1);
  assert.equal(summary.gap_summary.by_type['untested-flow'], 30);
  assert.ok(summary.continuation);
  assert.ok(summary.continuation!.includes('offset'));
  assert.ok(summary.continuation!.includes('severity'));
  assert.equal(summary.test_coverage!.component_count, 2);
  assert.equal(summary.test_coverage!.worst_covered_components[0].component, 'billing');
  assert.equal(summary.test_coverage!.worst_covered_components[0].untested_node_count, 2);
  assert.equal(summary.test_coverage!.test_relationship_count, 1);
  assert.ok(!('by_component' in (summary.test_coverage as Record<string, unknown>)));

  const paged = getTestSummary(cas, { severity: 'medium', limit: 10, offset: 25 });
  assert.equal(paged.gap_summary.matching, 30);
  assert.equal(paged.gap_summary.returned, 5);
  assert.equal(paged.gap_summary.offset, 25);
  assert.ok(!('continuation' in paged));

  const typed = getTestSummary(cas, { gapType: 'mock-only' });
  assert.equal(typed.gap_summary.matching, 1);
  assert.equal(typed.test_gaps[0].recommendation, 'replace the mock-only coverage');
});

interface ToolResponse {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function unwrapData(parsed: unknown): unknown {
  if (parsed && typeof parsed === 'object' && (parsed as { truncated?: boolean }).truncated === true) {
    return (parsed as { data: unknown }).data;
  }
  return parsed;
}

function findFirstNodeId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNodeId(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string' && record.id.length > 0 && (record.type !== undefined || record.name !== undefined)) {
      return record.id;
    }
    for (const item of Object.values(record)) {
      const found = findFirstNodeId(item);
      if (found) return found;
    }
  }
  return undefined;
}

test('every core-profile tool response stays within the byte budget on the largest stored analysis', { timeout: 600_000 }, async () => {
  const storagePath = process.env.KLAURO_STORAGE_PATH || nodePath.join(os.homedir(), '.klauro', 'analyses');
  const analyses = await listAnalyses();
  const usable = analyses
    .filter(entry => fs.existsSync(nodePath.isAbsolute(entry.file) ? entry.file : nodePath.join(storagePath, entry.file)))
    .sort((a, b) => b.node_count - a.node_count);
  const largest = usable[0];
  if (!largest) {
    console.log('No stored analyses available; skipping response-size invariant test.');
    return;
  }
  console.log(`Response-size invariant target: ${largest.name} (${largest.node_count} nodes) at ${largest.path}`);

  const previousProfile = process.env.KLAURO_TOOL_PROFILE;
  process.env.KLAURO_TOOL_PROFILE = 'core';
  try {
    const server = createServer();
    const registered = (server as any)._registeredTools as Record<string, { callback?: (args: any) => Promise<ToolResponse>; handler?: (args: any) => Promise<ToolResponse> }>;
    const invoke = async (tool: string, args: Record<string, unknown>): Promise<ToolResponse> => {
      const entry = registered[tool];
      assert.ok(entry, `core profile should expose tool ${tool}`);
      const callback = entry.callback ?? entry.handler;
      return (await callback!(args)) as ToolResponse;
    };

    const path = largest.path;
    const sizes: Record<string, number> = {};
    let truncatedResponses = 0;

    const assertBounded = (tool: string, response: ToolResponse): unknown => {
      assert.equal(response.content.length, 1, `${tool} should return a single content block`);
      const text = response.content[0].text;
      sizes[tool] = byteLength(text);
      assert.ok(
        byteLength(text) <= RESPONSE_BUDGET_BYTES + SIZE_SLACK_BYTES,
        `${tool} returned ${byteLength(text)} bytes, over the ${RESPONSE_BUDGET_BYTES}-byte budget`
      );
      const parsed = JSON.parse(text) as Record<string, unknown> | null;
      if (parsed === null || typeof parsed !== 'object') return parsed;
      if (parsed.truncated === true) {
        truncatedResponses += 1;
        if (Array.isArray(parsed.sections)) {
          assert.ok((parsed.sections as Array<Record<string, unknown>>).every(section => typeof section.size_bytes === 'number'), `${tool} digest sections must report size_bytes`);
          assert.ok((parsed.sections as Array<Record<string, unknown>>).some(section => section.included === false && section.fetch_with !== undefined), `${tool} digest must include fetch_with for withheld sections`);
          assert.ok(typeof parsed.continuation === 'string' && (parsed.continuation as string).includes('run_answer_pack'), `${tool} digest must include continuation instructions`);
        } else {
          assert.equal(parsed.has_more, true, `${tool} truncated response must set has_more`);
          assert.ok(typeof parsed.full_size_bytes === 'number' && (parsed.full_size_bytes as number) > RESPONSE_BUDGET_BYTES, `${tool} must report full_size_bytes`);
          assert.ok(Array.isArray(parsed.truncated_paths) && (parsed.truncated_paths as unknown[]).length > 0, `${tool} must report truncated_paths`);
          assert.ok(Array.isArray(parsed.continuation) && (parsed.continuation as unknown[]).length > 0, `${tool} must include continuation instructions`);
        }
      }
      return parsed;
    };

    const searchResponse = await invoke('search_nodes', { path, query: 'service', limit: 25 });
    const searchParsed = assertBounded('search_nodes', searchResponse);
    const nodeId = findFirstNodeId(unwrapData(searchParsed));

    const directCalls: Array<[string, Record<string, unknown>]> = [
      ['resolve_agent_analysis', { path }],
      ['get_agent_start_context', { path }],
      ['get_agent_tool_plan', { path, task: { task_type: 'orient' } }],
      ['get_agent_context', { path, task: { task_type: 'modify', target: 'service' } }],
      ['get_coding_context', { path, target: nodeId ?? 'service' }],
      ['find_tests', { path }],
      ['validate_agent_change', { path, files: ['src/index.ts'] }],
      ['get_product_map', { path }],
      ['get_user_journeys', { path }],
      ['run_answer_pack', { path }],
      ['run_answer_pack', { path, section: 'data' }],
    ];
    if (nodeId) directCalls.push(['assess_change_risk', { path, node_id: nodeId }]);

    for (const [tool, args] of directCalls) {
      assertBounded(tool === 'run_answer_pack' && args.section ? 'run_answer_pack(section)' : tool, await invoke(tool, args));
    }

    const gatewayTools: Array<[string, Record<string, unknown>]> = [
      ['get_security_overview', { path }],
      ['get_data_entities', { path }],
      ['get_route_table', { path }],
      ['get_cicd_pipelines', { path, limit: 10_000 }],
      ['get_entry_points', { path, limit: 10_000 }],
      ['get_exit_points', { path, limit: 10_000 }],
      ['get_level', { path, level: 1 }],
      ['get_summary', { path }],
      ['get_system_overview', { path }],
      ['get_flow_coverage', { path }],
      ['get_test_summary', { path }],
      ['get_database_schema', { path }],
      ['get_workflows', { path }],
      ['get_behaviors', { path }],
      ['get_external_services', { path }],
      ['get_domain_concepts', { path }],
      ['get_dependencies', { path }],
      ['get_implementation_health', { path }],
    ];
    for (const [tool, args] of gatewayTools) {
      const response = await invoke('klauro_query', { tool, args });
      if (response.isError) {
        const message = JSON.parse(response.content[0].text).error as string;
        assert.ok(byteLength(response.content[0].text) <= RESPONSE_BUDGET_BYTES + SIZE_SLACK_BYTES, `klauro_query(${tool}) error response over budget`);
        console.log(`klauro_query(${tool}) errored: ${message}`);
        continue;
      }
      assertBounded(`klauro_query(${tool})`, response);
    }

    const report = Object.entries(sizes)
      .sort((a, b) => b[1] - a[1])
      .map(([tool, size]) => `${tool}: ${size} bytes`)
      .join('\n');
    console.log(`Response sizes (largest first):\n${report}`);
    console.log(`Responses that required truncation: ${truncatedResponses}`);
    assert.ok(truncatedResponses > 0, 'expected at least one tool to require truncation on the largest analysis; the invariant test is otherwise vacuous');
  } finally {
    if (previousProfile === undefined) delete process.env.KLAURO_TOOL_PROFILE;
    else process.env.KLAURO_TOOL_PROFILE = previousProfile;
  }
});
