import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASEdge, CASNode } from '../../types/cas.types';
import { graphIndex, invalidateGraphIndex, outgoingEdges, incomingEdges, nodesInFile, edgesOfType } from './graph-index';

// Every pass and analyzer built its own lookup: 64 places rebuilt a node-id map,
// 126 loops built an edge index, 147 walked the whole node array, and 23 used
// the one shared helper. On a graph of 136,928 nodes and 209,010 edges that is
// roughly 20 million node visits and 26 million edge visits before any analysis
// happens. This is the one index, built once and shared.
//
// The reason nobody did it before is that the arrays are mutated during the
// analysis, so a cached index goes stale. The cache is keyed on the array
// identity and checks the lengths, so a push rebuilds it and a caller that
// mutates in place can force it.

function node(id: string, type: string, file?: string): CASNode {
  return { id, name: id, type, source: file ? { file, line: 1 } : undefined } as unknown as CASNode;
}

function edge(id: string, source: string, target: string, type: string): CASEdge {
  return { id, source, target, type } as unknown as CASEdge;
}

function fixture(): { nodes: CASNode[]; edges: CASEdge[] } {
  return {
    nodes: [
      node('a', 'function', 'src/a.ts'),
      node('b', 'function', 'src/a.ts'),
      node('c', 'class', 'src/b.ts')
    ],
    edges: [
      edge('e1', 'a', 'b', 'calls'),
      edge('e2', 'a', 'c', 'calls'),
      edge('e3', 'c', 'a', 'imports')
    ]
  };
}

test('one index answers by id, file, type, source and target', () => {
  const { nodes, edges } = fixture();
  const index = graphIndex(nodes, edges);
  assert.equal(index.nodeById.get('b')?.id, 'b');
  assert.deepEqual(nodesInFile(index, 'src/a.ts').map(n => n.id), ['a', 'b']);
  assert.deepEqual(index.nodesByType.get('function')?.map(n => n.id), ['a', 'b']);
  assert.deepEqual(outgoingEdges(index, 'a').map(e => e.id), ['e1', 'e2']);
  assert.deepEqual(incomingEdges(index, 'a').map(e => e.id), ['e3']);
  assert.deepEqual(edgesOfType(index, 'calls').map(e => e.id), ['e1', 'e2']);
});

test('asking twice for the same arrays returns the same index rather than rebuilding', () => {
  const { nodes, edges } = fixture();
  assert.equal(graphIndex(nodes, edges), graphIndex(nodes, edges));
});

test('appending a node invalidates the index, which is how the arrays are actually used', () => {
  const { nodes, edges } = fixture();
  const before = graphIndex(nodes, edges);
  nodes.push(node('d', 'function', 'src/c.ts'));
  const after = graphIndex(nodes, edges);
  assert.notEqual(before, after);
  assert.equal(after.nodeById.get('d')?.id, 'd');
});

test('appending an edge invalidates it too', () => {
  const { nodes, edges } = fixture();
  const before = graphIndex(nodes, edges);
  edges.push(edge('e4', 'b', 'c', 'calls'));
  const after = graphIndex(nodes, edges);
  assert.notEqual(before, after);
  assert.deepEqual(outgoingEdges(after, 'b').map(e => e.id), ['e4']);
});

test('a caller that mutates in place can force a rebuild', () => {
  // Lengths do not change when a node is edited rather than added, so the one
  // case the length check cannot see has an explicit escape.
  const { nodes, edges } = fixture();
  const before = graphIndex(nodes, edges);
  (nodes[0] as unknown as { type: string }).type = 'method';
  assert.equal(graphIndex(nodes, edges), before, 'an in-place edit is invisible to the length check');
  invalidateGraphIndex(nodes);
  const after = graphIndex(nodes, edges);
  assert.deepEqual(after.nodesByType.get('method')?.map(n => n.id), ['a']);
});

test('two different graphs do not share an index', () => {
  const first = fixture();
  const second = fixture();
  assert.notEqual(graphIndex(first.nodes, first.edges), graphIndex(second.nodes, second.edges));
});

test('the first node wins when two share an id, matching a plain map build', () => {
  const nodes = [node('dup', 'function', 'src/a.ts'), node('dup', 'class', 'src/b.ts')];
  const index = graphIndex(nodes, []);
  assert.equal(index.nodeById.get('dup')?.type, 'function');
  assert.equal(index.nodesByType.get('class')?.length, 1, 'both are still reachable by type');
});

test('missing keys return an empty list rather than undefined', () => {
  const index = graphIndex([], []);
  assert.deepEqual(outgoingEdges(index, 'nope'), []);
  assert.deepEqual(incomingEdges(index, 'nope'), []);
  assert.deepEqual(nodesInFile(index, 'nope.ts'), []);
  assert.deepEqual(edgesOfType(index, 'nope'), []);
});

test('nodes without a source file are indexed by type but not by file', () => {
  const nodes = [node('sys', 'system')];
  const index = graphIndex(nodes, []);
  assert.equal(index.nodesByType.get('system')?.length, 1);
  assert.equal(index.nodesByFile.size, 0);
});
