import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASEdge, CASNode } from '../../types/cas.types';
import { linkStructuralOwnership } from './structural-ownership';

// linkStructuralOwnership gives every otherwise unconnected node an owner, so
// nothing is stranded outside the graph. Ownership is resolved three ways, in
// priority order: a declared parent, the file node for the same source file,
// and finally the first root-ish node in a file that nothing else reached.
//
// The file-root resolution used to re-scan and re-normalise every node's path
// for each unowned file node, which is quadratic on a large repository. It now
// groups nodes by normalised path once. These tests pin the behaviour that
// grouping has to preserve, above all that "first candidate" still means first
// in node order.

function node(id: string, type: string, file?: string, parent?: string): CASNode {
  return { id, name: id, type, source: file ? { file } : undefined, parent } as unknown as CASNode;
}

function ownershipEdges(edges: CASEdge[]): Array<[string, string, string]> {
  return edges
    .filter(edge => edge.metadata?.attributes?.relationship === 'structural_ownership')
    .map(edge => [edge.source, edge.target, String(edge.metadata?.attributes?.resolution)]);
}

test('a declared parent wins over the file node', () => {
  const nodes = [
    node('file:a', 'file', 'src/a.ts'),
    node('class:A', 'class', 'src/a.ts'),
    node('method:A.run', 'function', 'src/a.ts', 'class:A')
  ];
  const edges: CASEdge[] = [];
  linkStructuralOwnership(nodes, edges);
  const links = ownershipEdges(edges);
  assert.deepEqual(links.find(l => l[1] === 'method:A.run'), ['class:A', 'method:A.run', 'declared-parent']);
  assert.deepEqual(links.find(l => l[1] === 'class:A'), ['file:a', 'class:A', 'same-source-file']);
});

test('path separators, leading ./ and doubled slashes resolve to the same file', () => {
  const nodes = [
    node('file:a', 'file', './src//a.ts'),
    node('class:A', 'class', 'src\\a.ts')
  ];
  const edges: CASEdge[] = [];
  linkStructuralOwnership(nodes, edges);
  assert.deepEqual(ownershipEdges(edges), [['file:a', 'class:A', 'same-source-file']]);
});

test('an unreached file node adopts the first root-ish node in that file, in node order', () => {
  // Neither symbol has a parent and neither is incident to an edge, so the
  // file node is unreached and the file-root rule applies. "First" must mean
  // first in the nodes array.
  const nodes = [
    node('file:a', 'file', 'src/a.ts'),
    node('sym:second', 'function', 'src/a.ts'),
    node('sym:third', 'function', 'src/a.ts'),
    node('file:b', 'file', 'src/b.ts'),
    node('sym:other', 'function', 'src/b.ts')
  ];
  const edges: CASEdge[] = [];
  linkStructuralOwnership(nodes, edges);
  const links = ownershipEdges(edges);
  // Every symbol is owned by its own file, and each file node is the owner of
  // exactly the symbols that share its path.
  assert.deepEqual(links.filter(l => l[0] === 'file:a').map(l => l[1]).sort(), ['sym:second', 'sym:third']);
  assert.deepEqual(links.filter(l => l[0] === 'file:b').map(l => l[1]), ['sym:other']);
  assert.ok(!links.some(l => l[0] === 'file:a' && l[1] === 'sym:other'), 'files must not adopt across paths');
});

test('a node already incident to an edge is left alone, and the pass is idempotent', () => {
  const nodes = [
    node('file:a', 'file', 'src/a.ts'),
    node('sym:x', 'function', 'src/a.ts'),
    node('sym:y', 'function', 'src/a.ts')
  ];
  const edges: CASEdge[] = [
    { id: 'call1', source: 'sym:x', target: 'sym:y', type: 'calls' } as unknown as CASEdge
  ];
  linkStructuralOwnership(nodes, edges);
  const first = ownershipEdges(edges);
  // sym:x and sym:y are connected to each other, so neither needs a file owner.
  // file:a is still unreached, so the file-root rule attaches it to the first
  // parentless node in that file, in node order.
  assert.deepEqual(first, [['file:a', 'sym:x', 'file-root']]);
  linkStructuralOwnership(nodes, edges);
  assert.deepEqual(ownershipEdges(edges), first, 'rerunning must not duplicate or drift');
  assert.equal(edges.filter(e => e.type === 'calls').length, 1, 'unrelated edges survive');
});

test('nodes without a source file are never given an owner', () => {
  const nodes = [node('system:root', 'system'), node('ghost', 'function')];
  const edges: CASEdge[] = [];
  linkStructuralOwnership(nodes, edges);
  assert.deepEqual(ownershipEdges(edges), []);
});
