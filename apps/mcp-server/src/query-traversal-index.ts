import type { CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export interface QueryTraversalIndex {
  nodesById: Map<string, CASNode>;
  incomingEdges: Map<string, CASOutput['edges']>;
  outgoingEdges: Map<string, CASOutput['edges']>;
  incomingMethodCalls: Map<string, NonNullable<CASOutput['method_calls']>>;
  outgoingMethodCalls: Map<string, NonNullable<CASOutput['method_calls']>>;
}

const indexes = new WeakMap<CASOutput, QueryTraversalIndex>();

export function getQueryTraversalIndex(cas: CASOutput): QueryTraversalIndex {
  const cached = indexes.get(cas);
  if (cached) return cached;
  const index: QueryTraversalIndex = {
    nodesById: new Map(cas.nodes.map(node => [node.id, node])),
    incomingEdges: new Map(),
    outgoingEdges: new Map(),
    incomingMethodCalls: new Map(),
    outgoingMethodCalls: new Map(),
  };
  for (const edge of cas.edges) {
    append(index.incomingEdges, edge.target, edge);
    append(index.outgoingEdges, edge.source, edge);
  }
  for (const methodCall of cas.method_calls || []) {
    if (methodCall.target_node) append(index.incomingMethodCalls, methodCall.target_node, methodCall);
    if (methodCall.caller_node) append(index.outgoingMethodCalls, methodCall.caller_node, methodCall);
  }
  indexes.set(cas, index);
  return index;
}

function append<T>(index: Map<string, T[]>, key: string, value: T): void {
  const values = index.get(key) || [];
  values.push(value);
  index.set(key, values);
}
