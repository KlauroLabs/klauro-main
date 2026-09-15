import type { CASEdge, CASNode } from '../../types/cas.types';

export interface GraphIndex {
  nodeById: ReadonlyMap<string, CASNode>;
  nodesByFile: ReadonlyMap<string, readonly CASNode[]>;
  nodesByType: ReadonlyMap<string, readonly CASNode[]>;
  edgesBySource: ReadonlyMap<string, readonly CASEdge[]>;
  edgesByTarget: ReadonlyMap<string, readonly CASEdge[]>;
  edgesByType: ReadonlyMap<string, readonly CASEdge[]>;
}

interface CachedIndex {
  nodeCount: number;
  edgeCount: number;
  index: GraphIndex;
}

const cache = new WeakMap<readonly CASNode[], CachedIndex>();

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function build(nodes: readonly CASNode[], edges: readonly CASEdge[]): GraphIndex {
  const nodeById = new Map<string, CASNode>();
  const nodesByFile = new Map<string, CASNode[]>();
  const nodesByType = new Map<string, CASNode[]>();
  for (const node of nodes) {
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
    const file = node.source?.file;
    if (file) push(nodesByFile, file, node);
    push(nodesByType, String(node.type), node);
  }

  const edgesBySource = new Map<string, CASEdge[]>();
  const edgesByTarget = new Map<string, CASEdge[]>();
  const edgesByType = new Map<string, CASEdge[]>();
  for (const edge of edges) {
    push(edgesBySource, edge.source, edge);
    push(edgesByTarget, edge.target, edge);
    push(edgesByType, String(edge.type), edge);
  }

  return { nodeById, nodesByFile, nodesByType, edgesBySource, edgesByTarget, edgesByType };
}

export function graphIndex(nodes: readonly CASNode[], edges: readonly CASEdge[]): GraphIndex {
  const cached = cache.get(nodes);
  if (cached && cached.nodeCount === nodes.length && cached.edgeCount === edges.length) return cached.index;
  const index = build(nodes, edges);
  cache.set(nodes, { nodeCount: nodes.length, edgeCount: edges.length, index });
  return index;
}

export function invalidateGraphIndex(nodes: readonly CASNode[]): void {
  cache.delete(nodes);
}

export function nodesInFile(index: GraphIndex, file: string): readonly CASNode[] {
  return index.nodesByFile.get(file) || [];
}

export function outgoingEdges(index: GraphIndex, nodeId: string): readonly CASEdge[] {
  return index.edgesBySource.get(nodeId) || [];
}

export function incomingEdges(index: GraphIndex, nodeId: string): readonly CASEdge[] {
  return index.edgesByTarget.get(nodeId) || [];
}

export function edgesOfType(index: GraphIndex, type: string): readonly CASEdge[] {
  return index.edgesByType.get(type) || [];
}
