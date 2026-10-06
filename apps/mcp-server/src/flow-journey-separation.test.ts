import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CASEntryPointFlow, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildSummary, getEntryPointFlows, getProductMap, getUserJourneys } from './query';
import { getAgentStartContext } from './agent-adoption';
import { diffBehavior } from '../../../packages/analyzer-core/src/analyzer/core/behavior-diff';
import { tierStackToCas } from '../../../packages/analyzer-core/src/analyzer/tier-stack/tier-stack-to-cas';

const flows = Object.values(JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'entry-point-flows', 'real-entry-point-flows.json'), 'utf8'),
) as Record<string, CASEntryPointFlow>).filter(flow => typeof flow === 'object' && flow !== null && flow.entry !== undefined);

const stepOf = (flow: string, name: string) => ({ step_id: `${flow}:${name}`, order: 1, name, description: name, functions: [{ function_id: `${flow}/${name}` }], entities: [] });
const flowOf = (id: string, name: string, entry: string, effect?: string) => ({
  flow_id: id, name, intent: name, entry_point: entry, entities: [],
  contract: { input: [], logic: name, side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
  steps: [stepOf(id, 'submit'), stepOf(id, 'deliver')],
  ...(effect === undefined ? {} : { terminus: { exit_point_id: 'exit', kind: 'process', produces: effect, node_id: id } }),
});
const JOURNEY = { id: 'journey:flow:send>flow:deliver', label: 'Send a message \u2192 Deliver the message' };
const JOURNEY_PARTS = {
  flows: [flowOf('flow:send', 'Send a message', 'entry:send'), flowOf('flow:deliver', 'Deliver the message', 'entry:deliver', 'agent')],
  entry_points: [{ id: 'entry:send', type: 'ui', name: 'send' }, { id: 'entry:deliver', type: 'ipc', name: 'deliver' }],
  communication_seams: {
    seams: [{ id: 'seam_1', modality: 'sync', confidence: 0.8, kind: 'exit_point', source: 'ui', target: 'daemon', evidence: '', summary: '', metadata: { via: 'ipc', channel: 'chat:send', from_flow: 'flow:send', to_flow: 'flow:deliver' } }],
  },
};

function cas(withEntryPointFlows: boolean): CASOutput {
  return {
    cas_version: '1.11.0',
    analysis_timestamp: '2026-01-01T00:00:00.000Z',
    analysis_id: 'separation',
    system: { name: 'fixture', type: 'service', description: 'Fixture', root_path: '/repo/fixture', technologies: { languages: [{ name: 'TypeScript', percentage: 100 }], frameworks: [], databases: [] } },
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_contributions: [],
    entry_point_flows: flows,
    entry_point_flow_summary: { total_discovered: flows.length, included: flows.length, by_kind: { 'user-facing': flows.length, system: 0, scheduled: 0 } },
    ...(withEntryPointFlows ? JOURNEY_PARTS : {}),
  } as unknown as CASOutput;
}

function entryPointFlowLabelledValues(value: unknown, trail = '', into: Array<{ trail: string; value: unknown }> = []): Array<{ trail: string; value: unknown }> {
  if (Array.isArray(value)) value.forEach((item, index) => entryPointFlowLabelledValues(item, `${trail}[${index}]`, into));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = `${trail}.${key}`;
      if (/journey/i.test(key) && !/notice/i.test(key)) into.push({ trail: next, value: item });
      entryPointFlowLabelledValues(item, next, into);
    }
  }
  return into;
}

function outputs(withEntryPointFlows: boolean): Record<string, unknown> {
  const analysis = cas(withEntryPointFlows);
  const result: Record<string, unknown> = {
    get_user_journeys: getUserJourneys(analysis),
    get_user_journeys_markdown: getUserJourneys(analysis, { format: 'markdown' }),
    product_map: getProductMap(analysis),
    product_map_markdown: getProductMap(analysis, { format: 'markdown' }),
    summary: buildSummary(analysis),
  };
  for (const response_profile of ['standard', 'minimal', 'first-turn', 'capsule-only'] as const) {
    result[`start_${response_profile}`] = getAgentStartContext(analysis, '/repo/fixture', { task_type: 'orient', response_profile });
  }
  return result;
}

test('no output labels an entry-point flow as a journey when the analysis has no journeys', () => {
  const flowMarkers = flows.flatMap(flow => [flow.id, flow.name]).filter(Boolean);
  for (const [name, output] of Object.entries(outputs(false))) {
    for (const held of entryPointFlowLabelledValues(output)) {
      const text = JSON.stringify(held.value);
      for (const marker of flowMarkers) assert.equal(text.includes(marker), false, `${name}${held.trail} carries flow ${marker}`);
    }
    if (typeof output === 'object' && output && 'markdown' in output) {
      const markdown = String((output as { markdown: string }).markdown);
      for (const flow of flows) assert.equal(markdown.includes(flow.name) && /journey/i.test(markdown.split(flow.name)[0].split('\n').pop() || ''), false, `${name} lists ${flow.name} on a journey line`);
    }
  }
  const empty = getUserJourneys(cas(false)) as { total: number; journeys: unknown[]; journeys_notice: string };
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.journeys, []);
  assert.match(empty.journeys_notice, /get_entry_point_flows/);
});

test('entry-point flows and journeys are counted and listed separately', () => {
  const map = getProductMap(cas(true)) as { entry_point_flows: { total: number }; journeys: { total: number; top: Array<{ id: string }> } };
  const flowList = getEntryPointFlows(cas(true)) as { entry_point_flows: Array<{ id: string }> };
  assert.equal(map.entry_point_flows.total, flowList.entry_point_flows.length);
  assert.equal(map.journeys.total, 1);
  assert.deepEqual(map.journeys.top.map(item => item.id), [JOURNEY.id]);
  const listed = getUserJourneys(cas(true)) as { journeys: Array<{ id: string }> };
  assert.deepEqual(listed.journeys.map(item => item.id), [JOURNEY.id]);
  assert.equal(flowList.entry_point_flows.some(item => item.id === JOURNEY.id), false);
  const summary = buildSummary(cas(true)) as { journeys: number; flows: number };
  assert.equal(summary.journeys, 1);
  const markdown = (getProductMap(cas(true), { format: 'markdown' }) as { markdown: string }).markdown;
  assert.ok(markdown.includes('## Entry-point flows'));
  assert.ok(markdown.includes('## Journeys'));
  assert.ok(markdown.includes('Send a message'));
  assert.ok(markdown.includes('2 flows'));
});

test('the behaviour diff keeps entry-point flow changes and journey changes in separate sections', () => {
  const before = cas(false);
  const after = { ...cas(true), entry_point_flows: flows.slice(1) } as CASOutput;
  const diff = diffBehavior(before, after);
  assert.ok(diff.entry_point_flows.removed.length > 0);
  assert.deepEqual(diff.journeys.added.map(item => item.id), [JOURNEY.id]);
  const flowIds = new Set(flows.map(flow => flow.id));
  for (const item of [...diff.journeys.added, ...diff.journeys.removed, ...diff.journeys.changed]) assert.equal(flowIds.has(item.id), false);
  const journeyIds = new Set([JOURNEY.id]);
  for (const item of [...diff.entry_point_flows.added, ...diff.entry_point_flows.removed, ...diff.entry_point_flows.changed]) assert.equal(journeyIds.has(item.id), false);
  const slimmer = { ...cas(true), flows: [{ ...JOURNEY_PARTS.flows[0], steps: [stepOf('flow:send', 'submit')] }, JOURNEY_PARTS.flows[1]] } as unknown as CASOutput;
  const changed = diffBehavior(cas(true), slimmer);
  assert.deepEqual(changed.journeys.changed.map(item => item.id), [JOURNEY.id]);
  assert.deepEqual(changed.entry_point_flows.changed, []);
});

test('the stored record carries crossings as seams naming flow endpoints and no journey structure', () => {
  const flow = (id: string, entry: string, units: string[]) => ({ id, entry_point: entry, kind: 'ipc', operation: id, standing: 'open', steps: [{ id: 's1', kind: 'call', label: 'Call', when: 'always', regions: units.map(unit => ({ unit, file: 0, start_line: 1, end_line: 2 })) }], path: units.map((unit, depth) => ({ unit, depth })) });
  const index = {
    root: '/tmp/x',
    files: [{ path: 'ui/a.ts', kind: 'source', language: 'typescript', extracted: true }, { path: 'daemon/b.rs', kind: 'source', language: 'rust', extracted: true }],
    nodes: [{ id: 'ui/a.ts:function:send', name: 'send', kind: 'function', file: 0, span: { line: 1 } }, { id: 'daemon/b.rs:function:deliver', name: 'deliver', kind: 'function', file: 1, span: { line: 1 } }],
    edges: [],
    entry_points: [
      { id: 'entry:send', kind: 'ui', name: 'send', handler: 'ui/a.ts:function:send', file: 0, line: 1, registrar: 'r' },
      { id: 'entry:deliver', kind: 'ipc', name: 'deliver', handler: 'daemon/b.rs:function:deliver', file: 1, line: 1, registrar: 'r' },
    ],
    crossings: [{ kind: 'ipc', communication: 'sync', channel: 'chat:send', from: 'ui/a.ts:function:send', from_file: 0, from_line: 2, to: 'daemon/b.rs:function:deliver', to_file: 1, to_line: 1 }],
    comprehension: { flows: [flow('flow:send', 'entry:send', ['ui/a.ts:function:send']), flow('flow:deliver', 'entry:deliver', ['daemon/b.rs:function:deliver'])] },
  } as unknown as Parameters<typeof tierStackToCas>[0];
  const record = tierStackToCas(index);
  assert.equal('causal_journeys' in record, false);
  assert.equal((record.analysis_facts ?? []).some(fact => (fact.fact_type as string) === 'journey'), false);
  const linked = (record.communication_seams?.seams ?? []).filter(seam => seam.metadata?.via === 'ipc');
  assert.equal(linked.length, 1);
  assert.deepEqual(
    [linked[0].metadata?.from_flow, linked[0].metadata?.to_flow, linked[0].metadata?.exit_unit, linked[0].metadata?.entry],
    ['flow:send', 'flow:deliver', 'ui/a.ts:function:send', 'entry:deliver'],
  );
  const chained = getUserJourneys(record) as { total: number; journeys: Array<{ flows: unknown[] }> };
  assert.equal(chained.total, 1);
  assert.equal(chained.journeys[0].flows.length, 2);
});
