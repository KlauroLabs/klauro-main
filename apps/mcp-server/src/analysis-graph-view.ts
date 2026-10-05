import type { CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getQueryTraversalIndex } from './query-traversal-index';

const CALL_EDGE_TYPES = new Set(['calls', 'invokes']);
const DECLARATION_TYPES = new Set(['function', 'method', 'class', 'interface', 'type', 'enum']);
const CONTAINER_TYPES = new Set(['class', 'interface', 'type', 'enum']);

export interface GraphView {
  cas: CASOutput;
  node(id: string): CASNode | undefined;
  declarations: CASNode[];
  members(id: string): CASNode[];
  callees(id: string): string[];
  callers(id: string): string[];
}

export function isDeclaration(node: CASNode): boolean {
  return DECLARATION_TYPES.has(node.type) && node.source?.file !== undefined;
}

export function isContainer(node: CASNode): boolean {
  return CONTAINER_TYPES.has(node.type);
}

export function viewOf(cas: CASOutput): GraphView {
  const index = getQueryTraversalIndex(cas);
  const children = new Map<string, CASNode[]>();
  for (const node of cas.nodes) {
    if (node.parent === undefined) continue;
    const held = children.get(node.parent) ?? [];
    held.push(node);
    children.set(node.parent, held);
  }
  const related = (id: string, direction: 'out' | 'in'): string[] => {
    const edges = (direction === 'out' ? index.outgoingEdges : index.incomingEdges).get(id) ?? [];
    const calls = (direction === 'out' ? index.outgoingMethodCalls : index.incomingMethodCalls).get(id) ?? [];
    const found = new Set<string>();
    for (const edge of edges) {
      if (CALL_EDGE_TYPES.has(edge.type)) found.add(direction === 'out' ? edge.target : edge.source);
    }
    for (const call of calls) {
      const other = direction === 'out' ? call.target_node : call.caller_node;
      if (other) found.add(other);
    }
    found.delete(id);
    return [...found].sort();
  };
  return {
    cas,
    node: id => index.nodesById.get(id),
    declarations: cas.nodes.filter(isDeclaration),
    members: id => children.get(id) ?? [],
    callees: id => related(id, 'out'),
    callers: id => related(id, 'in'),
  };
}

export interface NodeRef {
  id: string;
  name: string;
  type: string;
  file?: string;
  line?: number;
}

export function refOfNode(node: CASNode | undefined, fallback: string): NodeRef {
  return {
    id: node?.id ?? fallback,
    name: node?.name ?? fallback,
    type: node?.type ?? 'unknown',
    ...(node?.source?.file === undefined ? {} : { file: node.source.file }),
    ...(node?.source?.line === undefined ? {} : { line: node.source.line }),
  };
}
