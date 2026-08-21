import type { CASEdge, CASNode } from '../../types/cas.types';
import {
  encodeCompactCASGraph,
  validateCompactCASParity,
} from '../../analyzer/core/compact-cas-graph';

function cas(nodes: CASNode[], edges: CASEdge[]): { nodes: CASNode[]; edges: CASEdge[] } {
  return { nodes, edges };
}

describe('compact CAS graph', () => {
  const nodes: CASNode[] = [
    { id: 'node-c', name: 'Shared', type: 'function' },
    { id: 'node-a', name: 'Shared', type: 'service', source: { file: 'src/a.ts', line: 7 } },
    { id: 'node-b', name: 'Middle', type: 'function', qualified_name: 'Example.Middle', category: 'code' },
    { id: 'node-d', name: 'Disconnected', type: 'module' },
  ];
  const edges: CASEdge[] = [
    { id: 'edge-3', source: 'node-b', target: 'node-c', type: 'calls' },
    { id: 'edge-2', source: 'node-a', target: 'node-b', type: 'calls', category: 'control' },
    { id: 'edge-1', source: 'node-a', target: 'node-b', type: 'imports' },
    { id: 'edge-4', source: 'node-c', target: 'node-a', type: 'calls' },
  ];

  test('assigns stable dense ids and preserves duplicate names, disconnected nodes, and absent fields', () => {
    const graph = encodeCompactCASGraph(cas(nodes, edges));
    expect(Array.from({ length: graph.nodeCount }, (_, denseId) => graph.nodeAt(denseId).id))
      .toEqual(['node-a', 'node-b', 'node-c', 'node-d']);
    expect(graph.nodeById('node-a')).toMatchObject({ denseId: 0, name: 'Shared', sourceLine: 7 });
    expect(graph.nodeById('node-c')).toMatchObject({ denseId: 2, name: 'Shared' });
    expect(graph.nodeAt(2).qualifiedName).toBeUndefined();
    expect(graph.nodeAt(2).sourceFile).toBeUndefined();
    expect(Array.from(graph.findNodes({ name: 'Shared', limit: 10 }).denseIds)).toEqual([0, 2]);
    expect(Array.from(graph.findNodes({ type: 'function', name: 'Shared', limit: 10 }).denseIds)).toEqual([2]);
    expect(graph.findNodes({ name: 'Unknown', limit: 10 })).toEqual({ denseIds: new Uint32Array(0), total: 0 });
    expect(graph.outgoingEdges(3, { limit: 10 })).toEqual({ items: [], total: 0, nextOffset: undefined });
    expect(graph.incomingEdges(3, { limit: 10 })).toEqual({ items: [], total: 0, nextOffset: undefined });
  });

  test('preserves multiedges and exact CSR and CSC adjacency', () => {
    const graph = encodeCompactCASGraph(cas(nodes, edges));
    expect(Array.from(graph.outgoing.offsets)).toEqual([0, 2, 3, 4, 4]);
    expect(Array.from(graph.incoming.offsets)).toEqual([0, 1, 3, 4, 4]);
    expect(graph.outgoingEdges(0, { limit: 10 }).items.map(edge => [edge.id, edge.sourceId, edge.targetId, edge.type]))
      .toEqual([
        ['edge-2', 'node-a', 'node-b', 'calls'],
        ['edge-1', 'node-a', 'node-b', 'imports'],
      ]);
    expect(graph.incomingEdges(1, { limit: 1 })).toMatchObject({ total: 2, nextOffset: 1 });
    expect(graph.incomingEdges(1, { offset: 1, limit: 1 }).items.map(edge => edge.id)).toEqual(['edge-1']);
    expect(Array.from(graph.outgoing.edgeOrdinals)).toEqual([0, 1, 2, 3]);
    expect(Array.from(graph.incoming.edgeOrdinals)).toEqual([3, 0, 1, 2]);
    const encodedArrays = [
      graph.dictionary.bytes,
      graph.dictionary.offsets,
      ...Object.values(graph.nodes),
      ...Object.values(graph.edges),
      graph.outgoing.offsets,
      graph.outgoing.edgeOrdinals,
      graph.incoming.offsets,
      graph.incoming.edgeOrdinals,
    ];
    expect(graph.encodedByteLength).toBe(encodedArrays.reduce((total, array) => total + array.byteLength, 0));
    expect(validateCompactCASParity(graph, cas(nodes, edges))).toEqual({ ok: true, errors: [] });
  });

  test('encodes identically across input ordering', () => {
    const first = encodeCompactCASGraph(cas(nodes, edges));
    const second = encodeCompactCASGraph(cas([...nodes].reverse(), [edges[2], edges[0], edges[3], edges[1]]));
    expect(Array.from(second.dictionary.bytes)).toEqual(Array.from(first.dictionary.bytes));
    expect(Array.from(second.dictionary.offsets)).toEqual(Array.from(first.dictionary.offsets));
    expect(Array.from(second.nodes.id)).toEqual(Array.from(first.nodes.id));
    expect(Array.from(second.edges.id)).toEqual(Array.from(first.edges.id));
    expect(Array.from(second.outgoing.edgeOrdinals)).toEqual(Array.from(first.outgoing.edgeOrdinals));
    expect(Array.from(second.incoming.edgeOrdinals)).toEqual(Array.from(first.incoming.edgeOrdinals));
  });

  test('rejects unresolved edge endpoints before producing a graph', () => {
    expect(() => encodeCompactCASGraph(cas(nodes, [
      { id: 'dangling', source: 'node-a', target: 'missing', type: 'calls' },
    ]))).toThrow('CAS edge dangling has unresolved target missing');
  });

  test('reports structural parity failures', () => {
    const graph = encodeCompactCASGraph(cas(nodes, edges));
    graph.edges.target[0] = 3;
    const parity = validateCompactCASParity(graph, cas(nodes, edges));
    expect(parity.ok).toBe(false);
    expect(parity.errors).toContain('edges.target[0] 3 does not match 1');
  });

  test('bounds pages and traversal while returning exact edge ordinals', () => {
    const graph = encodeCompactCASGraph(cas(nodes, edges), {
      maxPageSize: 2,
      maxTraversalNodes: 4,
      maxTraversalEdges: 4,
      maxTraversalDepth: 4,
    });
    expect(() => graph.outgoingEdges(0, { limit: 3 })).toThrow('limit must be an integer from 1 through 2');
    const traversal = graph.traverse(0, { direction: 'outgoing', maxDepth: 4, maxNodes: 3, maxEdges: 3 });
    expect(Array.from(traversal.nodeDenseIds)).toEqual([0, 1, 2]);
    expect(Array.from(traversal.edgeOrdinals)).toEqual([0, 1, 2]);
    expect(traversal.truncated).toBe(true);
  });
});
