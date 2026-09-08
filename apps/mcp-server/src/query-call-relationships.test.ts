import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getCallers, getCallees, getCodingContext, getInterfaceSignature } from './query';

function graph(edges: Array<[string, string, string]>, methodCalls: Array<[string, string]> = []): CASOutput {
  const ids = [...new Set([...edges.flatMap(([source, target]) => [source, target]), ...methodCalls.flat()])];
  return {
    cas_version: '3.0.0', analysis_id: 'query-relations', analysis_timestamp: '2026-09-08T00:00:00.000Z',
    system: { name: 'relations', type: 'library' }, analyzer_contributions: [],
    nodes: ids.map(id => ({ id, name: id, type: id.startsWith('file') ? 'file' : 'function', source: { file: id + '.ts', line: 1 }, metadata: {} })),
    edges: edges.map(([source, target, type], i) => ({ id: 'edge-' + i, source, target, type })),
    method_calls: methodCalls.map(([caller_node, target_node], i) => ({
      id: 'call-' + i, caller_node, target_node, call_details: { method_name: target_node },
    })),
  } as unknown as CASOutput;
}

test('containment does not consume caller limits or hide actual file-level invocation', () => {
  const cas = graph([['file-owner', 'target', 'contains'], ['file-execution', 'target', 'calls']]);
  const result = getCallers(cas, 'target', 1, 1);
  assert.deepEqual(result.callers.map(row => row.node_id), ['file-execution']);
  assert.equal(result.callers[0].via, 'edge:calls');
  assert.equal(result.truncated, false);
});

test('contained declarations and their calls are not callees of the lexical owner', () => {
  const cas = graph([['file-owner', 'declaration', 'contains'], ['declaration', 'unrelated', 'calls'], ['file-owner', 'executed', 'calls']]);
  assert.deepEqual(getCallees(cas, 'file-owner', 3).callees.map(row => row.node_id), ['executed']);
});

test('reference reads and method-call-only consumers are retained in both directions', () => {
  const cas = graph([['file-owner', 'constant', 'contains'], ['reader', 'constant', 'references']], [['file-execution', 'constant']]);
  assert.deepEqual(getCallers(cas, 'constant', 1).callers.map(row => [row.node_id, row.via]),
    [['reader', 'edge:references'], ['file-execution', 'method_call:constant']]);
  assert.deepEqual(getCallees(cas, 'reader', 1).callees.map(row => row.node_id), ['constant']);
  assert.deepEqual(getCallees(cas, 'file-execution', 1).callees.map(row => row.node_id), ['constant']);
});

test('exact limits are complete and duplicate edges/method calls are counted once', () => {
  const cas = graph([['a', 'target', 'calls'], ['a', 'target', 'references'], ['b', 'target', 'calls']], [['a', 'target']]);
  assert.equal(getCallers(cas, 'target', 1, 2).truncated, false);
  assert.equal(getCallers(cas, 'target', 1, 2).total, 2);
  assert.equal(getCallers(cas, 'target', 1, 1).truncated, true);
  assert.equal(getCallers(cas, 'target', 1, 0).truncated, true);
  assert.deepEqual(getCallers(cas, 'missing', 1, 0).callers, []);
  assert.equal(getCallers(cas, 'missing', 1, 0).truncated, false);
});

test('outgoing traversal uses shortest depths so an earlier longer path cannot hide descendants', () => {
  const cas = graph([['target', 'long', 'calls'], ['long', 'junction', 'calls'], ['target', 'junction', 'calls'],
    ['junction', 'middle', 'calls'], ['middle', 'leaf', 'calls']]);
  const rows = getCallees(cas, 'target', 3).callees;
  assert.deepEqual(rows.map(row => [row.node_id, row.depth]),
    [['long', 1], ['junction', 1], ['middle', 2], ['leaf', 3]]);
});

test('incoming traversal uses shortest depths across converging call paths', () => {
  const cas = graph([['long', 'target', 'calls'], ['junction', 'long', 'calls'], ['junction', 'target', 'calls'],
    ['middle', 'junction', 'calls'], ['leaf', 'middle', 'calls']]);
  assert.deepEqual(getCallers(cas, 'target', 3).callers.map(row => [row.node_id, row.depth]),
    [['long', 1], ['junction', 1], ['middle', 2], ['leaf', 3]]);
});

test('cycles and self-calls never duplicate the target or manufacture truncation', () => {
  const cas = graph([['a', 'a', 'calls'], ['a', 'b', 'calls'], ['b', 'a', 'calls']], [['a', 'b'], ['b', 'a']]);
  assert.deepEqual(getCallees(cas, 'a', 20, 1).callees.map(row => row.node_id), ['b']);
  assert.equal(getCallees(cas, 'a', 20, 1).truncated, false);
  assert.deepEqual(getCallers(cas, 'a', 20, 1).callers.map(row => row.node_id), ['b']);
  assert.equal(getCallers(cas, 'a', 20, 1).truncated, false);
  assert.equal(getCallers(cas, 'a', 0, 1).total, 0);
});

test('coding context preserves relationship evidence and separates bounded structural context', () => {
  const cas = graph([['file-owner', 'target', 'contains'], ['target', 'nested', 'contains'],
    ['caller', 'target', 'references'], ['target', 'callee', 'calls']]);
  const before = JSON.stringify(cas);
  const context = getCodingContext(cas, 'target') as any;
  assert.equal(context.connected_code.callers_total, 1);
  assert.equal(context.connected_code.callees_total, 1);
  assert.equal(context.connected_code.callers[0].via, 'edge:references');
  assert.equal(context.connected_code.callees[0].via, 'edge:calls');
  assert.deepEqual(context.connected_code.structural_context.containers.map((row: any) => [row.id, row.via]), [['file-owner', 'edge:contains']]);
  assert.deepEqual(context.connected_code.structural_context.children.map((row: any) => [row.id, row.via]), [['nested', 'edge:contains']]);
  assert.equal(JSON.stringify(cas), before);
});

test('coding and interface contexts report exact high-fanout totals beyond the old count probe', () => {
  const edges: Array<[string, string, string]> = [
    ['file-owner', 'target', 'contains'],
    ...Array.from({ length: 5005 }, (_, i): [string, string, string] => ['caller-' + i, 'target', 'calls']),
    ...Array.from({ length: 5001 }, (_, i): [string, string, string] => ['target', 'callee-' + i, 'references']),
  ];
  const cas = graph(edges, [['caller-0', 'target'], ['method-only', 'target']]);
  const context = getCodingContext(cas, 'target', { caller_limit: 1, callee_limit: 1 }) as any;
  assert.equal(context.connected_code.callers.length, 1);
  assert.equal(context.connected_code.callers_total, 5006);
  assert.equal(context.connected_code.callees_total, 5001);
  assert.equal(context.connected_code.truncated, true);
  const signature = getInterfaceSignature(cas, 'target') as any;
  assert.equal(signature.logic.callers_total, 5006);
  assert.equal(signature.logic.callees_total, 5001);
});

test('structural context keeps complete distinct counts with a separately bounded display', () => {
  const cas = graph([['file-owner', 'target', 'contains'], ['file-owner', 'target', 'contains'],
    ['second-owner', 'target', 'contains'], ['target', 'first-child', 'contains'], ['target', 'second-child', 'contains'],
    ['caller', 'target', 'calls'], ['target', 'callee', 'calls']]);
  const context = getCodingContext(cas, 'target', { caller_limit: 1, callee_limit: 1 }) as any;
  assert.equal(context.connected_code.truncated, false);
  const structural = context.connected_code.structural_context;
  assert.equal(structural.containers.length, 1);
  assert.equal(structural.children.length, 1);
  assert.equal(structural.containers_total, 2);
  assert.equal(structural.children_total, 2);
  assert.equal(structural.truncated, true);
});
