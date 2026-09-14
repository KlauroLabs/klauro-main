import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASNode } from '../../types/cas.types';
import { buildTypeScriptCallEdges } from './typescript-call-edges';

// The call that carries a command to its work is usually a method on a value,
// and those are invisible to name-based resolution. A command handler that
// awaits a helper and then calls a method on what it returns produces one edge,
// to the helper, and none to the method.
//
// The TypeScript checker resolves those exactly, to a file and a line. This
// turns such a resolution into an edge by finding the tightest code node
// containing the call site and the node declared at the target line.

function node(id: string, type: string, file: string, line: number, endLine: number): CASNode {
  return { id, name: id, type, source: { file, line, end_line: endLine } } as unknown as CASNode;
}

const CLI = '/repo/extensions/voice-call/src/cli.ts';
const MANAGER = '/repo/extensions/voice-call/src/manager.ts';

test('a resolved member call becomes an edge from the enclosing handler to the method', () => {
  const nodes = [
    node('registerCli', 'function', CLI, 44, 276),
    node('continueHandler', 'function', CLI, 116, 124),
    node('continueCall', 'method', MANAGER, 116, 130)
  ];
  const edges = buildTypeScriptCallEdges(nodes, new Set(), [
    { fromFile: CLI, fromLine: 118, toFile: MANAGER, toLine: 116, name: 'continueCall' }
  ]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].source, 'continueHandler', 'the tightest span containing the call site, not the outer function');
  assert.equal(edges[0].target, 'continueCall');
  assert.equal(edges[0].type, 'calls');
  assert.equal(edges[0].metadata?.attributes?.member, 'continueCall');
});

test('the caller is the innermost enclosing node, never an outer one', () => {
  const nodes = [
    node('outer', 'function', CLI, 1, 500),
    node('inner', 'function', CLI, 100, 120),
    node('target', 'method', MANAGER, 10, 20)
  ];
  const edges = buildTypeScriptCallEdges(nodes, new Set(), [
    { fromFile: CLI, fromLine: 110, toFile: MANAGER, toLine: 10, name: 'doThing' }
  ]);
  assert.equal(edges[0].source, 'inner');
});

test('paths that differ in prefix still match on their tail', () => {
  // The checker reports absolute paths; nodes may carry a different prefix.
  const nodes = [
    node('handler', 'function', 'extensions/voice-call/src/cli.ts', 116, 124),
    node('method', 'method', 'extensions/voice-call/src/manager.ts', 116, 130)
  ];
  const edges = buildTypeScriptCallEdges(nodes, new Set(), [
    { fromFile: CLI, fromLine: 118, toFile: MANAGER, toLine: 116, name: 'continueCall' }
  ]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, 'method');
});

test('a call with no code node around it produces nothing', () => {
  const nodes = [node('method', 'method', MANAGER, 116, 130)];
  const edges = buildTypeScriptCallEdges(nodes, new Set(), [
    { fromFile: CLI, fromLine: 118, toFile: MANAGER, toLine: 116, name: 'continueCall' }
  ]);
  assert.deepEqual(edges, [], 'no source node means no edge, rather than a guessed one');
});

test('a declaration with no matching node produces nothing', () => {
  const nodes = [node('handler', 'function', CLI, 116, 124)];
  const edges = buildTypeScriptCallEdges(nodes, new Set(), [
    { fromFile: CLI, fromLine: 118, toFile: MANAGER, toLine: 116, name: 'continueCall' }
  ]);
  assert.deepEqual(edges, []);
});

test('a method calling itself is not an edge', () => {
  const nodes = [node('self', 'method', MANAGER, 116, 130)];
  const edges = buildTypeScriptCallEdges(nodes, new Set(), [
    { fromFile: MANAGER, fromLine: 120, toFile: MANAGER, toLine: 116, name: 'continueCall' }
  ]);
  assert.deepEqual(edges, []);
});

test('the same resolution seen twice yields one edge, and a call already in the graph is not repeated', () => {
  const nodes = [
    node('handler', 'function', CLI, 116, 124),
    node('method', 'method', MANAGER, 116, 130)
  ];
  const twice = [
    { fromFile: CLI, fromLine: 118, toFile: MANAGER, toLine: 116, name: 'continueCall' },
    { fromFile: CLI, fromLine: 121, toFile: MANAGER, toLine: 116, name: 'continueCall' }
  ];
  assert.equal(buildTypeScriptCallEdges(nodes, new Set(), twice).length, 1);
  const already = new Set(['handler\u0000method']);
  assert.equal(buildTypeScriptCallEdges(nodes, already, twice).length, 0, 'an edge already in the graph is not repeated');
});

test('data and file nodes are not treated as callers or targets', () => {
  const nodes = [
    node('fileNode', 'file', CLI, 1, 400),
    node('prop', 'property', MANAGER, 116, 116)
  ];
  const edges = buildTypeScriptCallEdges(nodes, new Set(), [
    { fromFile: CLI, fromLine: 118, toFile: MANAGER, toLine: 116, name: 'continueCall' }
  ]);
  assert.deepEqual(edges, []);
});
