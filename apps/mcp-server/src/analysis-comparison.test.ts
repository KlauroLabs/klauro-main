import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { compareAnalyses } from './proposal-preview';

interface Spec {
  id: string;
  type?: string;
  name?: string;
  parent?: string;
  exported?: boolean;
  params?: Array<[string, string?, boolean?]>;
  returns?: string;
  lines?: number;
  access?: 'private' | 'protected';
}

function build(specs: Spec[], calls: Array<[string, string]> = [], extra: Partial<CASOutput> = {}): CASOutput {
  const nodes = specs.map(spec => ({
    id: spec.id,
    name: spec.name ?? spec.id.split(':').pop(),
    type: spec.type ?? 'function',
    parent: spec.parent ?? 'src/m.ts',
    primaryAnalyzer: 'tier-stack',
    source: { file: 'src/m.ts', line: 1, end_line: 1 + (spec.lines ?? 3) },
    signature: spec.params === undefined && spec.returns === undefined ? undefined : {
      parameters: (spec.params ?? []).map(([name, type, optional]) => ({ name, type, optional })),
      return_type: spec.returns,
    },
    metadata: {
      language: 'typescript',
      ...(spec.exported ? { is_exported: true } : {}),
      ...(spec.access === undefined ? {} : { access_modifier: spec.access }),
    },
  })) as unknown as CASNode[];
  return {
    cas_version: '3.0.0', analysis_id: `a${nodes.length}-${calls.length}`, analysis_timestamp: '2026-10-04T00:00:00.000Z',
    system: { name: 'x', type: 'library' }, analyzer_contributions: [],
    nodes: [{ id: 'src/m.ts', name: 'm.ts', type: 'file' } as CASNode, ...nodes],
    edges: calls.map(([source, target], at) => ({ id: `e${at}`, source, target, type: 'calls' })),
    ...extra,
  } as unknown as CASOutput;
}

const fn = (name: string, extra: Partial<Spec> = {}): Spec => ({ id: `src/m.ts:function:${name}`, ...extra });
const id = (name: string) => `src/m.ts:function:${name}`;

test('a renamed function is matched by kind, container, signature and callee set', () => {
  const base = build([fn('parse', { params: [['raw', 'string']], returns: 'number' }), fn('helper'), fn('top')], [[id('parse'), id('helper')], [id('top'), id('parse')]]);
  const next = build([fn('parseAmount', { params: [['raw', 'string']], returns: 'number' }), fn('helper'), fn('top')], [[id('parseAmount'), id('helper')], [id('top'), id('parseAmount')]]);
  const result = compareAnalyses(base, next);
  assert.deepEqual(result.renames?.map(rename => [rename.from.name, rename.to.name, rename.basis]), [['parse', 'parseAmount', 'signature+callees']]);
  assert.equal(result.graph_delta.nodes_removed, 1);
});

test('a leaf rename needs the same callers and size, otherwise it stays removed plus added', () => {
  const base = build([fn('leaf', { params: [['n', 'number']], returns: 'string' }), fn('top')], [[id('top'), id('leaf')]]);
  const renamed = build([fn('leaf2', { params: [['n', 'number']], returns: 'string' }), fn('top')], [[id('top'), id('leaf2')]]);
  assert.deepEqual(compareAnalyses(base, renamed).renames?.map(r => r.basis), ['signature+callers+size']);
  const longer = build([fn('leaf2', { params: [['n', 'number']], returns: 'string', lines: 9 }), fn('top')], [[id('top'), id('leaf2')]]);
  assert.deepEqual(compareAnalyses(base, longer).renames, []);
  const unused = build([fn('leaf', { params: [['n', 'number']], returns: 'string' })]);
  const unusedRenamed = build([fn('leaf2', { params: [['n', 'number']], returns: 'string' })]);
  assert.deepEqual(compareAnalyses(unused, unusedRenamed).renames, []);
});

test('two candidates with one fingerprint are ambiguous and reported as removed plus added', () => {
  const sig = { params: [['n', 'number'] as [string, string]], returns: 'number' };
  const base = build([fn('a', sig), fn('b', sig), fn('c')], [[id('a'), id('c')], [id('b'), id('c')]]);
  const next = build([fn('x', sig), fn('y', sig), fn('c')], [[id('x'), id('c')], [id('y'), id('c')]]);
  const result = compareAnalyses(base, next);
  assert.deepEqual(result.renames, []);
  assert.equal(result.ambiguous_renames?.length, 1);
  assert.deepEqual(result.ambiguous_renames?.[0].removed.sort(), [id('a'), id('b')]);
});

test('a renamed class carries its members and a member rename inside it is not invented', () => {
  const cls = (name: string): Spec => ({ id: `src/m.ts:class:${name}`, type: 'class', name });
  const method = (owner: string, name: string): Spec => ({ id: `src/m.ts:method:${owner}.${name}`, type: 'method', name, parent: `src/m.ts:class:${owner}` });
  const base = build([cls('Cart'), method('Cart', 'add'), method('Cart', 'drop')]);
  const next = build([cls('Basket'), method('Basket', 'add'), method('Basket', 'drop')]);
  const result = compareAnalyses(base, next);
  const names = result.renames?.map(rename => `${rename.from.name}>${rename.to.name}:${rename.basis}`).sort();
  assert.deepEqual(names, ['Cart>Basket:members', 'add>add:follows-renamed-container', 'drop>drop:follows-renamed-container']);
});

test('a changed exported signature is breaking and names its consumers', () => {
  const base = build([fn('total', { exported: true, params: [['a', 'number'], ['b', 'number']], returns: 'number' }), fn('report'), fn('handle')],
    [[id('report'), id('total')], [id('handle'), id('total')]]);
  const next = build([fn('total', { exported: true, params: [['a', 'number'], ['b', 'number'], ['tax', 'number']], returns: 'number' }), fn('report'), fn('handle')],
    [[id('report'), id('total')], [id('handle'), id('total')]]);
  const [change] = compareAnalyses(base, next).breaking_changes ?? [];
  assert.equal(change.type, 'signature-change');
  assert.equal(change.verdict, 'breaking');
  assert.deepEqual(change.consumers?.map(consumer => consumer.name).sort(), ['handle', 'report']);
  assert.match(change.description, /required parameter tax added/);
});

test('an added optional parameter is non-breaking and a changed return type is breaking', () => {
  const base = build([fn('f', { exported: true, params: [['a', 'number']], returns: 'number' })]);
  const optional = build([fn('f', { exported: true, params: [['a', 'number'], ['b', 'number', true]], returns: 'number' })]);
  assert.equal(compareAnalyses(base, optional).breaking_changes?.[0].verdict, 'non-breaking');
  const returns = build([fn('f', { exported: true, params: [['a', 'number']], returns: 'string' })]);
  assert.equal(compareAnalyses(base, returns).breaking_changes?.[0].verdict, 'breaking');
  const untyped = build([fn('f', { exported: true, params: [['a']], returns: 'number' })]);
  assert.equal(compareAnalyses(base, untyped).breaking_changes?.[0].verdict, 'potentially-breaking');
  assert.deepEqual(compareAnalyses(base, base).breaking_changes, []);
});

test('a removed export is breaking with consumers and potentially-breaking without', () => {
  const used = build([fn('gone', { exported: true }), fn('user')], [[id('user'), id('gone')]]);
  const after = build([fn('user')]);
  const removed = compareAnalyses(used, after).breaking_changes?.[0];
  assert.equal(removed?.type, 'removed-export');
  assert.equal(removed?.verdict, 'breaking');
  assert.deepEqual(removed?.consumers?.map(consumer => consumer.name), ['user']);
  const lonely = compareAnalyses(build([fn('gone', { exported: true })]), build([fn('other')])).breaking_changes?.[0];
  assert.equal(lonely?.verdict, 'potentially-breaking');
});

test('a renamed export is reported against its old name, and migrated consumers keep it potentially-breaking', () => {
  const sig = { params: [['n', 'number'] as [string, string]], returns: 'number' };
  const base = build([fn('old', { exported: true, ...sig }), fn('helper'), fn('user')], [[id('old'), id('helper')], [id('user'), id('old')]]);
  const next = build([fn('fresh', { exported: true, ...sig }), fn('helper'), fn('user')], [[id('fresh'), id('helper')], [id('user'), id('fresh')]]);
  const result = compareAnalyses(base, next);
  assert.equal(result.renames?.length, 1);
  const [change] = result.breaking_changes ?? [];
  assert.equal(change.type, 'renamed-export');
  assert.equal(change.verdict, 'potentially-breaking');
  assert.match(change.suggestedMigration ?? '', /fresh instead of old/);
  assert.deepEqual(change.affectedConsumers, [id('user')]);
});

test('a narrowed export or access level is breaking and a lost member of an exported class is a type change', () => {
  const base = build([fn('f', { exported: true }), { id: 'src/m.ts:class:K', type: 'class', name: 'K', exported: true }, { id: 'src/m.ts:method:K.a', type: 'method', name: 'a', parent: 'src/m.ts:class:K' }, { id: 'src/m.ts:method:K.b', type: 'method', name: 'b', parent: 'src/m.ts:class:K' }]);
  const next = build([fn('f'), { id: 'src/m.ts:class:K', type: 'class', name: 'K', exported: true }, { id: 'src/m.ts:method:K.a', type: 'method', name: 'a', parent: 'src/m.ts:class:K' }]);
  const kinds = (compareAnalyses(base, next).breaking_changes ?? []).map(change => [change.type, change.verdict]);
  assert.deepEqual(kinds.sort(), [['type-change', 'breaking'], ['visibility-change', 'breaking']]);
});

test('the engine delta names both revisions and reports capabilities, flows, steps, entities, seams and sub-projects', () => {
  const operation = (path: string) => ({ entry_point_id: `entry:${path}`, entry_point_type: 'http', action: path, path_or_command: path, trigger: { method: 'GET', path } });
  const capability = (idValue: string, name: string, paths: string[], entities: string[] = []) => ({ id: idValue, name, category: 'core', criticality: 'medium', operations: paths.map(operation), related_entities: entities });
  const step = (stepId: string, name: string, functions: string[]) => ({ step_id: stepId, order: 1, name, description: name, functions: functions.map(function_id => ({ function_id })), entities: [] });
  const flow = (flowId: string, entry: string, name: string, steps: unknown[], standing = 'terminal', open?: number) => ({ flow_id: flowId, name, intent: name, entry_point: entry, standing, ...(open === undefined ? {} : { open }), entities: [], steps });
  const entryPoint = (entryId: string, handler: string, path: string) => ({ id: entryId, source_node: handler, type: 'http', name: path, trigger: { method: 'GET', path } });
  const seam = (source: string, target: string) => ({ id: `s-${source}`, kind: 'exit_point', modality: 'sync', source, target, summary: `${source} calls ${target}`, metadata: { contract: target } });
  const sub = (idValue: string, root: string, nodes: number) => ({ ...build(Array.from({ length: nodes }, (_, at) => fn(`n${at}`))), id: idValue, system: { name: idValue, type: 'library', root_path: root } });
  const sig = { params: [['n', 'number'] as [string, string]], returns: 'number' };
  const base = build([fn('list', sig), fn('helper')], [[id('list'), id('helper')]], {
    capabilities: [capability('capability:browse', 'Browse', ['/items'], ['Item']), capability('capability:pay', 'Pay', ['/pay']), capability('capability:old', 'Old thing', ['/old'])] as any,
    entry_points: [entryPoint('entry:/items', id('list'), '/items'), entryPoint('entry:/pay', id('helper'), '/pay')] as any,
    flows: [
      flow('flow:entry:/items', 'entry:/items', 'List items', [step('flow:entry:/items:s1', 'Read items', [id('list')]), step('flow:entry:/items:s2', 'Respond', [id('helper')])], 'terminal'),
      flow('flow:entry:/pay', 'entry:/pay', 'Pay', [step('flow:entry:/pay:s1', 'Charge', [id('helper')])]),
    ] as any,
    entities: [{ id: 'Item', name: 'Item', fields: [{ name: 'id', type: 'number' }], relations: [], lifecycle: { created_by: [], read_by: [] } }] as any,
    communication_seams: { seams: [seam('web', 'billing')], inventory: {} } as any,
    children: [sub('cas:x:web', 'web', 2), sub('cas:x:gone', 'gone', 1)] as any,
  });
  const next = build([fn('listItems', sig), fn('helper')], [[id('listItems'), id('helper')]], {
    analysis_id: 'second',
    capabilities: [capability('capability:browse', 'Browse', ['/items'], ['Item', 'Tag']), capability('capability:settle', 'Settle', ['/old']), capability('capability:new', 'New thing', ['/new'])] as any,
    entry_points: [entryPoint('entry:/items', id('listItems'), '/items'), entryPoint('entry:/new', id('helper'), '/new')] as any,
    flows: [
      flow('flow:entry:/items', 'entry:/items', 'List items', [step('flow:entry:/items:s1', 'Read items', [id('listItems')]), step('flow:entry:/items:s3', 'Cache', [id('helper')])], 'open', 2),
      flow('flow:entry:/new', 'entry:/new', 'New', [step('flow:entry:/new:s1', 'Do', [id('helper')])]),
    ] as any,
    entities: [{ id: 'Item', name: 'Item', fields: [{ name: 'id', type: 'number' }, { name: 'sku', type: 'string' }], relations: [], lifecycle: { created_by: [], read_by: [] } }, { id: 'Tag', name: 'Tag', fields: [], relations: [], lifecycle: { created_by: [], read_by: [] } }] as any,
    communication_seams: { seams: [seam('web', 'search')], inventory: {} } as any,
    children: [sub('cas:x:web', 'web', 3), sub('cas:x:new', 'new', 1)] as any,
  });
  const { engine_delta: delta } = compareAnalyses(base, next, { baselineLabel: 'v1', proposedLabel: 'v2' });
  assert.equal(delta?.revisions.baseline.label, 'v1');
  assert.equal(delta?.revisions.proposed.label, 'v2');
  assert.equal(delta?.revisions.proposed.analysis_id, 'second');
  const names = (list: Array<{ name: string }>) => list.map(held => held.name).sort();
  assert.deepEqual(names(delta!.capabilities.added), ['New thing']);
  assert.deepEqual(names(delta!.capabilities.removed), ['Pay']);
  assert.deepEqual(delta!.capabilities.renamed.map(pair => [pair.from.name, pair.to.name]), [['Old thing', 'Settle']]);
  assert.deepEqual(delta!.capabilities.changed.map(held => held.name), ['Browse']);
  assert.deepEqual(names(delta!.flows.added), ['New']);
  assert.deepEqual(names(delta!.flows.removed), ['Pay']);
  const listed = delta!.flows.changed.find(held => held.name === 'List items');
  assert.ok(listed?.changes.some(change => change.facet === 'standing' && change.to === 'open'));
  assert.ok(listed?.changes.some(change => change.facet === 'open' && change.to === 2));
  assert.ok(!listed?.changes.some(change => change.facet === 'entry'));
  assert.deepEqual(names(delta!.steps.added), ['List items / Cache']);
  assert.deepEqual(names(delta!.steps.removed), ['List items / Respond']);
  assert.deepEqual(names(delta!.entities.added), ['Tag']);
  assert.deepEqual(delta!.entities.changed.map(held => held.name), ['Item']);
  assert.equal(delta!.seams.added.length, 1);
  assert.equal(delta!.seams.removed.length, 1);
  assert.deepEqual(names(delta!.sub_projects.added), ['cas:x:new']);
  assert.deepEqual(names(delta!.sub_projects.removed), ['cas:x:gone']);
  assert.deepEqual(delta!.sub_projects.changed.map(held => held.name), ['cas:x:web']);
});
