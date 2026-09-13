import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASEdge, CASNode } from '../../types/cas.types';
import { executableCallGraph, isExecutableNode, isInvocationEdge } from './terminality-scope';

// Terminality answers "what sits at the end of a chain". It was being computed
// over every node and every edge, which meant a class property with no outgoing
// containment edge counted as an end. 110,937 of 136,928 nodes came back
// terminal, led by properties with more than a thousand incoming edges. A
// property is not a destination; it is a field.
//
// The scope is now executable code joined by invocation edges. Containment is
// deliberately excluded: a file containing a function says nothing about what
// runs after what.

function node(id: string, type: string): CASNode {
  return { id, name: id, type } as unknown as CASNode;
}

function edge(source: string, target: string, type: string): CASEdge {
  return { id: `${source}-${target}`, source, target, type } as unknown as CASEdge;
}

test('code that runs is in scope, data and structure are not', () => {
  for (const type of ['function', 'method', 'constructor', 'route', 'component']) {
    assert.ok(isExecutableNode(node('x', type)), `${type} runs`);
  }
  for (const type of ['property', 'variable', 'file', 'import', 'type', 'interface', 'class']) {
    assert.equal(isExecutableNode(node('x', type)), false, `${type} does not run`);
  }
});

test('invocation edges are in scope, containment is not', () => {
  for (const type of ['calls', 'invokes', 'renders']) {
    assert.ok(isInvocationEdge(edge('a', 'b', type)), `${type} is invocation`);
  }
  for (const type of ['contains', 'has_method', 'imports', 'extends', 'references']) {
    assert.equal(isInvocationEdge(edge('a', 'b', type)), false, `${type} is not invocation`);
  }
});

test('the graph keeps only executable endpoints on both sides of an edge', () => {
  const nodes = [node('fnA', 'function'), node('fnB', 'method'), node('propC', 'property'), node('fileD', 'file')];
  const edges = [
    edge('fnA', 'fnB', 'calls'),
    edge('fnA', 'propC', 'calls'),
    edge('fileD', 'fnA', 'contains'),
    edge('fnB', 'fnA', 'imports')
  ];
  const graph = executableCallGraph(nodes, edges);
  assert.deepEqual(graph.ids, ['fnA', 'fnB']);
  assert.deepEqual(graph.edges, [{ source: 'fnA', target: 'fnB' }]);
});

test('a property with a thousand callers does not become an end of a chain', () => {
  // The exact shape that made 81% of the graph terminal.
  const nodes = [node('prop', 'property'), ...Array.from({ length: 20 }, (_, i) => node(`fn${i}`, 'function'))];
  const edges = Array.from({ length: 20 }, (_, i) => edge(`fn${i}`, 'prop', 'calls'));
  const graph = executableCallGraph(nodes, edges);
  assert.ok(!graph.ids.includes('prop'));
  assert.equal(graph.edges.length, 0, 'edges into a property carry no chain information');
});

test('an empty graph is empty rather than an error', () => {
  const graph = executableCallGraph([], []);
  assert.deepEqual(graph.ids, []);
  assert.deepEqual(graph.edges, []);
});
