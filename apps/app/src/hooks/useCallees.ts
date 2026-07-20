import { useMemo } from 'react';
import { useCodebaseNodes } from './useFileNodes';
import type { RelatedNode } from './useCallers';

/** Everything this node calls — the mirror of useCallers (edge.source === nodeId).
 *  See useCallers.ts for the shared shape and edge-derivation rationale. */
export function useCallees(projectId: string | undefined, nodeId: string | undefined) {
  const base = useCodebaseNodes(projectId);

  const callees = useMemo<RelatedNode[]>(() => {
    if (!nodeId) return [];
    return base.edges
      .filter(e => e.type === 'calls' && e.source === nodeId)
      .map(e => ({
        id: e.target,
        node: base.nodesById.get(e.target),
        line: e.metadata?.attributes?.line,
        methodName: e.metadata?.attributes?.method_name,
      }));
  }, [base.edges, base.nodesById, nodeId]);

  return { ...base, callees };
}
