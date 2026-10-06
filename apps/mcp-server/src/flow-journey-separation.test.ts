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

const JOURNEY = {
  id: 'journey:send-message',
  label: 'Send a message',
  does: 'a user types a message and the daemon delivers it',
  rank: 1,
  representative: true,
  steps: [{ file: 'ui/send.ts', symbol: 'send', does: 'submits' }, { file: 'daemon/deliver.rs', symbol: 'deliver', does: 'delivers', via: 'ipc' as const }],
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
    ...(withEntryPointFlows ? { causal_journeys: [JOURNEY] } : {}),
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
  assert.equal(map.entry_point_flows.total, flows.length);
  assert.equal(map.journeys.total, 1);
  assert.deepEqual(map.journeys.top.map(item => item.id), [JOURNEY.id]);
  const listed = getUserJourneys(cas(true)) as { journeys: Array<{ id: string }> };
  assert.deepEqual(listed.journeys.map(item => item.id), [JOURNEY.id]);
  const flowList = getEntryPointFlows(cas(true)) as { entry_point_flows: Array<{ id: string }> };
  assert.equal(flowList.entry_point_flows.some(item => item.id === JOURNEY.id), false);
  const summary = buildSummary(cas(true)) as { journeys: number; flows: number };
  assert.equal(summary.journeys, 1);
  const markdown = (getProductMap(cas(true), { format: 'markdown' }) as { markdown: string }).markdown;
  assert.ok(markdown.includes('## Entry-point flows'));
  assert.ok(markdown.includes('## Journeys'));
  assert.ok(markdown.includes('Send a message'));
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
  const changed = diffBehavior(cas(true), { ...cas(true), causal_journeys: [{ ...JOURNEY, steps: [JOURNEY.steps[0]] }] } as CASOutput);
  assert.deepEqual(changed.journeys.changed.map(item => item.id), [JOURNEY.id]);
  assert.deepEqual(changed.entry_point_flows.changed, []);
});

test('engine analysis facts label journeys as journeys and never label flows as journeys', () => {
  const index = {
    root: '/tmp/x',
    files: [{ path: 'a.ts', kind: 'source', language: 'typescript', extracted: true }],
    nodes: [{ id: 'a.ts', name: 'a.ts', kind: 'module', file: 0, span: { line: 1 } }],
    edges: [],
    journeys: [{ id: JOURNEY.id, label: JOURNEY.label, does: JOURNEY.does, rank: 1, representative: true, steps: JOURNEY.steps }],
  } as unknown as Parameters<typeof tierStackToCas>[0];
  const facts = tierStackToCas(index).analysis_facts ?? [];
  const journeyFacts = facts.filter(fact => fact.fact_type === 'journey');
  assert.deepEqual(journeyFacts.map(fact => fact.subject_id), [JOURNEY.id]);
  assert.equal(facts.some(fact => fact.fact_type === 'journey' && fact.subject_type !== 'journey'), false);
});
