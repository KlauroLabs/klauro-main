import type { CASEdge, CASExitPoint, CASNode } from '../../types/cas.types';

export interface PythonCallIndex {
  nodesById: Map<string, CASNode>;
  callablesByName: Map<string, CASNode[]>;
  edgeIds: Set<string>;
  exitPointIds: Set<string>;
}

export function buildPythonCallIndex(
  nodes: CASNode[],
  edges: CASEdge[],
  exitPoints: CASExitPoint[],
): PythonCallIndex {
  const nodesById = new Map<string, CASNode>();
  const callablesByName = new Map<string, CASNode[]>();
  for (const node of nodes) {
    nodesById.set(node.id, node);
    if (node.type !== 'function' && node.type !== 'method') continue;
    const candidates = callablesByName.get(node.name);
    if (candidates) candidates.push(node);
    else callablesByName.set(node.name, [node]);
  }
  return {
    nodesById,
    callablesByName,
    edgeIds: new Set(edges.map(edge => edge.id)),
    exitPointIds: new Set(exitPoints.map(exitPoint => exitPoint.id)),
  };
}

export function addPythonCallNodes(index: PythonCallIndex, nodes: CASNode[]): void {
  for (const node of nodes) {
    index.nodesById.set(node.id, node);
    if (node.type !== 'function' && node.type !== 'method') continue;
    const candidates = index.callablesByName.get(node.name);
    if (candidates) candidates.push(node);
    else index.callablesByName.set(node.name, [node]);
  }
}

export function selectPythonCallTarget(
  index: PythonCallIndex,
  name: string,
  callerFile: string,
): { target?: CASNode; candidates: number } {
  const candidates = index.callablesByName.get(name) || [];
  return {
    target: candidates.find(node => node.source?.file === callerFile) || candidates[0],
    candidates: candidates.length,
  };
}

export function selectPythonSelfCallTarget(
  index: PythonCallIndex,
  parentId: string | undefined,
  name: string,
): CASNode | undefined {
  if (!parentId) return undefined;
  return (index.callablesByName.get(name) || []).find(node => node.type === 'method' && node.parent === parentId);
}
