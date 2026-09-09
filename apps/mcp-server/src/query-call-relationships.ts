import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getQueryTraversalIndex, type QueryTraversalIndex } from './query-traversal-index';

type Direction = 'incoming' | 'outgoing';

export interface ScopedReferenceCounts {
  callers: number;
  callees: number;
  containers: number;
  children: number;
}

const SCOPED_REFERENCE_COUNTS = Symbol.for('klauro.cas.scoped-reference-counts');
type ReferenceCountedCas = CASOutput & { [SCOPED_REFERENCE_COUNTS]?: { targetId: string; counts: ScopedReferenceCounts } };

export function attachScopedReferenceCounts(cas: CASOutput, targetId: string, counts: ScopedReferenceCounts): void {
  Object.defineProperty(cas, SCOPED_REFERENCE_COUNTS, { configurable: true, enumerable: false, value: { targetId, counts } });
}

function referenceCountsFor(cas: CASOutput, targetId: string): ScopedReferenceCounts | undefined {
  const scoped = (cas as ReferenceCountedCas)[SCOPED_REFERENCE_COUNTS];
  return scoped?.targetId === targetId ? scoped.counts : undefined;
}

interface QueryReference {
  node_id: string;
  name: string;
  type: string;
  depth: number;
  via: string;
}

export function isContainmentRelationship(type: string): boolean {
  return type === 'contains';
}

function* referenceNeighbors(index: QueryTraversalIndex, id: string, direction: Direction) {
  const edges = direction === 'incoming' ? index.incomingEdges : index.outgoingEdges;
  const methodCalls = direction === 'incoming' ? index.incomingMethodCalls : index.outgoingMethodCalls;
  for (const edge of edges.get(id) || []) {
    if (isContainmentRelationship(edge.type)) continue;
    yield { id: direction === 'incoming' ? edge.source : edge.target, via: `edge:${edge.type}` };
  }
  for (const call of methodCalls.get(id) || []) {
    const relatedId = direction === 'incoming' ? call.caller_node : call.target_node;
    if (relatedId) yield { id: relatedId, via: `method_call:${call.call_details.method_name}` };
  }
}

function traverseReferences(cas: CASOutput, nodeId: string, direction: Direction, maxDepth: number, limit: number) {
  const index = getQueryTraversalIndex(cas);
  const discovered = new Set<string>([nodeId]);
  const queue = [{ id: nodeId, depth: 0 }];
  const matches: QueryReference[] = [];


  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (current.depth >= maxDepth) continue;
    for (const neighbor of referenceNeighbors(index, current.id, direction)) {
      if (discovered.has(neighbor.id)) continue;
      const node = index.nodesById.get(neighbor.id);
      if (!node) continue;
      if (matches.length >= limit) return { matches, total: matches.length, limit, truncated: true };
      discovered.add(neighbor.id);
      const depth = current.depth + 1;
      matches.push({ node_id: node.id, name: node.name, type: node.type, depth, via: neighbor.via });
      queue.push({ id: node.id, depth });
    }
  }
  return { matches, total: matches.length, limit, truncated: false };
}

export function getCallers(cas: CASOutput, nodeId: string, maxDepth = 2, limit = 50) {
  const { matches, ...summary } = traverseReferences(cas, nodeId, 'incoming', maxDepth, limit);
  return { ...summary, callers: matches };
}

export function getCallees(cas: CASOutput, nodeId: string, maxDepth = 2, limit = 50) {
  const { matches, ...summary } = traverseReferences(cas, nodeId, 'outgoing', maxDepth, limit);
  return { ...summary, callees: matches };
}

export function getDirectReferenceCounts(cas: CASOutput, nodeId: string) {
  const scoped = referenceCountsFor(cas, nodeId);
  if (scoped) return { callers: scoped.callers, callees: scoped.callees };
  const index = getQueryTraversalIndex(cas);
  const count = (direction: Direction) => {
    const ids = new Set<string>();
    for (const neighbor of referenceNeighbors(index, nodeId, direction)) {
      if (neighbor.id !== nodeId && index.nodesById.has(neighbor.id)) ids.add(neighbor.id);
    }
    return ids.size;
  };
  return { callers: count('incoming'), callees: count('outgoing') };
}

export function getStructuralContext(cas: CASOutput, nodeId: string, containerLimit = 10, childLimit = 10) {
  const index = getQueryTraversalIndex(cas);
  const direct = (direction: Direction, limit: number) => {
    const edges = direction === 'incoming' ? index.incomingEdges : index.outgoingEdges;
    const seen = new Set<string>([nodeId]);
    const items: Array<{ id: string; name: string; type: string; via: string }> = [];
    let total = 0;
    for (const edge of edges.get(nodeId) || []) {
      if (!isContainmentRelationship(edge.type)) continue;
      const id = direction === 'incoming' ? edge.source : edge.target;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = index.nodesById.get(id);
      if (!node) continue;
      total++;
      if (items.length < limit) items.push({ id: node.id, name: node.name, type: node.type, via: `edge:${edge.type}` });
    }
    return { items, total, truncated: total > items.length };
  };
  const containers = direct('incoming', containerLimit);
  const children = direct('outgoing', childLimit);
  const scoped = referenceCountsFor(cas, nodeId);
  const containersTotal = scoped?.containers ?? containers.total;
  const childrenTotal = scoped?.children ?? children.total;
  return {
    containers: containers.items, children: children.items,
    containers_total: containersTotal, children_total: childrenTotal,
    truncated: containersTotal > containers.items.length || childrenTotal > children.items.length,
  };
}
