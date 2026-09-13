import type { CASEdge, CASNode } from '../../types/cas.types';

const EXECUTABLE_NODE_TYPES = new Set([
  'function',
  'method',
  'constructor',
  'getter',
  'setter',
  'route',
  'handler',
  'component'
]);

const INVOCATION_EDGE_TYPES = new Set([
  'calls',
  'invokes',
  'dispatches',
  'renders'
]);

export function isExecutableNode(node: CASNode): boolean {
  return EXECUTABLE_NODE_TYPES.has(String(node.type));
}

export function isInvocationEdge(edge: CASEdge): boolean {
  return INVOCATION_EDGE_TYPES.has(String(edge.type));
}

export function executableCallGraph(
  nodes: readonly CASNode[],
  edges: readonly CASEdge[]
): { ids: string[]; edges: Array<{ source: string; target: string }> } {
  const ids: string[] = [];
  const included = new Set<string>();
  for (const node of nodes) {
    if (!isExecutableNode(node)) continue;
    ids.push(node.id);
    included.add(node.id);
  }
  const scoped: Array<{ source: string; target: string }> = [];
  for (const edge of edges) {
    if (!isInvocationEdge(edge)) continue;
    if (!included.has(edge.source) || !included.has(edge.target)) continue;
    scoped.push({ source: edge.source, target: edge.target });
  }
  return { ids, edges: scoped };
}
