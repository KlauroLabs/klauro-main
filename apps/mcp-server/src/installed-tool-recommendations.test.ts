import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { executeHostedProjectQuery } from './hosted-project-query';
import { isInstalledToolName } from './installed-tool-registry';

function registeredServerToolNames(): string[] {
  const source = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
  return [...source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map(match => match[1]);
}

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, into);
  return into;
}

function unregisteredToolMentions(result: unknown, serverTools: string[]): string[] {
  const offenders = new Set<string>();
  for (const text of collectStrings(result)) {
    for (const name of serverTools) {
      if (isInstalledToolName(name)) continue;
      if (new RegExp(`(^|[^a-z_])${name}([^a-z_]|$)`).test(text)) offenders.add(name);
    }
  }
  return [...offenders].sort();
}

function fixtureCas(): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'recommendation-scan',
    system: {
      name: 'Orders', type: 'api', description: 'Orders service', root_path: '/tmp/orders',
      technologies: { languages: [{ name: 'TypeScript', percentage: 100 }], frameworks: [], databases: [] },
    },
    nodes: [
      { id: 'orders-service', name: 'OrdersService', type: 'service', source: { file: 'src/orders.service.ts', line: 4 } },
      { id: 'orders-controller', name: 'OrdersController', type: 'controller', source: { file: 'src/orders.controller.ts', line: 2 } },
    ],
    edges: [{ id: 'e1', source: 'orders-controller', target: 'orders-service', type: 'calls' }],
    analyzer_contributions: [],
    entry_points: [{ id: 'entry-orders', name: 'POST /orders', type: 'http', source_node: 'orders-controller', handler: { node_id: 'orders-service', name: 'create' } }],
    exit_points: [],
  } as unknown as CASOutput;
}

const TASK_TYPES = ['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime'] as const;
const PROFILES = ['standard', 'minimal', 'first-turn', 'capsule-only'] as const;

test('hosted orientation outputs recommend only tools the installed client registers', async () => {
  const serverTools = registeredServerToolNames();
  assert.ok(serverTools.includes('preflight_agent_change'));
  const offenders: Record<string, string[]> = {};
  const run = async (label: string, tool: string, args: unknown) => {
    const result = await executeHostedProjectQuery({ cas: fixtureCas(), tool, args, projectPath: '/tmp/orders' });
    const found = unregisteredToolMentions(result, serverTools);
    if (found.length > 0) offenders[label] = found;
  };
  for (const taskType of TASK_TYPES) {
    const task = { task_type: taskType, target: 'create order', related_paths: ['src/orders.service.ts'] };
    await run(`tool_plan:${taskType}`, 'get_agent_tool_plan', { task });
    await run(`context:${taskType}`, 'get_agent_context', { task });
    for (const response_profile of PROFILES) {
      await run(`start:${taskType}:${response_profile}`, 'get_agent_start_context', { task: { ...task, response_profile } });
    }
  }
  await run('start:default', 'get_agent_start_context', {});
  await run('readiness', 'evaluate_agent_readiness', {});
  assert.deepEqual(offenders, {});
});

test('installed client instructions, tool descriptions, and help name only registered tools', () => {
  const serverTools = registeredServerToolNames();
  for (const file of ['installed-client-instructions.ts', 'installed-client-server.ts', 'installed-cli-help.ts']) {
    const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.deepEqual(unregisteredToolMentions(text, serverTools), [], file);
  }
});
