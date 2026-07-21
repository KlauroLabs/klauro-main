import { useMemo } from 'react';
import { useCodebaseNodes, type CasNode } from './useFileNodes';

export interface RelatedNode {
  node?: CasNode;

  id: string;
  line?: number;
  methodName?: string;
}

export function useCallers(projectId: string | undefined, nodeId: string | undefined) {
  const base = useCodebaseNodes(projectId);

  const callers = useMemo<RelatedNode[]>(() => {
    if (!nodeId) return [];
    return base.edges
      .filter(e => e.type === 'calls' && e.target === nodeId)
      .map(e => ({
        id: e.source,
        node: base.nodesById.get(e.source),
        line: e.metadata?.attributes?.line,
        methodName: e.metadata?.attributes?.method_name,
      }));
  }, [base.edges, base.nodesById, nodeId]);

  return { ...base, callers };
}
